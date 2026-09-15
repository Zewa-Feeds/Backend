/**
 * Z-Coin administration — ZSOP004 §9.4.
 *
 * §9.4 marks all of this a LAUNCH REQUIREMENT, not a fast-follow: "support and
 * finance cannot operate the programme without them", and §13.1 sequences the
 * admin surface BEFORE the storefront so support can see balances before
 * customers can.
 *
 * Mounted under `/api/v1/admin/loyalty`, inheriting the staff JWT + enrolled-2FA
 * guard that `adminRouter` applies.
 */
import { Router } from 'express';
import { z } from 'zod';
import { AuditModule, CoinLotState, CoinReason, CoinSourceType } from '@prisma/client';
import { asyncHandler } from '@/middleware/asyncHandler';
import { validate } from '@/middleware/validate';
import { requirePermission } from '@/middleware/auth';
import { prisma } from '@/lib/prisma';
import { AppError, ErrorCode } from '@/lib/errors';
import { writeAudit, auditContext } from '@/modules/audit/audit.service';
import * as ledger from './ledger.service';
import * as accountService from './account.service';
import * as rulesService from './rules.service';
import * as reconcile from './reconcile.service';
import * as fraudService from './fraud.service';

export const loyaltyAdminRouter = Router();

/**
 * GET /admin/loyalty/customers — the balance column and its filters (§9.4).
 *
 * "The main customer list in the CMS gains an Outstanding Coin Balance column,
 * sortable and filterable. Also filterable by 'has pending coins', 'expiring in
 * 30 days' and 'negative balance', so campaigns and exceptions can be pulled
 * without an export."
 */
