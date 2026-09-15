/**
 * Reversal engine — ZSOP004 §6.5, §6.6, §6.7, §7, §8.2.
 *
 * The scenarios here are the ones that move money, so they are exercised against
 * the real database rather than mocked: idempotency depends on a unique index,
 * the −50 floor on a CHECK-constrained column, and out-of-order convergence on
 * the actual persisted state.
 *
 * §7.1's correctness test is asserted explicitly, not merely approximated:
 * after any modification, the customer's coin position must equal what it would
 * have been had the order been placed in its final form.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  PrismaClient,
  CoinLotState,
  CoinSourceType,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  ReturnKind,
} from '@prisma/client';
import * as reversal from './reversal.service';
import * as account from './account.service';
import * as rules from './rules.service';

const prisma = new PrismaClient();
const TAG = 'zz-rev';
let ruleVersion: Awaited<ReturnType<typeof rules.active>>;

async function sweep() {
  const orders = await prisma.order.findMany({
    where: { email: { startsWith: TAG } },
    select: { id: true },
  });
  const orderIds = orders.map((o) => o.id);
  const customers = await prisma.customer.findMany({
    where: { email: { startsWith: TAG } },
    select: { id: true },
  });
  const custIds = customers.map((c) => c.id);
  const accounts = await prisma.loyaltyAccount.findMany({
    where: { customerId: { in: custIds } },
    select: { id: true },
  });
  const accIds = accounts.map((a) => a.id);

  if (orderIds.length) {
    await prisma.orderReturn.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderLoyalty.deleteMany({ where: { orderId: { in: orderIds } } });
  }
  if (accIds.length) {
    // Documented escape hatch from the migration: disable, delete, re-enable.
    await prisma.$executeRawUnsafe('ALTER TABLE "CoinLedger" DISABLE TRIGGER coin_ledger_no_delete');
    await prisma.coinLedger.deleteMany({ where: { accountId: { in: accIds } } });
    await prisma.$executeRawUnsafe('ALTER TABLE "CoinLedger" ENABLE TRIGGER coin_ledger_no_delete');
    await prisma.coinReservation.deleteMany({ where: { accountId: { in: accIds } } });
    await prisma.coinLot.deleteMany({ where: { accountId: { in: accIds } } });
    await prisma.loyaltyAccount.deleteMany({ where: { id: { in: accIds } } });
  }
  if (orderIds.length) await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  if (custIds.length) await prisma.customer.deleteMany({ where: { id: { in: custIds } } });

  await prisma.productFamily.deleteMany({ where: { slug: { startsWith: TAG } } });
}

/**
 * Build an order that has already earned and (optionally) redeemed, with the
 * per-line allocation snapshot written exactly as checkout would write it.
 */
