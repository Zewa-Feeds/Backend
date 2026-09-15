/**
 * Loyalty accounts and coin lots — ZSOP004 §4.2, §4.3, §9.
 *
 * Lots are the unit that makes the programme auditable. A single aggregate
 * balance would be simpler and would make FIFO expiry, per-lot restoration and
 * "why is my balance this number?" all unanswerable — §4.2 is explicit that lot
 * granularity "is what makes correct restoration possible on a later return".
 *
 * Everything that changes a balance here routes through `ledger.post()`.
 */
import { CoinLotState, CoinReason, LoyaltyAccountStatus } from '@prisma/client';
import type { LoyaltyAccount, CoinLot, LoyaltyRuleVersion , CoinSourceType} from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AppError, ErrorCode } from '@/lib/errors';
import { logger } from '@/lib/logger';
import * as ledger from './ledger.service';
import type { Tx } from './ledger.service';
import * as rules from './rules.service';

const log = logger.child({ module: 'loyalty.account' });

/**
 * Find or create the loyalty account for a customer (§9).
 *
 * Idempotent by construction: the unique index on `customerId` means two
 * concurrent creates resolve to one row, and the upsert swallows the race rather
 * than surfacing a 500 to a customer whose only crime was double-clicking.
 *
 * The holdout bucket is assigned at creation and never recomputed, so a
 * customer cannot drift in or out of the control group (§13.5).
 */
export async function ensureAccount(
  tx: Tx,
  customerId: string,
  phone?: string | null,
): Promise<LoyaltyAccount> {
  const existing = await tx.loyaltyAccount.findUnique({ where: { customerId } });
  if (existing) return existing;

  return tx.loyaltyAccount.upsert({
    where: { customerId },
    update: {},
    create: {
      customerId,
      phone: phone ?? null,
      holdout: rules.isHoldout(customerId),
    },
  });
}

/**
 * Create a coin lot and post the matching ledger row.
 *
 * Every grant in the system comes through here — earning, backfill, guest claim,
 * goodwill, merge. One path means one place where expiry, rule version and
 * ledger consistency are decided.
 *
 * `expiresAt` runs from the EARN date, not the unlock date (§4.3): "so the clock
 * is predictable from the order date and does not shift with delivery delays".
 */
export async function grantLot(
  tx: Tx,
  input: {
    accountId: string;
    coins: number;
    ruleVersion: LoyaltyRuleVersion;
    sourceType: CoinSourceType;
    reason: CoinReason;
    idempotencyKey: string;
    orderId?: string | null;
    /** Null until delivery is known; the unlock job fills it in. */
    maturesAt?: Date | null;
    /** Overrides the standard expiry — the backfill uses 90 days (§13.3). */
    expiryDays?: number;
    /** Grace lots reference the lot whose value they carry (§7.6). */
    parentLotId?: string | null;
    /** Backfill lots are held until the mobile is verified (§13.3). */
    heldUntilClaimed?: boolean;
    note?: string | null;
    actorId?: string | null;
    approvedById?: string | null;
    earnedAt?: Date;
  },
): Promise<{ lot: CoinLot | null; duplicate: boolean }> {
  if (input.coins <= 0) return { lot: null, duplicate: false };

  // Idempotency is checked on the LEDGER key, not the lot, because the ledger is
  // the record of truth. A repeat post finds the key and returns early, so the
  // lot below is never created twice.
  const already = await tx.coinLedger.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { lotId: true },
  });
  if (already) {
    const lot = already.lotId
      ? await tx.coinLot.findUnique({ where: { id: already.lotId } })
      : null;
    return { lot, duplicate: true };
  }

  const earnedAt = input.earnedAt ?? new Date();
  const expiresAt = new Date(earnedAt);
  expiresAt.setDate(expiresAt.getDate() + (input.expiryDays ?? input.ruleVersion.expiryDays));

  const lot = await tx.coinLot.create({
    data: {
      accountId: input.accountId,
      coinsGranted: input.coins,
      coinsRemaining: input.coins,
      // A lot with no maturity date is PENDING until the unlock job sets one.
      // Backfill and goodwill lots land AVAILABLE immediately.
      state: input.maturesAt === undefined ? CoinLotState.AVAILABLE : CoinLotState.PENDING,
      sourceType: input.sourceType,
      orderId: input.orderId ?? null,
      earnedAt,
      maturesAt: input.maturesAt ?? null,
      expiresAt,
      parentLotId: input.parentLotId ?? null,
      ruleVersionId: input.ruleVersion.id,
      claimedAt: input.heldUntilClaimed ? null : new Date(),
    },
  });

  const isPending = lot.state === CoinLotState.PENDING;

  await ledger.post(
    tx,
    {
      accountId: input.accountId,
      coinsDelta: input.coins,
      // A pending grant moves the pending counter; anything landing available
      // moves the spendable balance. `post` keys that off the reason, so EARN is
      // used for pending grants and the caller's reason otherwise.
      reason: isPending ? CoinReason.EARN : input.reason,
      idempotencyKey: input.idempotencyKey,
      lotId: lot.id,
      orderId: input.orderId ?? null,
      note: input.note ?? null,
      actorId: input.actorId ?? null,
      approvedById: input.approvedById ?? null,
    },
    { coinValuePaise: input.ruleVersion.coinValuePaise },
  );

  return { lot, duplicate: false };
}

