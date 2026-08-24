/**
 * Discount arithmetic: caps, residuals, and the paise invariants.
 *
 * The two properties worth proving are that a discount never exceeds what it
 * applies to, and that splitting one proportionally across lines loses nothing
 * to rounding. Both are pure functions, so both are provable without a database.
 */
import { describe, expect, it } from 'vitest';
import { DiscountType } from '@prisma/client';
import { drawDown, intendedDiscount } from './discounts';
import type { PromotionRow } from './types';

function coupon(over: Partial<PromotionRow>): PromotionRow {
  return {
    discountType: DiscountType.PERCENTAGE,
    discountValue: 10,
    maxDiscountPaise: null,
    bxgy: null,
    ...over,
  } as PromotionRow;
}

describe('percentage discounts', () => {
  it('takes the stated percentage', () => {
    expect(intendedDiscount(coupon({ discountValue: 10 }), 100_000)).toBe(10_000);
  });

  it('rounds to whole paise rather than carrying a fraction', () => {
    // 33% of 10,001 = 3300.33
    expect(intendedDiscount(coupon({ discountValue: 33 }), 10_001)).toBe(3_300);
    expect(Number.isInteger(intendedDiscount(coupon({ discountValue: 33 }), 10_001))).toBe(true);
  });

  it('honours a maximum discount cap', () => {
    // 50% of ₹2,000 is ₹1,000, capped at ₹300.
    expect(
      intendedDiscount(coupon({ discountValue: 50, maxDiscountPaise: 30_000 }), 200_000),
    ).toBe(30_000);
  });

  it('leaves a discount below the cap untouched', () => {
    expect(
      intendedDiscount(coupon({ discountValue: 10, maxDiscountPaise: 30_000 }), 100_000),
    ).toBe(10_000);
  });

  it('never exceeds the base, even at 100%', () => {
    expect(intendedDiscount(coupon({ discountValue: 100 }), 50_000)).toBe(50_000);
  });
});

describe('fixed discounts', () => {
  it('takes the stated amount', () => {
    expect(
      intendedDiscount(coupon({ discountType: DiscountType.FLAT, discountValue: 10_000 }), 100_000),
    ).toBe(10_000);
  });

  it('is capped at the base, so a total can never go negative', () => {
    expect(
      intendedDiscount(coupon({ discountType: DiscountType.FLAT, discountValue: 500_000 }), 20_000),
    ).toBe(20_000);
  });
});

describe('non-monetary types', () => {
  it('free shipping takes nothing off the goods', () => {
    expect(intendedDiscount(coupon({ discountType: DiscountType.FREE_SHIPPING }), 100_000)).toBe(0);
  });

  it('buy-x-get-y is priced elsewhere, in units', () => {
    expect(intendedDiscount(coupon({ discountType: DiscountType.BUY_X_GET_Y }), 100_000)).toBe(0);
  });
});

describe('drawDown', () => {
  it('splits proportionally across lines', () => {
    const remaining = [60_000, 40_000];
    const taken = drawDown(remaining, [0, 1], 10_000);
    expect(taken).toBe(10_000);
    expect(remaining).toEqual([54_000, 36_000]);
  });

  it('loses nothing to flooring — the remainder is placed', () => {
    // Three equal lines and 100 paise: 33 + 33 + 33 floors to 99.
    const remaining = [1_000, 1_000, 1_000];
    const taken = drawDown(remaining, [0, 1, 2], 100);
    expect(taken).toBe(100);
    expect(remaining.reduce((a, b) => a + b, 0)).toBe(2_900);
  });

  it('never draws more than the lines hold', () => {
    const remaining = [5_000];
    expect(drawDown(remaining, [0], 99_999)).toBe(5_000);
    expect(remaining).toEqual([0]);
  });

  it('touches only the lines it was given', () => {
    const remaining = [10_000, 10_000];
    drawDown(remaining, [1], 4_000);
    expect(remaining).toEqual([10_000, 6_000]);
  });

  it('is a no-op on an exhausted line', () => {
    const remaining = [0];
    expect(drawDown(remaining, [0], 5_000)).toBe(0);
  });

  it('stacks against the residual, so two 60% coupons never exceed 100%', () => {
    const remaining = [100_000];
    const first = drawDown(remaining, [0], intendedDiscount(coupon({ discountValue: 60 }), 100_000));
    const second = drawDown(
      remaining,
      [0],
      intendedDiscount(coupon({ discountValue: 60 }), remaining[0]!),
    );

    expect(first).toBe(60_000);
    expect(second).toBe(24_000); // 60% of the remaining ₹400
    expect(first + second).toBeLessThan(100_000);
    expect(remaining[0]).toBe(16_000);
  });

  it('keeps every figure an integer', () => {
    const remaining = [3_333, 6_667];
    const taken = drawDown(remaining, [0, 1], 1_234);
    expect(Number.isInteger(taken)).toBe(true);
    expect(remaining.every(Number.isInteger)).toBe(true);
  });
});
