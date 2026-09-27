/**
 * The public offers list must answer for the VIEWER, not for everybody.
 *
 * THE DEFECT THIS FILE EXISTS FOR
 *
 * `GET /offers` took no customer context, so it advertised every public coupon to
 * everyone. A signed-in customer was shown ZEWA1, which they had already used; the
 * cart applied it, and only the final `place()` refused it with "You have already
 * used ZEWA1." Three surfaces, two different answers about one coupon, and the
 * customer blocked at payment by a code the shop had just offered them.
 *
 * The rules are NOT duplicated for this list — `listPublicOffers` calls
 * `assertCustomerEligible`, the same function `assertEligible` uses at checkout.
 * These tests exist to prove that reuse holds for each eligibility kind, so a rule
 * added later cannot reach checkout while this list keeps advertising past it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CustomerEligibility,
  DiscountType,
  OrderStatus,
  PaymentStatus,
  PrismaClient,
} from '@prisma/client';
import { listPublicOffers } from './coupons.service';

const prisma = new PrismaClient();
const TAG = 'zzoffers';

let familyId = '';
let variantId = '';

/** A public, advertised coupon of the given eligibility kind. */
async function makeCoupon(
  code: string,
  over: Record<string, unknown> = {},
): Promise<{ id: string; code: string }> {
  return prisma.coupon.create({
    data: {
      code: `${TAG}-${code}`.toUpperCase(),
      name: `Offer ${code}`,
      discountType: DiscountType.PERCENTAGE,
      discountValue: 10,
      minOrderPaise: 0,
      isActive: true,
      showAtCheckout: true,
      startsAt: new Date(Date.now() - 86_400_000),
      endsAt: new Date(Date.now() + 86_400_000),
      customerEligibility: CustomerEligibility.ALL_CUSTOMERS,
      ...over,
    },
    select: { id: true, code: true },
  });
}

/** A delivered order, which is what "prior order" counts. */
async function makeOrder(email: string) {
  return prisma.order.create({
    data: {
      orderNo: `${TAG}-${Date.now()}${Math.floor(Math.random() * 1000)}`,
      email,
      phone: '+919000000009',
      shippingAddress: { name: 'Offers Test', line1: 'L1', city: 'Kochi', state: 'Kerala', pincode: '682001' },
      subtotalPaise: 50000,
      discountPaise: 0,
      shippingPaise: 0,
      taxPaise: 0,
      totalPaise: 50000,
      status: OrderStatus.DELIVERED,
      paymentStatus: PaymentStatus.PAID,
      paymentMethod: 'COD',
      items: {
        create: [
          {
            variantId,
            productName: 'Offers fixture',
            sku: `${TAG}-SKU`,
            pack: '1kg',
            qty: 1,
            unitPricePaise: 50000,
            lineTotalPaise: 50000,
            hsn: '2309',
            taxRatePct: 0,
          },
        ],
      },
    },
    select: { id: true },
  });
}

/** Find one coupon in the listing, by the code `makeCoupon` produced. */
const find = (offers: Awaited<ReturnType<typeof listPublicOffers>>, code: string) =>
  offers.find((o) => o.code === code);

beforeAll(async () => {
  const family = await prisma.productFamily.create({
    data: {
      slug: `${TAG}-fam-${Date.now()}`,
      name: 'Offers Fixture',
      category: 'FLOATING_PELLETS',
      status: 'ACTIVE',
      shortDesc: 'fixture',
    },
    select: { id: true },
  });
  familyId = family.id;
  const variant = await prisma.productVariant.create({
    data: {
      familyId: family.id,
      sku: `${TAG}-SKU`,
      pack: '1kg',
      pricePaise: 50000,
      mrpPaise: 50000,
      stock: 1000,
      isActive: true,
    },
    select: { id: true },
  });
  variantId = variant.id;
});

afterAll(async () => {
  await prisma.couponRedemption.deleteMany({ where: { email: { contains: TAG } } });
  await prisma.order.deleteMany({ where: { email: { contains: TAG } } });
  await prisma.coupon.deleteMany({ where: { code: { startsWith: TAG.toUpperCase() } } });
  await prisma.productVariant.deleteMany({ where: { familyId } });
  await prisma.productFamily.deleteMany({ where: { id: familyId } });
  await prisma.$disconnect();
});