/**
 * Spendable lots for an account, nearest expiry first (§4.2).
 *
 * "Redemption consumes the lot closest to expiry first — this maximises the
 * value the customer captures at marginal cost to us."
 *
 * Ordered by `expiresAt` then `earnedAt` so the ordering is total and stable: two
 * lots sharing an expiry date consume oldest-earned first, which keeps the
 * result deterministic across runs and therefore testable.
 */
export async function spendableLots(tx: Tx, accountId: string, now = new Date()) {
  return tx.coinLot.findMany({
    where: {
      accountId,
      state: CoinLotState.AVAILABLE,
      coinsRemaining: { gt: 0 },
      expiresAt: { gt: now },
      claimedAt: { not: null }, // backfill lots held pending OTP are not spendable
    },
    orderBy: [{ expiresAt: 'asc' }, { earnedAt: 'asc' }],
  });
}

/**
 * Consume `coins` from an account's lots, FIFO by nearest expiry (§4.2).
 *
 * Returns the lot map that the order persists — `[{ lotId, coins }]` — which is
 * what makes a later restoration able to put coins back into the lots they came
 * from, with their original expiry dates.
 *
 * Does NOT write the ledger: the caller decides whether this is a reservation
 * (no ledger movement yet) or a confirmed redemption. Keeping the lot walk pure
 * of ledger semantics is what lets reservation and confirmation share it.
 */
export function planConsumption(
  lots: Pick<CoinLot, 'id' | 'coinsRemaining'>[],
  coins: number,
): { lotId: string; coins: number }[] {
  const plan: { lotId: string; coins: number }[] = [];
  let left = coins;

  for (const lot of lots) {
    if (left <= 0) break;
    const take = Math.min(lot.coinsRemaining, left);
    if (take <= 0) continue;
    plan.push({ lotId: lot.id, coins: take });
    left -= take;
  }

  if (left > 0) {
    // The caller validated the balance before getting here, so this means the
    // cached balance disagreed with the lots — exactly what reconciliation
    // exists to catch. Fail rather than hand out coins that do not exist.
    throw new AppError(
      409,
      ErrorCode.CONFLICT,
      'Your coin balance has changed. Please refresh and try again.',
    );
  }

  return plan;
}

/** Apply a consumption plan to the lots, decrementing remainders. */
export async function applyConsumption(
  tx: Tx,
  plan: { lotId: string; coins: number }[],
): Promise<void> {
  for (const step of plan) {
    const lot = await tx.coinLot.findUniqueOrThrow({ where: { id: step.lotId } });
    const remaining = lot.coinsRemaining - step.coins;
    await tx.coinLot.update({
      where: { id: step.lotId },
      data: {
        coinsRemaining: remaining,
        // A fully consumed lot is REDEEMED; a partly consumed one stays
        // AVAILABLE so the remainder keeps its original expiry.
        state: remaining === 0 ? CoinLotState.REDEEMED : lot.state,
      },
    });
  }
}

