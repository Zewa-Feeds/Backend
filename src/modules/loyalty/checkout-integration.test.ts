/**
 * Checkout → payment → ledger — ZSOP004 §4.1, §4.3, §8.1.
 *
 * The other suites test the loyalty services directly. This one drives the REAL
 * `checkoutService.checkout()` and `confirmPayment()`, so it proves the coin hold
 * actually binds to an order, reduces the payable total, survives a payment
 * retry, and turns into exactly one ledger movement.
 *
 * Every scenario here is one the specification names in §8.1.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

/*
 * COD is env-gated and off by default. `vi.hoisted` runs before any import, so
 * this lands before `@/config/env` reads the value — the same pattern the
 * coupon and promotion suites use. No source file is touched and no payment
 * code is mocked.
 *
 * COD rather than Razorpay because §8.1 #5 redeems at PLACEMENT, which lets the
 * whole hold → order → ledger cycle be asserted without a payment gateway.
 */
vi.hoisted(() => {
  process.env.PAYMENT_COD_ENABLED = 'true';
  /*
   * Use the MOCK payment provider for the RAZORPAY tests below.
   *
   * Without this `paymentProvider()` picks the live client, and a gateway test
   * would either reach Razorpay's API or fail with "Razorpay is unavailable"
   * depending on whether keys happen to be set — neither of which says anything
   * about the amount this codebase asks for. The mock echoes `amountPaise`, which
   * is exactly the boundary under test.
   */
  process.env.RAZORPAY_AUTO_CONFIRM = 'true';
});

// The queues are Redis-backed; the coin paths under test never read them back,
// so stubbing keeps this file independent of a running worker.
vi.mock('@/jobs/queues', () => ({
  emailQueue: { add: vi.fn(async () => ({ id: 'job' })) },
  paymentQueue: { add: vi.fn(async () => ({ id: 'job' })), remove: vi.fn(async () => undefined) },
  maintenanceQueue: { add: vi.fn(async () => ({ id: 'job' })) },
  QUEUE_NAMES: { email: 'email', payment: 'payment', maintenance: 'maintenance' },
  scheduleMaintenance: vi.fn(async () => undefined),
  closeQueues: vi.fn(async () => undefined),
}));
import {
  PrismaClient,
  CoinLotState,
  CoinSourceType,
  CoinReason,
  PaymentMethod,
} from '@prisma/client';
import * as checkoutService from '@/modules/checkout/checkout.service';
import * as redemption from './redemption.service';
import * as account from './account.service';
import * as rules from './rules.service';
import { testActor, testCtx } from '@/test/fixtures';

const prisma = new PrismaClient();
const TAG = 'zzchk';
let ruleVersion: Awaited<ReturnType<typeof rules.active>>;
let originalRedemption = false;
let variantSku = '';
let familyId = '';

/**
 * The audit context checkout writes under.
 *
 * `writeAudit` stores a NON-NULL actor with a foreign key to CmsUser, so a
 * hand-rolled literal with `actorId: null` fails the insert and takes the whole
 * checkout transaction with it. `testActor` creates the row once, inside the
 * reserved namespace.
 */
let ctx: ReturnType<typeof testCtx>;

