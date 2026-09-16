/**
 * Adversarial: historical integrity and lot manipulation — ZSOP004 §7.4, §7.7,
 * §8.4 #35, §4.2.
 *
 * The existing suites cover out-of-order convergence at the arithmetic level
 * (coin-math) and FIFO *ordering* (ledger). This file attacks the two things
 * those cannot reach:
 *
 *   CAN THE PAST BE REWRITTEN? §7.4 and §8.4 #35 promise that a catalogue price
 *   edit or a rule-version change cannot alter what a completed order earned or
 *   how it unwinds. Both are promises about data the customer no longer
 *   controls, which makes them exactly the kind of thing that rots silently —
 *   nothing fails loudly when a return is recomputed against today's price, it
 *   just refunds the wrong amount.
 *
 *   CAN THE CUSTOMER CHOOSE WHICH LOT IS SPENT? §4.2 consumes nearest-expiry
 *   first because it "maximises the value the customer captures at marginal cost
 *   to us". A customer who could steer consumption toward the far-dated lot
 *   would strand the near-dated one and let it expire, then claim the balance
 *   they "still have" — turning a customer-favourable rule into a cost.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
import * as redemption from './redemption.service';
import * as account from './account.service';
import * as rules from './rules.service';
import { coinsForBase } from './coin-math';

const prisma = new PrismaClient();
const TAG = 'zzadv';
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
  // Rule versions this file created, so it cannot leave a stray active row.
  await prisma.loyaltyRuleVersion.deleteMany({ where: { label: { startsWith: TAG } } });
  await prisma.coupon.deleteMany({ where: { code: { startsWith: TAG.toUpperCase() } } });
}

/**
 * An order that has already earned, with the per-line allocation snapshot
 * written exactly as checkout writes it.
 */
async function makeOrder(opts: {
  label: string;
  pricePaise: number;
  qty: number;
  grantedCoins: number;
  ruleVersionId?: string;
}) {
  const customer = await prisma.customer.create({
    data: {
      email: `${TAG}-${opts.label}-${Date.now()}${Math.random().toString(36).slice(2, 5)}@zewafeeds.test`,
      firstName: 'Adv',
      lastName: 'Test',
    },
    select: { id: true },
  });
  const acc = await prisma.$transaction((tx) => account.ensureAccount(tx, customer.id));
  await prisma.loyaltyAccount.update({
    where: { id: acc.id },
    data: { availableCoins: opts.grantedCoins },
  });

  const family = await prisma.productFamily.create({
    data: {
      slug: `${TAG}-${opts.label}-${Date.now()}`,
      name: 'Adversarial Feed',
      category: 'FLOATING_PELLETS',
      status: 'ACTIVE',
      shortDesc: 'fixture',
    },
    select: { id: true },
  });
  const variant = await prisma.productVariant.create({
    data: {
      familyId: family.id,
      sku: `${TAG}-${opts.label}-${Date.now()}`.toUpperCase(),
      pack: '1kg',
      pricePaise: opts.pricePaise,
      mrpPaise: opts.pricePaise,
      stock: 100,
      isActive: true,
    },
    select: { id: true },
  });

  const lineTotal = opts.pricePaise * opts.qty;
  const order = await prisma.order.create({
    data: {
      orderNo: `${TAG}-${opts.label}-${Date.now().toString(36)}`,
      customerId: customer.id,
      email: `${TAG}-${opts.label}@zewafeeds.test`,
      phone: '+919000000000',
      status: OrderStatus.DELIVERED,
      paymentStatus: PaymentStatus.PAID,
      paymentMethod: PaymentMethod.RAZORPAY,
      subtotalPaise: lineTotal,
      totalPaise: lineTotal,
      deliveredAt: new Date(),
      shippingAddress: { name: 'A', line1: 'L', city: 'C', state: 'Kerala', pincode: '682001' },
      items: {
        create: {
          variantId: variant.id,
          productName: 'Adversarial Feed',
          sku: `${TAG}-${opts.label}-ITEM-${Date.now()}`,
          pack: '1kg',
          unitPricePaise: opts.pricePaise,
          qty: opts.qty,
          hsn: '2309',
          taxRatePct: 0,
          lineTotalPaise: lineTotal,
          // The §7.4 snapshot: what was ACTUALLY paid, frozen at creation.
          preTaxNetPaidPaise: lineTotal,
          allocatedCoins: 0,
          earnEligible: true,
          coinRedeemable: true,
        },
      },
    },
    select: { id: true, items: { select: { id: true } } },
  });

  /*
   * Only create the order's grant lot when it actually granted something.
   *
   * `CoinLot_coinsGranted_positive` (CHECK coinsGranted > 0) rejects a
   * zero-coin lot — correctly: a lot that never held a coin is not a record of
   * anything. The FIFO tests below pass `grantedCoins: 0` because they seed
   * their own lots with deliberate expiry dates, so there is no order lot to
   * write here.
   */
  if (opts.grantedCoins > 0) {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 365);
    await prisma.coinLot.create({
      data: {
        accountId: acc.id,
        coinsGranted: opts.grantedCoins,
        coinsRemaining: opts.grantedCoins,
        state: CoinLotState.AVAILABLE,
        sourceType: CoinSourceType.ORDER,
        orderId: order.id,
        earnedAt: new Date(),
        expiresAt,
        ruleVersionId: opts.ruleVersionId ?? ruleVersion.id,
        claimedAt: new Date(),
      },
    });
  }

  await prisma.orderLoyalty.create({
    data: {
      orderId: order.id,
      accountId: acc.id,
      ruleVersionId: opts.ruleVersionId ?? ruleVersion.id,
      preTaxEarnBasePaise: lineTotal,
      coinsGrantedCurrent: opts.grantedCoins,
      coinsRedeemed: 0,
      redemptionLotMap: [],
    },
  });

  return {
    orderId: order.id,
    accountId: acc.id,
    variantId: variant.id,
    itemId: order.items[0]!.id,
  };
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

