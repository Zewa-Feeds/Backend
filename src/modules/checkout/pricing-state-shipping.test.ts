import { describe, expect, it, vi } from 'vitest';
import { priceCart, getDeliveryEstimateForState, getVariantNetWeightGrams } from './pricing.service';
import * as settingsService from '@/modules/settings/settings.service';
import { prisma } from '@/lib/prisma';

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
      keralaRatePerKgPaise: 4500, // ₹45/kg
      outsideKeralaRatePerKgPaise: 7000, // ₹70/kg
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
    it('calculates 3 × 45g (135g) + 100g packaging = 235g -> 0.5kg slab', async () => {
      const v45 = createMockVariant('F3-45G', '45 g', 45, 10000); // 10000 paise = ₹100
      vi.mocked(settingsService.getAll).mockResolvedValue(mockSettings as never);
      vi.mocked(prisma.productVariant.findMany).mockResolvedValue([v45] as never);

      // Kerala: 0.5kg * ₹45 = ₹22.50 (2250 paise)
      const resKerala = await priceCart({
        lines: [{ sku: 'F3-45G', qty: 3 }],
        state: 'Kerala',
      });
      expect(resKerala.billableWeightGrams).toBe(235);
      expect(resKerala.chargeableWeightKg).toBe(0.5);
      expect(resKerala.shippingPaise).toBe(2250); // ₹22.50
      expect(resKerala.totalPaise).toBe(30000 + 2250);

      // Outside Kerala: 0.5kg * ₹70 = ₹35.00 (3500 paise)
      const resOutside = await priceCart({
        lines: [{ sku: 'F3-45G', qty: 3 }],
        state: 'Maharashtra',
      });
      expect(resOutside.billableWeightGrams).toBe(235);
      expect(resOutside.chargeableWeightKg).toBe(0.5);
      expect(resOutside.shippingPaise).toBe(3500); // ₹35.00
      expect(resOutside.totalPaise).toBe(30000 + 3500);
    });

    it('calculates 10 × 45g (450g) + 100g packaging = 550g -> 1.0kg slab', async () => {
      const v45 = createMockVariant('F3-45G', '45 g', 45, 5000); // ₹50 each (total ₹500 < ₹999)
      vi.mocked(settingsService.getAll).mockResolvedValue(mockSettings as never);
      vi.mocked(prisma.productVariant.findMany).mockResolvedValue([v45] as never);

      const resKerala = await priceCart({
        lines: [{ sku: 'F3-45G', qty: 10 }],
        state: 'Kerala',
      });
      expect(resKerala.billableWeightGrams).toBe(550);
      expect(resKerala.chargeableWeightKg).toBe(1.0);
      expect(resKerala.shippingPaise).toBe(4500); // ₹45.00

      const resOutside = await priceCart({
        lines: [{ sku: 'F3-45G', qty: 10 }],
        state: 'Karnataka',
      });
      expect(resOutside.billableWeightGrams).toBe(550);
      expect(resOutside.chargeableWeightKg).toBe(1.0);
      expect(resOutside.shippingPaise).toBe(7000); // ₹70.00
    });

    it('verifies weight slab rounding boundaries: 500g, 501g, 999g, 1000g, 1001g', async () => {
      vi.mocked(settingsService.getAll).mockResolvedValue(mockSettings as never);

      // 400g product + 100g pkg = 500g -> 0.5kg
      const v400 = createMockVariant('V-400', '400g', 400, 10000);
      vi.mocked(prisma.productVariant.findMany).mockResolvedValue([v400] as never);
      const res500 = await priceCart({ lines: [{ sku: 'V-400', qty: 1 }], state: 'Tamil Nadu' });
      expect(res500.chargeableWeightKg).toBe(0.5);
      expect(res500.shippingPaise).toBe(3500); // 0.5 * 70 = ₹35

      // 401g product + 100g pkg = 501g -> 1.0kg
      const v401 = createMockVariant('V-401', '401g', 401, 10000);
      vi.mocked(prisma.productVariant.findMany).mockResolvedValue([v401] as never);
      const res501 = await priceCart({ lines: [{ sku: 'V-401', qty: 1 }], state: 'Tamil Nadu' });
      expect(res501.chargeableWeightKg).toBe(1.0);
      expect(res501.shippingPaise).toBe(7000); // 1.0 * 70 = ₹70

      // 899g product + 100g pkg = 999g -> 1.0kg
      const v899 = createMockVariant('V-899', '899g', 899, 10000);
      vi.mocked(prisma.productVariant.findMany).mockResolvedValue([v899] as never);
      const res999 = await priceCart({ lines: [{ sku: 'V-899', qty: 1 }], state: 'Tamil Nadu' });
      expect(res999.chargeableWeightKg).toBe(1.0);
      expect(res999.shippingPaise).toBe(7000);

      // 900g product + 100g pkg = 1000g -> 1.0kg
      const v900 = createMockVariant('V-900', '900g', 900, 10000);
      vi.mocked(prisma.productVariant.findMany).mockResolvedValue([v900] as never);
      const res1000 = await priceCart({ lines: [{ sku: 'V-900', qty: 1 }], state: 'Tamil Nadu' });
      expect(res1000.chargeableWeightKg).toBe(1.0);
      expect(res1000.shippingPaise).toBe(7000);

      // 901g product + 100g pkg = 1001g -> 1.5kg
      const v901 = createMockVariant('V-901', '901g', 901, 10000);
      vi.mocked(prisma.productVariant.findMany).mockResolvedValue([v901] as never);
      const res1001 = await priceCart({ lines: [{ sku: 'V-901', qty: 1 }], state: 'Tamil Nadu' });
      expect(res1001.chargeableWeightKg).toBe(1.5);
      expect(res1001.shippingPaise).toBe(10500); // 1.5 * 70 = ₹105 (10500 paise)
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

  describe('Free Shipping Threshold', () => {
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
  });
});