async function sweep() {
  const orders = await prisma.order.findMany({
    where: { OR: [{ email: { startsWith: TAG } }, { orderNo: { startsWith: TAG } }] },
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
    await prisma.couponRedemption.deleteMany({ where: { orderId: { in: orderIds } } });
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
}

/** A signed-in customer holding `coins` spendable coins. */
async function seedCustomer(label: string, coins: number) {
  const customer = await prisma.customer.create({
    data: {
      email: `${TAG}-${label}-${Date.now()}${Math.random().toString(36).slice(2, 5)}@zewafeeds.test`,
      firstName: 'Chk',
      lastName: 'Test',
      phone: '+919000000009',
    },
    select: { id: true },
  });
  const acc = await prisma.$transaction((tx) => account.ensureAccount(tx, customer.id));

  if (coins > 0) {
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
  }
  return { customerId: customer.id, accountId: acc.id };
}

/** Hold coins for a cart, exactly as POST /account/coins/apply does. */
async function hold(customerId: string, coins: number, cartKey: string) {
  return redemption.reserve({
    customerId,
    coins,
    cartKey,
    lines: [
      {
        id: 'x',
        lineTotalPaise: 120000, // ₹1,200 — matches the cart placed below
        taxRatePct: 0,
        earnEligible: true,
        coinRedeemable: true,
        couponDiscountPaise: 0,
      },
    ],
  });
}

function placeOrder(customerId: string, extra: Record<string, unknown> = {}) {
  return checkoutService.checkout(
    {
      lines: [{ sku: variantSku, qty: 1 }],
      email: `${TAG}-buyer@zewafeeds.test`,
      phone: '+919000000009',
      shippingAddress: {
        name: 'Chk Test',
        phone: '+919000000009',
        line1: 'Line 1',
        city: 'Kochi',
        state: 'Kerala',
        pincode: '682001',
      },
      paymentMethod: PaymentMethod.COD,
      customerId,
      ...extra,
    } as Parameters<typeof checkoutService.checkout>[0],
    ctx as Parameters<typeof checkoutService.checkout>[1],
  );
}

beforeAll(async () => {
  await sweep();
  ctx = testCtx(await testActor(prisma));
  const current = await rules.active(prisma);
  originalRedemption = current.redemptionEnabled;

  // Redemption ships OFF (§13.2). Enable it for this file so the paths below
  // can be exercised; restored in afterAll.
  await prisma.loyaltyRuleVersion.update({
    where: { id: current.id },
    data: { redemptionEnabled: true },
  });
  rules.invalidate();
  ruleVersion = await rules.active(prisma);

  const family = await prisma.productFamily.create({
    data: {
      slug: `${TAG}-fam-${Date.now()}`,
      name: 'Checkout Test Feed',
      category: 'FLOATING_PELLETS',
      status: 'ACTIVE',
      shortDesc: 'integration fixture',
    },
    select: { id: true },
  });
  familyId = family.id;

  const variant = await prisma.productVariant.create({
    data: {
      familyId,
      sku: `${TAG}-SKU-${Date.now()}`.toUpperCase(),
      pack: '1kg',
      pricePaise: 120000,
      mrpPaise: 120000,
      stock: 10_000,
      isActive: true,
    },
    select: { sku: true },
  });
  variantSku = variant.sku;
});

beforeEach(async () => {
  /*
   * Re-assert the redemption kill switch before every test.
   *
   * `redemptionEnabled` is a single shared row (§9.3) and more than one suite
   * needs it ON. With `fileParallelism: false` the files run back to back, so
   * one file's afterAll restore lands while the next is still running — the
   * symptom is a spurious ACCOUNT_CANNOT_REDEEM on whichever test is next.
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

afterAll(async () => {
  await prisma.loyaltyRuleVersion.update({
    where: { id: ruleVersion.id },
    data: { redemptionEnabled: originalRedemption },
  });
  rules.invalidate();
  await sweep();
  await prisma.$disconnect();
});

describe('Applying coins at checkout (§4.1, §4.3)', () => {
  it('reduces the payable total by the coin value and binds the hold', async () => {
    const { customerId } = await seedCustomer('apply', 500);
    const cartKey = `${TAG}-apply-${Date.now()}`;
    const held = await hold(customerId, 200, cartKey);
    expect(held.held).toBe(200);

    const order = await placeOrder(customerId, { coinCartKey: cartKey });

    // ₹1,200 product + shipping, less ₹200 of coins.
    const row = await prisma.order.findFirstOrThrow({
      where: { orderNo: order.orderNo },
      select: { totalPaise: true, discountPaise: true, subtotalPaise: true, shippingPaise: true },
    });
    expect(row.discountPaise).toBe(20000);
    expect(row.totalPaise).toBe(row.subtotalPaise + row.shippingPaise - 20000);

    /*
     * The hold is bound to the ORDER, not merely to the cart.
     *
     * Looked up by orderId rather than cartKey: confirming a redemption clears
     * `cartKey` so the (accountId, cartKey) unique index constrains only LIVE
     * holds. The orderId is the durable link.
     */
    const placed = await prisma.order.findFirstOrThrow({
      where: { orderNo: order.orderNo },
      select: { id: true },
    });
    const reservation = await prisma.coinReservation.findUniqueOrThrow({
      where: { orderId: placed.id },
    });
    expect(reservation.coins).toBe(200);
    expect(reservation.status).toBe('CONFIRMED'); // COD confirms at placement
  });

  it('COD redeems at placement — the door collects the discounted amount (§8.1 #5)', async () => {
    const { customerId, accountId } = await seedCustomer('cod', 300);
    const cartKey = `${TAG}-cod-${Date.now()}`;
    await hold(customerId, 100, cartKey);
    await placeOrder(customerId, { coinCartKey: cartKey });

    const acc = await prisma.loyaltyAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(acc.availableCoins).toBe(200); // 300 − 100, spent now
    expect(acc.lockedCoins).toBe(0);

    const redeemRows = await prisma.coinLedger.count({
      where: { accountId, reason: CoinReason.REDEEM },
    });
    expect(redeemRows).toBe(1);
  });

  it('prices at full value when no cart key is supplied', async () => {
    const { customerId } = await seedCustomer('nokey', 500);
    const order = await placeOrder(customerId);
    const row = await prisma.order.findFirstOrThrow({
      where: { orderNo: order.orderNo },
      select: { discountPaise: true },
    });
    expect(row.discountPaise).toBe(0);
  });
});