/**
 * The customer-facing balance summary (§10.1).
 *
 * Pending is returned SEPARATELY and never summed into the headline — §10.1:
 * "Show pending coins separately with the unlock date. Never add them to the
 * headline number."
 *
 * A negative available balance is reported as 0 with a flag, because §6.7
 * requires the widget be hidden rather than show a negative figure, "which reads
 * as a bug".
 */
export async function summary(customerId: string) {
  const account = await prisma.loyaltyAccount.findUnique({
    where: { customerId },
    select: {
      id: true,
      availableCoins: true,
      pendingCoins: true,
      lockedCoins: true,
      status: true,
      holdout: true,
      redeemEnabled: true,
      earnEnabled: true,
      flaggedDeficit: true,
    },
  });

  if (!account) {
    return {
      available: 0,
      pending: 0,
      negative: false,
      holdout: false,
      canRedeem: false,
      expiringSoon: [] as { coins: number; expiresAt: Date }[],
      nextUnlockAt: null as Date | null,
    };
  }

  const negative = account.availableCoins < 0;
  const now = new Date();
  const soon = new Date(now);
  soon.setDate(soon.getDate() + 30);

  const [expiring, nextPending] = await Promise.all([
    prisma.coinLot.findMany({
      where: {
        accountId: account.id,
        state: CoinLotState.AVAILABLE,
        coinsRemaining: { gt: 0 },
        expiresAt: { gt: now, lte: soon },
      },
      orderBy: { expiresAt: 'asc' },
      select: { coinsRemaining: true, expiresAt: true },
    }),
    prisma.coinLot.findFirst({
      where: { accountId: account.id, state: CoinLotState.PENDING },
      orderBy: { maturesAt: 'asc' },
      select: { maturesAt: true },
    }),
  ]);

  return {
    available: negative ? 0 : account.availableCoins,
    pending: account.pendingCoins,
    negative,
    holdout: account.holdout,
    canRedeem:
      !negative &&
      !account.holdout &&
      account.redeemEnabled &&
      account.status === LoyaltyAccountStatus.ACTIVE,
    expiringSoon: expiring.map((l) => ({ coins: l.coinsRemaining, expiresAt: l.expiresAt })),
    nextUnlockAt: nextPending?.maturesAt ?? null,
  };
}

/**
 * Can this account earn right now? (§3.3)
 *
 * Every gate from §3.3 that is knowable from account state. Order-level gates
 * (minimum base, eligible SKUs) live in the earning engine.
 */
export function canEarn(account: LoyaltyAccount): boolean {
  return (
    account.status === LoyaltyAccountStatus.ACTIVE && account.earnEnabled && !account.holdout
  );
}

/** Can this account redeem right now? (§4, §6.7) */
export function canRedeem(account: LoyaltyAccount): boolean {
  return (
    account.status === LoyaltyAccountStatus.ACTIVE &&
    account.redeemEnabled &&
    !account.holdout &&
    account.availableCoins >= 0 && // §6.7: redemption blocked while negative
    account.mismatchStreak < 2 // §9.2: two consecutive mismatches block redemption
  );
}

/**
 * Freeze an account for review (§8.4 #30, §12.1).
 *
 * "Earn and redeem disabled, balance preserved. Expiry clocks pause so a
 * wrongly-flagged customer isn't penalised by our review time."
 *
 * The pause is implemented by the expiry job skipping frozen accounts rather
 * than by rewriting `expiresAt` — moving the dates would make the original
 * expiry unrecoverable if the flag turns out to be wrong.
 */
export async function freeze(tx: Tx, accountId: string, reason: string): Promise<void> {
  await tx.loyaltyAccount.update({
    where: { id: accountId },
    data: {
      status: LoyaltyAccountStatus.FROZEN,
      earnEnabled: false,
      redeemEnabled: false,
      version: { increment: 1 },
    },
  });
  log.warn({ accountId, reason }, 'loyalty account frozen');
}
