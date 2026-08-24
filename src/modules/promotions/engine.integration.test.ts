/**
 * The promotion engine end to end, against a real database.
 *
 * What is proved here cannot be proved with mocks: that order-history
 * eligibility reads the right orders, that a released redemption stops counting
 * against a customer, that stacked promotions produce one redemption row each,
 * and that free shipping waives a charge the weight calculation still produced.
 *
 * COD throughout — it exercises the same checkout transaction as an online
 * order while keeping Razorpay out of the test entirely.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// COD is off in this developer's .env; .env.test does not override it. Set for
// this process only, before the import graph reads config. No source is touched.
vi.hoisted(() => {
  process.env.PAYMENT_COD_ENABLED = 'true';
});

vi.mock('@/jobs/queues', () => ({
  emailQueue: { add: vi.fn(async () => ({ id: 'job' })) },
  paymentQueue: { add: vi.fn(async () => ({ id: 'job' })) },
  maintenanceQueue: { add: vi.fn(async () => ({ id: 'job' })) },
}));

import {
  Category,
  CouponStacking,
  CouponTargetRole,
  CouponTrigger,
  CustomerEligibility,
  DiscountType,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PrismaClient,
  ProductStatus,
} from '@prisma/client';
import { checkout } from '@/modules/checkout/checkout.service';
import { priceCart } from '@/modules/checkout/pricing.service';
import { transition } from '@/modules/orders/orders.service';
import { ns, sweepFixtures, testActor, testCtx } from '@/test/fixtures';

const prisma = new PrismaClient();

const ADDRESS = {
  name: 'Zz Fixture',
  phone: '9876543210',
  line1: '1 Test Lane',
  city: 'Kochi',
  state: 'Kerala',
  pincode: '682001',
};

/** ₹300 a unit — one unit clears a ₹999 minimum at four. */
const UNIT_A = 30_000;
const UNIT_B = 20_000;

let actorId = '';
let famA = '';
let famB = '';
let skuA = '';
let skuB = '';
const couponIds: string[] = [];
const emails: string[] = [];

async function makeFamily(label: string, price: number, category: Category) {
  const slug = ns(label);
  const family = await prisma.productFamily.create({
    data: {
      slug,
      name: `ZZ ${label} ${slug}`,
      category,
      status: ProductStatus.ACTIVE,
      shortDesc: 'fixture',
      variants: {
        create: {
          sku: slug.toUpperCase(),
          pack: '45g',
          mrpPaise: price + 5_000,
          pricePaise: price,
          stock: 500,
        },
      },
    },
    include: { variants: true },
  });
  return { familyId: family.id, sku: family.variants[0]!.sku, variantId: family.variants[0]!.id };
}

interface CouponOpts {
  discountType?: DiscountType;
  discountValue?: number;
  maxDiscountPaise?: number | null;
  minOrderPaise?: number;
  minQty?: number | null;
  stackingMode?: CouponStacking;
  priority?: number;
  trigger?: CouponTrigger;
  customerEligibility?: CustomerEligibility;
  firstNOrders?: number | null;
  allowedStates?: string[];
  perCustomerLimit?: number;
  totalUsageLimit?: number | null;
  customerEmails?: string[];
  discountFamilies?: string[];
  qualifyFamilies?: string[];
  requireAllQualifiers?: boolean;
}

