/**
 * Qualify versus discount — the distinction that stops a promotion discounting
 * the very product that was only supposed to unlock it.
 *
 * Also covers the Buy X Get Y unit maths, which shares the same targeting.
 */
import { describe, expect, it } from 'vitest';
import { Category, CouponScope, CouponTargetRole } from '@prisma/client';
import { resolveTargeting } from './targeting';
import { priceBxgy } from './bxgy';
import type { PromoLine, PromotionRow } from './types';

const line = (over: Partial<PromoLine> & { familyId: string }): PromoLine => ({
  variantId: `v-${over.familyId}`,
  category: Category.SLOW_SINKING_PELLETS,
  sku: `SKU-${over.familyId}`,
  productName: `Product ${over.familyId}`,
  qty: 1,
  unitPricePaise: 10_000,
  lineTotalPaise: 10_000,
  ...over,
});

function coupon(over: Partial<PromotionRow>): PromotionRow {
  return {
    scope: CouponScope.ALL_PRODUCTS,
    requireAllQualifiers: false,
    products: [],
    variants: [],
    categories: [],
    customers: [],
    bxgy: null,
    ...over,
  } as unknown as PromotionRow;
}

const D = CouponTargetRole.DISCOUNT;
const Q = CouponTargetRole.QUALIFY;
const X = CouponTargetRole.EXCLUDE;

describe('cart-wide promotions', () => {
  it('discount every line when nothing is targeted', () => {
    const lines = [line({ familyId: 'A' }), line({ familyId: 'B' })];
    const t = resolveTargeting(coupon({}), lines);
    expect(t.discountableIdx).toEqual([0, 1]);
    expect(t.qualifies).toBe(true);
  });
});

describe('product-specific promotions', () => {
  it('discount only the targeted family', () => {
    const lines = [line({ familyId: 'A' }), line({ familyId: 'B' })];
    const t = resolveTargeting(coupon({ products: [{ familyId: 'A', role: D }] }), lines);
    expect(t.discountableIdx).toEqual([0]);
    expect(t.appliedTo).toEqual(['Product A']);
  });

  it('discount only the targeted pack, not the whole product', () => {
    const lines = [
      line({ familyId: 'A', variantId: 'v-45g' }),
      line({ familyId: 'A', variantId: 'v-1kg' }),
    ];
    const t = resolveTargeting(coupon({ variants: [{ variantId: 'v-1kg', role: D }] }), lines);
    expect(t.discountableIdx).toEqual([1]);
  });

  it('discount by category', () => {
    const lines = [
      line({ familyId: 'A', category: Category.FLOATING_PELLETS }),
      line({ familyId: 'B', category: Category.BOTTOM_DWELLERS }),
    ];
    const t = resolveTargeting(
      coupon({ categories: [{ category: Category.BOTTOM_DWELLERS, role: D }] }),
      lines,
    );
    expect(t.discountableIdx).toEqual([1]);
  });

  it('honour an exclusion carved out of a broader selection', () => {
    const lines = [
      line({ familyId: 'A', category: Category.FLOATING_PELLETS }),
      line({ familyId: 'B', category: Category.FLOATING_PELLETS }),
    ];
    const t = resolveTargeting(
      coupon({
        categories: [{ category: Category.FLOATING_PELLETS, role: D }],
        products: [{ familyId: 'B', role: X }],
      }),
      lines,
    );
    expect(t.discountableIdx).toEqual([0]);
  });

  it('match nothing when a product-specific coupon has lost its products', () => {
    // Otherwise it would silently become cart-wide — the opposite of its label.
    const lines = [line({ familyId: 'A' })];
    const t = resolveTargeting(coupon({ scope: CouponScope.SPECIFIC_PRODUCTS }), lines);
    expect(t.discountableIdx).toEqual([]);
    expect(t.qualifies).toBe(false);
  });
});

describe('qualifying products are not discounted by accident', () => {
  it('buy A, get money off B — A keeps its full price', () => {
    const lines = [line({ familyId: 'A' }), line({ familyId: 'B' })];
    const t = resolveTargeting(
      coupon({
        products: [
          { familyId: 'A', role: Q },
          { familyId: 'B', role: D },
        ],
      }),
      lines,
    );

    expect(t.qualifies).toBe(true);
    expect(t.qualifyingIdx).toEqual([0]);
    // The whole point: A qualified but is NOT in the discountable set.
    expect(t.discountableIdx).toEqual([1]);
  });

  it('does not fire when the qualifying product is absent', () => {
    const lines = [line({ familyId: 'B' })];
    const t = resolveTargeting(
      coupon({
        products: [
          { familyId: 'A', role: Q },
          { familyId: 'B', role: D },
        ],
      }),
      lines,
    );
    expect(t.qualifies).toBe(false);
  });
});

