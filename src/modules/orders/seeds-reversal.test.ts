/**
 * Zewa Seeds follow an order that is cancelled or fully refunded (ZSOP004 §7).
 *
 * Driven through the real `transition()` and `refund()`, against the test
 * database, so the wiring is what is proved — the reversal arithmetic itself is
 * covered in loyalty/reversal.test.ts.
 *
 * COD is used because it confirms the seed redemption at placement, which is
 * the state a paid online order reaches at payment.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.hoisted(() => {
  process.env.PAYMENT_COD_ENABLED = 'true';
  process.env.RAZORPAY_AUTO_CONFIRM = 'true';
});

const notifyAdjusted = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@/jobs/queues', () => ({
  emailQueue: { add: vi.fn(async () => ({ id: 'job' })) },
  paymentQueue: { add: vi.fn(async () => ({ id: 'job' })), remove: vi.fn(async () => undefined) },
  maintenanceQueue: { add: vi.fn(async () => ({ id: 'job' })) },
  QUEUE_NAMES: { email: 'email', payment: 'payment', maintenance: 'maintenance' },
  scheduleMaintenance: vi.fn(async () => undefined),
  closeQueues: vi.fn(async () => undefined),
}));

vi.mock('@/modules/loyalty/notify.service', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  notifyAdjusted,
}));

import {
  PrismaClient,
  CoinLotState,
  CoinSourceType,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  ReturnKind,
} from '@prisma/client';
import * as checkoutService from '@/modules/checkout/checkout.service';
import * as ordersService from './orders.service';
import * as redemption from '@/modules/loyalty/redemption.service';
import * as account from '@/modules/loyalty/account.service';
import * as rules from '@/modules/loyalty/rules.service';
import { testActor, testCtx } from '@/test/fixtures';

const prisma = new PrismaClient();
const TAG = 'zzsrev';
let ruleVersion: Awaited<ReturnType<typeof rules.active>>;
let originalRedemption = false;
let variantSku = '';
let ctx: ReturnType<typeof testCtx>;
let actorId = '';

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
  const accIds = (
    await prisma.loyaltyAccount.findMany({ where: { customerId: { in: custIds } }, select: { id: true } })
  ).map((a) => a.id);

  if (orderIds.length) {
    await prisma.orderReturn.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderLoyalty.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.couponRedemption.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.refund.deleteMany({ where: { orderId: { in: orderIds } } });
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

/** A customer holding `coins` spendable seeds, who spends `spend` of them on a ₹1,200 COD order. */
async function orderWithSeeds(label: string, coins: number, spend: number) {
  const customer = await prisma.customer.create({
    data: {
      email: `${TAG}-${label}-${Date.now()}${Math.random().toString(36).slice(2, 5)}@zewafeeds.test`,
      firstName: 'Rev',
      lastName: 'Test',
      phone: '+919000000009',
    },
    select: { id: true, email: true },
  });
  const acc = await prisma.$transaction((tx) => account.ensureAccount(tx, customer.id));
  const expiresAt = new Date(Date.now() + 365 * 86_400_000);
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
  await prisma.loyaltyAccount.update({ where: { id: acc.id }, data: { availableCoins: coins } });

  const cartKey = `${TAG}-${label}-${Date.now()}`;
  await redemption.reserve({
    customerId: customer.id,
    coins: spend,
    cartKey,
    lines: [
      { id: 'x', lineTotalPaise: 120000, taxRatePct: 0, earnEligible: true, coinRedeemable: true, couponDiscountPaise: 0 },
    ],
  });
  const placed = await checkoutService.checkout(
    {
      lines: [{ sku: variantSku, qty: 1 }],
      email: customer.email,
      phone: '+919000000009',
      shippingAddress: {
        name: 'Rev Test',
        phone: '+919000000009',
        line1: 'Line 1',
        city: 'Kochi',
        state: 'Kerala',
        pincode: '682001',
      },
      paymentMethod: PaymentMethod.COD,
      customerId: customer.id,
      coinCartKey: cartKey,
    } as Parameters<typeof checkoutService.checkout>[0],
    ctx as Parameters<typeof checkoutService.checkout>[1],
  );
  const order = await prisma.order.findFirstOrThrow({
    where: { orderNo: placed.orderNo },
    select: { id: true, orderNo: true, totalPaise: true },
  });
  return { accountId: acc.id, order };
}

const available = async (accountId: string) =>
  (await prisma.loyaltyAccount.findUniqueOrThrow({ where: { id: accountId } })).availableCoins;