describe('§7.4 A catalogue price change cannot rewrite a completed order', () => {
  it('recomputes a return against the PAID price, not today\'s price', async () => {
    // ₹1,000 × 2 = ₹2,000 → 40 coins.
    const o = await makeOrder({ label: 'price', pricePaise: 100000, qty: 2, grantedCoins: 40 });

    /*
     * The attack: the catalogue price triples after delivery. If the reversal
     * read the live variant instead of the order-line snapshot, returning one
     * unit would credit the customer against ₹3,000 of "retained" value and
     * refund cash that was never paid.
     */
    await prisma.productVariant.update({
      where: { id: o.variantId },
      data: { pricePaise: 300000, mrpPaise: 300000 },
    });

    const res = await reversal.reverseOrder({
      orderId: o.orderId,
      returnedLines: [{ orderItemId: o.itemId, qty: 1 }],
      sourceEventId: `${TAG}-price-1`,
      kind: ReturnKind.RETURN,
    });

    // Half the order retained at the PAID price: ₹1,000 → 20 coins, so the
    // grant falls 40 → 20 and the cash refund is the ₹1,000 actually paid.
    expect(res.clawedBack).toBe(20);
    expect(res.cashRefundPaise).toBe(100000);

    const loyalty = await prisma.orderLoyalty.findUniqueOrThrow({
      where: { orderId: o.orderId },
    });
    expect(loyalty.coinsGrantedCurrent).toBe(20);
    expect(loyalty.preTaxEarnBasePaise).toBe(100000);
  });

  it('a price DROP does not claw back more than was granted', async () => {
    // The mirror case: a discount after purchase must not retroactively shrink
    // what the customer earned.
    const o = await makeOrder({ label: 'pricedrop', pricePaise: 100000, qty: 2, grantedCoins: 40 });
    await prisma.productVariant.update({
      where: { id: o.variantId },
      data: { pricePaise: 1000, mrpPaise: 1000 },
    });

    const res = await reversal.reverseOrder({
      orderId: o.orderId,
      returnedLines: [{ orderItemId: o.itemId, qty: 1 }],
      sourceEventId: `${TAG}-pricedrop-1`,
      kind: ReturnKind.RETURN,
    });

    expect(res.clawedBack).toBe(20);
    expect(res.cashRefundPaise).toBe(100000);
  });

  it('deleting the variant entirely does not break the reversal', async () => {
    /*
     * §7.4 snapshots onto the line precisely so history survives the catalogue.
     * `OrderItem.variantId` is `onDelete: SetNull`, so this is a real scenario,
     * not a contrived one.
     */
    const o = await makeOrder({ label: 'gone', pricePaise: 50000, qty: 2, grantedCoins: 20 });
    await prisma.productVariant.delete({ where: { id: o.variantId } });

    const res = await reversal.reverseOrder({
      orderId: o.orderId,
      returnedLines: [{ orderItemId: o.itemId, qty: 1 }],
      sourceEventId: `${TAG}-gone-1`,
      kind: ReturnKind.RETURN,
    });

    expect(res.clawedBack).toBe(10);
    expect(res.cashRefundPaise).toBe(50000);
  });
});