async function makeOrder(opts: {
  label: string;
  lines: { pricePaise: number; qty: number }[];
  coinsRedeemed?: number;
  /** Seed this many AVAILABLE coins and mark them as the redemption source. */
  grantedCoins: number;
  grantState?: CoinLotState;
}) {
  const customer = await prisma.customer.create({
    data: {
      email: `${TAG}-${opts.label}-${Date.now()}@zewafeeds.test`,
      firstName: 'Rev',
      lastName: 'Test',
    },
    select: { id: true },
  });
  const acc = await prisma.$transaction((tx) => account.ensureAccount(tx, customer.id));
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

  const subtotal = opts.lines.reduce((s, l) => s + l.pricePaise * l.qty, 0);
  const order = await prisma.order.create({
    data: {
      orderNo: `${TAG}-${opts.label}-${Date.now().toString(36)}`,
      customerId: customer.id,
      email: `${TAG}-${opts.label}@zewafeeds.test`,
      phone: '+919000000000',
      status: OrderStatus.DELIVERED,
      paymentStatus: PaymentStatus.PAID,
      paymentMethod: PaymentMethod.RAZORPAY,
      subtotalPaise: subtotal,
      totalPaise: subtotal,
      shippingAddress: { name: 'T', line1: 'L', city: 'C', state: 'Kerala', pincode: '600001' },
      deliveredAt: new Date(),
    },
    select: { id: true },
  });

  // Coin allocation, pro rata by line value — exactly what checkout persists.
  const coins = opts.coinsRedeemed ?? 0;
  const items: { id: string; allocatedCoins: number }[] = [];
  let assigned = 0;
  const created = [];
  for (let i = 0; i < opts.lines.length; i++) {
    const l = opts.lines[i]!;
    const lineTotal = l.pricePaise * l.qty;
    const share = Math.floor((coins * lineTotal) / subtotal);
    assigned += share;
    created.push({ lineTotal, share, qty: l.qty });
  }
  // Remainder to the highest-value line (§6.5).
  if (coins - assigned > 0) {
    const biggest = created.reduce((a, b) => (b.lineTotal > a.lineTotal ? b : a));
    biggest.share += coins - assigned;
  }

  for (let i = 0; i < created.length; i++) {
    const c = created[i]!;
    const item = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productName: `Item ${i}`,
        sku: `${TAG}-SKU-${i}-${Date.now()}`,
        pack: '1kg',
        unitPricePaise: opts.lines[i]!.pricePaise,
        qty: c.qty,
        hsn: '2309',
        taxRatePct: 0, // Zewa catalogue is 0% GST
        lineTotalPaise: c.lineTotal,
        allocatedCoins: c.share,
        allocatedCoinDiscountPaise: c.share * 100,
        preTaxNetPaidPaise: c.lineTotal - c.share * 100,
        earnEligible: true,
        coinRedeemable: true,
      },
      select: { id: true },
    });
    items.push({ id: item.id, allocatedCoins: c.share });
  }

  // The lot the redemption drew from, so restoration has somewhere to go.
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 365);
  const sourceLot = await prisma.coinLot.create({
    data: {
      accountId: acc.id,
      coinsGranted: Math.max(coins, 1),
      coinsRemaining: 0, // fully spent on this order
      state: coins > 0 ? CoinLotState.REDEEMED : CoinLotState.AVAILABLE,
      sourceType: CoinSourceType.MANUAL,
      earnedAt: new Date(),
      expiresAt,
      ruleVersionId: ruleVersion.id,
      claimedAt: new Date(),
    },
  });

  // The grant this order produced.
  const grantLot = await prisma.coinLot.create({
    data: {
      accountId: acc.id,
      coinsGranted: Math.max(opts.grantedCoins, 1),
      coinsRemaining: opts.grantedCoins,
      state: opts.grantState ?? CoinLotState.AVAILABLE,
      sourceType: CoinSourceType.ORDER,
      orderId: order.id,
      earnedAt: new Date(),
      expiresAt,
      ruleVersionId: ruleVersion.id,
      claimedAt: new Date(),
    },
  });

  await prisma.loyaltyAccount.update({
    where: { id: acc.id },
    data: {
      availableCoins: opts.grantState === CoinLotState.PENDING ? 0 : opts.grantedCoins,
      pendingCoins: opts.grantState === CoinLotState.PENDING ? opts.grantedCoins : 0,
    },
  });

  await prisma.orderLoyalty.create({
    data: {
      orderId: order.id,
      accountId: acc.id,
      ruleVersionId: ruleVersion.id,
      preTaxEarnBasePaise: subtotal - coins * 100,
      coinsGrantedCurrent: opts.grantedCoins,
      grantState: opts.grantState ?? CoinLotState.AVAILABLE,
      coinsRedeemed: coins,
      redemptionLotMap: coins > 0 ? [{ lotId: sourceLot.id, coins }] : [],
      coinDiscountPaise: coins * 100,
    },
  });

  return { orderId: order.id, accountId: acc.id, items, sourceLot, grantLot };
}

beforeAll(async () => {
  await sweep();
  ruleVersion = await rules.active(prisma);
});

afterAll(async () => {
  await sweep();
  await prisma.$disconnect();
});

