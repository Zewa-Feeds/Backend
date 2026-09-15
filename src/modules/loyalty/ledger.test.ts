/**
 * Ledger and account integration — ZSOP004 §6.7, §9.1, §9.2.
 *
 * Runs against the real database, because the things under test ARE database
 * behaviours: the append-only trigger, the CHECK constraints, row locking under
 * concurrency, and the unique index that makes idempotency work. A mock would
 * only prove the mock was called.
 *
 * Fixtures live under the reserved `zz` namespace from src/test/fixtures.ts so a
 * crashed run costs the next one nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, CoinReason, CoinSourceType, CoinLotState } from '@prisma/client';
import * as ledger from './ledger.service';
import * as account from './account.service';
import * as rules from './rules.service';

const prisma = new PrismaClient();

const NS = `zz-ledger-${Date.now().toString(36)}`;
let customerId: string;
let accountId: string;
let ruleVersion: Awaited<ReturnType<typeof rules.active>>;

/** Remove everything this file created, trigger included. */
async function sweep() {
  const customers = await prisma.customer.findMany({
    where: { email: { startsWith: 'zz-ledger-' } },
    select: { id: true },
  });
  if (customers.length === 0) return;
  const ids = customers.map((c) => c.id);
  const accounts = await prisma.loyaltyAccount.findMany({
    where: { customerId: { in: ids } },
    select: { id: true },
  });
  const accIds = accounts.map((a) => a.id);

  // The append-only trigger blocks DELETE, so it is disabled for the duration of
  // the cleanup and restored immediately. This is the documented escape hatch
  // from the migration — deliberate, scoped, and reversed in the same statement.
  if (accIds.length) {
    await prisma.$executeRawUnsafe('ALTER TABLE "CoinLedger" DISABLE TRIGGER coin_ledger_no_delete');
    await prisma.coinLedger.deleteMany({ where: { accountId: { in: accIds } } });
    await prisma.$executeRawUnsafe('ALTER TABLE "CoinLedger" ENABLE TRIGGER coin_ledger_no_delete');
    await prisma.coinReservation.deleteMany({ where: { accountId: { in: accIds } } });
    await prisma.coinLot.deleteMany({ where: { accountId: { in: accIds } } });
    await prisma.loyaltyAccount.deleteMany({ where: { id: { in: accIds } } });
  }
  await prisma.customer.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  await sweep();
  ruleVersion = await rules.active(prisma);

  const customer = await prisma.customer.create({
    data: {
      email: `${NS}@zewafeeds.test`,
      firstName: 'Ledger',
      lastName: 'Test',
      phone: '+919000000001',
    },
    select: { id: true },
  });
  customerId = customer.id;

  const acc = await prisma.$transaction((tx) => account.ensureAccount(tx, customerId, '+919000000001'));
  accountId = acc.id;
});

afterAll(async () => {
  await sweep();
  await prisma.$disconnect();
});

describe('Append-only enforcement (§9.2) — must fail LOUDLY', () => {
  it('rejects UPDATE on a ledger row at the database level', async () => {
    const row = await prisma.coinLedger.create({
      data: {
        accountId,
        coinsDelta: 10,
        balanceAfter: 10,
        monetaryValuePaise: 1000,
        reason: CoinReason.ADJUSTMENT,
        idempotencyKey: `${NS}-append-1`,
      },
      select: { id: true },
    });

    // This is the behaviour that differs deliberately from the AuditLog rule:
    // the write RAISES rather than being silently discarded.
    await expect(
      prisma.coinLedger.update({ where: { id: row.id }, data: { coinsDelta: 9999 } }),
    ).rejects.toThrow(/append-only/i);

    const after = await prisma.coinLedger.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.coinsDelta).toBe(10); // unchanged
  });

  it('rejects DELETE on a ledger row at the database level', async () => {
    const row = await prisma.coinLedger.create({
      data: {
        accountId,
        coinsDelta: 5,
        balanceAfter: 15,
        monetaryValuePaise: 500,
        reason: CoinReason.ADJUSTMENT,
        idempotencyKey: `${NS}-append-2`,
      },
      select: { id: true },
    });

    await expect(prisma.coinLedger.delete({ where: { id: row.id } })).rejects.toThrow(
      /append-only/i,
    );
    expect(await prisma.coinLedger.findUnique({ where: { id: row.id } })).not.toBeNull();
  });
});