describe('a coupon the viewer has already used', () => {
  it('comes back marked unavailable, with the reason', async () => {
    const email = `${TAG}-used-${Date.now()}@zewafeeds.test`;
    const coupon = await makeCoupon(`used${Date.now()}`, { perCustomerLimit: 1 });
    const order = await makeOrder(email);
    await prisma.couponRedemption.create({
      data: { couponId: coupon.id, orderId: order.id, email, discountPaise: 100 },
    });

    const offers = await listPublicOffers({ email });

    expect(find(offers, coupon.code)?.unavailableReason).toMatch(/already used/i);
  });

  /* A released redemption — cancelled order — must stop counting. */
  it('becomes available again once the redemption is released', async () => {
    const email = `${TAG}-rel-${Date.now()}@zewafeeds.test`;
    const coupon = await makeCoupon(`rel${Date.now()}`, { perCustomerLimit: 1 });
    const order = await makeOrder(email);
    await prisma.couponRedemption.create({
      data: {
        couponId: coupon.id,
        orderId: order.id,
        email,
        discountPaise: 100,
        releasedAt: new Date(),
      },
    });

    const offers = await listPublicOffers({ email });

    expect(find(offers, coupon.code)?.unavailableReason).toBeNull();
  });
});

describe('a first-order-only coupon', () => {
  it('is unavailable to a customer who has ordered before', async () => {
    const email = `${TAG}-repeat-${Date.now()}@zewafeeds.test`;
    const coupon = await makeCoupon(`first${Date.now()}`, {
      customerEligibility: CustomerEligibility.FIRST_ORDER,
    });
    await makeOrder(email);

    const offers = await listPublicOffers({ email });

    expect(find(offers, coupon.code)?.unavailableReason).toMatch(/first order/i);
  });

  it('is available to a customer who has not', async () => {
    const email = `${TAG}-new-${Date.now()}@zewafeeds.test`;
    const coupon = await makeCoupon(`firstok${Date.now()}`, {
      customerEligibility: CustomerEligibility.FIRST_ORDER,
    });

    const offers = await listPublicOffers({ email });

    expect(find(offers, coupon.code)?.unavailableReason).toBeNull();
  });
});

describe('a returning-customer coupon', () => {
  it('is unavailable to someone with no orders', async () => {
    const email = `${TAG}-noorders-${Date.now()}@zewafeeds.test`;
    const coupon = await makeCoupon(`existing${Date.now()}`, {
      customerEligibility: CustomerEligibility.EXISTING_CUSTOMER,
    });

    const offers = await listPublicOffers({ email });

    expect(find(offers, coupon.code)?.unavailableReason).toMatch(/returning customers/i);
  });
});

describe('a guest with no session', () => {
  /*
   * No regression for guests: per-customer rules cannot be judged without an
   * identity, so nothing is greyed out on a guess. Checkout decides once the
   * customer signs in or types an email.
   */
  it('sees every public coupon as available', async () => {
    const coupon = await makeCoupon(`guest${Date.now()}`, {
      customerEligibility: CustomerEligibility.FIRST_ORDER,
    });

    const offers = await listPublicOffers();

    expect(find(offers, coupon.code)?.unavailableReason).toBeNull();
  });

  it('is unaffected by another customer having used the coupon', async () => {
    const other = `${TAG}-other-${Date.now()}@zewafeeds.test`;
    const coupon = await makeCoupon(`shared${Date.now()}`, { perCustomerLimit: 1 });
    const order = await makeOrder(other);
    await prisma.couponRedemption.create({
      data: { couponId: coupon.id, orderId: order.id, email: other, discountPaise: 100 },
    });

    const offers = await listPublicOffers();

    expect(find(offers, coupon.code)?.unavailableReason).toBeNull();
  });
});

describe('an ordinary eligible coupon', () => {
  it('is still offered exactly as before', async () => {
    const email = `${TAG}-fine-${Date.now()}@zewafeeds.test`;
    const coupon = await makeCoupon(`fine${Date.now()}`);

    const offers = await listPublicOffers({ email });
    const row = find(offers, coupon.code);

    expect(row?.unavailableReason).toBeNull();
    expect(row?.discountLabel).toBe('10% off');
  });

  /*
   * Cart rules are NOT judged here. A minimum-spend coupon must stay offerable —
   * the cart predicts the shortfall itself and phrases it as "add ₹81 more",
   * which is actionable in a way "unavailable" is not.
   */
  it('does not grey out a coupon merely for having a minimum spend', async () => {
    const email = `${TAG}-min-${Date.now()}@zewafeeds.test`;
    const coupon = await makeCoupon(`min${Date.now()}`, { minOrderPaise: 999_00 });

    const offers = await listPublicOffers({ email });

    expect(find(offers, coupon.code)?.unavailableReason).toBeNull();
    expect(find(offers, coupon.code)?.minOrderPaise).toBe(999_00);
  });
});