async function makeCoupon(opts: CouponOpts = {}) {
  const code = ns('p').toUpperCase();
  const coupon = await prisma.coupon.create({
    data: {
      code,
      discountType: opts.discountType ?? DiscountType.PERCENTAGE,
      discountValue: opts.discountValue ?? 10,
      maxDiscountPaise: opts.maxDiscountPaise ?? null,
      minOrderPaise: opts.minOrderPaise ?? 0,
      minQty: opts.minQty ?? null,
      startsAt: new Date(Date.now() - 86_400_000),
      endsAt: new Date(Date.now() + 86_400_000),
      isActive: true,
      stackingMode: opts.stackingMode ?? CouponStacking.STACKABLE,
      priority: opts.priority ?? 0,
      trigger: opts.trigger ?? CouponTrigger.CODE,
      customerEligibility: opts.customerEligibility ?? CustomerEligibility.ALL_CUSTOMERS,
      firstNOrders: opts.firstNOrders ?? null,
      allowedStates: opts.allowedStates ?? [],
      requireAllQualifiers: opts.requireAllQualifiers ?? false,
      perCustomerLimit: opts.perCustomerLimit ?? 99,
      totalUsageLimit: opts.totalUsageLimit ?? null,
      customers: { create: (opts.customerEmails ?? []).map((email) => ({ email })) },
      products: {
        create: [
          ...(opts.discountFamilies ?? []).map((familyId) => ({
            familyId,
            role: CouponTargetRole.DISCOUNT,
          })),
          ...(opts.qualifyFamilies ?? []).map((familyId) => ({
            familyId,
            role: CouponTargetRole.QUALIFY,
          })),
        ],
      },
    },
    select: { id: true, code: true },
  });
  couponIds.push(coupon.id);
  return coupon;
}

function place(codes: string[], email: string, lines?: { sku: string; qty: number }[]) {
  emails.push(email.toLowerCase());
  return checkout(
    {
      lines: lines ?? [{ sku: skuA, qty: 1 }],
      email,
      phone: '9876543210',
      shippingAddress: ADDRESS,
      paymentMethod: PaymentMethod.COD,
      couponCodes: codes,
    },
    testCtx(actorId),
  );
}

/** Mark an order as a completed sale, the way ops accepting a COD order does. */
async function acceptOrder(orderNo: string) {
  await transition(orderNo, { to: OrderStatus.PROCESSING, fields: {}, notifyCustomer: false }, testCtx(actorId));
}

beforeAll(async () => {
  await sweepFixtures(prisma);
  actorId = await testActor(prisma);
  const a = await makeFamily('pa', UNIT_A, Category.SLOW_SINKING_PELLETS);
  const b = await makeFamily('pb', UNIT_B, Category.BOTTOM_DWELLERS);
  famA = a.familyId;
  skuA = a.sku;
  famB = b.familyId;
  skuB = b.sku;
});

beforeEach(async () => {
  // Automatic promotions are global, so one left behind would apply to every
  // later cart. Cleared between tests.
  await prisma.coupon.deleteMany({
    where: { id: { in: couponIds }, trigger: CouponTrigger.AUTOMATIC },
  });
});

afterAll(async () => {
  if (emails.length > 0) {
    await prisma.order.deleteMany({ where: { email: { in: emails } } });
    await prisma.customer.deleteMany({ where: { email: { in: emails } } });
  }
  if (couponIds.length > 0) {
    await prisma.coupon.deleteMany({ where: { id: { in: couponIds } } });
  }
  await sweepFixtures(prisma);
  await prisma.$disconnect();
});