describe('Idempotency (§9.1) — every event arrives at least twice', () => {
  it('treats a repeated key as a no-op and returns the original row', async () => {
    const key = `${NS}-idem-1`;
    const first = await prisma.$transaction((tx) =>
      ledger.post(tx, {
        accountId,
        coinsDelta: 40,
        reason: CoinReason.ADJUSTMENT,
        idempotencyKey: key,
      }),
    );
    const second = await prisma.$transaction((tx) =>
      ledger.post(tx, {
        accountId,
        coinsDelta: 40,
        reason: CoinReason.ADJUSTMENT,
        idempotencyKey: key,
      }),
    );

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.ledgerId).toBe(first.ledgerId);

    // The balance moved exactly once.
    const rows = await prisma.coinLedger.count({ where: { idempotencyKey: key } });
    expect(rows).toBe(1);
  });

  it('a duplicate grant does not create a second lot', async () => {
    const key = `${NS}-idem-lot`;
    const a = await prisma.$transaction((tx) =>
      account.grantLot(tx, {
        accountId,
        coins: 25,
        ruleVersion,
        sourceType: CoinSourceType.MANUAL,
        reason: CoinReason.GOODWILL,
        idempotencyKey: key,
      }),
    );
    const b = await prisma.$transaction((tx) =>
      account.grantLot(tx, {
        accountId,
        coins: 25,
        ruleVersion,
        sourceType: CoinSourceType.MANUAL,
        reason: CoinReason.GOODWILL,
        idempotencyKey: key,
      }),
    );

    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(b.lot?.id).toBe(a.lot?.id);

    const lots = await prisma.coinLot.count({ where: { accountId, id: a.lot!.id } });
    expect(lots).toBe(1);
  });
});

describe('The −50 floor (§6.7)', () => {
  it('floors the operative balance and records the full deficit', () => {
    // Pure-function check of the rule before exercising it against the database.
    expect(ledger.applyFloor(0, 40, 50)).toEqual({ debit: 40, excess: 0 });
    expect(ledger.applyFloor(0, 50, 50)).toEqual({ debit: 50, excess: 0 });
    // A 1,520-coin clawback against a zero balance: 50 debited, 1,470 flagged.
    expect(ledger.applyFloor(0, 1520, 50)).toEqual({ debit: 50, excess: 1470 });
    // Partial balance absorbs first.
    expect(ledger.applyFloor(30, 100, 50)).toEqual({ debit: 80, excess: 20 });
  });

  it('freezes the account and flags the deficit rather than writing it off', async () => {
    const c = await prisma.customer.create({
      data: { email: `zz-ledger-floor-${Date.now()}@zewafeeds.test`, firstName: 'F', lastName: 'T' },
      select: { id: true },
    });
    const acc = await prisma.$transaction((tx) => account.ensureAccount(tx, c.id));
  /*
   * Opt this fixture OUT of the holdout.
   *
   * `ensureAccount` assigns the holdout deterministically from a hash of the
   * customer id (§13.5), so ~5% of randomly generated UUIDs land in it and
   * correctly earn nothing. Left alone, a couple of fixtures per run silently
   * become control-group accounts and whichever test owns them fails — which is
   * why the failure appeared to move between tests on every run.
   *
   * Holdout behaviour itself is covered explicitly in concurrency.test.ts.
   */
  await prisma.loyaltyAccount.update({ where: { id: acc.id }, data: { holdout: false } });

    await prisma.$transaction((tx) =>
      ledger.postFlooredDebit(
        tx,
        {
          accountId: acc.id,
          coinsDelta: -1520,
          reason: CoinReason.CLAWBACK,
          idempotencyKey: `zz-ledger-floor-${Date.now()}`,
        },
        50,
      ),
    );

    const after = await prisma.loyaltyAccount.findUniqueOrThrow({ where: { id: acc.id } });
    expect(after.availableCoins).toBe(-50); // operative floor
    expect(after.flaggedDeficit).toBe(1470); // full shortfall preserved
    expect(after.status).toBe('FROZEN'); // surfaced for review, not absorbed
  });
});

