/**
 * Monthly earning cap, overrides and internal-user exclusion — ZSOP004 §3.3.
 *
 * §3.3 lists "monthly earn cap not exceeded" and "internal / test / staff
 * accounts excluded" among the earning gates. Both govern ISSUANCE only: neither
 * may touch the redemption engine, and neither may alter coins already earned —
 * a cap lowered today cannot claw back what last month granted.
 *
 * The cap TRUNCATES rather than refuses. A customer 10 coins below their cap
 * earns those 10; refusing the whole grant would make the cap a cliff that
 * punishes whichever order happens to cross it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  PrismaClient,
  CoinReason,
  CoinSourceType,
  CoinLotState,
  Role,
} from '@prisma/client';
import * as earnCap from './earn-cap.service';
import * as account from './account.service';
import * as ledger from './ledger.service';
import * as rules from './rules.service';

const prisma = new PrismaClient();
const TAG = 'zzcap';
let ruleVersion: Awaited<ReturnType<typeof rules.active>>;

async function sweep() {
  const customers = await prisma.customer.findMany({
    where: { email: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = customers.map((c) => c.id);
  if (ids.length) {
    const accounts = await prisma.loyaltyAccount.findMany({
      where: { customerId: { in: ids } },
      select: { id: true },
    });
    const accIds = accounts.map((a) => a.id);
    await prisma.customerEarnCapOverride.deleteMany({ where: { customerId: { in: ids } } });
    if (accIds.length) {
      await prisma.$executeRawUnsafe('ALTER TABLE "CoinLedger" DISABLE TRIGGER coin_ledger_no_delete');
      await prisma.coinLedger.deleteMany({ where: { accountId: { in: accIds } } });
      await prisma.$executeRawUnsafe('ALTER TABLE "CoinLedger" ENABLE TRIGGER coin_ledger_no_delete');
      await prisma.coinLot.deleteMany({ where: { accountId: { in: accIds } } });
      await prisma.loyaltyAccount.deleteMany({ where: { id: { in: accIds } } });
    }
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
  }
  /*
   * Staff fixtures must go, or a stale CmsUser row makes a later test's customer
   * "internal" and the isInternalUser tests start failing for no visible reason.
   *
   * Their AuditLog rows are deleted first: `AuditLog.actorId` references CmsUser,
   * and the audit log carries a DO INSTEAD NOTHING rule, so Postgres's
   * referential-integrity check on the cascade returns an unexpected result and
   * the delete fails with XX000 rather than a normal FK error. Clearing the
   * referencing rows sidesteps it without touching the audit log's guard.
   */
  const staff = await prisma.cmsUser.findMany({
    where: { email: { startsWith: TAG } },
    select: { id: true },
  });
  if (staff.length) {
    const staffIds = staff.map((u) => u.id);
    /*
     * BOTH rules, and the UPDATE one is the important half.
     *
     * `AuditLog.actorId` is `onDelete: SetNull`, so deleting a CmsUser makes
     * Postgres issue an UPDATE against AuditLog — which `audit_log_no_update`
     * rewrites to nothing, and the FK integrity check then reports
     * "gave unexpected result" (XX000). Disabling only the DELETE rule changes
     * nothing, which is exactly what the first attempt here did.
     *
     * Scoped to this sweep and restored in `finally`; the guard is never left
     * down. This is a pre-existing quirk of the audit log, not of Z-Coin — see
     * the note in README.md.
     */
    await prisma.$executeRawUnsafe('ALTER TABLE "AuditLog" DISABLE RULE audit_log_no_delete');
    await prisma.$executeRawUnsafe('ALTER TABLE "AuditLog" DISABLE RULE audit_log_no_update');
    try {
      await prisma.cmsUser.deleteMany({ where: { id: { in: staffIds } } });
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "AuditLog" ENABLE RULE audit_log_no_update');
      await prisma.$executeRawUnsafe('ALTER TABLE "AuditLog" ENABLE RULE audit_log_no_delete');
    }
  }
}

async function seed(label: string) {
  const email = `${TAG}-${label}-${Date.now()}${Math.random().toString(36).slice(2, 5)}@zewafeeds.test`;
  const customer = await prisma.customer.create({
    data: { email, firstName: 'Cap', lastName: 'Test' },
    select: { id: true, email: true },
  });
  const acc = await prisma.$transaction((tx) => account.ensureAccount(tx, customer.id));
  // ~5% of random ids land in the §13.5 holdout and earn nothing.
  await prisma.loyaltyAccount.update({
    where: { id: acc.id },
    data: { holdout: false },
  });
  return { customerId: customer.id, accountId: acc.id, email: customer.email };
}