describe('§6.5 Partial return — restore and clawback are independent movements', () => {
  it('restores the returned line’s coins and reduces the grant separately', async () => {
    // §6.5 exactly: ₹1,200 + ₹800, 210 coins redeemed (126/84), 36 coins granted.
    // Return item B → +84 restored, grant falls 36 → 21, net +69.
    const o = await makeOrder({
      label: 'partial',
      lines: [{ pricePaise: 120000, qty: 1 }, { pricePaise: 80000, qty: 1 }],
      coinsRedeemed: 210,
      grantedCoins: 36,
    });

    expect(o.items[1]!.allocatedCoins).toBe(84); // pro-rata split holds

    const res = await reversal.reverseOrder({
      orderId: o.orderId,
      returnedLines: [{ orderItemId: o.items[1]!.id, qty: 1 }],
      sourceEventId: `${TAG}-partial-1`,
      kind: ReturnKind.RETURN,
    });

    expect(res.restored).toBe(84);
    // Retained = A only: ₹1,200 − ₹126 coin discount = ₹1,074 → 21 coins.
    // Clawback = 36 − 21 = 15, exactly §6.5's figure.
    expect(res.clawedBack).toBe(15);

    // The two movements are SEPARATE ledger rows, never netted (§7.2).
    const rows = await prisma.coinLedger.findMany({
      where: { orderId: o.orderId },
      select: { reason: true, coinsDelta: true },
    });
    expect(rows.some((r) => r.reason === 'RESTORE' && r.coinsDelta === 84)).toBe(true);
    expect(rows.some((r) => r.reason === 'CLAWBACK' && r.coinsDelta === -15)).toBe(true);
  });

  it('refunds cash net of the coin discount — never the list price', async () => {
    const o = await makeOrder({
      label: 'cash',
      lines: [{ pricePaise: 120000, qty: 1 }, { pricePaise: 80000, qty: 1 }],
      coinsRedeemed: 210,
      grantedCoins: 36,
    });
    const res = await reversal.reverseOrder({
      orderId: o.orderId,
      returnedLines: [{ orderItemId: o.items[1]!.id, qty: 1 }],
      sourceEventId: `${TAG}-cash-1`,
      kind: ReturnKind.RETURN,
    });
    // B is ₹800 with 84 coins on it → ₹716 was paid in cash for it.
    expect(res.cashRefundPaise).toBe(71600);
  });
});

describe('§7.1 THE CORRECTNESS TEST', () => {
  it('leaves the customer where they would have been had they ordered only the retained item', async () => {
    const o = await makeOrder({
      label: 'invariant',
      lines: [{ pricePaise: 120000, qty: 1 }, { pricePaise: 80000, qty: 1 }],
      coinsRedeemed: 210,
      grantedCoins: 36,
    });

    await reversal.reverseOrder({
      orderId: o.orderId,
      returnedLines: [{ orderItemId: o.items[1]!.id, qty: 1 }],
      sourceEventId: `${TAG}-inv-1`,
      kind: ReturnKind.RETURN,
    });

    const loyalty = await prisma.orderLoyalty.findUniqueOrThrow({
      where: { orderId: o.orderId },
    });

    // Had the customer ordered only A (₹1,200) and spent A's 126 coins, the
    // earn base would be ₹1,074 and the grant 21 coins. That is exactly where
    // the reversal must land.
    expect(loyalty.preTaxEarnBasePaise).toBe(120000 - 12600);
    expect(loyalty.coinsGrantedCurrent).toBe(21);
  });
});

describe('§8.2 #19 Multiple sequential partial returns', () => {
  it('recomputes from cumulative state rather than chaining deltas', async () => {
    const o = await makeOrder({
      label: 'seq',
      lines: [
        { pricePaise: 120000, qty: 1 },
        { pricePaise: 80000, qty: 1 },
        { pricePaise: 50000, qty: 1 },
      ],
      coinsRedeemed: 0,
      grantedCoins: 50, // FLOOR(250000/5000) = 50
    });

    await reversal.reverseOrder({
      orderId: o.orderId,
      returnedLines: [{ orderItemId: o.items[2]!.id, qty: 1 }],
      sourceEventId: `${TAG}-seq-1`,
      kind: ReturnKind.RETURN,
    });
    const afterFirst = await prisma.orderLoyalty.findUniqueOrThrow({
      where: { orderId: o.orderId },
    });
    expect(afterFirst.coinsGrantedCurrent).toBe(40); // ₹2,000 retained → 40

    await reversal.reverseOrder({
      orderId: o.orderId,
      returnedLines: [{ orderItemId: o.items[1]!.id, qty: 1 }],
      sourceEventId: `${TAG}-seq-2`,
      kind: ReturnKind.RETURN,
    });
    const afterSecond = await prisma.orderLoyalty.findUniqueOrThrow({
      where: { orderId: o.orderId },
    });
    expect(afterSecond.coinsGrantedCurrent).toBe(24); // ₹1,200 retained → 24
  });

  it('handles a partial quantity return on a multi-unit line', async () => {
    const o = await makeOrder({
      label: 'qty',
      lines: [{ pricePaise: 50000, qty: 4 }], // ₹2,000 total
      coinsRedeemed: 0,
      grantedCoins: 40,
    });

    await reversal.reverseOrder({
      orderId: o.orderId,
      returnedLines: [{ orderItemId: o.items[0]!.id, qty: 2 }],
      sourceEventId: `${TAG}-qty-1`,
      kind: ReturnKind.RETURN,
    });

    const after = await prisma.orderLoyalty.findUniqueOrThrow({ where: { orderId: o.orderId } });
    expect(after.coinsGrantedCurrent).toBe(20); // half retained → ₹1,000 → 20
  });
});

