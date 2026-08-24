import { describe, expect, it, vi } from 'vitest';
import {
  Category,
  CouponScope,
  CouponStacking,
  CouponTargetRole,
  CouponTrigger,
  CustomerEligibility,
  DiscountType,
} from '@prisma/client';

vi.mock('@/lib/prisma', () => ({
  prisma: {
    coupon: { findMany: vi.fn().mockResolvedValue([]) },
    couponRedemption: { findMany: vi.fn().mockResolvedValue([]) },
    order: { count: vi.fn().mockResolvedValue(0) },
  },
}));

import { evaluate } from '@/modules/promotions/engine';
import type { PromoLine, PromotionRow } from '@/modules/promotions/types';

const line = (over: Partial<PromoLine> & { familyId: string; sku: string }): PromoLine => ({
  variantId: `v-${over.sku}`,
  category: Category.SLOW_SINKING_PELLETS,
  productName: `Product ${over.familyId}`,
  qty: 1,
  unitPricePaise: 50_000,
  lineTotalPaise: 50_000,
  ...over,
});

function makePromotion(over: Partial<PromotionRow>): PromotionRow {
  const now = new Date();
  const startsAt = new Date(now.getTime() - 86400000);
  const endsAt = new Date(now.getTime() + 86400000 * 30);

  return {
    id: 'preview-promo',
    code: 'TESTPROMO',
    name: 'Test Promotion',
    description: null,
    discountType: DiscountType.PERCENTAGE,
    discountValue: 10,
    maxDiscountPaise: null,
    minOrderPaise: 0,
    minQty: null,
    maxQty: null,
    startsAt,
    endsAt,
    totalUsageLimit: null,
    perCustomerLimit: 1,
    usedCount: 0,
    isActive: true,
    scope: CouponScope.ALL_PRODUCTS,
    stackingMode: CouponStacking.NON_STACKABLE,
    priority: 0,
    trigger: CouponTrigger.CODE,
    combinesWithAutomatic: true,
    customerEligibility: CustomerEligibility.ALL_CUSTOMERS,
    firstNOrders: null,
    allowedStates: [],
    requireAllQualifiers: false,
    products: [],
    variants: [],
    categories: [],
    customers: [],
    bxgy: null,
    ...over,
  };
}