beforeAll(async () => {
  await sweep();
  actorId = await testActor(prisma);
  ctx = testCtx(actorId);
  const current = await rules.active(prisma);
  originalRedemption = current.redemptionEnabled;
  ruleVersion = current;

  const family = await prisma.productFamily.create({
    data: {
      slug: `${TAG}-fam-${Date.now()}`,
      name: 'Seeds Reversal Feed',
      category: 'FLOATING_PELLETS',
      status: 'ACTIVE',
      shortDesc: 'integration fixture',
    },
    select: { id: true },
  });
  const variant = await prisma.productVariant.create({
    data: {
      familyId: family.id,
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
  // Shared kill switch; other files may flip it (see checkout-integration.test.ts).
  await prisma.loyaltyRuleVersion.updateMany({ where: { isActive: true }, data: { redemptionEnabled: true } });
  rules.invalidate();
  notifyAdjusted.mockClear();
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

describe('Cancelling an order gives back the seeds spent on it', () => {
  it('restores the confirmed redemption, voids the pending grant and tells the customer', async () => {
    const { accountId, order } = await orderWithSeeds('cancel', 400, 120);
    expect(await available(accountId)).toBe(280);

    await ordersService.transition(
      order.orderNo,
      { to: OrderStatus.CANCELLED, fields: { cancelReason: 'Customer changed their mind' }, notifyCustomer: false },
      ctx,
    );

    expect(await available(accountId)).toBe(400);
    const pending = await prisma.coinLot.count({
      where: { orderId: order.id, state: CoinLotState.PENDING },
    });
    expect(pending).toBe(0);
    const ret = await prisma.orderReturn.findMany({ where: { orderId: order.id } });
    expect(ret.map((r) => r.kind)).toEqual([ReturnKind.CANCELLATION]);
    expect(notifyAdjusted).toHaveBeenCalledWith(
      accountId,
      `order-cancel:${order.id}`,
      expect.objectContaining({ restored: 120, clawedBack: 0, event: 'cancellation' }),
    );
  });

  it('a repeated cancellation restores nothing twice', async () => {
    const { accountId, order } = await orderWithSeeds('cancel2', 300, 100);
    await ordersService.transition(
      order.orderNo,
      { to: OrderStatus.CANCELLED, fields: { cancelReason: 'Duplicate' }, notifyCustomer: false },
      ctx,
    );
    await expect(
      ordersService.transition(order.orderNo, { to: OrderStatus.CANCELLED, fields: { cancelReason: 'Again' }, notifyCustomer: false }, ctx),
    ).rejects.toThrow();
    expect(await available(accountId)).toBe(300);
  });
});

describe('An order that comes back undelivered counts towards the RTO rule', () => {
  it('restores seeds and increments the 90-day RTO counter', async () => {
    const { accountId, order } = await orderWithSeeds('rto', 400, 120);
    await ordersService.transition(
      order.orderNo,
      { to: OrderStatus.PROCESSING, fields: { invoiceNumber: `${TAG}-INV-${Date.now()}` }, notifyCustomer: false },
      ctx,
    );
    await ordersService.transition(
      order.orderNo,
      { to: OrderStatus.SHIPPED, fields: { carrier: 'Test Post', trackingNumber: 'T123' }, notifyCustomer: false },
      ctx,
    );
    await ordersService.transition(
      order.orderNo,
      {
        to: OrderStatus.CANCELLED,
        fields: { cancelReason: 'Refused at delivery', deliveryFailed: true },
        notifyCustomer: false,
      },
      ctx,
    );

    expect(await available(accountId)).toBe(400);
    const acc = await prisma.loyaltyAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(acc.rtoCount90d).toBe(1);
  });

  it('an ordinary cancellation does not count as an RTO', async () => {
    const { accountId, order } = await orderWithSeeds('nonrto', 400, 120);
    await ordersService.transition(
      order.orderNo,
      { to: OrderStatus.CANCELLED, fields: { cancelReason: 'Changed mind', deliveryFailed: true }, notifyCustomer: false },
      ctx,
    );
    // Not shipped, so the flag is ignored.
    const acc = await prisma.loyaltyAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(acc.rtoCount90d).toBe(0);
  });
});

describe('A full refund gives back seeds spent and withdraws seeds earned', () => {
  it('restores the redemption and leaves no grant behind', async () => {
    const { accountId, order } = await orderWithSeeds('refund', 400, 120);
    // COD collected at the door — the state a refund needs.
    await prisma.order.update({ where: { id: order.id }, data: { paymentStatus: PaymentStatus.PAID } });

    await ordersService.refund(order.orderNo, order.totalPaise, 'Damaged in transit', actorId, ctx);

    expect(await available(accountId)).toBe(400);
    const loyalty = await prisma.orderLoyalty.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(loyalty.coinsGrantedCurrent).toBe(0);
    const ret = await prisma.orderReturn.findMany({ where: { orderId: order.id } });
    expect(ret.map((r) => r.kind)).toEqual([ReturnKind.RETURN]);
  });

  it('a partial refund leaves seeds alone', async () => {
    const { accountId, order } = await orderWithSeeds('partial', 400, 120);
    await prisma.order.update({ where: { id: order.id }, data: { paymentStatus: PaymentStatus.PAID } });

    await ordersService.refund(order.orderNo, 10000, 'Goodwill', actorId, ctx);

    expect(await available(accountId)).toBe(280);
    expect(await prisma.orderReturn.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('refunding an already-cancelled order does not restore twice', async () => {
    const { accountId, order } = await orderWithSeeds('cancelrefund', 400, 120);
    await prisma.order.update({ where: { id: order.id }, data: { paymentStatus: PaymentStatus.PAID } });
    await ordersService.transition(
      order.orderNo,
      { to: OrderStatus.CANCELLED, fields: { cancelReason: 'Out of stock' }, notifyCustomer: false },
      ctx,
    );
    await ordersService.refund(order.orderNo, order.totalPaise, 'Cancelled order', actorId, ctx);

    expect(await available(accountId)).toBe(400);
    const kinds = (await prisma.orderReturn.findMany({ where: { orderId: order.id } })).map((r) => r.kind);
    expect(kinds).toEqual([ReturnKind.CANCELLATION]);
  });
});
