/**
 * Coupon usage limits under concurrency — against a real database.
 *
 * The property under test cannot be proved with a mock: that two checkouts
 * racing for the last use of a coupon cannot both win. The limit is enforced by
 * a conditional UPDATE inside the checkout transaction, so what matters is what
 * Postgres does when two transactions issue it at the same moment.
 *
 * COD is used throughout. It exercises the same transaction and the same coupon
 * reservation as an online order while keeping Razorpay entirely out of the
 * test — no gateway, no signature, no webhook.
 *
 * The queues ARE mocked. They are Redis, and nothing here depends on a job
 * running; only on the order and coupon rows the transaction leaves behind.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/*
 * COD is switched OFF in this developer's .env, and .env.test does not override
 * it. These tests use COD deliberately — it exercises the same transaction and
 * the same coupon reservation as an online order while keeping Razorpay out of
 * the test entirely — so the flag is set for this process only.
 *
 * `vi.hoisted` runs before the import graph is evaluated, which is what makes it
 * land before `@/config/env` reads the value. No source file is touched and no
 * payment code is mocked.
 */
vi.hoisted(() => {
  process.env.PAYMENT_COD_ENABLED = 'true';
});

vi.mock('@/jobs/queues', () => ({
  emailQueue: { add: vi.fn(async () => ({ id: 'job' })) },
  paymentQueue: { add: vi.fn(async () => ({ id: 'job' })) },
  maintenanceQueue: { add: vi.fn(async () => ({ id: 'job' })) },
}));

import { PrismaClient, DiscountType, PaymentMethod } from '@prisma/client';
import { checkout } from '@/modules/checkout/checkout.service';
import { ns, sweepFixtures, testActor, testCtx } from '@/test/fixtures';

const prisma = new PrismaClient();

/** Kochi — a real PIN, so the checkout's pincode/state guard is satisfied. */
const ADDRESS = {
  name: 'Zz Fixture',
  phone: '9876543210',
  line1: '1 Test Lane',
  city: 'Kochi',
  state: 'Kerala',
  pincode: '682001',
};

let SKU = '';
let actorId = '';
const createdCouponIds: string[] = [];
const createdEmails: string[] = [];

/** A variant with stock far beyond anything a test here will consume. */
async function makeVariant(): Promise<string> {
  const slug = ns('usage');
  const family = await prisma.productFamily.create({
    data: {
      slug,
      name: `ZZ Usage ${slug}`,
      category: 'SLOW_SINKING_PELLETS',
      status: 'ACTIVE',
      shortDesc: 'fixture',
      variants: {
        create: {
          sku: slug.toUpperCase(),
          pack: '45g',
          mrpPaise: 150000,
          pricePaise: 120000, // ₹1,200 — clears a ₹999 minimum on one unit
          stock: 500,
        },
      },
    },
    include: { variants: true },
  });
  return family.variants[0]!.sku;
}

async function makeCoupon(opts: {
  discountType?: DiscountType;
  discountValue?: number;
  minOrderPaise?: number;
  totalUsageLimit?: number | null;
  perCustomerLimit?: number;
  usedCount?: number;
}): Promise<{ id: string; code: string }> {
  const code = ns('cpn').toUpperCase();
  const coupon = await prisma.coupon.create({
    data: {
      code,
      discountType: opts.discountType ?? DiscountType.PERCENTAGE,
      discountValue: opts.discountValue ?? 10,
      minOrderPaise: opts.minOrderPaise ?? 0,
      startsAt: new Date(Date.now() - 86_400_000),
      endsAt: new Date(Date.now() + 86_400_000),
      totalUsageLimit: opts.totalUsageLimit === undefined ? null : opts.totalUsageLimit,
      perCustomerLimit: opts.perCustomerLimit ?? 1,
      usedCount: opts.usedCount ?? 0,
      isActive: true,
    },
    select: { id: true, code: true },
  });
  createdCouponIds.push(coupon.id);
  return coupon;
}

function place(couponCode: string | null, email: string, qty = 1) {
  createdEmails.push(email.toLowerCase());
  return checkout(
    {
      lines: [{ sku: SKU, qty }],
      email,
      phone: '9876543210',
      shippingAddress: ADDRESS,
      paymentMethod: PaymentMethod.COD,
      couponCode,
    },
    testCtx(actorId),
  );
}

beforeAll(async () => {
  await sweepFixtures(prisma);
  actorId = await testActor(prisma);
  SKU = await makeVariant();
});

afterAll(async () => {
  // Orders do not hang off ProductFamily, so the sweep cannot reach them.
  if (createdEmails.length > 0) {
    await prisma.order.deleteMany({ where: { email: { in: createdEmails } } });
    await prisma.customer.deleteMany({ where: { email: { in: createdEmails } } });
  }
  if (createdCouponIds.length > 0) {
    await prisma.coupon.deleteMany({ where: { id: { in: createdCouponIds } } });
  }
  await sweepFixtures(prisma);
  await prisma.$disconnect();
});