describe('§8.2 #26 / §7.7 Adversarial — duplicate and excessive reversals', () => {
  it('a duplicate source event is a no-op, not a second restoration', async () => {
    const o = await makeOrder({
      label: 'dup',
      lines: [{ pricePaise: 120000, qty: 1 }, { pricePaise: 80000, qty: 1 }],
      coinsRedeemed: 210,
      grantedCoins: 36,
    });

    const first = await reversal.reverseOrder({
      orderId: o.orderId,
      returnedLines: [{ orderItemId: o.items[1]!.id, qty: 1 }],
      sourceEventId: `${TAG}-dup-1`,
      kind: ReturnKind.RETURN,
    });
    const second = await reversal.reverseOrder({
      orderId: o.orderId,
      returnedLines: [{ orderItemId: o.items[1]!.id, qty: 1 }],
      sourceEventId: `${TAG}-dup-1`, // same event id
      kind: ReturnKind.RETURN,
    });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.restored).toBe(0);

    // Exactly one RESTORE row exists.
    const restores = await prisma.coinLedger.count({
      where: { orderId: o.orderId, reason: 'RESTORE' },
    });
    expect(restores).toBe(1);
  });

  it('rejects a return of more units than remain outstanding', async () => {
    const o = await makeOrder({
      label: 'over',
      lines: [{ pricePaise: 50000, qty: 2 }],
      coinsRedeemed: 0,
      grantedCoins: 20,
    });

    await reversal.reverseOrder({
      orderId: o.orderId,
      returnedLines: [{ orderItemId: o.items[0]!.id, qty: 2 }],
      sourceEventId: `${TAG}-over-1`,
      kind: ReturnKind.RETURN,
    });

    // Everything is already back; a further return must be refused.
    await expect(
      reversal.reverseOrder({
        orderId: o.orderId,
        returnedLines: [{ orderItemId: o.items[0]!.id, qty: 1 }],
        sourceEventId: `${TAG}-over-2`,
        kind: ReturnKind.RETURN,
      }),
    ).rejects.toThrow(/exceed the quantity/i);
  });

  it('never restores more coins than were redeemed', async () => {
    const o = await makeOrder({
      label: 'maxrestore',
      lines: [{ pricePaise: 120000, qty: 1 }, { pricePaise: 80000, qty: 1 }],
      coinsRedeemed: 210,
      grantedCoins: 36,
    });

    // Return everything — restoration must total exactly 210, never more.
    const res = await reversal.reverseOrder({
      orderId: o.orderId,
      returnedLines: [
        { orderItemId: o.items[0]!.id, qty: 1 },
        { orderItemId: o.items[1]!.id, qty: 1 },
      ],
      sourceEventId: `${TAG}-maxrestore-1`,
      kind: ReturnKind.RETURN,
    });
    expect(res.restored).toBe(210);

    const loyalty = await prisma.orderLoyalty.findUniqueOrThrow({
      where: { orderId: o.orderId },
    });
    expect(loyalty.coinsAlreadyRestored).toBeLessThanOrEqual(loyalty.coinsRedeemed);
  });
});

describe('§6.6 Full return of a coin-paid order', () => {
  it('restores every coin and claws the grant back to zero', async () => {
    const o = await makeOrder({
      label: 'full',
      lines: [{ pricePaise: 150000, qty: 1 }],
      coinsRedeemed: 340,
      grantedCoins: 23,
    });

    const res = await reversal.reverseOrder({
      orderId: o.orderId,
      returnedLines: [{ orderItemId: o.items[0]!.id, qty: 1 }],
      sourceEventId: `${TAG}-full-1`,
      kind: ReturnKind.RETURN,
    });

    expect(res.restored).toBe(340);
    expect(res.clawedBack).toBe(23);

    const loyalty = await prisma.orderLoyalty.findUniqueOrThrow({
      where: { orderId: o.orderId },
    });
    expect(loyalty.coinsGrantedCurrent).toBe(0);
  });
});