describe('§8.4 #35 A rule change is never retroactive', () => {
  it('unwinds an old order under the rule version it was PLACED under', async () => {
    /*
     * "Every order stores rule_version_id. All later recomputation uses the
     * stored version. Config is never retroactive."
     *
     * The attack is the reverse of the obvious one: not a customer gaming a new
     * rate, but the business silently re-rating old orders when it changes the
     * programme — which would make a customer's final position depend on WHEN
     * they returned rather than WHAT they bought.
     */
    const generous = await prisma.loyaltyRuleVersion.create({
      data: {
        label: `${TAG}-generous-${Date.now()}`,
        isActive: false,
        // 1 coin per ₹10 — five times the standard rate.
        earnGranularityPaise: 1000,
        coinsPerStep: 1,
      },
      select: { id: true },
    });

    // ₹2,000 at the generous rate → 200 coins.
    const o = await makeOrder({
      label: 'ruleold',
      pricePaise: 100000,
      qty: 2,
      grantedCoins: 200,
      ruleVersionId: generous.id,
    });

    // The programme later moves to the standard rate. The ACTIVE version is now
    // far less generous than the one this order was priced under.
    const res = await reversal.reverseOrder({
      orderId: o.orderId,
      returnedLines: [{ orderItemId: o.itemId, qty: 1 }],
      sourceEventId: `${TAG}-ruleold-1`,
      kind: ReturnKind.RETURN,
    });

    /*
     * Half retained = ₹1,000. Under the STORED version that is 100 coins, so
     * the clawback is 100. Under today's active version it would be 20 — and a
     * clawback of 180 would take coins the customer legitimately earned.
     */
    const loyalty = await prisma.orderLoyalty.findUniqueOrThrow({
      where: { orderId: o.orderId },
    });
    expect(loyalty.coinsGrantedCurrent).toBe(100);
    expect(res.clawedBack).toBe(100);
  });

  it('the stored version survives the active version changing mid-life', async () => {
    const o = await makeOrder({ label: 'ruleswap', pricePaise: 100000, qty: 2, grantedCoins: 40 });

    // Flip the active version between the order and the return.
    const current = await prisma.loyaltyRuleVersion.findFirstOrThrow({ where: { isActive: true } });
    const { id: _id, label: _l, createdAt: _c, isActive: _a, createdById: _cb, ...rest } = current;
    await prisma.loyaltyRuleVersion.update({
      where: { id: current.id },
      data: { isActive: false },
    });
    await prisma.loyaltyRuleVersion.create({
      data: { ...rest, label: `${TAG}-swap-${Date.now()}`, isActive: true, earnGranularityPaise: 100 },
    });
    rules.invalidate();

    try {
      const res = await reversal.reverseOrder({
        orderId: o.orderId,
        returnedLines: [{ orderItemId: o.itemId, qty: 1 }],
        sourceEventId: `${TAG}-ruleswap-1`,
        kind: ReturnKind.RETURN,
      });
      // Still the ORIGINAL ₹50 granularity: ₹1,000 retained → 20 coins.
      expect(res.clawedBack).toBe(20);
    } finally {
      // Restore the real active version, or every later suite reads a ₹1 rate.
      await prisma.loyaltyRuleVersion.deleteMany({ where: { label: { startsWith: `${TAG}-swap` } } });
      await prisma.loyaltyRuleVersion.update({
        where: { id: current.id },
        data: { isActive: true },
      });
      rules.invalidate();
    }
  });

  it('the arithmetic itself is version-driven, not hardcoded', () => {
    // A guard on the pure function: the same base under two rule versions must
    // give two different answers, or "config is never retroactive" is vacuous
    // because config never mattered.
    const standard = { earnGranularityPaise: 5000, coinsPerStep: 1, minEarnBasePaise: 5000,
      coinValuePaise: 100, minRedemptionCoins: 10, maxRedemptionPct: 100 };
    const generous = { ...standard, earnGranularityPaise: 1000 };
    expect(coinsForBase(100000, standard)).toBe(20);
    expect(coinsForBase(100000, generous)).toBe(100);
  });
});

