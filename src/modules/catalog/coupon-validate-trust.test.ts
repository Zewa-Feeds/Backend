/**
 * The public coupon endpoints must not take a customer's word for what a cart
 * is worth.
 *
 * `POST /coupons/validate` used to accept `subtotalPaise` from the request body
 * and check the coupon's minimum-order rule against it. Checkout re-priced from
 * SKUs, so no discount was ever wrongly GIVEN — but the endpoint would happily
 * tell a client a coupon was valid for a cart that never met the minimum. These
 * tests pin the corrected behaviour: the subtotal comes from `priceCart`, and a
 * forged one has nowhere to enter.
 *
 * The real router is mounted on a real listening server, so the zod schema, the
 * limiter wiring and the error envelope are all exercised rather than described.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Category, DiscountType, PrismaClient, ProductStatus } from '@prisma/client';
import { ns, sweepFixtures } from '@/test/fixtures';
import { catalogRouter } from './catalog.routes';
import { errorHandler } from '@/middleware/errorHandler';

const prisma = new PrismaClient();

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as express.Request & { id: string }).id = 'test-request';
  next();
});
app.use('/', catalogRouter);
app.use(errorHandler);

let server: Server;
const url = (p: string) => `http://127.0.0.1:${(server.address() as AddressInfo).port}${p}`;

let SKU = '';
let slug = '';
const couponIds: string[] = [];

/** One unit costs ₹200, so a one-line cart is worth well under a ₹999 minimum. */
const UNIT_PAISE = 20_000;

async function makeCoupon(minOrderPaise: number): Promise<string> {
  const code = ns('cv').toUpperCase();
  const c = await prisma.coupon.create({
    data: {
      code,
      discountType: DiscountType.PERCENTAGE,
      discountValue: 10,
      minOrderPaise,
      startsAt: new Date(Date.now() - 86_400_000),
      endsAt: new Date(Date.now() + 86_400_000),
      isActive: true,
    },
    select: { id: true, code: true },
  });
  couponIds.push(c.id);
  return c.code;
}

const validateCoupon = (body: unknown) =>
  fetch(url('/coupons/validate'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const validateCart = (body: unknown) =>
  fetch(url('/cart/validate'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  await sweepFixtures(prisma);
  slug = ns('cval');
  const family = await prisma.productFamily.create({
    data: {
      slug,
      name: `ZZ Validate ${slug}`,
      category: Category.SLOW_SINKING_PELLETS,
      status: ProductStatus.ACTIVE,
      shortDesc: 'fixture',
      variants: {
        create: {
          sku: slug.toUpperCase(),
          pack: '45g',
          mrpPaise: 25_000,
          pricePaise: UNIT_PAISE,
          stock: 100,
        },
      },
    },
    include: { variants: true },
  });
  SKU = family.variants[0]!.sku;
  server = app.listen(0);
});

afterAll(async () => {
  server?.close();
  if (couponIds.length > 0) {
    await prisma.coupon.deleteMany({ where: { id: { in: couponIds } } });
  }
  await sweepFixtures(prisma);
  await prisma.$disconnect();
});

describe('POST /coupons/validate — server-derived subtotal', () => {
  it('rejects a body that supplies a subtotal instead of cart lines', async () => {
    const code = await makeCoupon(0);
    // The old contract. `lines` is required now, so this cannot even parse.
    const res = await validateCoupon({ code, subtotalPaise: 999_999 });
    expect(res.status).toBe(422);
  });

  it('ignores a forged subtotal smuggled alongside real lines', async () => {
    const code = await makeCoupon(99_900); // ₹999 minimum

    // One unit is ₹200. The forged subtotal claims ₹9,999.99 to clear it.
    const res = await validateCoupon({
      code,
      lines: [{ sku: SKU, qty: 1 }],
      subtotalPaise: 999_999,
    });

    // The server prices the cart itself: ₹200 does not meet ₹999.
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('COUPON_MIN_ORDER');
  });

  it('computes the discount from real line prices, not client-supplied ones', async () => {
    const code = await makeCoupon(0);

    const res = await validateCoupon({
      code,
      lines: [{ sku: SKU, qty: 3 }],
      subtotalPaise: 1, // ignored
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { discountPaise: number; newSubtotalPaise: number; code: string };
    };
    // 3 × ₹200 = ₹600; 10% off = ₹60.
    expect(body.data.discountPaise).toBe(6_000);
    expect(body.data.newSubtotalPaise).toBe(54_000);
    expect(body.data.code).toBe(code);
  });

  it('lets a genuinely qualifying cart through', async () => {
    const code = await makeCoupon(99_900);
    // 6 × ₹200 = ₹1,200, comfortably over the ₹999 minimum.
    const res = await validateCoupon({ code, lines: [{ sku: SKU, qty: 6 }] });
    expect(res.status).toBe(200);
  });

  it('preserves the response shape existing callers expect', async () => {
    const code = await makeCoupon(0);
    const res = await validateCoupon({ code, lines: [{ sku: SKU, qty: 1 }] });
    const body = (await res.json()) as { data: Record<string, unknown> };

    for (const key of [
      'code',
      'discountPaise',
      'discountLabel',
      'newSubtotalPaise',
      'scope',
      'eligibleSubtotalPaise',
      'appliedTo',
    ]) {
      expect(body.data).toHaveProperty(key);
    }
  });

  it('still reports distinct, customer-facing rejection reasons', async () => {
    const code = ns('gone').toUpperCase();
    const res = await validateCoupon({ code, lines: [{ sku: SKU, qty: 1 }] });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('COUPON_NOT_FOUND');
    expect(body.error.message).toMatch(/not a recognised coupon code/i);
  });
});

describe('POST /cart/validate — unchanged for ordinary re-pricing', () => {
  it('prices a cart with no coupon', async () => {
    const res = await validateCart({ lines: [{ sku: SKU, qty: 2 }] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { subtotalPaise: number; discountPaise: number } };
    expect(body.data.subtotalPaise).toBe(40_000);
    expect(body.data.discountPaise).toBe(0);
  });

  it('applies a valid coupon and reports it', async () => {
    const code = await makeCoupon(0);
    const res = await validateCart({ lines: [{ sku: SKU, qty: 2 }], couponCode: code });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { discountPaise: number; coupon: { code: string } | null };
    };
    expect(body.data.discountPaise).toBe(4_000); // 10% of ₹400
    expect(body.data.coupon?.code).toBe(code);
  });

  it('keeps a bad coupon non-fatal, reported under the __coupon__ sentinel', async () => {
    // The storefront filters on this exact sku to decide fulfillability, so the
    // sentinel string is part of the contract, not an implementation detail.
    const res = await validateCart({
      lines: [{ sku: SKU, qty: 2 }],
      couponCode: ns('nope').toUpperCase(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { discountPaise: number; issues: { sku: string; code: string }[] };
    };
    expect(body.data.discountPaise).toBe(0);
    const issue = body.data.issues.find((i) => i.sku === '__coupon__');
    expect(issue?.code).toBe('COUPON_NOT_FOUND');
  });
});