describe('§6.7 Clawback beyond the −50 floor', () => {
  it('floors the balance at −50 and records the full deficit', async () => {
    // A large order whose coins have been spent elsewhere: the grant is 1,520
    // but the balance is 0, so the clawback cannot be met.
    const o = await makeOrder({
      label: 'floor',
      lines: [{ pricePaise: 8000000, qty: 1 }], // ₹80,000
      coinsRedeemed: 0,
      grantedCoins: 1600,
    });
    // Simulate the coins having been spent: zero the balance and the lot.
    await prisma.loyaltyAccount.update({
      where: { id: o.accountId },
      data: { availableCoins: 0 },
    });
    await prisma.coinLot.update({
      where: { id: o.grantLot.id },
      data: { coinsRemaining: 0, state: CoinLotState.REDEEMED },
    });

    await reversal.reverseOrder({
      orderId: o.orderId,
      returnedLines: [{ orderItemId: o.items[0]!.id, qty: 1 }],
      sourceEventId: `${TAG}-floor-1`,
      kind: ReturnKind.RETURN,
    });

    const acc = await prisma.loyaltyAccount.findUniqueOrThrow({ where: { id: o.accountId } });
    expect(acc.availableCoins).toBe(-50); // operative floor
    expect(acc.flaggedDeficit).toBe(1550); // 1,600 − 50, recorded in full
    expect(acc.status).toBe('FROZEN'); // surfaced for review
  });
});

describe('§7.3 Pending grants are reduced, not clawed back', () => {
  it('reduces a still-pending lot rather than debiting the balance', async () => {
    const o = await makeOrder({
      label: 'pending',
      lines: [{ pricePaise: 120000, qty: 1 }, { pricePaise: 80000, qty: 1 }],
      coinsRedeemed: 0,
      grantedCoins: 40,
      grantState: CoinLotState.PENDING,
    });

    await reversal.reverseOrder({
      orderId: o.orderId,
      returnedLines: [{ orderItemId: o.items[1]!.id, qty: 1 }],
      sourceEventId: `${TAG}-pending-1`,
      kind: ReturnKind.RETURN,
    });

    const acc = await prisma.loyaltyAccount.findUniqueOrThrow({ where: { id: o.accountId } });
    // Balance untouched — the coins were never spendable.
    expect(acc.availableCoins).toBe(0);
    expect(acc.pendingCoins).toBe(24); // 40 → 24 (₹1,200 retained)
  });
});

describe('§7.6 Restoring into an expired lot creates a grace lot', () => {
  it('creates a 30-day grace lot referencing the original', async () => {
    const o = await makeOrder({
      label: 'grace',
      lines: [{ pricePaise: 120000, qty: 1 }],
      coinsRedeemed: 100,
      grantedCoins: 20,
    });

    // The lot the coins came from has since expired.
    const past = new Date();
    past.setDate(past.getDate() - 5);
    await prisma.coinLot.update({
      where: { id: o.sourceLot.id },
      data: { state: CoinLotState.EXPIRED, expiresAt: past },
    });

    await reversal.reverseOrder({
      orderId: o.orderId,
      returnedLines: [{ orderItemId: o.items[0]!.id, qty: 1 }],
      sourceEventId: `${TAG}-grace-1`,
      kind: ReturnKind.RETURN,
    });

    const grace = await prisma.coinLot.findFirst({
      where: { accountId: o.accountId, parentLotId: o.sourceLot.id },
    });
    expect(grace).not.toBeNull();
    expect(grace!.coinsRemaining).toBe(100);
    // 30 days out, not the original expiry.
    const days = Math.round((grace!.expiresAt.getTime() - Date.now()) / 86400000);
    expect(days).toBeGreaterThanOrEqual(29);
    expect(days).toBeLessThanOrEqual(30);
  });
});

describe('§8.2 #15 RTO', () => {
  it('voids the grant, restores coins and increments the RTO counter', async () => {
    const o = await makeOrder({
      label: 'rto',
      lines: [{ pricePaise: 120000, qty: 1 }],
      coinsRedeemed: 50,
      grantedCoins: 14,
      grantState: CoinLotState.PENDING,
    });

    const res = await reversal.handleRto({
      orderId: o.orderId,
      sourceEventId: `${TAG}-rto-1`,
    });

    expect(res.restored).toBe(50);
    expect(res.voided).toBe(14);
    expect(res.rtoCount).toBe(1);

    const acc = await prisma.loyaltyAccount.findUniqueOrThrow({ where: { id: o.accountId } });
    expect(acc.pendingCoins).toBe(0); // nothing spendable left behind
  });
});