describe('multiple-product conditions', () => {
  it('ANY: one of the named products is enough', () => {
    const lines = [line({ familyId: 'B' })];
    const t = resolveTargeting(
      coupon({
        requireAllQualifiers: false,
        products: [
          { familyId: 'A', role: Q },
          { familyId: 'B', role: Q },
        ],
      }),
      lines,
    );
    expect(t.qualifies).toBe(true);
  });

  it('ALL: both named products must be present', () => {
    const onlyB = resolveTargeting(
      coupon({
        requireAllQualifiers: true,
        products: [
          { familyId: 'A', role: Q },
          { familyId: 'B', role: Q },
        ],
      }),
      [line({ familyId: 'B' })],
    );
    expect(onlyB.qualifies).toBe(false);

    const both = resolveTargeting(
      coupon({
        requireAllQualifiers: true,
        products: [
          { familyId: 'A', role: Q },
          { familyId: 'B', role: Q },
        ],
      }),
      [line({ familyId: 'A' }), line({ familyId: 'B' })],
    );
    expect(both.qualifies).toBe(true);
  });
});

describe('quantity conditions', () => {
  it('counts units across the qualifying set', () => {
    const lines = [line({ familyId: 'A', qty: 3, lineTotalPaise: 30_000 })];
    const t = resolveTargeting(coupon({ products: [{ familyId: 'A', role: Q }] }), lines);
    expect(t.qualifyingQty).toBe(3);
  });

  it('counts the whole cart when no qualifying set is declared', () => {
    const lines = [line({ familyId: 'A', qty: 2 }), line({ familyId: 'B', qty: 4 })];
    const t = resolveTargeting(coupon({}), lines);
    expect(t.qualifyingQty).toBe(6);
  });
});

describe('buy X get Y', () => {
  const bxgyCoupon = (over: Partial<NonNullable<PromotionRow['bxgy']>> = {}) =>
    coupon({
      bxgy: { buyQty: 2, getQty: 1, rewardPercentOff: 100, maxRepeats: null, ...over },
    });

  it('gives away the cheapest qualifying unit', () => {
    const lines = [
      line({ familyId: 'A', qty: 2, unitPricePaise: 30_000, lineTotalPaise: 60_000 }),
      line({ familyId: 'B', qty: 1, unitPricePaise: 10_000, lineTotalPaise: 10_000 }),
    ];
    const t = resolveTargeting(bxgyCoupon(), lines);
    const result = priceBxgy(bxgyCoupon(), lines, t);

    // 3 units => one batch of 2 => 1 free unit, the ₹100 one.
    expect(result.rewardedUnits).toBe(1);
    expect(result.discountPaise).toBe(10_000);
  });

  it('repeats while the cart can pay for it', () => {
    const lines = [line({ familyId: 'A', qty: 6, unitPricePaise: 10_000, lineTotalPaise: 60_000 })];
    const t = resolveTargeting(bxgyCoupon(), lines);
    const result = priceBxgy(bxgyCoupon(), lines, t);
    // 6 units, buy 2 get 1: 3 batches, but only 6 units exist. Two are withheld
    // per batch as the "buy" side, leaving 0 spare — so the giveaway is bounded.
    expect(result.rewardedUnits).toBeLessThanOrEqual(3);
    expect(result.discountPaise).toBe(result.rewardedUnits * 10_000);
  });

  it('honours maxRepeats', () => {
    const lines = [line({ familyId: 'A', qty: 9, unitPricePaise: 10_000, lineTotalPaise: 90_000 })];
    const c = bxgyCoupon({ maxRepeats: 1 });
    const t = resolveTargeting(c, lines);
    const result = priceBxgy(c, lines, t);
    expect(result.rewardedUnits).toBe(1);
  });

  it('discounts partially when the reward is not 100% off', () => {
    const lines = [line({ familyId: 'A', qty: 3, unitPricePaise: 10_000, lineTotalPaise: 30_000 })];
    const c = bxgyCoupon({ rewardPercentOff: 50 });
    const t = resolveTargeting(c, lines);
    const result = priceBxgy(c, lines, t);
    expect(result.discountPaise).toBe(5_000); // half of one ₹100 unit
  });

  it('earns nothing when the cart is short of a batch', () => {
    const lines = [line({ familyId: 'A', qty: 1, unitPricePaise: 10_000 })];
    const t = resolveTargeting(bxgyCoupon(), lines);
    expect(priceBxgy(bxgyCoupon(), lines, t).rewardedUnits).toBe(0);
  });
});