describe('FIFO consumption (§4.2)', () => {
  it('consumes the lot closest to expiry first', () => {
    // §4.2's worked example: 300 coins across three lots.
    const lots = [
      { id: 'L-101', coinsRemaining: 50 },
      { id: 'L-102', coinsRemaining: 100 },
      { id: 'L-103', coinsRemaining: 220 },
    ];
    expect(account.planConsumption(lots, 300)).toEqual([
      { lotId: 'L-101', coins: 50 }, // closed
      { lotId: 'L-102', coins: 100 }, // closed
      { lotId: 'L-103', coins: 150 }, // 70 remaining
    ]);
  });

  it('refuses to consume more than the lots hold', () => {
    const lots = [{ id: 'L-1', coinsRemaining: 10 }];
    expect(() => account.planConsumption(lots, 50)).toThrow(/balance has changed/i);
  });

  it('orders lots by expiry, not by grant order', async () => {
    const c = await prisma.customer.create({
      data: { email: `zz-ledger-fifo-${Date.now()}@zewafeeds.test`, firstName: 'F', lastName: 'I' },
      select: { id: true },
    });
    const acc = await prisma.$transaction((tx) => account.ensureAccount(tx, c.id));
  /*
   * Opt this fixture OUT of the holdout.
   *
   * `ensureAccount` assigns the holdout deterministically from a hash of the
   * customer id (§13.5), so ~5% of randomly generated UUIDs land in it and
   * correctly earn nothing. Left alone, a couple of fixtures per run silently
   * become control-group accounts and whichever test owns them fails — which is
   * why the failure appeared to move between tests on every run.
   *
   * Holdout behaviour itself is covered explicitly in concurrency.test.ts.
   */
  await prisma.loyaltyAccount.update({ where: { id: acc.id }, data: { holdout: false } });

    const far = new Date();
    far.setDate(far.getDate() + 300);
    const near = new Date();
    near.setDate(near.getDate() + 10);

    // Granted far-expiry FIRST, near-expiry second — FIFO must still pick near.
    await prisma.coinLot.create({
      data: {
        accountId: acc.id, coinsGranted: 100, coinsRemaining: 100,
        state: CoinLotState.AVAILABLE, sourceType: CoinSourceType.MANUAL,
        expiresAt: far, ruleVersionId: ruleVersion.id, claimedAt: new Date(),
      },
    });
    const nearLot = await prisma.coinLot.create({
      data: {
        accountId: acc.id, coinsGranted: 30, coinsRemaining: 30,
        state: CoinLotState.AVAILABLE, sourceType: CoinSourceType.MANUAL,
        expiresAt: near, ruleVersionId: ruleVersion.id, claimedAt: new Date(),
      },
    });

    const spendable = await prisma.$transaction((tx) => account.spendableLots(tx, acc.id));
    expect(spendable[0]!.id).toBe(nearLot.id);
  });

  it('excludes expired, unclaimed and pending lots from the spendable set', async () => {
    const c = await prisma.customer.create({
      data: { email: `zz-ledger-excl-${Date.now()}@zewafeeds.test`, firstName: 'E', lastName: 'X' },
      select: { id: true },
    });
    const acc = await prisma.$transaction((tx) => account.ensureAccount(tx, c.id));
  /*
   * Opt this fixture OUT of the holdout.
   *
   * `ensureAccount` assigns the holdout deterministically from a hash of the
   * customer id (§13.5), so ~5% of randomly generated UUIDs land in it and
   * correctly earn nothing. Left alone, a couple of fixtures per run silently
   * become control-group accounts and whichever test owns them fails — which is
   * why the failure appeared to move between tests on every run.
   *
   * Holdout behaviour itself is covered explicitly in concurrency.test.ts.
   */
  await prisma.loyaltyAccount.update({ where: { id: acc.id }, data: { holdout: false } });

    const past = new Date();
    past.setDate(past.getDate() - 1);
    const future = new Date();
    future.setDate(future.getDate() + 100);

    await prisma.coinLot.createMany({
      data: [
        // expired
        { accountId: acc.id, coinsGranted: 10, coinsRemaining: 10, state: CoinLotState.AVAILABLE,
          sourceType: CoinSourceType.MANUAL, expiresAt: past, ruleVersionId: ruleVersion.id, claimedAt: new Date() },
        // pending (not yet unlocked)
        { accountId: acc.id, coinsGranted: 20, coinsRemaining: 20, state: CoinLotState.PENDING,
          sourceType: CoinSourceType.ORDER, expiresAt: future, ruleVersionId: ruleVersion.id, claimedAt: new Date() },
        // backfill held pending OTP verification (§13.3)
        { accountId: acc.id, coinsGranted: 30, coinsRemaining: 30, state: CoinLotState.AVAILABLE,
          sourceType: CoinSourceType.LAUNCH_BACKFILL, expiresAt: future, ruleVersionId: ruleVersion.id, claimedAt: null },
      ],
    });

    const spendable = await prisma.$transaction((tx) => account.spendableLots(tx, acc.id));
    expect(spendable).toHaveLength(0);
  });
});

