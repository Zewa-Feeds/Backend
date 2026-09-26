/**
 * Adversarial: double-spend, concurrency and replay — ZSOP004 §8.1, §9.1, §12.
 *
 * These are the tests that justify the design. Everything else verifies that the
 * system does what the specification says; these verify that it cannot be made to
 * do what the specification forbids.
 *
 * Real database, real transactions, genuinely parallel requests. A mock cannot
 * prove a row lock works.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { PrismaClient, CoinLotState, CoinSourceType, CoinReason } from '@prisma/client';
import * as ledger from './ledger.service';
import * as account from './account.service';
import * as redemption from './redemption.service';
import * as rules from './rules.service';

const prisma = new PrismaClient();
const TAG = 'zz-conc';
let ruleVersion: Awaited<ReturnType<typeof rules.active>>;
/** Restored in afterAll — redemption is OFF by default (§13.2). */
let originalRedemptionEnabled = false;

async function sweep() {
  const customers = await prisma.customer.findMany({
    where: { email: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = customers.map((c) => c.id);
  if (!ids.length) return;
  const accounts = await prisma.loyaltyAccount.findMany({
    where: { customerId: { in: ids } },
    select: { id: true },
  });
  const accIds = accounts.map((a) => a.id);
  if (accIds.length) {
    await prisma.$executeRawUnsafe('ALTER TABLE "CoinLedger" DISABLE TRIGGER coin_ledger_no_delete');
    await prisma.coinLedger.deleteMany({ where: { accountId: { in: accIds } } });
    await prisma.$executeRawUnsafe('ALTER TABLE "CoinLedger" ENABLE TRIGGER coin_ledger_no_delete');
    /*
     * Orders and their OrderLoyalty rows go too.
     *
     * This suite creates an order in the duplicate-confirmation test, and the
     * sweep previously stopped at the account's own rows — so every run left an
     * order and an OrderLoyalty record behind, accumulating in a financial table
     * across runs. Harmless individually, but it makes "no test data remains"
     * false and could mask a genuine reconciliation finding later.
     */
    const orders = await prisma.order.findMany({
      where: { OR: [{ email: { startsWith: TAG } }, { orderNo: { startsWith: TAG } }] },
      select: { id: true },
    });
    const orderIds = orders.map((o) => o.id);
    if (orderIds.length) {
      await prisma.orderLoyalty.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.coinReservation.deleteMany({ where: { orderId: { in: orderIds } } });
    }

    await prisma.coinReservation.deleteMany({ where: { accountId: { in: accIds } } });
    await prisma.coinLot.deleteMany({ where: { accountId: { in: accIds } } });
    await prisma.loyaltyAccount.deleteMany({ where: { id: { in: accIds } } });
  }
  await prisma.order.deleteMany({
    where: { OR: [{ email: { startsWith: TAG } }, { orderNo: { startsWith: TAG } }] },
  });
  await prisma.customer.deleteMany({ where: { id: { in: ids } } });
}

/** A customer holding `coins` spendable coins in one lot. */
async function seedCustomer(label: string, coins: number) {
  const customer = await prisma.customer.create({
    data: {
      email: `${TAG}-${label}-${Date.now()}${Math.random().toString(36).slice(2, 6)}@zewafeeds.test`,
      firstName: 'Conc',
      lastName: 'Test',
    },
    select: { id: true },
  });
  const acc = await prisma.$transaction((tx) => account.ensureAccount(tx, customer.id));

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 365);
  await prisma.coinLot.create({
    data: {
      accountId: acc.id,
      coinsGranted: coins,
      coinsRemaining: coins,
      state: CoinLotState.AVAILABLE,
      sourceType: CoinSourceType.MANUAL,
      expiresAt,
      ruleVersionId: ruleVersion.id,
      claimedAt: new Date(),
    },
  });
  await prisma.loyaltyAccount.update({
    where: { id: acc.id },
    data: { availableCoins: coins },
  });

  return { customerId: customer.id, accountId: acc.id };
}

/**
 * Re-assert redemption before each test.
 *
 * `beforeAll` enables the kill switch once, but `rules.active()` caches the
 * version for 60s (§9.3) and that cache is module-level state shared with every
 * other suite in the run. A neighbouring file that invalidates it mid-run can
 * leave this one reading a stale `redemptionEnabled: false`, which surfaces as a
 * spurious ACCOUNT_CANNOT_REDEEM / NOTHING_REDEEMABLE on whichever test happens
 * to run next.
 *
 * Invalidating per test costs one query and makes the suite order-independent.
 */
beforeEach(async () => {
  /*
   * Re-assert the redemption kill switch before every test.
   *
   * `redemptionEnabled` is a single shared row (§9.3) and more than one suite
   * needs it ON. With `fileParallelism: false` the files run back to back, so
   * one file's afterAll restore lands while the next is still running — the
   * symptom is a spurious ACCOUNT_CANNOT_REDEEM / NOTHING_REDEEMABLE on
   * whichever test happens to be next.
   *
   * Setting it per test rather than per file costs one write and makes the
   * suite order-independent.
   */
  await prisma.loyaltyRuleVersion.updateMany({
    where: { isActive: true },
    data: { redemptionEnabled: true },
  });
  rules.invalidate();
});

const LINES = [
  {
    id: 'L1',
    lineTotalPaise: 500000, // ₹5,000 — never the binding constraint below
    taxRatePct: 0,
    earnEligible: true,
    coinRedeemable: true,
    couponDiscountPaise: 0,
  },
];

beforeAll(async () => {
  await sweep();
  const current = await rules.active(prisma);
  originalRedemptionEnabled = current.redemptionEnabled;

  // Redemption ships disabled (§13.2 silent accrual). Enable it for this file
  // only, so the double-spend defences can actually be exercised.
  await prisma.loyaltyRuleVersion.update({
    where: { id: current.id },
    data: { redemptionEnabled: true },
  });
  rules.invalidate();
  ruleVersion = await rules.active(prisma);
});

afterAll(async () => {
  await prisma.loyaltyRuleVersion.update({
    where: { id: ruleVersion.id },
    data: { redemptionEnabled: originalRedemptionEnabled },
  });
  rules.invalidate();
  await sweep();
  await prisma.$disconnect();
});

describe('§8.1 #7 Two tabs redeeming the same coins', () => {
  it('never lets two concurrent holds exceed the balance', async () => {
    const { customerId, accountId } = await seedCustomer('twotab', 100);

    // Two tabs, two different carts, each trying to hold the full 100 coins.
    const [a, b] = await Promise.all([
      redemption.reserve({ customerId, coins: 100, lines: LINES, cartKey: 'tab-a' }),
      redemption.reserve({ customerId, coins: 100, lines: LINES, cartKey: 'tab-b' }),
    ]);

    // Whatever the interleaving, the two holds together cannot exceed 100.
    expect(a.held + b.held).toBeLessThanOrEqual(100);

    const live = await prisma.coinReservation.aggregate({
      where: { accountId, status: 'PENDING' },
      _sum: { coins: true },
    });
    expect(live._sum.coins ?? 0).toBeLessThanOrEqual(100);
  });

  it('holds are account-anchored, so a second device cannot duplicate them', async () => {
    const { customerId, accountId } = await seedCustomer('device', 50);

    await redemption.reserve({ customerId, coins: 50, lines: LINES, cartKey: 'phone' });
    const second = await redemption.reserve({
      customerId,
      coins: 50,
      lines: LINES,
      cartKey: 'laptop',
    });

    // The first hold consumed the balance; the second device gets nothing.
    expect(second.held).toBe(0);

    const total = await prisma.coinReservation.aggregate({
      where: { accountId, status: 'PENDING' },
      _sum: { coins: true },
    });
    expect(total._sum.coins).toBe(50);
  });

  it('re-applying on the same cart replaces the hold rather than stacking it', async () => {
    const { customerId, accountId } = await seedCustomer('reapply', 100);

    await redemption.reserve({ customerId, coins: 80, lines: LINES, cartKey: 'cart-1' });
    const second = await redemption.reserve({
      customerId,
      coins: 30,
      lines: LINES,
      cartKey: 'cart-1',
    });

    expect(second.held).toBe(30);
    const live = await prisma.coinReservation.findMany({
      where: { accountId, status: 'PENDING' },
    });
    expect(live).toHaveLength(1);
    expect(live[0]!.coins).toBe(30);
  });
});

describe('§9.1 Concurrent ledger writes', () => {
  it('serialises parallel debits so the balance can never go below the floor', async () => {
    const { accountId } = await seedCustomer('parallel', 100);

    // Ten concurrent 20-coin debits against a 100-coin balance. Without the row
    // lock, several would read 100 and all succeed, landing at −100.
    const attempts = Array.from({ length: 10 }, (_, i) =>
      prisma
        .$transaction(async (tx) => {
          await ledger.lockAccount(tx, accountId);
          return ledger.postFlooredDebit(
            tx,
            {
              accountId,
              coinsDelta: -20,
              reason: CoinReason.ADJUSTMENT,
              idempotencyKey: `${TAG}-parallel-${accountId}-${i}`,
              note: 'concurrency probe',
            },
            50,
          );
        })
        .catch(() => null),
    );
    await Promise.all(attempts);

    const acc = await prisma.loyaltyAccount.findUniqueOrThrow({ where: { id: accountId } });
    // The floor holds regardless of interleaving.
    expect(acc.availableCoins).toBeGreaterThanOrEqual(-50);
  });

  it('a repeated idempotency key applies once even when fired in parallel', async () => {
    const { accountId } = await seedCustomer('idem', 100);
    const key = `${TAG}-idem-parallel-${accountId}`;

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        prisma
          .$transaction((tx) =>
            ledger.post(tx, {
              accountId,
              coinsDelta: 10,
              reason: CoinReason.ADJUSTMENT,
              idempotencyKey: key,
            }),
          )
          .catch(() => null),
      ),
    );

    // Exactly one row exists for the key, however many callers raced.
    const rows = await prisma.coinLedger.count({ where: { idempotencyKey: key } });
    expect(rows).toBe(1);

    const applied = results.filter((r) => r && !r.duplicate).length;
    expect(applied).toBeLessThanOrEqual(1);
  });
});