loyaltyAdminRouter.get(
  '/customers',
  requirePermission('loyalty.view'),
  validate({
    query: z.object({
      filter: z.enum(['all', 'pending', 'expiring', 'negative', 'flagged']).default('all'),
      sort: z.enum(['balance', 'recent']).default('balance'),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { filter, sort, limit, offset } = req.query as unknown as {
      filter: string;
      sort: string;
      limit: number;
      offset: number;
    };

    const soon = new Date();
    soon.setDate(soon.getDate() + 30);

    const where =
      filter === 'pending'
        ? { pendingCoins: { gt: 0 } }
        : filter === 'negative'
          ? { availableCoins: { lt: 0 } }
          : filter === 'flagged'
            ? { flaggedDeficit: { gt: 0 } }
            : filter === 'expiring'
              ? {
                  lots: {
                    some: {
                      state: CoinLotState.AVAILABLE,
                      coinsRemaining: { gt: 0 },
                      expiresAt: { gt: new Date(), lte: soon },
                    },
                  },
                }
              : {};

    const [rows, total] = await Promise.all([
      prisma.loyaltyAccount.findMany({
        where,
        orderBy: sort === 'balance' ? { availableCoins: 'desc' } : { updatedAt: 'desc' },
        take: limit,
        skip: offset,
        select: {
          id: true,
          availableCoins: true,
          pendingCoins: true,
          lockedCoins: true,
          lifetimeEarned: true,
          lifetimeRedeemed: true,
          flaggedDeficit: true,
          status: true,
          holdout: true,
          customer: {
            select: { id: true, firstName: true, lastName: true, email: true, phone: true },
          },
        },
      }),
      prisma.loyaltyAccount.count({ where }),
    ]);

    res.json({ data: { rows, total } });
  }),
);

/**
 * GET /admin/loyalty/customers/:customerId — the support panel (§9.4).
 *
 * "This is the screen support uses to answer 'why is my balance this number?' —
 * the 60-second test." Everything needed to answer that question is on this one
 * response: balances, every lot with its dates, and the full ledger with
 * plain-language reasons.
 */
loyaltyAdminRouter.get(
  '/customers/:customerId',
  requirePermission('loyalty.view'),
  asyncHandler(async (req, res) => {
    const account = await prisma.loyaltyAccount.findUnique({
      where: { customerId: req.params.customerId! },
      include: {
        customer: {
          select: { id: true, firstName: true, lastName: true, email: true, phone: true },
        },
        lots: {
          orderBy: { earnedAt: 'desc' },
          take: 100,
          select: {
            id: true,
            coinsGranted: true,
            coinsRemaining: true,
            state: true,
            sourceType: true,
            orderId: true,
            earnedAt: true,
            maturesAt: true,
            expiresAt: true,
            parentLotId: true,
            claimedAt: true,
          },
        },
      },
    });

    if (!account) {
      res.json({ data: null });
      return;
    }

    const entries = await prisma.coinLedger.findMany({
      where: { accountId: account.id },
      orderBy: { id: 'desc' },
      take: 200,
    });

    // The ledger holds plain ids (no FK, so history outlives its order), which
    // means order numbers are resolved by lookup rather than join.
    const orderIds = [...new Set(entries.map((e) => e.orderId).filter(Boolean))] as string[];
    const orders = orderIds.length
      ? await prisma.order.findMany({
          where: { id: { in: orderIds } },
          select: { id: true, orderNo: true },
        })
      : [];
    const orderNoById = new Map(orders.map((o) => [o.id, o.orderNo]));

    res.json({
      data: {
        ...account,
        ledger: entries.map((e) => ({
          ...e,
          id: e.id.toString(),
          orderNo: e.orderId ? (orderNoById.get(e.orderId) ?? null) : null,
        })),
      },
    });
  }),
);

/**
 * POST /admin/loyalty/customers/:customerId/adjust — manual credit/debit (§9.2).
 *
 * "Manual adjustments require a reason code, a free-text note and the admin user
 * ID. Above 500 coins, second-person approval."
 *
 * The approval threshold is read from the rule version rather than hardcoded, so
 * §2.3's "every one is a configuration change, not a code change" holds here too.
 */
loyaltyAdminRouter.post(
  '/customers/:customerId/adjust',
  requirePermission('loyalty.adjust'),
  validate({
    body: z.object({
      coins: z.number().int().refine((n) => n !== 0, 'Adjustment cannot be zero.'),
      // Mandatory — §9.2. Not optional, not defaulted.
      note: z.string().trim().min(3).max(500),
      reason: z.enum(['GOODWILL', 'ADJUSTMENT']).default('ADJUSTMENT'),
      /** Second admin's id, required above the threshold. */
      approvedById: z.string().uuid().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { coins, note, reason, approvedById } = req.body as {
      coins: number;
      note: string;
      reason: 'GOODWILL' | 'ADJUSTMENT';
      approvedById?: string;
    };
    const actorId = req.user!.id;
    const rv = await rulesService.active();

    if (Math.abs(coins) > rv.approvalThresholdCoins && !approvedById) {
      throw new AppError(
        400,
        ErrorCode.VALIDATION_FAILED,
        `Adjustments above ${rv.approvalThresholdCoins} coins need a second approver.`,
        { fields: { approvedById: 'Second-person approval is required for this amount.' } },
      );
    }
    if (approvedById && approvedById === actorId) {
      // "Second-person" means a different person, or the control is theatre.
      throw new AppError(
        400,
        ErrorCode.VALIDATION_FAILED,
        'The approver must be a different admin.',
        { fields: { approvedById: 'You cannot approve your own adjustment.' } },
      );
    }

    const result = await prisma.$transaction(async (tx) => {
      const account = await accountService.ensureAccount(tx, req.params.customerId!);
      await ledger.lockAccount(tx, account.id);

      if (coins > 0) {
        // A credit is a NEW lot, never a resurrection of an expired one (§4.3).
        const { lot } = await accountService.grantLot(tx, {
          accountId: account.id,
          coins,
          ruleVersion: rv,
          sourceType: CoinSourceType.MANUAL,
          reason: reason === 'GOODWILL' ? CoinReason.GOODWILL : CoinReason.ADJUSTMENT,
          idempotencyKey: `adjust:${account.id}:${Date.now()}:${actorId}`,
          note,
          actorId,
          approvedById: approvedById ?? null,
        });
        return { lotId: lot?.id ?? null, coins };
      }

      // A debit floors at −50 like any other, with the excess flagged (§6.7).
      await ledger.postFlooredDebit(
        tx,
        {
          accountId: account.id,
          coinsDelta: coins,
          reason: CoinReason.ADJUSTMENT,
          idempotencyKey: `adjust:${account.id}:${Date.now()}:${actorId}`,
          note,
          actorId,
          approvedById: approvedById ?? null,
        },
        rv.maxNegativeBalance,
        { coinValuePaise: rv.coinValuePaise },
      );
      return { lotId: null, coins };
    });

    await writeAudit(auditContext(req), {
      module: AuditModule.CUSTOMERS,
      action: `Z-Coin adjustment ${coins > 0 ? '+' : ''}${coins} — ${note}`,
      recordId: req.params.customerId!,
    });

    res.json({ data: result });
  }),
);

/**
 * POST /admin/loyalty/customers/:customerId/freeze — fraud hold (§8.4 #30).
 *
 * Earn and redeem disabled, balance preserved, expiry clocks paused so our
 * review time cannot cost a wrongly-flagged customer value.
 */
loyaltyAdminRouter.post(
  '/customers/:customerId/freeze',
  requirePermission('loyalty.adjust'),
  validate({ body: z.object({ reason: z.string().trim().min(3).max(300) }) }),
  asyncHandler(async (req, res) => {
    const { reason } = req.body as { reason: string };
    const account = await prisma.loyaltyAccount.findUnique({
      where: { customerId: req.params.customerId! },
      select: { id: true },
    });
    if (!account) throw new AppError(404, ErrorCode.NOT_FOUND, 'No loyalty account.');

    await prisma.$transaction((tx) => accountService.freeze(tx, account.id, reason));
    await writeAudit(auditContext(req), {
      module: AuditModule.CUSTOMERS,
      action: `Z-Coin account frozen — ${reason}`,
      recordId: req.params.customerId!,
    });

    res.json({ data: { frozen: true } });
  }),
);

/**
 * GET /admin/loyalty/liability — the finance dashboard (§9.4, §11.3).
 *
 * "Live outstanding liability, daily movement, ageing by expiry bucket, and the
 * exception list." Liability is the face value of coins that have UNLOCKED and
 * not yet been spent — §11.1 recognises the liability at unlock, not issuance,
 * because pending coins are contingent on the order becoming final.
 */
loyaltyAdminRouter.get(
  '/liability',
  requirePermission('loyalty.view'),
  asyncHandler(async (_req, res) => {
    const rv = await rulesService.active();
    const now = new Date();
    const buckets = [30, 60, 90, 180, 365];

    const [available, pending, exceptions] = await Promise.all([
      prisma.coinLot.aggregate({
        where: { state: CoinLotState.AVAILABLE, coinsRemaining: { gt: 0 } },
        _sum: { coinsRemaining: true },
      }),
      prisma.coinLot.aggregate({
        where: { state: CoinLotState.PENDING },
        _sum: { coinsRemaining: true },
      }),
      prisma.loyaltyAccount.findMany({
        where: { OR: [{ flaggedDeficit: { gt: 0 } }, { availableCoins: { lt: 0 } }, { mismatchStreak: { gte: 1 } }] },
        select: {
          id: true,
          availableCoins: true,
          flaggedDeficit: true,
          mismatchStreak: true,
          status: true,
          customer: { select: { id: true, email: true, firstName: true, lastName: true } },
        },
        take: 200,
      }),
    ]);

    // Ageing by expiry bucket — how much of the liability falls due when.
    const ageing: { withinDays: number; coins: number }[] = [];
    let previous = now;
    for (const days of buckets) {
      const until = new Date(now);
      until.setDate(until.getDate() + days);
      const agg = await prisma.coinLot.aggregate({
        where: {
          state: CoinLotState.AVAILABLE,
          coinsRemaining: { gt: 0 },
          expiresAt: { gt: previous, lte: until },
        },
        _sum: { coinsRemaining: true },
      });
      ageing.push({ withinDays: days, coins: agg._sum.coinsRemaining ?? 0 });
      previous = until;
    }

    const availableCoins = available._sum.coinsRemaining ?? 0;
    res.json({
      data: {
        // The liability that belongs on the balance sheet (§11.1).
        outstandingCoins: availableCoins,
        outstandingLiabilityPaise: availableCoins * rv.coinValuePaise,
        // Contingent, reported separately — no accounting entry yet (§11.1).
        pendingCoins: pending._sum.coinsRemaining ?? 0,
        ageing,
        exceptions,
      },
    });
  }),
);

/**
 * GET /admin/loyalty/export — the finance CSV (§9.4).
 *
 * "A totals row gives the outstanding liability directly, so finance can
 * reconcile without asking engineering."
 */
loyaltyAdminRouter.get(
  '/export',
  requirePermission('loyalty.view'),
  asyncHandler(async (_req, res) => {
    const accounts = await prisma.loyaltyAccount.findMany({
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
        lots: {
          where: { state: CoinLotState.AVAILABLE, coinsRemaining: { gt: 0 } },
          orderBy: { expiresAt: 'asc' },
          take: 1,
          select: { expiresAt: true },
        },
      },
      take: 10_000,
    });

    const header = [
      'Customer ID', 'Name', 'Email', 'Phone',
      'Lifetime earned', 'Lifetime redeemed', 'Lifetime expired',
      'Available', 'Pending', 'Oldest expiry', 'Flagged deficit', 'Status',
    ];

    const escape = (v: unknown) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const rows = accounts.map((a) =>
      [
        a.customer.id,
        `${a.customer.firstName} ${a.customer.lastName}`.trim(),
        a.customer.email,
        a.customer.phone ?? '',
        a.lifetimeEarned,
        a.lifetimeRedeemed,
        a.lifetimeExpired,
        a.availableCoins,
        a.pendingCoins,
        a.lots[0]?.expiresAt.toISOString().slice(0, 10) ?? '',
        a.flaggedDeficit,
        a.status,
      ].map(escape).join(','),
    );

    // The totals row finance reconciles against.
    const totals = [
      'TOTAL', '', '', '',
      accounts.reduce((s, a) => s + a.lifetimeEarned, 0),
      accounts.reduce((s, a) => s + a.lifetimeRedeemed, 0),
      accounts.reduce((s, a) => s + a.lifetimeExpired, 0),
      accounts.reduce((s, a) => s + a.availableCoins, 0),
      accounts.reduce((s, a) => s + a.pendingCoins, 0),
      '',
      accounts.reduce((s, a) => s + a.flaggedDeficit, 0),
      '',
    ].map(escape).join(',');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="zewa-coins.csv"');
    res.send([header.join(','), ...rows, totals].join('\n'));
  }),
);

/**
 * Per-customer monthly earning-cap overrides — ZSOP004 §3.3.
 *
 * Deliberately generic. The exception needing a higher cap today is a wholesale
 * buyer; the next will be a corporate account or a goodwill case. Encoding the
 * REASON as text and the EFFECT as a number keeps one mechanism for all of them.
 *
 * `loyalty.adjust` rather than `loyalty.view`: raising a customer's cap raises
 * what the programme will pay out, which is the same class of decision as moving
 * coins directly.
 */
loyaltyAdminRouter.get(
  '/customers/:customerId/earn-cap',
  requirePermission('loyalty.view'),
  asyncHandler(async (req, res) => {
    const rv = await rulesService.active();
    const overrides = await prisma.customerEarnCapOverride.findMany({
      where: { customerId: req.params.customerId! },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { createdBy: { select: { id: true, name: true, email: true } } },
    });

    const now = new Date();
    const live = overrides.find(
      (o) => !o.revokedAt && (!o.expiresAt || o.expiresAt > now),
    );

    res.json({
      data: {
        defaultCapCoins: rv.monthlyEarnCapCoins,
        effectiveCapCoins: live?.monthlyCapCoins ?? rv.monthlyEarnCapCoins,
        // The full history, not just the live row: "what was this customer
        // allowed, and when" is the audit question.
        overrides,
      },
    });
  }),
);

loyaltyAdminRouter.post(
  '/customers/:customerId/earn-cap',
  requirePermission('loyalty.adjust'),
  validate({
    body: z.object({
      monthlyCapCoins: z.number().int().min(0).max(1_000_000),
      // Mandatory — an override with no stated reason is unauditable, and these
      // are granted in ones and twos by people who will not remember why.
      reason: z.string().trim().min(3).max(500),
      expiresAt: z.coerce.date().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { monthlyCapCoins, reason, expiresAt } = req.body as {
      monthlyCapCoins: number;
      reason: string;
      expiresAt?: Date;
    };
    const customerId = req.params.customerId!;

    const created = await prisma.$transaction(async (tx) => {
      // Supersede any live override rather than leaving two active: the newest
      // wins at read time anyway, and revoking makes that explicit in history.
      await tx.customerEarnCapOverride.updateMany({
        where: { customerId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return tx.customerEarnCapOverride.create({
        data: {
          customerId,
          monthlyCapCoins,
          reason,
          expiresAt: expiresAt ?? null,
          createdById: req.user!.id,
        },
      });
    });

    await writeAudit(auditContext(req), {
      module: AuditModule.CUSTOMERS,
      action:
        `Z-Coin monthly earning cap set to ${monthlyCapCoins}` +
        (expiresAt ? ` until ${expiresAt.toISOString().slice(0, 10)}` : '') +
        ` — ${reason}`,
      recordId: customerId,
    });

    res.status(201).json({ data: created });
  }),
);

loyaltyAdminRouter.delete(
  '/customers/:customerId/earn-cap',
  requirePermission('loyalty.adjust'),
  asyncHandler(async (req, res) => {
    const customerId = req.params.customerId!;
    // Revoked, never deleted — the history of what was allowed is the audit.
    const { count } = await prisma.customerEarnCapOverride.updateMany({
      where: { customerId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    if (count > 0) {
      await writeAudit(auditContext(req), {
        module: AuditModule.CUSTOMERS,
        action: 'Z-Coin monthly earning cap override removed — back to the default',
        recordId: customerId,
      });
    }

    res.json({ data: { revoked: count } });
  }),
);

/**
 * GET /admin/loyalty/risk — the fraud and risk view (§12.1 monitoring).
 *
 * "Daily issuance and redemption against the trailing 7-day average, plus counts
 * of negative balances and flagged deficits; weekly review of high-return
 * accounts holding balances."
 *
 * Also reports `largeRedemptionsUnverified` — redemptions that WOULD have needed
 * OTP re-verification. Zewa has no SMS provider, so that control cannot run; the
 * count makes the exposure a number someone can look at rather than an absence
 * nobody notices.
 */
loyaltyAdminRouter.get(
  '/risk',
  requirePermission('loyalty.view'),
  asyncHandler(async (_req, res) => {
    const [risk, volume] = await Promise.all([
      fraudService.riskReport(),
      fraudService.dailyVolumeCheck(),
    ]);
    res.json({ data: { ...risk, volume } });
  }),
);

/**
 * GET/PUT /admin/loyalty/rules — versioned configuration (§8.4 #35, §9.3).
 *
 * A change writes a NEW version and flips `isActive`; it never edits the row
 * historical orders point at. The partial unique index in the migration
 * guarantees exactly one active version even under concurrent saves.
 */
loyaltyAdminRouter.get(
  '/rules',
  requirePermission('loyalty.view'),
  asyncHandler(async (_req, res) => {
    const versions = await prisma.loyaltyRuleVersion.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json({ data: versions });
  }),
);

loyaltyAdminRouter.put(
  '/rules',
  requirePermission('loyalty.config'),
  validate({
    body: z.object({
      label: z.string().trim().min(1).max(40),
      earningEnabled: z.boolean().optional(),
      redemptionEnabled: z.boolean().optional(),
      rolloutPct: z.number().int().min(0).max(100).optional(),
      expiryDays: z.number().int().min(1).max(3650).optional(),
      minRedemptionCoins: z.number().int().min(1).optional(),
      maxRedemptionPct: z.number().int().min(1).max(100).optional(),
      earnGranularityPaise: z.number().int().min(1).optional(),
      coinsPerStep: z.number().int().min(1).optional(),
      coinValuePaise: z.number().int().min(1).optional(),
      returnWindowDays: z.number().int().min(0).optional(),
      largeOrderThresholdPaise: z.number().int().min(0).optional(),
      largeOrderHoldDays: z.number().int().min(0).optional(),
      /** Monthly earning cap in coins; 0 disables the cap entirely (§3.3). */
      monthlyEarnCapCoins: z.number().int().min(0).max(1_000_000).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const body = req.body as Record<string, unknown> & { label: string };

    const created = await prisma.$transaction(async (tx) => {
      const current = await tx.loyaltyRuleVersion.findFirstOrThrow({ where: { isActive: true } });
      // Deactivate first: the partial unique index permits only one active row,
      // so the flip has to happen in this order inside one transaction.
      await tx.loyaltyRuleVersion.update({
        where: { id: current.id },
        data: { isActive: false },
      });

      const { id: _id, createdAt: _c, label: _l, isActive: _a, createdById: _cb, ...inherited } = current;
      return tx.loyaltyRuleVersion.create({
        data: {
          ...inherited,
          ...body,
          isActive: true,
          createdById: req.user!.id,
        },
      });
    });

    // §9.3: a kill switch must take effect without a deployment.
    rulesService.invalidate();

    await writeAudit(auditContext(req), {
      module: AuditModule.SETTINGS,
      action: `Z-Coin rules updated — new version ${created.label}`,
      recordId: created.id,
    });

    res.json({ data: created });
  }),
);

/**
 * POST /admin/loyalty/reconcile — run the nightly job on demand (§9.2).
 *
 * Useful when investigating a specific complaint rather than waiting for the
 * scheduled sweep.
 */
loyaltyAdminRouter.post(
  '/reconcile',
  requirePermission('loyalty.adjust'),
  asyncHandler(async (_req, res) => {
    const report = await reconcile.reconcileAll();
    res.json({ data: report });
  }),
);