describe('Rollout bucketing (§13.5)', () => {
  it('is deterministic for a given customer id', () => {
    const id = 'customer-abc-123';
    expect(rules.bucketFor(id)).toBe(rules.bucketFor(id));
  });

  it('keeps the holdout in the bottom buckets so a ramp can never sweep it in', () => {
    // The property that matters: a holdout customer is unexposed at EVERY
    // rollout percentage, including 100.
    const holdouts = Array.from({ length: 500 }, (_, i) => `cust-${i}`).filter((id) =>
      rules.isHoldout(id),
    );
    expect(holdouts.length).toBeGreaterThan(0);
    for (const id of holdouts) {
      for (const pct of [0, 10, 50, 100]) {
        expect(rules.isExposed(id, pct)).toBe(false);
      }
    }
  });

  it('exposes roughly the configured percentage of non-holdout customers', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `rollout-${i}`);
    const exposed = ids.filter((id) => rules.isExposed(id, 50)).length;
    // Buckets 5–49 are exposed at 50% → ~45% of the population.
    expect(exposed / ids.length).toBeGreaterThan(0.35);
    expect(exposed / ids.length).toBeLessThan(0.55);
  });
});

describe('Reconciliation (§9.2) — the ledger always wins', () => {
  it('detects drift between the cached balance and the lots', async () => {
    const c = await prisma.customer.create({
      data: { email: `zz-ledger-drift-${Date.now()}@zewafeeds.test`, firstName: 'D', lastName: 'R' },
      select: { id: true },
    });
    const acc = await prisma.$transaction((tx) => account.ensureAccount(tx, c.id));
  /*
   * Opt this fixture OUT of the holdout.
   *
   * `ensureAccount` assigns the holdout deterministically from a hash of the
   * customer id (§13.5), so ~5% of randomly generated UUIDs land in it and
   * correctly earn nothing. Left alone, a couple of fixtures per run silently
   * become control-group accounts and whichever test owns them fails — which is
   * why the failure appeared to move between tests on every run.
   *
   * Holdout behaviour itself is covered explicitly in concurrency.test.ts.
   */
  await prisma.loyaltyAccount.update({ where: { id: acc.id }, data: { holdout: false } });

    const future = new Date();
    future.setDate(future.getDate() + 100);
    await prisma.coinLot.create({
      data: {
        accountId: acc.id, coinsGranted: 60, coinsRemaining: 60,
        state: CoinLotState.AVAILABLE, sourceType: CoinSourceType.MANUAL,
        expiresAt: future, ruleVersionId: ruleVersion.id, claimedAt: new Date(),
      },
    });
    // Corrupt the CACHE only — the lots are the truth here.
    await prisma.loyaltyAccount.update({
      where: { id: acc.id },
      data: { availableCoins: 999 },
    });

    const audit = await prisma.$transaction((tx) => ledger.auditAccount(tx, acc.id));
    expect(audit.clean).toBe(false);
    expect(audit.derived.available).toBe(60);
    expect(audit.drift.available).toBe(60 - 999);
  });

  it('reports clean when the cache agrees with the lots', async () => {
    const c = await prisma.customer.create({
      data: { email: `zz-ledger-clean-${Date.now()}@zewafeeds.test`, firstName: 'C', lastName: 'L' },
      select: { id: true },
    });
    const acc = await prisma.$transaction((tx) => account.ensureAccount(tx, c.id));
  /*
   * Opt this fixture OUT of the holdout.
   *
   * `ensureAccount` assigns the holdout deterministically from a hash of the
   * customer id (§13.5), so ~5% of randomly generated UUIDs land in it and
   * correctly earn nothing. Left alone, a couple of fixtures per run silently
   * become control-group accounts and whichever test owns them fails — which is
   * why the failure appeared to move between tests on every run.
   *
   * Holdout behaviour itself is covered explicitly in concurrency.test.ts.
   */
  await prisma.loyaltyAccount.update({ where: { id: acc.id }, data: { holdout: false } });
    const audit = await prisma.$transaction((tx) => ledger.auditAccount(tx, acc.id));
    expect(audit.clean).toBe(true);
  });
});