describe('§8.1 #4 Duplicate webhooks and replayed events', () => {
  it('confirming the same order twice redeems once', async () => {
    const { customerId, accountId } = await seedCustomer('confirm', 100);
    const reserved = await redemption.reserve({
      customerId,
      coins: 40,
      lines: LINES,
      cartKey: 'confirm-cart',
    });
    expect(reserved.held).toBe(40);

    // Bind the hold to an order, as checkout does.
    const order = await prisma.order.create({
      data: {
        orderNo: `${TAG}-confirm-${Date.now().toString(36)}`,
        customerId,
        email: `${TAG}-confirm@zewafeeds.test`,
        phone: '+919000000000',
        paymentMethod: 'RAZORPAY',
        subtotalPaise: 500000,
        totalPaise: 496000,
        shippingAddress: { name: 'T', line1: 'L', city: 'C', state: 'Kerala', pincode: '600001' },
      },
      select: { id: true },
    });
    await prisma.$transaction((tx) =>
      redemption.attachToOrder(tx, reserved.reservationId!, order.id),
    );

    // Two payment webhooks for the same order — Razorpay retries on any timeout.
    const first = await prisma.$transaction((tx) => redemption.confirmForOrder(tx, order.id));
    const second = await prisma.$transaction((tx) => redemption.confirmForOrder(tx, order.id));

    expect(first).toBe(40);
    expect(second).toBe(0); // no-op

    const redeemRows = await prisma.coinLedger.count({
      where: { accountId, reason: CoinReason.REDEEM },
    });
    expect(redeemRows).toBe(1);

    const acc = await prisma.loyaltyAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(acc.availableCoins).toBe(60); // 100 − 40, debited exactly once
    expect(acc.lockedCoins).toBe(0);
  });
});