describe('§4.2 FIFO cannot be steered by the customer', () => {
  it('always consumes nearest-expiry first, whatever order the lots arrived in', async () => {
    const o = await makeOrder({ label: 'fifo', pricePaise: 50000, qty: 1, grantedCoins: 0 });

    const near = new Date();
    near.setDate(near.getDate() + 10);
    const far = new Date();
    far.setDate(far.getDate() + 300);

    // Created far-first, so insertion order and expiry order disagree.
    const farLot = await prisma.coinLot.create({
      data: {
        accountId: o.accountId, coinsGranted: 100, coinsRemaining: 100,
        state: CoinLotState.AVAILABLE, sourceType: CoinSourceType.MANUAL,
        earnedAt: new Date(), expiresAt: far, ruleVersionId: ruleVersion.id, claimedAt: new Date(),
      },
      select: { id: true },
    });
    const nearLot = await prisma.coinLot.create({
      data: {
        accountId: o.accountId, coinsGranted: 60, coinsRemaining: 60,
        state: CoinLotState.AVAILABLE, sourceType: CoinSourceType.MANUAL,
        earnedAt: new Date(), expiresAt: near, ruleVersionId: ruleVersion.id, claimedAt: new Date(),
      },
      select: { id: true },
    });

    const lots = await prisma.$transaction((tx) => account.spendableLots(tx, o.accountId));
    const plan = account.planConsumption(lots, 80);

    // The near lot is drained first, then the remainder comes from the far one.
    expect(plan[0]!.lotId).toBe(nearLot.id);
    expect(plan[0]!.coins).toBe(60);
    expect(plan[1]!.lotId).toBe(farLot.id);
    expect(plan[1]!.coins).toBe(20);
  });

  it('the plan is a server decision — the caller cannot name a lot', () => {
    /*
     * The structural defence. `planConsumption` takes an AMOUNT, never a lot
     * id, so there is no parameter through which a request could ask for the
     * far-dated lot and strand the near-dated one to expire.
     */
    const lots = [
      { id: 'near', coinsRemaining: 30 },
      { id: 'far', coinsRemaining: 500 },
    ];
    expect(account.planConsumption(lots, 30)).toEqual([{ lotId: 'near', coins: 30 }]);
    expect(account.planConsumption.length).toBe(2); // (lots, coins) — no lot selector
  });

  it('a held lot is not offered twice across concurrent carts', async () => {
    // Re-reading `spendableLots` must not let the same coins back into a second
    // plan; the reservation subtraction lives in redemption.service, so here we
    // assert the primitive it depends on — lot remainders are the only source.
    const o = await makeOrder({ label: 'fifohold', pricePaise: 50000, qty: 1, grantedCoins: 0 });
    const soon = new Date();
    soon.setDate(soon.getDate() + 30);
    await prisma.coinLot.create({
      data: {
        accountId: o.accountId, coinsGranted: 40, coinsRemaining: 40,
        state: CoinLotState.AVAILABLE, sourceType: CoinSourceType.MANUAL,
        earnedAt: new Date(), expiresAt: soon, ruleVersionId: ruleVersion.id, claimedAt: new Date(),
      },
    });

    const lots = await prisma.$transaction((tx) => account.spendableLots(tx, o.accountId));
    const total = lots.reduce((s, l) => s + l.coinsRemaining, 0);
    // Asking for more than exists must fail rather than over-allocate.
    expect(() => account.planConsumption(lots, total + 1)).toThrow(/balance has changed/i);
  });

  it('an expired lot is never planned against, however near its date', async () => {
    const o = await makeOrder({ label: 'fifoexp', pricePaise: 50000, qty: 1, grantedCoins: 0 });
    const past = new Date();
    past.setDate(past.getDate() - 1);
    await prisma.coinLot.create({
      data: {
        accountId: o.accountId, coinsGranted: 999, coinsRemaining: 999,
        state: CoinLotState.AVAILABLE, sourceType: CoinSourceType.MANUAL,
        earnedAt: new Date(), expiresAt: past, ruleVersionId: ruleVersion.id, claimedAt: new Date(),
      },
    });

    const lots = await prisma.$transaction((tx) => account.spendableLots(tx, o.accountId));
    expect(lots).toHaveLength(0);
  });
});