/** Record `coins` as EARNED at a given moment, the way a real grant would. */
async function recordEarning(accountId: string, coins: number, at = new Date()) {
  const expiresAt = new Date(at);
  expiresAt.setDate(expiresAt.getDate() + 365);
  const lot = await prisma.coinLot.create({
    data: {
      accountId,
      coinsGranted: coins,
      coinsRemaining: coins,
      state: CoinLotState.PENDING,
      sourceType: CoinSourceType.ORDER,
      earnedAt: at,
      expiresAt,
      ruleVersionId: ruleVersion.id,
      claimedAt: at,
    },
    select: { id: true },
  });
  await prisma.coinLedger.create({
    data: {
      accountId,
      coinsDelta: coins,
      balanceAfter: 0,
      monetaryValuePaise: coins * 100,
      reason: CoinReason.EARN,
      lotId: lot.id,
      idempotencyKey: `${TAG}-earn-${lot.id}`,
      createdAt: at,
    },
  });
  await prisma.loyaltyAccount.update({
    where: { id: accountId },
    data: { pendingCoins: { increment: coins } },
  });
}

beforeAll(async () => {
  await sweep();
  ruleVersion = await rules.active(prisma);
});

beforeEach(() => {
  rules.invalidate();
});

afterAll(async () => {
  await sweep();
  await prisma.$disconnect();
});

describe('§3.3 The default monthly cap', () => {
  it('defaults to 1,000 coins and is configurable, not hardcoded', async () => {
    // The VALUE lives on the rule version so the CMS can change it without a
    // deployment. The test asserts the default and the mechanism, not a
    // constant buried in business logic.
    expect(ruleVersion.monthlyEarnCapCoins).toBe(1000);
  });

  it('grants in full when the customer is well under the cap', async () => {
    const { accountId, customerId } = await seed('under');
    const decision = await prisma.$transaction((tx) =>
      earnCap.capGrant(tx, {
        accountId,
        customerId,
        proposedCoins: 40,
        defaultCapCoins: 1000,
      }),
    );
    expect(decision.granted).toBe(40);
    expect(decision.capped).toBe(false);
  });

  it('TRUNCATES rather than refusing when a grant crosses the cap', async () => {
    const { accountId, customerId } = await seed('cross');
    await recordEarning(accountId, 990);

    const decision = await prisma.$transaction((tx) =>
      earnCap.capGrant(tx, {
        accountId,
        customerId,
        proposedCoins: 40,
        defaultCapCoins: 1000,
      }),
    );
    // 10 of the 40, not zero — the cap is a ceiling, not a cliff.
    expect(decision.granted).toBe(10);
    expect(decision.withheld).toBe(30);
    expect(decision.capped).toBe(true);
  });

  it('grants nothing once the cap is already reached', async () => {
    const { accountId, customerId } = await seed('reached');
    await recordEarning(accountId, 1000);

    const decision = await prisma.$transaction((tx) =>
      earnCap.capGrant(tx, {
        accountId,
        customerId,
        proposedCoins: 50,
        defaultCapCoins: 1000,
      }),
    );
    expect(decision.granted).toBe(0);
    expect(decision.withheld).toBe(50);
  });

  it('resets at the next calendar month', async () => {
    const { accountId, customerId } = await seed('reset');
    // Last month's earnings, at the cap.
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1, 15);
    await recordEarning(accountId, 1000, lastMonth);

    const decision = await prisma.$transaction((tx) =>
      earnCap.capGrant(tx, {
        accountId,
        customerId,
        proposedCoins: 60,
        defaultCapCoins: 1000,
      }),
    );
    // A calendar month, not a rolling 30 days — last month's total is spent.
    expect(decision.granted).toBe(60);
    expect(decision.earnedSoFar).toBe(0);
  });

  it('counts only EARN rows, so a clawback does not refund headroom', async () => {
    /*
     * A clawback reverses a grant that should not have stood. Letting it return
     * headroom would let a customer earn, return, and earn again against the
     * same cap indefinitely.
     */
    const { accountId, customerId } = await seed('clawback');
    await recordEarning(accountId, 1000);
    await prisma.coinLedger.create({
      data: {
        accountId,
        coinsDelta: -400,
        balanceAfter: 0,
        monetaryValuePaise: 40000,
        reason: CoinReason.CLAWBACK,
        idempotencyKey: `${TAG}-claw-${Date.now()}`,
      },
    });

    const decision = await prisma.$transaction((tx) =>
      earnCap.capGrant(tx, {
        accountId,
        customerId,
        proposedCoins: 50,
        defaultCapCoins: 1000,
      }),
    );
    expect(decision.earnedSoFar).toBe(1000);
    expect(decision.granted).toBe(0);
  });

  it('a zero default means the cap is disabled, not that nobody earns', async () => {
    const { accountId, customerId } = await seed('nocap');
    await recordEarning(accountId, 99_999);

    const decision = await prisma.$transaction((tx) =>
      earnCap.capGrant(tx, {
        accountId,
        customerId,
        proposedCoins: 500,
        defaultCapCoins: 0,
      }),
    );
    expect(decision.granted).toBe(500);
    expect(decision.capped).toBe(false);
  });
});