describe('Promotion Preview Engine with Overlay Promotions', () => {
  it('evaluates an unsaved All Products percentage discount without DB persistence', async () => {
    const promo = makePromotion({
      code: 'UNSAVED10',
      discountType: DiscountType.PERCENTAGE,
      discountValue: 10,
    });

    const lines = [
      line({ familyId: 'f1', sku: 'SKU-1', unitPricePaise: 100_000, lineTotalPaise: 100_000, qty: 1 }),
      line({ familyId: 'f2', sku: 'SKU-2', unitPricePaise: 50_000, lineTotalPaise: 50_000, qty: 1 }),
    ];

    const outcome = await evaluate(
      {
        lines,
        subtotalPaise: 150_000,
        requestedCodes: ['UNSAVED10'],
      },
      { overlayPromotions: [promo] },
    );

    expect(outcome.applied.length).toBe(1);
    expect(outcome.applied[0].code).toBe('UNSAVED10');
    expect(outcome.applied[0].discountPaise).toBe(15_000); // 10% of 1500
    expect(outcome.totalDiscountPaise).toBe(15_000);
    expect(outcome.rejected.length).toBe(0);
  });

  it('rejects an unsaved coupon when minimum order requirement is not met', async () => {
    const promo = makePromotion({
      code: 'MIN999',
      minOrderPaise: 99_900, // ₹999
    });

    const lines = [
      line({ familyId: 'f1', sku: 'SKU-1', unitPricePaise: 50_000, lineTotalPaise: 50_000, qty: 1 }),
    ];

    const outcome = await evaluate(
      {
        lines,
        subtotalPaise: 50_000,
        requestedCodes: ['MIN999'],
      },
      { overlayPromotions: [promo] },
    );

    expect(outcome.applied.length).toBe(0);
    expect(outcome.rejected.length).toBe(1);
    expect(outcome.rejected[0].code).toBe('MIN999');
    expect(outcome.rejected[0].errorCode).toBe('COUPON_MIN_ORDER');
  });

  it('evaluates Specific Products targeting with exclusions on unsaved promotion', async () => {
    const promo = makePromotion({
      code: 'TARGETSPECIFIC',
      scope: CouponScope.SPECIFIC_PRODUCTS,
      discountType: DiscountType.FLAT,
      discountValue: 10_000, // ₹100 flat
      products: [
        { familyId: 'f1', role: CouponTargetRole.DISCOUNT },
        { familyId: 'f2', role: CouponTargetRole.EXCLUDE },
      ],
    });

    const lines = [
      line({ familyId: 'f1', sku: 'SKU-1', unitPricePaise: 60_000, lineTotalPaise: 60_000, qty: 1 }),
      line({ familyId: 'f2', sku: 'SKU-2', unitPricePaise: 40_000, lineTotalPaise: 40_000, qty: 1 }),
    ];

    const outcome = await evaluate(
      {
        lines,
        subtotalPaise: 100_000,
        requestedCodes: ['TARGETSPECIFIC'],
      },
      { overlayPromotions: [promo] },
    );

    expect(outcome.applied.length).toBe(1);
    expect(outcome.applied[0].appliedTo).toEqual(['Product f1']);
    expect(outcome.applied[0].discountPaise).toBe(10_000);
  });

  it('evaluates unsaved BXGY promotion', async () => {
    const promo = makePromotion({
      code: 'BUY2GET1',
      discountType: DiscountType.BUY_X_GET_Y,
      bxgy: {
        buyQty: 2,
        getQty: 1,
        rewardPercentOff: 100,
        maxRepeats: null,
      },
    });

    const lines = [
      line({ familyId: 'f1', sku: 'SKU-1', unitPricePaise: 20_000, lineTotalPaise: 60_000, qty: 3 }),
    ];

    const outcome = await evaluate(
      {
        lines,
        subtotalPaise: 60_000,
        requestedCodes: ['BUY2GET1'],
      },
      { overlayPromotions: [promo] },
    );

    expect(outcome.applied.length).toBe(1);
    expect(outcome.applied[0].discountPaise).toBe(20_000); // 1 free unit
  });

  it('evaluates customer email eligibility on unsaved promotion', async () => {
    const promo = makePromotion({
      code: 'VIPONLY',
      customerEligibility: CustomerEligibility.SPECIFIC_CUSTOMERS,
      customers: [{ email: 'vip@example.com' }],
    });

    const lines = [
      line({ familyId: 'f1', sku: 'SKU-1', unitPricePaise: 50_000, lineTotalPaise: 50_000, qty: 1 }),
    ];

    // Wrong email
    const failedOutcome = await evaluate(
      {
        lines,
        subtotalPaise: 50_000,
        requestedCodes: ['VIPONLY'],
        email: 'regular@example.com',
      },
      { overlayPromotions: [promo] },
    );
    expect(failedOutcome.applied.length).toBe(0);
    expect(failedOutcome.rejected[0].errorCode).toBe('COUPON_NOT_ELIGIBLE');

    // Matching email
    const successOutcome = await evaluate(
      {
        lines,
        subtotalPaise: 50_000,
        requestedCodes: ['VIPONLY'],
        email: 'vip@example.com',
      },
      { overlayPromotions: [promo] },
    );
    expect(successOutcome.applied.length).toBe(1);
  });

  it('evaluates state restrictions on unsaved promotion', async () => {
    const promo = makePromotion({
      code: 'KERALAONLY',
      allowedStates: ['Kerala'],
    });

    const lines = [
      line({ familyId: 'f1', sku: 'SKU-1', unitPricePaise: 50_000, lineTotalPaise: 50_000, qty: 1 }),
    ];

    // Different state
    const nonKerala = await evaluate(
      {
        lines,
        subtotalPaise: 50_000,
        requestedCodes: ['KERALAONLY'],
        state: 'Maharashtra',
      },
      { overlayPromotions: [promo] },
    );
    expect(nonKerala.applied.length).toBe(0);
    expect(nonKerala.rejected[0].errorCode).toBe('COUPON_STATE_RESTRICTED');

    // Kerala
    const kerala = await evaluate(
      {
        lines,
        subtotalPaise: 50_000,
        requestedCodes: ['KERALAONLY'],
        state: 'Kerala',
      },
      { overlayPromotions: [promo] },
    );
    expect(kerala.applied.length).toBe(1);
  });
});