describe('§4 A coupon may block coins outright', () => {
  /**
   * "Coupon stacking: allowed — coupon first, coins second. With a per-coupon
   * block flag for aggressive promotions."
   *
   * The flag is per-coupon and independent of `CouponStacking`: a promotion can
   * be freely stackable with other COUPONS and still be too thin to absorb a
   * coin discount on top.
   */
  async function makeCoupon(label: string, blocksCoins: boolean) {
    // `startsAt`/`endsAt` are required on Coupon — a promotion with no window
    // is not a promotion. Open now, closing well past any test's lifetime.
    const startsAt = new Date();
    const endsAt = new Date();
    endsAt.setDate(endsAt.getDate() + 365);

    return prisma.coupon.create({
      data: {
        code: `${TAG}-${label}-${Date.now()}`.toUpperCase(),
        discountType: 'PERCENTAGE',
        discountValue: 50,
        startsAt,
        endsAt,
        blocksCoins,
      },
      select: { code: true },
    });
  }

  async function seedSpender(label: string, coins: number) {
    const customer = await prisma.customer.create({
      data: {
        email: `${TAG}-${label}-${Date.now()}${Math.random().toString(36).slice(2, 5)}@zewafeeds.test`,
        firstName: 'Coupon',
        lastName: 'Test',
      },
      select: { id: true },
    });
    const acc = await prisma.$transaction((tx) => account.ensureAccount(tx, customer.id));
    await prisma.loyaltyAccount.update({
      where: { id: acc.id },
      data: { availableCoins: coins },
    });
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 365);
    await prisma.coinLot.create({
      data: {
        accountId: acc.id, coinsGranted: coins, coinsRemaining: coins,
        state: CoinLotState.AVAILABLE, sourceType: CoinSourceType.MANUAL,
        earnedAt: new Date(), expiresAt, ruleVersionId: ruleVersion.id, claimedAt: new Date(),
      },
    });
    return { customerId: customer.id, accountId: acc.id };
  }

  const LINES = [{
    id: 'L', lineTotalPaise: 200000, taxRatePct: 0,
    earnEligible: true, coinRedeemable: true, couponDiscountPaise: 0,
  }];

  /*
   * Redemption ships OFF (§13.2 silent accrual), and `reserve()` checks that
   * kill switch before anything else — so without this every assertion here
   * would read REDEMPTION_DISABLED and the two "allows coins" cases would pass
   * for entirely the wrong reason.
   *
   * Enabled per test and restored in afterAll, matching concurrency.test.ts.
   */
  beforeEach(async () => {
    await prisma.loyaltyRuleVersion.updateMany({
      where: { isActive: true },
      data: { redemptionEnabled: true },
    });
    rules.invalidate();
  });

  afterAll(async () => {
    await prisma.loyaltyRuleVersion.updateMany({
      where: { isActive: true },
      data: { redemptionEnabled: false },
    });
    rules.invalidate();
  });

  it('refuses the hold when an applied coupon blocks coins', async () => {
    const { customerId } = await seedSpender('cblock', 500);
    const coupon = await makeCoupon('block', true);

    const res = await redemption.reserve({
      customerId, coins: 100, lines: LINES,
      cartKey: `${TAG}-cblock-${Date.now()}`,
      couponCodes: [coupon.code],
    });

    expect(res.held).toBe(0);
    expect(res.reason).toBe('COUPON_BLOCKS_COINS');
  });

  it('hides the checkout box entirely for a blocking coupon (§10.1)', async () => {
    // An input the customer can fill in but never submit is worse than no input.
    const { customerId } = await seedSpender('cquote', 500);
    const coupon = await makeCoupon('quoteblock', true);
    expect(await redemption.quote(customerId, LINES, [coupon.code])).toBeNull();
  });

  it('allows coins alongside an ordinary coupon — stacking is the DEFAULT (§4)', async () => {
    const { customerId } = await seedSpender('cok', 500);
    const coupon = await makeCoupon('ok', false);

    const res = await redemption.reserve({
      customerId, coins: 100, lines: LINES,
      cartKey: `${TAG}-cok-${Date.now()}`,
      couponCodes: [coupon.code],
    });
    expect(res.held).toBe(100);
  });

  it('one blocking code in a stack refuses the whole cart', async () => {
    const { customerId } = await seedSpender('cmixed', 500);
    const fine = await makeCoupon('fine', false);
    const blocking = await makeCoupon('bad', true);

    const res = await redemption.reserve({
      customerId, coins: 100, lines: LINES,
      cartKey: `${TAG}-cmixed-${Date.now()}`,
      couponCodes: [fine.code, blocking.code],
    });
    expect(res.reason).toBe('COUPON_BLOCKS_COINS');
  });

  it('matches codes case-insensitively, as checkout does', async () => {
    const { customerId } = await seedSpender('ccase', 500);
    const coupon = await makeCoupon('case', true);

    const res = await redemption.reserve({
      customerId, coins: 100, lines: LINES,
      cartKey: `${TAG}-ccase-${Date.now()}`,
      couponCodes: [coupon.code.toLowerCase()],
    });
    expect(res.reason).toBe('COUPON_BLOCKS_COINS');
  });

  it('an unknown code is ignored rather than treated as blocking', async () => {
    const { customerId } = await seedSpender('cunknown', 500);
    const res = await redemption.reserve({
      customerId, coins: 100, lines: LINES,
      cartKey: `${TAG}-cunknown-${Date.now()}`,
      couponCodes: ['NOT-A-REAL-CODE'],
    });
    expect(res.held).toBe(100);
  });
});