// ============================================================================
describe('order-history eligibility', () => {
  it('lets a first-time buyer use a first-order coupon', async () => {
    const c = await makeCoupon({ customerEligibility: CustomerEligibility.FIRST_ORDER });
    const email = `${ns('f1')}@example.invalid`;
    const result = await place([c.code], email);

    const order = await prisma.order.findUniqueOrThrow({
      where: { orderNo: result.orderNo },
      select: { discountPaise: true },
    });
    expect(order.discountPaise).toBe(3_000);
  });

  it('refuses a first-order coupon once a qualifying order exists', async () => {
    const c = await makeCoupon({ customerEligibility: CustomerEligibility.FIRST_ORDER });
    const email = `${ns('f2')}@example.invalid`;

    const first = await place([c.code], email);
    await acceptOrder(first.orderNo); // now a real, completed sale

    await expect(place([c.code], email)).rejects.toThrow(/first order/i);
  });

  it('does NOT count an abandoned unpaid online order as a first order', async () => {
    const c = await makeCoupon({ customerEligibility: CustomerEligibility.FIRST_ORDER });
    const email = `${ns('f3')}@example.invalid`;
    emails.push(email);

    // An unpaid, still-PENDING Razorpay order — exactly what an abandoned
    // checkout leaves behind.
    await prisma.order.create({
      data: {
        orderNo: ns('ab').toUpperCase().slice(0, 20),
        email,
        phone: '9876543210',
        status: OrderStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
        paymentMethod: PaymentMethod.RAZORPAY,
        subtotalPaise: UNIT_A,
        totalPaise: UNIT_A,
        shippingAddress: ADDRESS,
      },
    });

    // Still their first real order, so the coupon must still apply.
    const result = await place([c.code], email);
    expect(result.orderNo).toBeTruthy();
  });

  it('does NOT count a cancelled order', async () => {
    const c = await makeCoupon({ customerEligibility: CustomerEligibility.FIRST_ORDER });
    const email = `${ns('f4')}@example.invalid`;

    const first = await place([c.code], email);
    await acceptOrder(first.orderNo);
    await transition(
      first.orderNo,
      { to: OrderStatus.CANCELLED, fields: { cancelReason: 'test' }, notifyCustomer: false },
      testCtx(actorId),
    );

    // The cancelled order no longer counts, so they are a first-time buyer again.
    const second = await place([c.code], email);
    expect(second.orderNo).toBeTruthy();
  });

  it('covers the first N orders, then stops', async () => {
    const c = await makeCoupon({
      customerEligibility: CustomerEligibility.FIRST_N_ORDERS,
      firstNOrders: 2,
      perCustomerLimit: 99,
    });
    const email = `${ns('fn')}@example.invalid`;

    const o1 = await place([c.code], email);
    await acceptOrder(o1.orderNo);
    const o2 = await place([c.code], email);
    await acceptOrder(o2.orderNo);

    // Two qualifying orders exist; the third is outside the offer.
    await expect(place([c.code], email)).rejects.toThrow(/first 2 orders/i);
  });

  it('refuses a returning-customer coupon to a brand new buyer', async () => {
    const c = await makeCoupon({ customerEligibility: CustomerEligibility.EXISTING_CUSTOMER });
    await expect(place([c.code], `${ns('new')}@example.invalid`)).rejects.toThrow(/returning/i);
  });
});

// ============================================================================
describe('customer targeting', () => {
  it('applies for a named customer', async () => {
    const email = `${ns('vip')}@example.invalid`;
    const c = await makeCoupon({
      customerEligibility: CustomerEligibility.SPECIFIC_CUSTOMERS,
      customerEmails: [email.toLowerCase()],
    });
    const result = await place([c.code], email);
    expect(result.orderNo).toBeTruthy();
  });

  it('refuses everyone else', async () => {
    const c = await makeCoupon({
      customerEligibility: CustomerEligibility.SPECIFIC_CUSTOMERS,
      customerEmails: [`${ns('someone')}@example.invalid`],
    });
    await expect(place([c.code], `${ns('other')}@example.invalid`)).rejects.toThrow(
      /not available for your account/i,
    );
  });
});