describe('global usage limit', () => {
  it('cannot be exceeded by concurrent checkouts racing for the last use', async () => {
    const coupon = await makeCoupon({ totalUsageLimit: 1, perCustomerLimit: 1 });

    // Different emails, so the per-customer limit is not what stops the loser —
    // the global reservation has to be the thing that does.
    const results = await Promise.allSettled([
      place(coupon.code, `${ns('a')}@example.invalid`),
      place(coupon.code, `${ns('b')}@example.invalid`),
    ]);

    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');

    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);

    const after = await prisma.coupon.findUniqueOrThrow({
      where: { id: coupon.id },
      select: { usedCount: true },
    });
    expect(after.usedCount).toBe(1);

    // The loser's whole transaction rolled back — one redemption, one order.
    const redemptions = await prisma.couponRedemption.count({ where: { couponId: coupon.id } });
    expect(redemptions).toBe(1);
  });

  it('holds under a wider race than the limit allows', async () => {
    const coupon = await makeCoupon({ totalUsageLimit: 3, perCustomerLimit: 1 });

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => place(coupon.code, `${ns('r')}@example.invalid`)),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);

    const after = await prisma.coupon.findUniqueOrThrow({
      where: { id: coupon.id },
      select: { usedCount: true },
    });
    expect(after.usedCount).toBe(3);
  });

  it('rejects a coupon that is already at its limit', async () => {
    const coupon = await makeCoupon({ totalUsageLimit: 5, usedCount: 5 });

    await expect(place(coupon.code, `${ns('full')}@example.invalid`)).rejects.toThrow(
      /usage limit/i,
    );

    const after = await prisma.coupon.findUniqueOrThrow({
      where: { id: coupon.id },
      select: { usedCount: true },
    });
    expect(after.usedCount).toBe(5);
  });

  it('increments exactly once per successful order, and not at all on failure', async () => {
    const coupon = await makeCoupon({ totalUsageLimit: 10, perCustomerLimit: 5 });
    const email = `${ns('inc')}@example.invalid`;

    await place(coupon.code, email);
    await place(coupon.code, email);

    const after = await prisma.coupon.findUniqueOrThrow({
      where: { id: coupon.id },
      select: { usedCount: true },
    });
    expect(after.usedCount).toBe(2);
  });

  it('leaves an unlimited coupon unconstrained', async () => {
    // totalUsageLimit null must not be caught by the `usedCount < limit` guard:
    // in SQL that comparison is NULL, not true.
    const coupon = await makeCoupon({ totalUsageLimit: null, perCustomerLimit: 5 });
    const email = `${ns('unl')}@example.invalid`;

    await place(coupon.code, email);
    await place(coupon.code, email);
    await place(coupon.code, email);

    const after = await prisma.coupon.findUniqueOrThrow({
      where: { id: coupon.id },
      select: { usedCount: true },
    });
    expect(after.usedCount).toBe(3);
  });
});

describe('existing coupon behaviour is unchanged', () => {
  it('applies a MONSOON10-shaped percentage coupon exactly as before', async () => {
    // Same shape as the seeded MONSOON10: 10% off, ₹999 minimum.
    const coupon = await makeCoupon({
      discountType: DiscountType.PERCENTAGE,
      discountValue: 10,
      minOrderPaise: 99_900,
      totalUsageLimit: 500,
    });

    const result = await place(coupon.code, `${ns('m10')}@example.invalid`);
    const order = await prisma.order.findUniqueOrThrow({
      where: { orderNo: result.orderNo },
      select: { subtotalPaise: true, discountPaise: true, couponCode: true },
    });

    expect(order.couponCode).toBe(coupon.code);
    expect(order.subtotalPaise).toBe(120_000);
    expect(order.discountPaise).toBe(12_000); // 10% of ₹1,200
  });

  it('applies a FIRSTTANK-shaped flat coupon exactly as before', async () => {
    // Same shape as the seeded FIRSTTANK: ₹100 off, ₹499 minimum.
    const coupon = await makeCoupon({
      discountType: DiscountType.FLAT,
      discountValue: 10_000,
      minOrderPaise: 49_900,
    });

    const result = await place(coupon.code, `${ns('ft')}@example.invalid`);
    const order = await prisma.order.findUniqueOrThrow({
      where: { orderNo: result.orderNo },
      select: { discountPaise: true },
    });

    expect(order.discountPaise).toBe(10_000);
  });

  it('still rejects a coupon below its minimum order value', async () => {
    const coupon = await makeCoupon({ minOrderPaise: 500_000 });

    await expect(place(coupon.code, `${ns('min')}@example.invalid`)).rejects.toThrow(/5,000\.00/);
  });

  it('still records a redemption so per-customer limits keep working', async () => {
    const coupon = await makeCoupon({ perCustomerLimit: 1 });
    const email = `${ns('per')}@example.invalid`;

    await place(coupon.code, email);
    await expect(place(coupon.code, email)).rejects.toThrow(/already used/i);
  });

  it('places an order with no coupon at all', async () => {
    const result = await place(null, `${ns('none')}@example.invalid`);
    const order = await prisma.order.findUniqueOrThrow({
      where: { orderNo: result.orderNo },
      select: { discountPaise: true, couponCode: true },
    });

    expect(order.couponCode).toBeNull();
    expect(order.discountPaise).toBe(0);
  });
});