describe('§3.3 Customer-level overrides', () => {
  async function setOverride(
    customerId: string,
    monthlyCapCoins: number,
    opts: { expiresAt?: Date; revokedAt?: Date } = {},
  ) {
    return prisma.customerEarnCapOverride.create({
      data: {
        customerId,
        monthlyCapCoins,
        reason: 'Approved wholesale buyer',
        expiresAt: opts.expiresAt ?? null,
        revokedAt: opts.revokedAt ?? null,
      },
      select: { id: true },
    });
  }

  it('raises the cap for an exceptional customer', async () => {
    // The wholesale case, expressed generically: a number and a reason.
    const { accountId, customerId } = await seed('wholesale');
    await setOverride(customerId, 5000);
    await recordEarning(accountId, 1200);

    const decision = await prisma.$transaction((tx) =>
      earnCap.capGrant(tx, {
        accountId,
        customerId,
        proposedCoins: 300,
        defaultCapCoins: 1000,
      }),
    );
    // Would have been 0 under the default; the override permits it.
    expect(decision.cap).toBe(5000);
    expect(decision.granted).toBe(300);
  });

  it('LOWERS the cap when the override is smaller than the default', async () => {
    // An override is authoritative in both directions — a reduced cap is a
    // legitimate setting for an account under review.
    const { accountId, customerId } = await seed('reduced');
    await setOverride(customerId, 100);
    await recordEarning(accountId, 100);

    const decision = await prisma.$transaction((tx) =>
      earnCap.capGrant(tx, {
        accountId,
        customerId,
        proposedCoins: 50,
        defaultCapCoins: 1000,
      }),
    );
    expect(decision.cap).toBe(100);
    expect(decision.granted).toBe(0);
  });

  it('a zero override stops earning entirely', async () => {
    const { accountId, customerId } = await seed('zero');
    await setOverride(customerId, 0);

    const decision = await prisma.$transaction((tx) =>
      earnCap.capGrant(tx, {
        accountId,
        customerId,
        proposedCoins: 40,
        defaultCapCoins: 1000,
      }),
    );
    // Distinguished from a zero DEFAULT, which disables the cap — the override
    // is an explicit decision about this customer.
    expect(decision.granted).toBe(0);
  });

  it('ignores an expired override and falls back to the default', async () => {
    const { accountId, customerId } = await seed('expired');
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    await setOverride(customerId, 5000, { expiresAt: yesterday });
    await recordEarning(accountId, 1000);

    const decision = await prisma.$transaction((tx) =>
      earnCap.capGrant(tx, {
        accountId,
        customerId,
        proposedCoins: 50,
        defaultCapCoins: 1000,
      }),
    );
    expect(decision.cap).toBe(1000);
    expect(decision.granted).toBe(0);
  });

  it('honours an override that has not yet expired', async () => {
    const { accountId, customerId } = await seed('future');
    const nextYear = new Date();
    nextYear.setFullYear(nextYear.getFullYear() + 1);
    await setOverride(customerId, 5000, { expiresAt: nextYear });

    const decision = await prisma.$transaction((tx) =>
      earnCap.capGrant(tx, {
        accountId,
        customerId,
        proposedCoins: 50,
        defaultCapCoins: 1000,
      }),
    );
    expect(decision.cap).toBe(5000);
  });

  it('ignores a revoked override', async () => {
    const { accountId, customerId } = await seed('revoked');
    await setOverride(customerId, 5000, { revokedAt: new Date() });

    const decision = await prisma.$transaction((tx) =>
      earnCap.capGrant(tx, {
        accountId,
        customerId,
        proposedCoins: 50,
        defaultCapCoins: 1000,
      }),
    );
    expect(decision.cap).toBe(1000);
  });

  it('the newest live override wins when several exist', async () => {
    const { customerId } = await seed('newest');
    await setOverride(customerId, 2000);
    await new Promise((r) => setTimeout(r, 10));
    await setOverride(customerId, 7000);

    const resolved = await prisma.$transaction((tx) =>
      earnCap.effectiveCap(tx, customerId, 1000),
    );
    expect(resolved.cap).toBe(7000);
  });

  it('changing the default does not disturb an override', async () => {
    const { customerId } = await seed('defaultchange');
    await setOverride(customerId, 5000);

    const a = await prisma.$transaction((tx) => earnCap.effectiveCap(tx, customerId, 1000));
    const b = await prisma.$transaction((tx) => earnCap.effectiveCap(tx, customerId, 250));
    expect(a.cap).toBe(5000);
    expect(b.cap).toBe(5000);
  });
});