describe('§4.3 Reservations and expiry interact safely', () => {
  it('a released hold returns the coins to the spendable balance', async () => {
    const { customerId, accountId } = await seedCustomer('release', 100);
    await redemption.reserve({ customerId, coins: 60, lines: LINES, cartKey: 'rel' });

    const acc1 = await prisma.loyaltyAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(acc1.lockedCoins).toBe(60);

    await prisma.$transaction((tx) => redemption.releaseByCartKey(tx, accountId, 'rel'));

    const acc2 = await prisma.loyaltyAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(acc2.lockedCoins).toBe(0);
    expect(acc2.availableCoins).toBe(100);
  });

  it('the sweeper releases dead holds without touching the ledger', async () => {
    const { customerId, accountId } = await seedCustomer('sweep', 100);
    const r = await redemption.reserve({
      customerId,
      coins: 30,
      lines: LINES,
      cartKey: 'dead',
    });

    // Age the hold past its TTL.
    await prisma.coinReservation.update({
      where: { id: r.reservationId! },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const before = await prisma.coinLedger.count({ where: { accountId } });
    await redemption.sweepExpired();
    const after = await prisma.coinLedger.count({ where: { accountId } });

    // A hold that never became a redemption moved no coins, so it writes no
    // ledger rows — releasing it is purely a cache correction.
    expect(after).toBe(before);

    const acc = await prisma.loyaltyAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(acc.lockedCoins).toBe(0);
  });
});

describe('§4 Redemption limits are enforced server-side', () => {
  it('rejects a redemption below the 10-coin minimum', async () => {
    const { customerId } = await seedCustomer('min', 100);
    const r = await redemption.reserve({ customerId, coins: 5, lines: LINES, cartKey: 'min' });
    expect(r.held).toBe(0);
    expect(r.reason).toBe('BELOW_MINIMUM');
  });

  it('silently reduces when the customer asks for more than they hold (§4.1)', async () => {
    const { customerId } = await seedCustomer('over', 40);
    const r = await redemption.reserve({ customerId, coins: 9999, lines: LINES, cartKey: 'over' });
    expect(r.held).toBe(40);
    expect(r.reduced).toBe(true);
  });

  it('caps at the eligible product value, not the balance', async () => {
    const { customerId } = await seedCustomer('cap', 5000);
    // A ₹100 cart absorbs at most 99 coins whatever the balance: ₹1 stays
    // payable, because Razorpay refuses an order under 100 paise.
    const smallCart = [{ ...LINES[0]!, lineTotalPaise: 10000 }];
    const r = await redemption.reserve({
      customerId,
      coins: 5000,
      lines: smallCart,
      cartKey: 'cap',
    });
    expect(r.held).toBe(99);
  });

  it('holds nothing when the cart contains no redeemable items (§6.4)', async () => {
    const { customerId } = await seedCustomer('noelig', 500);
    const clearanceOnly = [{ ...LINES[0]!, coinRedeemable: false }];
    const r = await redemption.reserve({
      customerId,
      coins: 100,
      lines: clearanceOnly,
      cartKey: 'noelig',
    });
    expect(r.held).toBe(0);
    expect(r.reason).toBe('NOTHING_REDEEMABLE');
  });
});

describe('§6.7 / §13.5 Redemption is blocked where the specification requires', () => {
  it('blocks redemption while the balance is negative', async () => {
    const { customerId, accountId } = await seedCustomer('neg', 100);
    await prisma.loyaltyAccount.update({
      where: { id: accountId },
      data: { availableCoins: -20 },
    });

    const r = await redemption.reserve({ customerId, coins: 10, lines: LINES, cartKey: 'neg' });
    expect(r.held).toBe(0);
    expect(r.reason).toBe('ACCOUNT_CANNOT_REDEEM');

    // §10.1: the box is hidden entirely, not shown with a negative number.
    expect(await redemption.quote(customerId, LINES)).toBeNull();
  });

  it('redeems normally for a customer still carrying the legacy holdout flag', async () => {
    /*
     * The §13.5 holdout used to hide the coin surface entirely. The experiment
     * is removed, so a row that still has the stale flag set must redeem like
     * anyone else — the column is inert legacy data, not an eligibility gate.
     */
    const { customerId, accountId } = await seedCustomer('legacyholdout', 100);
    await prisma.loyaltyAccount.update({ where: { id: accountId }, data: { holdout: true } });

    const quote = await redemption.quote(customerId, LINES);
    expect(quote).not.toBeNull();
    expect(quote!.visible).toBe(true);

    const r = await redemption.reserve({ customerId, coins: 50, lines: LINES, cartKey: 'ho' });
    expect(r.held).toBe(50);
  });

  it('blocks redemption after two consecutive reconciliation mismatches (§9.2)', async () => {
    const { customerId, accountId } = await seedCustomer('drift', 100);
    await prisma.loyaltyAccount.update({
      where: { id: accountId },
      data: { mismatchStreak: 2 },
    });

    const r = await redemption.reserve({ customerId, coins: 20, lines: LINES, cartKey: 'drift' });
    expect(r.held).toBe(0);
    expect(r.reason).toBe('ACCOUNT_CANNOT_REDEEM');
  });

  it('the kill switch hides the box within the cache TTL (§9.3)', async () => {
    const { customerId } = await seedCustomer('kill', 100);
    await prisma.loyaltyRuleVersion.update({
      where: { id: ruleVersion.id },
      data: { redemptionEnabled: false },
    });
    rules.invalidate();

    /*
     * try/finally, not a trailing restore.
     *
     * `redemptionEnabled` is one shared row, and a failed assertion here would
     * otherwise leave the switch OFF for every suite that runs afterwards —
     * turning one real failure into a cascade of unrelated ones that points
     * nowhere near the actual bug.
     */
    try {
      expect(await redemption.quote(customerId, LINES)).toBeNull();
      const r = await redemption.reserve({ customerId, coins: 50, lines: LINES, cartKey: 'kill' });
      expect(r.reason).toBe('REDEMPTION_DISABLED');
    } finally {
      await prisma.loyaltyRuleVersion.update({
        where: { id: ruleVersion.id },
        data: { redemptionEnabled: true },
      });
      rules.invalidate();
    }
  });
});
