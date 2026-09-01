import { describe, expect, it, vi } from 'vitest';
import { priceCart, getDeliveryEstimateForState, getVariantNetWeightGrams } from './pricing.service';
import * as settingsService from '@/modules/settings/settings.service';
import { prisma } from '@/lib/prisma';
import { buildStateRates } from '@/lib/india-states';

vi.mock('@/modules/settings/settings.service', () => ({
  getAll: vi.fn(),
  getTaxConfig: vi.fn().mockResolvedValue({
    gstRatePct: 0,
    gstInclusive: true,
    sellerState: 'Maharashtra',
  }),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    productVariant: {
      findMany: vi.fn(),
    },
    /*
     * `priceCart` now runs the promotion engine, which sweeps for automatic
     * promotions on every quote. These suites are about weight, slabs and
     * thumbnails, so the sweep finds nothing — but the model still has to exist
     * on the mock for the call to be made at all.
     */
    coupon: { findMany: vi.fn().mockResolvedValue([]) },
    couponRedemption: { findMany: vi.fn().mockResolvedValue([]) },
    order: { count: vi.fn().mockResolvedValue(0) },
  },
}));

describe('Weight-based shipping & State Delivery Estimation', () => {
  const createMockVariant = (sku: string, pack: string, weightGrams: number, pricePaise = 24900) => ({
    id: `var-${sku}`,
    sku,
    pack,
    weightGrams,
    pricePaise,
    mrpPaise: pricePaise + 5000,
    stock: 50,
    hsn: '23099090',
    baseVariantId: null,
    heroMediaId: null,
    packMultiplier: 1,
    family: {
      id: `fam-${sku}`,
      name: `Test Product ${sku}`,
      slug: `test-product-${sku.toLowerCase()}`,
      status: 'ACTIVE',
      deletedAt: null,
      media: [],
    },
  });

  const mockSettings = {
    shipping: {
      /*
       * Rates are per STATE now. These keep the suite's original numbers —
       * ₹45 a slab for Kerala, ₹70 elsewhere — so every expectation below still
       * describes the same arithmetic it always did.
       */
      stateRatesPaise: buildStateRates({
        homePaise: 4500,
        southPaise: 7000,
        restPaise: 7000,
      }),
      defaultRatePaise: 7000,
      packagingWeightGrams: 100, // 100g packaging overhead
      slabWeightGrams: 500, // 500g slab (0.5kg)
      freeThresholdPaise: 99900, // ₹999
      standardRatePaise: 6000,
      deliveryText: '3–5 business days across India',
      pinBlacklist: [],
    },
    tax: { gstRatePct: 0, gstInclusive: true, gstin: '' },
    announcement: { text: '', active: false },
    maintenance: { on: false },
  };

  describe('Weight & Packaging Calculations', () => {
    it('calculates 3 × 45g (135g) + 100g packaging = 235g -> 1 slab (500g)', async () => {
      const v45 = createMockVariant('F3-45G', '45 g', 45, 10000); // 10000 paise = ₹100
      vi.mocked(settingsService.getAll).mockResolvedValue(mockSettings as never);
      vi.mocked(prisma.productVariant.findMany).mockResolvedValue([v45] as never);

      // Kerala: 1 slab * ₹45 = ₹45 (4500 paise)
      const resKerala = await priceCart({
        lines: [{ sku: 'F3-45G', qty: 3 }],
        state: 'Kerala',
      });
      expect(resKerala.billableWeightGrams).toBe(235);
      expect(resKerala.chargeableWeightKg).toBe(0.5);
      expect(resKerala.shippingPaise).toBe(4500); // ₹45.00
      expect(resKerala.totalPaise).toBe(30000 + 4500);

      // Outside Kerala: 1 slab * ₹70 = ₹70 (7000 paise)
      const resOutside = await priceCart({
        lines: [{ sku: 'F3-45G', qty: 3 }],
        state: 'Maharashtra',
      });
      expect(resOutside.billableWeightGrams).toBe(235);
      expect(resOutside.chargeableWeightKg).toBe(0.5);
      expect(resOutside.shippingPaise).toBe(7000); // ₹70.00
      expect(resOutside.totalPaise).toBe(30000 + 7000);
    });

    it('calculates 10 × 45g (450g) + 100g packaging = 550g -> 2 slabs (1000g)', async () => {
      const v45 = createMockVariant('F3-45G', '45 g', 45, 5000); // ₹50 each (total ₹500 < ₹999)
      vi.mocked(settingsService.getAll).mockResolvedValue(mockSettings as never);
      vi.mocked(prisma.productVariant.findMany).mockResolvedValue([v45] as never);

      // Kerala: 2 slabs * ₹45 = ₹90 (9000 paise)
      const resKerala = await priceCart({
        lines: [{ sku: 'F3-45G', qty: 10 }],
        state: 'Kerala',
      });
      expect(resKerala.billableWeightGrams).toBe(550);
      expect(resKerala.chargeableWeightKg).toBe(1.0);
      expect(resKerala.shippingPaise).toBe(9000); // ₹90.00
      expect(resKerala.totalPaise).toBe(50000 + 9000);

      // Outside Kerala: 2 slabs * ₹70 = ₹140 (14000 paise)
      const resOutside = await priceCart({
        lines: [{ sku: 'F3-45G', qty: 10 }],
        state: 'Karnataka',
      });
      expect(resOutside.billableWeightGrams).toBe(550);
      expect(resOutside.chargeableWeightKg).toBe(1.0);
      expect(resOutside.shippingPaise).toBe(14000); // ₹140.00
      expect(resOutside.totalPaise).toBe(50000 + 14000);
    });

    it('Scenario 1: 1 × 45g (45g) + 100g pkg = 145g -> 1 slab -> ₹45 for Kerala', async () => {
      const v45 = createMockVariant('F3-45G', '45 g', 45, 18500); // ₹185
      vi.mocked(settingsService.getAll).mockResolvedValue(mockSettings as never);
      vi.mocked(prisma.productVariant.findMany).mockResolvedValue([v45] as never);

      const resKerala = await priceCart({
        lines: [{ sku: 'F3-45G', qty: 1 }],
        state: 'Kerala',
      });
      expect(resKerala.billableWeightGrams).toBe(145);
      expect(resKerala.chargeableWeightKg).toBe(0.5);
      expect(resKerala.shippingPaise).toBe(4500); // ₹45.00
      expect(resKerala.totalPaise).toBe(18500 + 4500);
    });

    it('Scenario 1b: 1 × 45g (45g) + 100g pkg = 145g -> 1 slab -> ₹70 Outside Kerala', async () => {
      const v45 = createMockVariant('F3-45G', '45 g', 45, 18500); // ₹185
      vi.mocked(settingsService.getAll).mockResolvedValue(mockSettings as never);
      vi.mocked(prisma.productVariant.findMany).mockResolvedValue([v45] as never);

      const resOutside = await priceCart({
        lines: [{ sku: 'F3-45G', qty: 1 }],
        state: 'Maharashtra',
      });
      expect(resOutside.billableWeightGrams).toBe(145);
      expect(resOutside.chargeableWeightKg).toBe(0.5);
      expect(resOutside.shippingPaise).toBe(7000); // ₹70.00
      expect(resOutside.totalPaise).toBe(18500 + 7000);
    });

    it('Scenario 2: 10 × 45g (450g) + 100g pkg = 550g -> 2 slabs -> ₹90.00 for Kerala', async () => {
      const v45 = createMockVariant('F3-45G', '45 g', 45, 5000); // ₹50 each, subtotal ₹500 < ₹999 threshold
      vi.mocked(settingsService.getAll).mockResolvedValue(mockSettings as never);
      vi.mocked(prisma.productVariant.findMany).mockResolvedValue([v45] as never);

      const resKerala = await priceCart({
        lines: [{ sku: 'F3-45G', qty: 10 }],
        state: 'Kerala',
      });
      expect(resKerala.billableWeightGrams).toBe(550);
      expect(resKerala.chargeableWeightKg).toBe(1.0);
      expect(resKerala.shippingPaise).toBe(9000); // ₹90.00
      expect(resKerala.totalPaise).toBe(50000 + 9000);
    });

    it('Scenario 3: 10 × 45g (450g) + 100g pkg = 550g -> 2 slabs -> ₹140.00 Outside Kerala', async () => {
      const v45 = createMockVariant('F3-45G', '45 g', 45, 5000); // ₹50 each, subtotal ₹500 < ₹999 threshold
      vi.mocked(settingsService.getAll).mockResolvedValue(mockSettings as never);
      vi.mocked(prisma.productVariant.findMany).mockResolvedValue([v45] as never);

      const resOutside = await priceCart({
        lines: [{ sku: 'F3-45G', qty: 10 }],
        state: 'Karnataka',
      });
      expect(resOutside.billableWeightGrams).toBe(550);
      expect(resOutside.chargeableWeightKg).toBe(1.0);
      expect(resOutside.shippingPaise).toBe(14000); // ₹140.00
      expect(resOutside.totalPaise).toBe(50000 + 14000);
    });

    it('Multiple products: adds packaging exactly once per order', async () => {
      // Line 1: 2 × 45g = 90g
      const v45 = createMockVariant('F3-45G', '45 g', 45, 10000);
      // Line 2: 1 × 200g = 200g
      const v200 = createMockVariant('C4-200G', '200 g', 200, 15000);
      // Total product: 290g + 100g packaging = 390g -> 1 slab (500g)
      vi.mocked(settingsService.getAll).mockResolvedValue(mockSettings as never);
      vi.mocked(prisma.productVariant.findMany).mockResolvedValue([v45, v200] as never);

      const res = await priceCart({
        lines: [
          { sku: 'F3-45G', qty: 2 },
          { sku: 'C4-200G', qty: 1 },
        ],
        state: 'Kerala',
      });
      expect(res.billableWeightGrams).toBe(390);
      expect(res.chargeableWeightKg).toBe(0.5);
      expect(res.shippingPaise).toBe(4500); // 1 slab * ₹45 = ₹45.00
    });

    it('extracts weight from kg strings, multipliers, and fallback', () => {
      // Numeric weightGrams takes priority
      expect(getVariantNetWeightGrams({ weightGrams: 250, pack: '1 kg' })).toBe(250);
      // kg string parsing
      expect(getVariantNetWeightGrams({ pack: '1 kg' })).toBe(1000);
      expect(getVariantNetWeightGrams({ pack: '2.5 kg' })).toBe(2500);
      // g string parsing with multiplier
      expect(getVariantNetWeightGrams({ pack: '100g x 2' })).toBe(200);
      expect(getVariantNetWeightGrams({ pack: '45 g', packMultiplier: 3 })).toBe(135);
      // Unknown / unparseable fallback
      expect(getVariantNetWeightGrams({ pack: 'Special Edition' })).toBe(50);
    });

    it('verifies weight slab rounding boundaries: 500g (1 slab), 501g (2 slabs), 999g (2 slabs), 1000g (2 slabs), 1001g (3 slabs)', async () => {
      vi.mocked(settingsService.getAll).mockResolvedValue(mockSettings as never);

      // 400g product + 100g pkg = 500g -> 1 slab (0.5kg)
      const v400 = createMockVariant('V-400', '400g', 400, 10000);
      vi.mocked(prisma.productVariant.findMany).mockResolvedValue([v400] as never);
      const res500 = await priceCart({ lines: [{ sku: 'V-400', qty: 1 }], state: 'Tamil Nadu' });
      expect(res500.chargeableWeightKg).toBe(0.5);
      expect(res500.shippingPaise).toBe(7000); // 1 slab * 70 = ₹70

      // 401g product + 100g pkg = 501g -> 2 slabs (1.0kg)
      const v401 = createMockVariant('V-401', '401g', 401, 10000);
      vi.mocked(prisma.productVariant.findMany).mockResolvedValue([v401] as never);
      const res501 = await priceCart({ lines: [{ sku: 'V-401', qty: 1 }], state: 'Tamil Nadu' });
      expect(res501.chargeableWeightKg).toBe(1.0);
      expect(res501.shippingPaise).toBe(14000); // 2 slabs * 70 = ₹140

      // 899g product + 100g pkg = 999g -> 2 slabs (1.0kg)
      const v899 = createMockVariant('V-899', '899g', 899, 10000);
      vi.mocked(prisma.productVariant.findMany).mockResolvedValue([v899] as never);
      const res999 = await priceCart({ lines: [{ sku: 'V-899', qty: 1 }], state: 'Tamil Nadu' });
      expect(res999.chargeableWeightKg).toBe(1.0);
      expect(res999.shippingPaise).toBe(14000); // 2 slabs * 70 = ₹140

      // 900g product + 100g pkg = 1000g -> 2 slabs (1.0kg)
      const v900 = createMockVariant('V-900', '900g', 900, 10000);
      vi.mocked(prisma.productVariant.findMany).mockResolvedValue([v900] as never);
      const res1000 = await priceCart({ lines: [{ sku: 'V-900', qty: 1 }], state: 'Tamil Nadu' });
      expect(res1000.chargeableWeightKg).toBe(1.0);
      expect(res1000.shippingPaise).toBe(14000); // 2 slabs * 70 = ₹140

      // 901g product + 100g pkg = 1001g -> 3 slabs (1.5kg)
      const v901 = createMockVariant('V-901', '901g', 901, 10000);
      vi.mocked(prisma.productVariant.findMany).mockResolvedValue([v901] as never);
      const res1001 = await priceCart({ lines: [{ sku: 'V-901', qty: 1 }], state: 'Tamil Nadu' });
      expect(res1001.chargeableWeightKg).toBe(1.5);
      expect(res1001.shippingPaise).toBe(21000); // 3 slabs * 70 = ₹210 (21000 paise)
    });
  });

  describe('Per-state rates', () => {
    /** Kerala ₹30, southern neighbours ₹50, everywhere else ₹60 — per 500g slab. */
    const tieredSettings = {
      ...mockSettings,
      shipping: {
        ...mockSettings.shipping,
        packagingWeightGrams: 440,
        freeThresholdPaise: 0,
        stateRatesPaise: buildStateRates({ homePaise: 3000, southPaise: 5000, restPaise: 6000 }),
        defaultRatePaise: 6000,
      },
    };

    /** 1kg pouch: 1000g + 440g packaging = 1440g -> 3 slabs. */
    const oneKgTo = async (state: string) => {
      const v = createMockVariant('P-1KG', '1kg Pouch', 1000, 10000);
      vi.mocked(settingsService.getAll).mockResolvedValue(tieredSettings as never);
      vi.mocked(prisma.productVariant.findMany).mockResolvedValue([v] as never);
      return priceCart({ lines: [{ sku: 'P-1KG', qty: 1 }], state });
    };

    it('charges the home rate in Kerala', async () => {
      const res = await oneKgTo('Kerala');
      expect(res.billableWeightGrams).toBe(1440);
      expect(res.shippingPaise).toBe(9000); // 3 slabs × ₹30
      expect(res.isKerala).toBe(true);
    });

    it('charges the south-zone rate in TN, KA, Telangana, AP and Goa', async () => {
      for (const state of ['Tamil Nadu', 'Karnataka', 'Telangana', 'Andhra Pradesh', 'Goa']) {
        const res = await oneKgTo(state);
        expect(res.shippingPaise, state).toBe(15000); // 3 slabs × ₹50
        expect(res.isKerala, state).toBe(false);
      }
    });

    it('charges the rest-of-India rate everywhere else', async () => {
      for (const state of ['Maharashtra', 'Delhi', 'West Bengal', 'Assam']) {
        const res = await oneKgTo(state);
        expect(res.shippingPaise, state).toBe(18000); // 3 slabs × ₹60
      }
    });

    it('honours a single state moved off its tier, without touching its neighbours', async () => {
      // The whole point of per-state rates: Goa alone goes to ₹75 a slab.
      const moved = {
        ...tieredSettings,
        shipping: {
          ...tieredSettings.shipping,
          stateRatesPaise: { ...tieredSettings.shipping.stateRatesPaise, Goa: 7500 },
        },
      };
      const v = createMockVariant('P-1KG', '1kg Pouch', 1000, 10000);
      vi.mocked(settingsService.getAll).mockResolvedValue(moved as never);
      vi.mocked(prisma.productVariant.findMany).mockResolvedValue([v] as never);

      const goa = await priceCart({ lines: [{ sku: 'P-1KG', qty: 1 }], state: 'Goa' });
      expect(goa.shippingPaise).toBe(22500); // 3 × ₹75

      const karnataka = await priceCart({ lines: [{ sku: 'P-1KG', qty: 1 }], state: 'Karnataka' });
      expect(karnataka.shippingPaise).toBe(15000); // still ₹50 — unaffected
    });

    it('matches a state name regardless of case or spacing', async () => {
      for (const spelling of ['tamil nadu', 'TAMIL NADU', '  Tamil Nadu  ']) {
        const res = await oneKgTo(spelling);
        expect(res.shippingPaise, spelling).toBe(15000);
      }
    });

    it('falls back to the default rate for a state with no configured rate', async () => {
      const sparse = {
        ...tieredSettings,
        shipping: { ...tieredSettings.shipping, stateRatesPaise: { Kerala: 3000 } },
      };
      const v = createMockVariant('P-1KG', '1kg Pouch', 1000, 10000);
      vi.mocked(settingsService.getAll).mockResolvedValue(sparse as never);
      vi.mocked(prisma.productVariant.findMany).mockResolvedValue([v] as never);

      const res = await priceCart({ lines: [{ sku: 'P-1KG', qty: 1 }], state: 'Nagaland' });
      expect(res.shippingPaise).toBe(18000); // 3 × the ₹60 default
    });
  });

  describe('Outside India', () => {
    /*
     * The rate is configurable but UNREACHABLE today: nothing supplies a country,
     * because the checkout has no country field. These pin both halves of that —
     * the rate works when a country is passed, and every order the system can
     * currently take is still priced domestically.
     */
    const intlSettings = {
      ...mockSettings,
      shipping: {
        ...mockSettings.shipping,
        packagingWeightGrams: 440,
        freeThresholdPaise: 0,
        stateRatesPaise: buildStateRates({ homePaise: 3000, southPaise: 5000, restPaise: 6000 }),
        defaultRatePaise: 6000,
        internationalRatePaise: 25000, // ₹250 a slab
      },
    };

    const price = async (input: { state?: string; country?: string }) => {
      const v = createMockVariant('P-1KG', '1kg Pouch', 1000, 10000);
      vi.mocked(settingsService.getAll).mockResolvedValue(intlSettings as never);
      vi.mocked(prisma.productVariant.findMany).mockResolvedValue([v] as never);
      return priceCart({ lines: [{ sku: 'P-1KG', qty: 1 }], ...input });
    };

    it('charges the international rate for a non-Indian country', async () => {
      const res = await price({ country: 'Singapore' });
      expect(res.billableWeightGrams).toBe(1440); // 3 slabs
      expect(res.shippingPaise).toBe(75000); // 3 × ₹250
      expect(res.isKerala).toBe(false);
    });

    it('prices an overseas order without waiting for an Indian state', async () => {
      // A domestic quote with no state returns 0 until one is chosen. An
      // international one has no Indian state to wait for.
      expect((await price({ country: 'United Kingdom' })).shippingPaise).toBe(75000);
      expect((await price({})).shippingPaise).toBe(0);
    });

    it('leaves every domestic order untouched — the default path is unchanged', async () => {
      expect((await price({ state: 'Kerala' })).shippingPaise).toBe(9000);
      expect((await price({ state: 'Tamil Nadu' })).shippingPaise).toBe(15000);
      expect((await price({ state: 'Delhi' })).shippingPaise).toBe(18000);
      // Explicitly saying India is the same as saying nothing.
      expect((await price({ state: 'Delhi', country: 'India' })).shippingPaise).toBe(18000);
    });

    it('never lets an overseas address be treated as Kerala', async () => {
      const res = await price({ state: 'Kerala', country: 'Sri Lanka' });
      expect(res.isKerala).toBe(false);
      expect(res.shippingPaise).toBe(75000);
    });
  });

  describe('State-Based Delivery Estimates', () => {
    it('returns correct days and disclaimers for Kerala, Karnataka, TN, MH, TG, AP and rest of India', () => {
      expect(getDeliveryEstimateForState('Kerala')).toEqual({
        days: 2,
        deliveryText: 'Estimated delivery: 2 days*',
        ruralNote: '*Rural areas may take 1 additional day.',
      });

      expect(getDeliveryEstimateForState('Karnataka').days).toBe(3);
      expect(getDeliveryEstimateForState('Tamil Nadu').days).toBe(3);
      expect(getDeliveryEstimateForState('Maharashtra').days).toBe(4);
      expect(getDeliveryEstimateForState('Telangana').days).toBe(4);
      expect(getDeliveryEstimateForState('Andhra Pradesh').days).toBe(4);
      expect(getDeliveryEstimateForState('Delhi').days).toBe(5);
      expect(getDeliveryEstimateForState('Gujarat').days).toBe(5);
      expect(getDeliveryEstimateForState('Assam').days).toBe(5);
      expect(getDeliveryEstimateForState(null).deliveryText).toBe('Enter your state to calculate shipping');
    });
  });

  describe('Free Shipping Threshold & Coupon Free Shipping', () => {
    it('applies free shipping (₹0) when payable >= ₹999', async () => {
      const v1kg = createMockVariant('F3-1KG', '1 kg', 1000, 189000); // ₹1890 (>= ₹999)
      vi.mocked(settingsService.getAll).mockResolvedValue(mockSettings as never);
      vi.mocked(prisma.productVariant.findMany).mockResolvedValue([v1kg] as never);

      const res = await priceCart({
        lines: [{ sku: 'F3-1KG', qty: 1 }],
        state: 'Maharashtra',
      });

      expect(res.subtotalPaise).toBe(189000);
      expect(res.shippingPaise).toBe(0); // FREE
      expect(res.totalPaise).toBe(189000);
      expect(res.chargeableWeightKg).toBe(1.5); // 1000g + 100g = 1100g -> 1.5kg
    });

    it('applies free shipping when a FREE_SHIPPING coupon is applied under the threshold', async () => {
      const v45 = createMockVariant('F3-45G', '45 g', 45, 18500); // ₹185 (< ₹999)
      vi.mocked(settingsService.getAll).mockResolvedValue(mockSettings as never);
      vi.mocked(prisma.productVariant.findMany).mockResolvedValue([v45] as never);

      const res = await priceCart({
        lines: [{ sku: 'F3-45G', qty: 1 }],
        state: 'Maharashtra',
        overlayPromotions: [{
          id: 'promo-free-ship',
          code: 'FREESHIP',
          name: 'Free Shipping Promo',
          description: null,
          discountType: 'FREE_SHIPPING',
          discountValue: 0,
          maxDiscountPaise: null,
          minOrderPaise: 0,
          minQty: null,
          maxQty: null,
          startsAt: new Date('2026-01-01'),
          endsAt: new Date('2030-01-01'),
          totalUsageLimit: null,
          perCustomerLimit: null,
          usedCount: 0,
          isActive: true,
          scope: 'ORDER',
          stackingMode: 'STACKABLE',
          priority: 0,
          trigger: 'CODE',
          combinesWithAutomatic: true,
          customerEligibility: 'ALL',
          firstNOrders: null,
          allowedStates: [],
          requireAllQualifiers: false,
          products: [],
          variants: [],
          categories: [],
          customers: [],
          bxgy: null,
        } as never],
        couponCode: 'FREESHIP',
      });

      expect(res.subtotalPaise).toBe(18500);
      expect(res.freeShippingFromCoupon).toBe(true);
      expect(res.shippingPaise).toBe(0); // FREE due to coupon
      expect(res.totalPaise).toBe(18500);
    });
  });
});