describe('§3.3 Concurrency and idempotency near the cap', () => {
  it('two concurrent grants cannot both spend the same headroom', async () => {
    const { accountId, customerId } = await seed('race');
    await recordEarning(accountId, 970); // 30 coins of headroom

    /*
     * Each attempt takes the account lock before reading the month's total, so
     * the second blocks until the first commits and then sees the updated total.
     * Without the lock both would read 970 and both grant 30.
     */
    const attempt = () =>
      prisma.$transaction(async (tx) => {
        await ledger.lockAccount(tx, accountId);
        const decision = await earnCap.capGrant(tx, {
          accountId,
          customerId,
          proposedCoins: 30,
          defaultCapCoins: 1000,
        });
        if (decision.granted > 0) {
          await tx.coinLedger.create({
            data: {
              accountId,
              coinsDelta: decision.granted,
              balanceAfter: 0,
              monetaryValuePaise: decision.granted * 100,
              reason: CoinReason.EARN,
              idempotencyKey: `${TAG}-race-${Math.random().toString(36).slice(2)}`,
            },
          });
        }
        return decision.granted;
      });

    const results = await Promise.all([attempt(), attempt()]);
    const total = results.reduce((a, b) => a + b, 0);

    // Between them they may grant at most the 30 remaining.
    expect(total).toBeLessThanOrEqual(30);

    const earned = await earnCap.earnedThisMonth(prisma, accountId);
    expect(earned).toBeLessThanOrEqual(1000);
  });

  it('a duplicate earning event does not consume headroom twice', async () => {
    // Only the account is needed here — the cap is not consulted, the ledger's
    // idempotency key is what this test exercises.
    const { accountId } = await seed('dupevent');
    await recordEarning(accountId, 500);

    const key = `${TAG}-dup-${Date.now()}`;
    const post = () =>
      prisma.$transaction(async (tx) => {
        await ledger.lockAccount(tx, accountId);
        return ledger.post(tx, {
          accountId,
          coinsDelta: 200,
          reason: CoinReason.EARN,
          idempotencyKey: key,
        });
      });

    await post();
    const second = await post();
    expect(second.duplicate).toBe(true);

    // 500 + 200, not 500 + 400 — the replay wrote nothing.
    expect(await earnCap.earnedThisMonth(prisma, accountId)).toBe(700);
  });
});

describe('§3.3 Internal and staff accounts do not earn', () => {
  it('excludes a customer whose email belongs to an active CMS user', async () => {
    const { customerId, email } = await seed('staff');
    await prisma.cmsUser.create({
      data: {
        email,
        name: 'Ops Person',
        role: Role.OPS_MANAGER,
        passwordHash: 'x',
        status: 'ACTIVE',
      },
    });

    expect(await earnCap.isInternalUser(prisma, customerId)).toBe(true);
  });

  it('an ordinary customer is not internal', async () => {
    const { customerId } = await seed('ordinary');
    expect(await earnCap.isInternalUser(prisma, customerId)).toBe(false);
  });

  it('a DEACTIVATED operator earns again — they have left', async () => {
    const { customerId, email } = await seed('former');
    await prisma.cmsUser.create({
      data: {
        email,
        name: 'Former Staff',
        role: Role.OPS_MANAGER,
        passwordHash: 'x',
        status: 'DEACTIVATED',
      },
    });

    expect(await earnCap.isInternalUser(prisma, customerId)).toBe(false);
  });

  it('uses the CMS user list, not an email-domain guess', async () => {
    /*
     * A @zewafeeds.com address is neither necessary nor sufficient: staff use
     * personal addresses, and a founder's relative on the company domain is not
     * staff. The CMS user list is the record of who actually works here.
     */
    const customer = await prisma.customer.create({
      data: {
        email: `${TAG}-domain-${Date.now()}@zewafeeds.com`,
        firstName: 'Looks',
        lastName: 'Internal',
      },
      select: { id: true },
    });
    expect(await earnCap.isInternalUser(prisma, customer.id)).toBe(false);
  });
});

describe('The cap governs issuance only', () => {
  it('never alters coins already earned', async () => {
    const { accountId, customerId: capCustomerId } = await seed('historical');
    await recordEarning(accountId, 800);

    const before = await prisma.loyaltyAccount.findUniqueOrThrow({ where: { id: accountId } });

    // Lower the cap well below what has already been earned.
    await prisma.customerEarnCapOverride.create({
      data: { customerId: capCustomerId, monthlyCapCoins: 100, reason: 'Under review' },
    });
    await prisma.$transaction((tx) =>
      earnCap.capGrant(tx, {
        accountId,
        customerId: capCustomerId,
        proposedCoins: 50,
        defaultCapCoins: 1000,
      }),
    );

    const after = await prisma.loyaltyAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(after.pendingCoins).toBe(before.pendingCoins);
    expect(after.availableCoins).toBe(before.availableCoins);
  });
});