describe('§7.7 Out-of-order reversal events at the service level', () => {
  it('two returns arriving in either sequence reach the same final grant', async () => {
    /*
     * coin-math proves the arithmetic converges. This proves the SERVICE does —
     * that persisting `returnedQty` before recomputing is what makes the second
     * event read cumulative state rather than chain a delta onto the first.
     */
    const a = await makeOrder({ label: 'ooa', pricePaise: 50000, qty: 4, grantedCoins: 40 });
    const b = await makeOrder({ label: 'oob', pricePaise: 50000, qty: 4, grantedCoins: 40 });

    // Order A: return 1 unit, then 2.
    await reversal.reverseOrder({
      orderId: a.orderId, returnedLines: [{ orderItemId: a.itemId, qty: 1 }],
      sourceEventId: `${TAG}-ooa-1`, kind: ReturnKind.RETURN,
    });
    await reversal.reverseOrder({
      orderId: a.orderId, returnedLines: [{ orderItemId: a.itemId, qty: 2 }],
      sourceEventId: `${TAG}-ooa-2`, kind: ReturnKind.RETURN,
    });

    // Order B: the same total, arriving 2 then 1.
    await reversal.reverseOrder({
      orderId: b.orderId, returnedLines: [{ orderItemId: b.itemId, qty: 2 }],
      sourceEventId: `${TAG}-oob-1`, kind: ReturnKind.RETURN,
    });
    await reversal.reverseOrder({
      orderId: b.orderId, returnedLines: [{ orderItemId: b.itemId, qty: 1 }],
      sourceEventId: `${TAG}-oob-2`, kind: ReturnKind.RETURN,
    });

    const [la, lb] = await Promise.all([
      prisma.orderLoyalty.findUniqueOrThrow({ where: { orderId: a.orderId } }),
      prisma.orderLoyalty.findUniqueOrThrow({ where: { orderId: b.orderId } }),
    ]);

    // 1 of 4 units retained = ₹500 → 10 coins, whichever way the events landed.
    expect(la.coinsGrantedCurrent).toBe(10);
    expect(lb.coinsGrantedCurrent).toBe(la.coinsGrantedCurrent);
    expect(la.preTaxEarnBasePaise).toBe(lb.preTaxEarnBasePaise);
  });

  it('a duplicate event interleaved between two real ones changes nothing', async () => {
    const o = await makeOrder({ label: 'oodup', pricePaise: 50000, qty: 4, grantedCoins: 40 });

    await reversal.reverseOrder({
      orderId: o.orderId, returnedLines: [{ orderItemId: o.itemId, qty: 1 }],
      sourceEventId: `${TAG}-oodup-1`, kind: ReturnKind.RETURN,
    });
    // The gateway redelivers the FIRST event before the second arrives.
    const replay = await reversal.reverseOrder({
      orderId: o.orderId, returnedLines: [{ orderItemId: o.itemId, qty: 1 }],
      sourceEventId: `${TAG}-oodup-1`, kind: ReturnKind.RETURN,
    });
    await reversal.reverseOrder({
      orderId: o.orderId, returnedLines: [{ orderItemId: o.itemId, qty: 1 }],
      sourceEventId: `${TAG}-oodup-2`, kind: ReturnKind.RETURN,
    });

    expect(replay.duplicate).toBe(true);

    const loyalty = await prisma.orderLoyalty.findUniqueOrThrow({
      where: { orderId: o.orderId },
    });
    // 2 of 4 returned → ₹1,000 retained → 20 coins. The replay must not have
    // counted as a third return.
    expect(loyalty.coinsGrantedCurrent).toBe(20);

    const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: o.itemId } });
    expect(item.returnedQty).toBe(2);
  });
});
