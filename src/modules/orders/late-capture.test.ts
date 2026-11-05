/**
 * A payment captured after we cancelled the order as unpaid.
 *
 * THE INCIDENT. 27ZFO152 (29 Oct 2026): the first payment attempt failed, the
 * `payment.failed` webhook released the order at minute 9, and the customer's
 * retry inside the same Razorpay window was captured seconds later.
 * `confirmPayment` correctly refused to resurrect a cancelled order, and that
 * refusal was only logged — the money sat unmatched until staff pressed Verify
 * a week later. Restoring then left the order's coupons released, so the sale
 * never counted toward coupon usage or revenue.
 *
 * Driven against the test database through the real `recoverLateCapture()` and
 * `reconcilePayment()`, so the restore, the coupon re-count and the once-only
 * staff alert are what is proved.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.hoisted(() => {
  process.env.RAZORPAY_AUTO_CONFIRM = 'true';
});

const emailAdd = vi.hoisted(() => vi.fn(async () => ({ id: 'job' })));

vi.mock('@/jobs/queues', () => ({
  emailQueue: { add: emailAdd },
  paymentQueue: { add: vi.fn(async () => ({ id: 'job' })), remove: vi.fn(async () => undefined) },
  maintenanceQueue: { add: vi.fn(async () => ({ id: 'job' })) },
  QUEUE_NAMES: { email: 'email', payment: 'payment', maintenance: 'maintenance' },
  scheduleMaintenance: vi.fn(async () => undefined),
  closeQueues: vi.fn(async () => undefined),
}));

import { PrismaClient, DiscountType, OrderStatus, PaymentMethod, PaymentStatus } from '@prisma/client';
import * as checkoutService from '@/modules/checkout/checkout.service';
import * as ordersService from './orders.service';
import { testActor, testCtx } from '@/test/fixtures';

const prisma = new PrismaClient();
const TAG = 'zzlate';
let variantSku = '';
let couponId = '';
let ctx: ReturnType<typeof testCtx>;

async function sweep() {
  const orders = await prisma.order.findMany({ where: { email: { startsWith: TAG } }, select: { id: true, orderNo: true } });
  const ids = orders.map((o) => o.id);
  if (ids.length) {
    await prisma.couponRedemption.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderLoyalty.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.emailLog.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.order.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.coupon.deleteMany({ where: { code: { startsWith: TAG.toUpperCase() } } });
  await prisma.productFamily.deleteMany({ where: { slug: { startsWith: TAG } } });
}

/** A guest online order, cancelled as unpaid the way the release job does it. */
async function cancelledUnpaidOrder(label: string) {
  const email = `${TAG}-${label}-${Date.now()}${Math.random().toString(36).slice(2, 5)}@zewafeeds.test`;
  const placed = await checkoutService.checkout(
    {
      lines: [{ sku: variantSku, qty: 1 }],
      email,
      phone: '+919000000009',
      shippingAddress: { name: 'Late Capture', phone: '+919000000009', line1: 'Line 1', city: 'Kochi', state: 'Kerala', pincode: '682001' },
      paymentMethod: PaymentMethod.RAZORPAY,
    } as Parameters<typeof checkoutService.checkout>[0],
    ctx as Parameters<typeof checkoutService.checkout>[1],
  );
  const order = await prisma.order.findFirstOrThrow({ where: { orderNo: placed.orderNo }, select: { id: true, orderNo: true, totalPaise: true } });
  // A coupon redemption, released by the cancellation below.
  await prisma.couponRedemption.create({
    data: { couponId, orderId: order.id, email, cartValuePaise: order.totalPaise, discountPaise: 0 },
  });
  await ordersService.transition(
    order.orderNo,
    { to: OrderStatus.CANCELLED, fields: { cancelReason: 'Payment was not completed in time. Stock released automatically.' }, notifyCustomer: false },
    ctx as Parameters<typeof ordersService.transition>[2],
  );
  return order;
}

beforeAll(async () => {
  await sweep();
  ctx = testCtx(await testActor(prisma));
  const family = await prisma.productFamily.create({
    data: { slug: `${TAG}-fam-${Date.now()}`, name: 'Late Capture Feed', category: 'FLOATING_PELLETS', status: 'ACTIVE', shortDesc: 'integration fixture' },
    select: { id: true },
  });
  const variant = await prisma.productVariant.create({
    data: { familyId: family.id, sku: `${TAG}-SKU-${Date.now()}`.toUpperCase(), pack: '45g', pricePaise: 16650, mrpPaise: 16650, stock: 100, isActive: true },
    select: { sku: true },
  });
  variantSku = variant.sku;
  const coupon = await prisma.coupon.create({
    data: {
      code: `${TAG.toUpperCase()}${Date.now()}`,
      discountType: DiscountType.PERCENTAGE,
      discountValue: 10,
      startsAt: new Date(Date.now() - 86_400_000),
      endsAt: new Date(Date.now() + 86_400_000),
    },
    select: { id: true },
  });
  couponId = coupon.id;
});

beforeEach(() => emailAdd.mockClear());

afterAll(async () => {
  await sweep();
  await prisma.$disconnect();
});

describe('a payment captured after the order was cancelled as unpaid', () => {
  it('restores and confirms the order, and counts its coupon again', async () => {
    const order = await cancelledUnpaidOrder('restore');

    const outcome = await ordersService.recoverLateCapture(
      order.orderNo,
      { id: `pay_${TAG}restore`, amountPaise: order.totalPaise },
      ctx as Parameters<typeof ordersService.recoverLateCapture>[2],
    );

    expect(outcome).toBe('restored');
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true, paymentStatus: true, razorpayPaymentId: true } });
    expect(after).toEqual({ status: OrderStatus.PENDING, paymentStatus: PaymentStatus.PAID, razorpayPaymentId: `pay_${TAG}restore` });

    const redemption = await prisma.couponRedemption.findFirstOrThrow({ where: { orderId: order.id } });
    expect(redemption.releasedAt).toBeNull();
    expect(redemption.confirmedAt).not.toBeNull();
  });

  it('does not touch an order that is not cancelled-and-unpaid', async () => {
    const order = await cancelledUnpaidOrder('paid');
    await ordersService.recoverLateCapture(order.orderNo, { id: `pay_${TAG}paid`, amountPaise: order.totalPaise }, ctx as never);

    const again = await ordersService.recoverLateCapture(order.orderNo, { id: `pay_${TAG}other`, amountPaise: order.totalPaise }, ctx as never);
    expect(again).toBe('not-applicable');
  });

  it('leaves a mismatched amount to staff, alerting them once however often it is found', async () => {
    const order = await cancelledUnpaidOrder('mismatch');
    const payment = { id: `pay_${TAG}mismatch`, amountPaise: order.totalPaise + 100 };

    expect(await ordersService.recoverLateCapture(order.orderNo, payment, ctx as never)).toBe('needs-review');
    // The hourly sweep finds the same payment again.
    expect(await ordersService.recoverLateCapture(order.orderNo, payment, ctx as never)).toBe('needs-review');

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true, paymentStatus: true } });
    expect(after).toEqual({ status: OrderStatus.CANCELLED, paymentStatus: PaymentStatus.UNPAID });

    const flags = await prisma.auditLog.count({ where: { recordId: order.orderNo, action: { contains: 'needs review' } } });
    expect(flags).toBe(1);
    const alerts = emailAdd.mock.calls.filter((c) => (c as unknown[])[1] && ((c as unknown[])[1] as { template?: string }).template === 'staff-payment-needs-review');
    expect(alerts).toHaveLength(1);
  });
});