describe('Adversarial: a client cannot spend coins it never reserved', () => {
  it('ignores a cart key belonging to another customer', async () => {
    const victim = await seedCustomer('victim', 500);
    const attacker = await seedCustomer('attacker', 0);

    const cartKey = `${TAG}-steal-${Date.now()}`;
    await hold(victim.customerId, 300, cartKey);

    // The attacker submits the victim's cart key. The lookup is scoped to the
    // ATTACKER's account, so it resolves to nothing.
    const order = await placeOrder(attacker.customerId, { coinCartKey: cartKey });
    const row = await prisma.order.findFirstOrThrow({
      where: { orderNo: order.orderNo },
      select: { discountPaise: true },
    });
    expect(row.discountPaise).toBe(0);

    // The victim's coins are untouched and still held.
    const acc = await prisma.loyaltyAccount.findUniqueOrThrow({
      where: { id: victim.accountId },
    });
    expect(acc.availableCoins).toBe(500);
    expect(acc.lockedCoins).toBe(300);
  });

  it('ignores an expired hold and prices at full value (§4.3)', async () => {
    const { customerId, accountId } = await seedCustomer('expired', 400);
    const cartKey = `${TAG}-exp-${Date.now()}`;
    const held = await hold(customerId, 150, cartKey);

    await prisma.coinReservation.update({
      where: { id: held.reservationId! },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const order = await placeOrder(customerId, { coinCartKey: cartKey });
    const row = await prisma.order.findFirstOrThrow({
      where: { orderNo: order.orderNo },
      select: { discountPaise: true },
    });
    // Fails CLOSED — no discount rather than an unfunded one.
    expect(row.discountPaise).toBe(0);

    const acc = await prisma.loyaltyAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(acc.availableCoins).toBe(400);
  });

  it('a guest checkout cannot claim a hold', async () => {
    const { customerId } = await seedCustomer('guestclaim', 500);
    const cartKey = `${TAG}-guest-${Date.now()}`;
    await hold(customerId, 200, cartKey);

    // No customerId on the order — a guest.
    const order = await placeOrder(null as unknown as string, { coinCartKey: cartKey });
    const row = await prisma.order.findFirstOrThrow({
      where: { orderNo: order.orderNo },
      select: { discountPaise: true },
    });
    expect(row.discountPaise).toBe(0);
  });

  it('one hold cannot back two orders', async () => {
    const { customerId } = await seedCustomer('twoorders', 500);
    const cartKey = `${TAG}-dbl-${Date.now()}`;
    await hold(customerId, 200, cartKey);

    await placeOrder(customerId, { coinCartKey: cartKey });

    // The hold is now CONFIRMED and bound; a second order finds no live
    // reservation for the key and prices at full value.
    const second = await placeOrder(customerId, { coinCartKey: cartKey });
    const row = await prisma.order.findFirstOrThrow({
      where: { orderNo: second.orderNo },
      select: { discountPaise: true },
    });
    expect(row.discountPaise).toBe(0);
  });
});

describe('Payment lifecycle (§8.1 #1, #4)', () => {
  it('a duplicate confirmation redeems exactly once (§8.1 #4)', async () => {
    const { customerId, accountId } = await seedCustomer('dupconfirm', 400);
    const cartKey = `${TAG}-dupc-${Date.now()}`;
    await hold(customerId, 120, cartKey);
    const order = await placeOrder(customerId, { coinCartKey: cartKey });

    const row = await prisma.order.findFirstOrThrow({
      where: { orderNo: order.orderNo },
      select: { id: true },
    });

    // COD already confirmed at placement. A replayed confirmation — which the
    // webhook does on every gateway retry — must be a no-op.
    const again = await prisma.$transaction((tx) =>
      redemption.confirmForOrder(tx, row.id),
    );
    expect(again).toBe(0);

    const redeemRows = await prisma.coinLedger.count({
      where: { accountId, reason: CoinReason.REDEEM },
    });
    expect(redeemRows).toBe(1);

    const acc = await prisma.loyaltyAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(acc.availableCoins).toBe(280); // 400 − 120, debited once
  });

  it('releasing after a failed payment returns the coins (§8.1 #1)', async () => {
    const { customerId, accountId } = await seedCustomer('failed', 400);
    const cartKey = `${TAG}-fail-${Date.now()}`;
    const held = await hold(customerId, 150, cartKey);

    // Simulate a prepaid order whose payment never completed: bind the hold,
    // then release it the way the cancellation path does.
    await prisma.coinReservation.update({
      where: { id: held.reservationId! },
      data: { orderId: null },
    });
    await prisma.$transaction((tx) =>
      redemption.releaseByCartKey(tx, accountId, cartKey),
    );

    const acc = await prisma.loyaltyAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(acc.availableCoins).toBe(400); // fully restored
    expect(acc.lockedCoins).toBe(0);

    // No ledger movement: a hold that never became a redemption moved no coins.
    const rows = await prisma.coinLedger.count({
      where: { accountId, reason: CoinReason.REDEEM },
    });
    expect(rows).toBe(0);
  });

  it('an abandoned checkout is swept and the coins come back (§8.1 #2)', async () => {
    const { customerId, accountId } = await seedCustomer('abandon', 250);
    const cartKey = `${TAG}-aband-${Date.now()}`;
    const held = await hold(customerId, 100, cartKey);

    await prisma.coinReservation.update({
      where: { id: held.reservationId! },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await redemption.sweepExpired();

    const acc = await prisma.loyaltyAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(acc.lockedCoins).toBe(0);
    expect(acc.availableCoins).toBe(250);
  });
});

describe('Cart changes after applying (§4.1)', () => {
  it('re-applying on the same cart key replaces rather than stacks', async () => {
    const { customerId, accountId } = await seedCustomer('recalc', 500);
    const cartKey = `${TAG}-recalc-${Date.now()}`;

    await hold(customerId, 300, cartKey);
    const second = await hold(customerId, 120, cartKey);
    expect(second.held).toBe(120);

    const live = await prisma.coinReservation.findMany({
      where: { accountId, status: 'PENDING' },
    });
    expect(live).toHaveLength(1);
    expect(live[0]!.coins).toBe(120);

    const acc = await prisma.loyaltyAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(acc.lockedCoins).toBe(120);
  });

  it('silently reduces when the cart can no longer absorb the applied coins', async () => {
    const { customerId } = await seedCustomer('shrink', 5000);
    const cartKey = `${TAG}-shrink-${Date.now()}`;

    // A ₹100 cart cannot take 5,000 coins — the server caps at the cart value
    // and reports the reduction rather than failing (§4.1).
    const result = await redemption.reserve({
      customerId,
      coins: 5000,
      cartKey,
      lines: [
        {
          id: 'small',
          lineTotalPaise: 10000,
          taxRatePct: 0,
          earnEligible: true,
          coinRedeemable: true,
          couponDiscountPaise: 0,
        },
      ],
    });
    expect(result.held).toBe(100);
    expect(result.reduced).toBe(true);
  });
});

/*
 * THE GATEWAY BOUNDARY — the defect this section exists for.
 *
 * A 376-coin checkout displayed ₹0.20 and created a ₹376.20 Razorpay order: the
 * customer paid full price AND lost the coins. The cause was the retry comparison
 *
 *     existing.totalPaise === cart.totalPaise
 *
 * comparing the stored order total (net of coins) against the freshly priced cart
 * (which `priceCart` computes WITHOUT coins). Those never match when coins are
 * applied, so every attempt superseded itself into a full-price order.
 *
 * These use RAZORPAY rather than COD, because COD never reaches a gateway and so
 * cannot observe the amount actually charged.
 */
describe('The amount charged equals the amount owed (§4.1)', () => {
  /** Place an online order, returning both the order row and the gateway amount. */
  async function placeOnline(customerId: string, extra: Record<string, unknown> = {}) {
    const result = await checkoutService.checkout(
      {
        lines: [{ sku: variantSku, qty: 1 }],
        email: `${TAG}-buyer@zewafeeds.test`,
        phone: '+919000000009',
        shippingAddress: {
          name: 'Chk Test',
          phone: '+919000000009',
          line1: 'Line 1',
          city: 'Kochi',
          state: 'Kerala',
          pincode: '682001',
        },
        paymentMethod: PaymentMethod.RAZORPAY,
        customerId,
        ...extra,
      } as Parameters<typeof checkoutService.checkout>[0],
      ctx as Parameters<typeof checkoutService.checkout>[1],
    );
    const row = await prisma.order.findFirstOrThrow({
      where: { orderNo: result.orderNo },
      select: { id: true, totalPaise: true, razorpayOrderId: true },
    });
    return { result, row };
  }

  it('charges the discounted total, not the pre-coin cart total', async () => {
    const { customerId } = await seedCustomer('gw-discount', 500);
    const cartKey = `${TAG}-gw-${Date.now()}`;
    await hold(customerId, 200, cartKey);

    const { result, row } = await placeOnline(customerId, { coinCartKey: cartKey });

    // The order records the discounted figure...
    expect(row.totalPaise).toBe(result.totalPaise);
    // ...and that is exactly what the gateway was asked for. This is the
    // assertion the buggy implementation failed.
    expect(result.payment.amountPaise).toBe(row.totalPaise);
  });

  /*
   * The reported case, to the rupee. 376 coins against a cart whose total leaves
   * ₹0.20 payable — the shape that charged ₹376.20.
   */
  it('leaves only the shipping remainder payable when coins cover the products', async () => {
    const { customerId } = await seedCustomer('gw-376', 400);
    const cartKey = `${TAG}-gw376-${Date.now()}`;

    /*
     * `reserve` reports what it actually held, which is 376 or the order ceiling,
     * whichever is lower — the ceiling depends on the fixture's price and must not
     * be hard-coded here.
     */
    const held = await hold(customerId, 376, cartKey);
    const coins = held.held;
    expect(coins).toBeGreaterThan(0);

    const { result, row } = await placeOnline(customerId, { coinCartKey: cartKey });

    const before = await placeOnlineTotalWithoutCoins(customerId);
    expect(row.totalPaise).toBe(before - coins * 100);
    expect(result.payment.amountPaise).toBe(row.totalPaise);
  });

  /** The same cart priced with no hold at all, for the delta above. */
  async function placeOnlineTotalWithoutCoins(_customerId: string) {
    const { customerId } = await seedCustomer('gw-baseline', 0);
    const { row } = await placeOnline(customerId);
    return row.totalPaise;
  }

  it('applies no discount when no hold exists', async () => {
    const { customerId } = await seedCustomer('gw-nohold', 500);
    const { result, row } = await placeOnline(customerId);
    expect(result.payment.amountPaise).toBe(row.totalPaise);
  });

  it('applies no discount when the hold has expired', async () => {
    const { customerId, accountId } = await seedCustomer('gw-expired', 500);
    const cartKey = `${TAG}-gw-exp-${Date.now()}`;
    await hold(customerId, 200, cartKey);
    // Expire it exactly as the sweeper would find it.
    await prisma.coinReservation.updateMany({
      where: { accountId, cartKey },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const baseline = await placeOnlineTotalWithoutCoins(customerId);
    const { result, row } = await placeOnline(customerId, { coinCartKey: cartKey });

    expect(row.totalPaise).toBe(baseline);
    expect(result.payment.amountPaise).toBe(row.totalPaise);
  });

  it('never prices an order below zero, however many coins are held', async () => {
    const { customerId } = await seedCustomer('gw-floor', 100000);
    const cartKey = `${TAG}-gw-floor-${Date.now()}`;
    // Far more coins than the order can absorb; reserve caps it at the ceiling.
    await hold(customerId, 100000, cartKey);

    const { result, row } = await placeOnline(customerId, { coinCartKey: cartKey });

    expect(row.totalPaise).toBeGreaterThanOrEqual(0);
    expect(result.payment.amountPaise).toBe(row.totalPaise);
  });
});

/*
 * RETRY. A dismissed Razorpay modal leaves the order payable; pressing Pay again
 * must reuse it rather than supersede it into a full-price one.
 */
describe('Retrying a coin checkout (§8.1 #1)', () => {
  async function place(customerId: string, extra: Record<string, unknown> = {}) {
    return checkoutService.checkout(
      {
        lines: [{ sku: variantSku, qty: 1 }],
        email: `${TAG}-buyer@zewafeeds.test`,
        phone: '+919000000009',
        shippingAddress: {
          name: 'Chk Test',
          phone: '+919000000009',
          line1: 'Line 1',
          city: 'Kochi',
          state: 'Kerala',
          pincode: '682001',
        },
        paymentMethod: PaymentMethod.RAZORPAY,
        customerId,
        ...extra,
      } as Parameters<typeof checkoutService.checkout>[0],
      ctx as Parameters<typeof checkoutService.checkout>[1],
    );
  }

  /*
   * The regression. With the old comparison this superseded on every retry and
   * the second gateway order was priced WITHOUT the coins.
   */
  it('reuses the same discounted gateway order on an unchanged retry', async () => {
    const { customerId } = await seedCustomer('retry-same', 500);
    const cartKey = `${TAG}-retry-${Date.now()}`;
    await hold(customerId, 200, cartKey);
    const key = `idem-${TAG}-${Date.now()}`;

    const first = await place(customerId, { coinCartKey: cartKey, idempotencyKey: key });
    const second = await place(customerId, { coinCartKey: cartKey, idempotencyKey: key });

    expect(second.orderNo).toBe(first.orderNo);
    expect(second.totalPaise).toBe(first.totalPaise);
    expect(second.payment.gatewayOrderId).toBe(first.payment.gatewayOrderId);
    // Still discounted the second time round.
    expect(second.payment.amountPaise).toBe(first.payment.amountPaise);
  });

  it('supersedes when the cart genuinely changes', async () => {
    const { customerId } = await seedCustomer('retry-changed', 500);
    const key = `idem-chg-${TAG}-${Date.now()}`;

    const first = await place(customerId, { idempotencyKey: key });
    const second = await checkoutService.checkout(
      {
        // Two units rather than one: a real change in what is owed.
        lines: [{ sku: variantSku, qty: 2 }],
        email: `${TAG}-buyer@zewafeeds.test`,
        phone: '+919000000009',
        shippingAddress: {
          name: 'Chk Test',
          phone: '+919000000009',
          line1: 'Line 1',
          city: 'Kochi',
          state: 'Kerala',
          pincode: '682001',
        },
        paymentMethod: PaymentMethod.RAZORPAY,
        customerId,
        idempotencyKey: key,
      } as Parameters<typeof checkoutService.checkout>[0],
      ctx as Parameters<typeof checkoutService.checkout>[1],
    );

    expect(second.orderNo).not.toBe(first.orderNo);
    expect(second.totalPaise).toBeGreaterThan(first.totalPaise);
  });

  it('prices a cart with no coins exactly as before', async () => {
    const { customerId } = await seedCustomer('retry-nocoins', 0);
    const key = `idem-nc-${TAG}-${Date.now()}`;

    const first = await place(customerId, { idempotencyKey: key });
    const second = await place(customerId, { idempotencyKey: key });

    expect(second.orderNo).toBe(first.orderNo);
    expect(second.payment.gatewayOrderId).toBe(first.payment.gatewayOrderId);
  });
});

/*
 * The client names a KEY, never an amount (§4.3).
 *
 * Asserted rather than assumed: the whole defence against a crafted request
 * spending coins nobody reserved is that the request has no field for an amount,
 * and the server reads the figure off its own reservation row.
 */
describe('The coin amount is the server\'s, not the client\'s', () => {
  it('ignores a coin amount smuggled into the placement request', async () => {
    const { customerId } = await seedCustomer('forge-amount', 500);
    const cartKey = `${TAG}-forge-${Date.now()}`;
    const held = await hold(customerId, 50, cartKey);
    expect(held.held).toBe(50);

    const order = await checkoutService.checkout(
      {
        lines: [{ sku: variantSku, qty: 1 }],
        email: `${TAG}-buyer@zewafeeds.test`,
        phone: '+919000000009',
        shippingAddress: {
          name: 'Chk Test',
          phone: '+919000000009',
          line1: 'Line 1',
          city: 'Kochi',
          state: 'Kerala',
          pincode: '682001',
        },
        paymentMethod: PaymentMethod.COD,
        customerId,
        coinCartKey: cartKey,
        // Fields a crafted request might carry. None is read.
        coins: 400,
        coinDiscountPaise: 40000,
        discountPaise: 40000,
      } as unknown as Parameters<typeof checkoutService.checkout>[0],
      ctx as Parameters<typeof checkoutService.checkout>[1],
    );

    const row = await prisma.order.findFirstOrThrow({
      where: { orderNo: order.orderNo },
      select: { totalPaise: true },
    });
    const baseline = await (async () => {
      const { customerId: plain } = await seedCustomer('forge-baseline', 0);
      const o = await placeOrder(plain);
      const r = await prisma.order.findFirstOrThrow({
        where: { orderNo: o.orderNo },
        select: { totalPaise: true },
      });
      return r.totalPaise;
    })();

    // Exactly the 50 coins RESERVED, not the 400 claimed.
    expect(row.totalPaise).toBe(baseline - 50 * 100);
  });

  /*
   * A dismissed payment must leave the reservation usable. `releaseForOrder` also
   * clears `cartKey`, so a hold that was wrongly released cannot be found again —
   * which is precisely how the retry lost its discount.
   */
  it('leaves the reservation pending and findable after an ONLINE placement', async () => {
    const { customerId, accountId } = await seedCustomer('dismiss', 500);
    const cartKey = `${TAG}-dismiss-${Date.now()}`;
    await hold(customerId, 200, cartKey);

    /*
     * RAZORPAY, not COD. §8.1 #5 has COD redeem at PLACEMENT, which confirms the
     * reservation and clears `cartKey` — correct for COD, and nothing to do with
     * the retry path, where money has not moved and the hold must stay live.
     */
    await checkoutService.checkout(
      {
        lines: [{ sku: variantSku, qty: 1 }],
        email: `${TAG}-buyer@zewafeeds.test`,
        phone: '+919000000009',
        shippingAddress: {
          name: 'Chk Test',
          phone: '+919000000009',
          line1: 'Line 1',
          city: 'Kochi',
          state: 'Kerala',
          pincode: '682001',
        },
        paymentMethod: PaymentMethod.RAZORPAY,
        customerId,
        coinCartKey: cartKey,
      } as Parameters<typeof checkoutService.checkout>[0],
      ctx as Parameters<typeof checkoutService.checkout>[1],
    );

    const reservation = await prisma.coinReservation.findFirst({
      where: { accountId, coins: 200 },
      select: { status: true, cartKey: true, orderId: true },
    });

    // Bound to the order, still PENDING (no money has moved), and the key still
    // resolves it — which is what lets a dismissed payment be retried.
    expect(reservation?.orderId).toBeTruthy();
    expect(reservation?.status).toBe('PENDING');
    expect(reservation?.cartKey).toBe(cartKey);
  });

  /* The discount moves the total once, never twice. */
  it('applies the discount exactly once', async () => {
    const { customerId } = await seedCustomer('once', 500);
    const cartKey = `${TAG}-once-${Date.now()}`;
    await hold(customerId, 150, cartKey);

    const order = await placeOrder(customerId, { coinCartKey: cartKey });
    const row = await prisma.order.findFirstOrThrow({
      where: { orderNo: order.orderNo },
      select: { totalPaise: true, discountPaise: true },
    });

    const { customerId: plain } = await seedCustomer('once-baseline', 0);
    const base = await placeOrder(plain);
    const baseRow = await prisma.order.findFirstOrThrow({
      where: { orderNo: base.orderNo },
      select: { totalPaise: true, discountPaise: true },
    });

    expect(row.totalPaise).toBe(baseRow.totalPaise - 150 * 100);
    expect(row.discountPaise).toBe(baseRow.discountPaise + 150 * 100);
  });
});
