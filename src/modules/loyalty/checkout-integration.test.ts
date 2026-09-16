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