// ============================================================================
describe('stacking through a real checkout', () => {
  it('applies two stackable coupons and records a redemption for each', async () => {
    const a = await makeCoupon({ discountValue: 10, stackingMode: CouponStacking.STACKABLE });
    const b = await makeCoupon({ discountValue: 20, stackingMode: CouponStacking.STACKABLE });
    const email = `${ns('st')}@example.invalid`;

    const result = await place([a.code, b.code], email, [{ sku: skuA, qty: 1 }]);
    const order = await prisma.order.findUniqueOrThrow({
      where: { orderNo: result.orderNo },
      select: { discountPaise: true, couponCode: true, couponCodes: true, id: true },
    });

    // ₹300 → 10% = ₹30, then 20% of the remaining ₹270 = ₹54. Residual pricing.
    expect(order.discountPaise).toBe(3_000 + 5_400);
    expect(order.couponCodes).toEqual([a.code, b.code]);
    expect(order.couponCode).toBe(a.code);

    const redemptions = await prisma.couponRedemption.count({ where: { orderId: order.id } });
    expect(redemptions).toBe(2);
  });

  it('refuses a non-stackable coupon alongside another', async () => {
    const a = await makeCoupon({ stackingMode: CouponStacking.STACKABLE });
    const b = await makeCoupon({ stackingMode: CouponStacking.NON_STACKABLE });
    await expect(place([a.code, b.code], `${ns('ns')}@example.invalid`)).rejects.toThrow(
      /cannot be combined/i,
    );
  });

  it('refuses anything alongside an exclusive coupon', async () => {
    const a = await makeCoupon({ stackingMode: CouponStacking.EXCLUSIVE });
    const b = await makeCoupon({ stackingMode: CouponStacking.STACKABLE });
    await expect(place([a.code, b.code], `${ns('ex')}@example.invalid`)).rejects.toThrow(
      /exclusive/i,
    );
  });

  it('lets the survivor through once the conflicting coupon is removed', async () => {
    const a = await makeCoupon({ stackingMode: CouponStacking.NON_STACKABLE });
    const b = await makeCoupon({ stackingMode: CouponStacking.STACKABLE });
    const email = `${ns('rm')}@example.invalid`;

    await expect(place([a.code, b.code], email)).rejects.toThrow(/cannot be combined/i);
    // Customer removes A; B alone is fine.
    const ok = await place([b.code], email);
    expect(ok.orderNo).toBeTruthy();
  });

  it('never lets a stacked discount exceed the cart', async () => {
    const a = await makeCoupon({ discountValue: 80, stackingMode: CouponStacking.STACKABLE });
    const b = await makeCoupon({ discountValue: 80, stackingMode: CouponStacking.STACKABLE });
    const email = `${ns('cap')}@example.invalid`;

    const result = await place([a.code, b.code], email, [{ sku: skuA, qty: 1 }]);
    const order = await prisma.order.findUniqueOrThrow({
      where: { orderNo: result.orderNo },
      select: { subtotalPaise: true, discountPaise: true, totalPaise: true },
    });

    expect(order.discountPaise).toBeLessThan(order.subtotalPaise);
    expect(order.totalPaise).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
describe('automatic promotions', () => {
  it('apply with no code entered', async () => {
    const c = await makeCoupon({
      trigger: CouponTrigger.AUTOMATIC,
      discountValue: 15,
      stackingMode: CouponStacking.STACKABLE,
    });
    const email = `${ns('auto')}@example.invalid`;

    const result = await place([], email, [{ sku: skuA, qty: 1 }]);
    const order = await prisma.order.findUniqueOrThrow({
      where: { orderNo: result.orderNo },
      select: { discountPaise: true, couponCodes: true },
    });

    expect(order.discountPaise).toBe(4_500);
    expect(order.couponCodes).toEqual([c.code]);
  });

  it('cannot be applied by typing their code', async () => {
    const c = await makeCoupon({ trigger: CouponTrigger.AUTOMATIC });
    const cart = await priceCart({
      lines: [{ sku: skuA, qty: 1 }],
      couponCodes: [c.code],
      email: `${ns('typed')}@example.invalid`,
    });
    // Applied automatically, but the typed code is refused as unrecognised so it
    // can never be counted twice.
    const issue = cart.issues.find((i) => i.sku === '__coupon__');
    expect(issue?.code).toBe('COUPON_NOT_FOUND');
  });

  it('resolve deterministically when several are eligible', async () => {
    await makeCoupon({
      trigger: CouponTrigger.AUTOMATIC,
      stackingMode: CouponStacking.EXCLUSIVE,
      discountValue: 5,
      priority: 90,
    });
    await makeCoupon({
      trigger: CouponTrigger.AUTOMATIC,
      stackingMode: CouponStacking.STACKABLE,
      discountValue: 25,
      priority: 1,
    });

    // The exclusive one wins on mode, despite the worse priority and the smaller
    // discount — and it wins the same way every run.
    const first = await priceCart({ lines: [{ sku: skuA, qty: 1 }] });
    const second = await priceCart({ lines: [{ sku: skuA, qty: 1 }] });

    expect(first.coupons).toHaveLength(1);
    expect(first.coupons[0]!.discountPaise).toBe(1_500);
    expect(second.coupons.map((c) => c.code)).toEqual(first.coupons.map((c) => c.code));
  });
});

// ============================================================================
describe('conditions', () => {
  it('enforces a minimum order value against the real subtotal', async () => {
    const c = await makeCoupon({ minOrderPaise: 500_000 });
    await expect(place([c.code], `${ns('min')}@example.invalid`)).rejects.toThrow(/5,000/);
  });

  it('enforces a minimum quantity', async () => {
    const c = await makeCoupon({ minQty: 5 });
    await expect(
      place([c.code], `${ns('mq')}@example.invalid`, [{ sku: skuA, qty: 2 }]),
    ).rejects.toThrow(/5 or more/i);
  });

  it('caps a percentage discount', async () => {
    const c = await makeCoupon({ discountValue: 50, maxDiscountPaise: 5_000 });
    const email = `${ns('cap2')}@example.invalid`;
    const result = await place([c.code], email, [{ sku: skuA, qty: 4 }]);
    const order = await prisma.order.findUniqueOrThrow({
      where: { orderNo: result.orderNo },
      select: { discountPaise: true },
    });
    // 50% of ₹1,200 is ₹600, capped at ₹50.
    expect(order.discountPaise).toBe(5_000);
  });

  it('discounts only the targeted product, not the qualifying one', async () => {
    const c = await makeCoupon({
      discountValue: 50,
      qualifyFamilies: [famA],
      discountFamilies: [famB],
    });
    const email = `${ns('tgt')}@example.invalid`;
    const result = await place([c.code], email, [
      { sku: skuA, qty: 1 },
      { sku: skuB, qty: 1 },
    ]);
    const order = await prisma.order.findUniqueOrThrow({
      where: { orderNo: result.orderNo },
      select: { discountPaise: true },
    });
    // 50% of B (₹200) only — A qualified but keeps its full price.
    expect(order.discountPaise).toBe(10_000);
  });

  it('refuses when the qualifying product is missing', async () => {
    const c = await makeCoupon({ qualifyFamilies: [famB], discountFamilies: [famA] });
    await expect(
      place([c.code], `${ns('noq')}@example.invalid`, [{ sku: skuA, qty: 1 }]),
    ).rejects.toThrow(/specific products/i);
  });

  it('honours a state restriction', async () => {
    const c = await makeCoupon({ allowedStates: ['Tamil Nadu'] });
    await expect(place([c.code], `${ns('st2')}@example.invalid`)).rejects.toThrow(/Kerala/i);
  });
});

// ============================================================================
describe('free shipping promotions', () => {
  it('waive the shipping charge without touching the weight calculation', async () => {
    const paid = await priceCart({ lines: [{ sku: skuA, qty: 1 }], state: 'Kerala' });
    expect(paid.shippingPaise).toBeGreaterThan(0);

    const c = await makeCoupon({ discountType: DiscountType.FREE_SHIPPING, discountValue: 0 });
    const free = await priceCart({
      lines: [{ sku: skuA, qty: 1 }],
      couponCodes: [c.code],
      state: 'Kerala',
    });

    expect(free.shippingPaise).toBe(0);
    expect(free.freeShippingFromCoupon).toBe(true);
    // The goods are untouched — this waives postage, it is not money off.
    expect(free.discountPaise).toBe(0);
    expect(free.subtotalPaise).toBe(paid.subtotalPaise);
  });
});

// ============================================================================
describe('usage release', () => {
  it('hands a coupon use back when the order is cancelled', async () => {
    const c = await makeCoupon({ totalUsageLimit: 1, perCustomerLimit: 1 });
    const email = `${ns('rel')}@example.invalid`;

    const order = await place([c.code], email);
    const afterUse = await prisma.coupon.findUniqueOrThrow({
      where: { id: c.id },
      select: { usedCount: true },
    });
    expect(afterUse.usedCount).toBe(1);

    await transition(
      order.orderNo,
      { to: OrderStatus.CANCELLED, fields: { cancelReason: 'changed mind' }, notifyCustomer: false },
      testCtx(actorId),
    );

    const afterRelease = await prisma.coupon.findUniqueOrThrow({
      where: { id: c.id },
      select: { usedCount: true },
    });
    // The use is handed back — the order will never complete.
    expect(afterRelease.usedCount).toBe(0);

    // And the customer's per-customer allowance is free again.
    const retry = await place([c.code], email);
    expect(retry.orderNo).toBeTruthy();
  });

  it('is idempotent — a second release cannot hand the same use back twice', async () => {
    const c = await makeCoupon({ totalUsageLimit: 5 });
    const email = `${ns('idem')}@example.invalid`;
    const order = await place([c.code], email);

    const cancel = () =>
      transition(
        order.orderNo,
        { to: OrderStatus.CANCELLED, fields: { cancelReason: 'x' }, notifyCustomer: false },
        testCtx(actorId),
      );

    await cancel();
    await cancel().catch(() => undefined); // already terminal; must not double-release

    const after = await prisma.coupon.findUniqueOrThrow({
      where: { id: c.id },
      select: { usedCount: true },
    });
    expect(after.usedCount).toBe(0);
  });
});

// ============================================================================
describe('backward compatibility', () => {
  it('a coupon created with only the original fields behaves exactly as before', async () => {
    // No stacking mode, no trigger, no eligibility — the defaults must reproduce
    // the pre-engine behaviour: one coupon, cart-wide, code-entered.
    const code = ns('legacy').toUpperCase();
    const legacy = await prisma.coupon.create({
      data: {
        code,
        discountType: DiscountType.PERCENTAGE,
        discountValue: 10,
        minOrderPaise: 99_900,
        startsAt: new Date(Date.now() - 86_400_000),
        endsAt: new Date(Date.now() + 86_400_000),
        totalUsageLimit: 500,
        perCustomerLimit: 1,
        isActive: true,
      },
      select: { id: true, code: true, stackingMode: true, trigger: true },
    });
    couponIds.push(legacy.id);

    expect(legacy.stackingMode).toBe(CouponStacking.NON_STACKABLE);
    expect(legacy.trigger).toBe(CouponTrigger.CODE);

    const email = `${ns('leg')}@example.invalid`;
    const result = await place([legacy.code], email, [{ sku: skuA, qty: 4 }]);
    const order = await prisma.order.findUniqueOrThrow({
      where: { orderNo: result.orderNo },
      select: { discountPaise: true, couponCode: true, couponCodes: true },
    });

    expect(order.discountPaise).toBe(12_000); // 10% of ₹1,200
    expect(order.couponCode).toBe(legacy.code);
    expect(order.couponCodes).toEqual([legacy.code]);
  });

  it('a legacy coupon still refuses to stack, because that was the old behaviour', async () => {
    const legacy = await makeCoupon({ stackingMode: CouponStacking.NON_STACKABLE });
    const other = await makeCoupon({ stackingMode: CouponStacking.STACKABLE });
    await expect(place([legacy.code, other.code], `${ns('lg2')}@example.invalid`)).rejects.toThrow(
      /cannot be combined/i,
    );
  });

  it('still accepts the original single couponCode field', async () => {
    const c = await makeCoupon({ stackingMode: CouponStacking.NON_STACKABLE });
    const cart = await priceCart({ lines: [{ sku: skuA, qty: 1 }], couponCode: c.code });
    expect(cart.discountPaise).toBe(3_000);
    expect(cart.coupon?.code).toBe(c.code);
  });
});

// ============================================================================
describe('server authority', () => {
  it('ignores any price the client suggests — quantities and SKUs only', async () => {
    const c = await makeCoupon({ discountValue: 10 });
    const cart = await priceCart({
      lines: [{ sku: skuA, qty: 2 }],
      couponCodes: [c.code],
    });
    // Priced from the catalogue: 2 × ₹300 = ₹600, 10% = ₹60.
    expect(cart.subtotalPaise).toBe(UNIT_A * 2);
    expect(cart.discountPaise).toBe(6_000);
  });

  it('re-evaluates at checkout rather than trusting an earlier quote', async () => {
    const c = await makeCoupon({ customerEligibility: CustomerEligibility.FIRST_ORDER });
    const email = `${ns('reval')}@example.invalid`;

    // An anonymous quote looks eligible — there is no identity to judge.
    const anonymous = await priceCart({ lines: [{ sku: skuA, qty: 1 }], couponCodes: [c.code] });
    expect(anonymous.discountPaise).toBeGreaterThan(0);

    // Give the customer a completed order, then check out with their email.
    const first = await place([], email);
    await acceptOrder(first.orderNo);

    await expect(place([c.code], email)).rejects.toThrow(/first order/i);
  });
});
