import { describe, expect, it } from 'vitest';
import {
  formatInvoiceFilename,
  resolveOrderAppliedCoupons,
  allocateCartDiscount,
  generateInvoicePdf,
  type InvoiceOrder,
} from './invoice';
import type { TaxConfig } from '@/modules/orders/tax';

const mockTaxConfig: TaxConfig = {
  sellerState: 'Maharashtra',
  gstRatePct: 0,
  gstInclusive: true,
};

describe('formatInvoiceFilename', () => {
  it('formats filename with invoice number and customer name', () => {
    expect(formatInvoiceFilename('27ZFI003', 'Nikhildev M')).toBe('27ZFI003-Nikhildev M.pdf');
  });

  it('sanitizes illegal path and header characters in invoice number and customer name', () => {
    expect(formatInvoiceFilename('ZEW/26-27/0319', 'Priya <Nair>')).toBe('ZEW-26-27-0319-Priya Nair.pdf');
    expect(formatInvoiceFilename('INV:123*?', 'John "Doe"|')).toBe('INV-123---John Doe.pdf');
  });

  it('handles missing or empty customer name by returning invoice number only', () => {
    expect(formatInvoiceFilename('27ZFI003', '')).toBe('27ZFI003.pdf');
    expect(formatInvoiceFilename('27ZFI003', null)).toBe('27ZFI003.pdf');
    expect(formatInvoiceFilename('27ZFI003', undefined)).toBe('27ZFI003.pdf');
  });

  it('handles null/undefined invoice number gracefully', () => {
    expect(formatInvoiceFilename(null, 'Nikhildev M')).toBe('invoice-Nikhildev M.pdf');
    expect(formatInvoiceFilename(undefined, null)).toBe('invoice.pdf');
  });
});

describe('resolveOrderAppliedCoupons', () => {
  it('reads snapshot appliedCoupons array when present', () => {
    const order: InvoiceOrder = {
      orderNo: '27ZFO104',
      invoiceNumber: '27ZFI009',
      placedAt: new Date(),
      email: 'test@example.com',
      phone: '9999999999',
      shippingAddress: {},
      subtotalPaise: 18500,
      discountPaise: 1850,
      shippingPaise: 0,
      totalPaise: 16650,
      appliedCoupons: [
        { code: 'SPECIAL10', scope: 'cart', amountPaise: 1850 },
        { code: 'ZEWA1', scope: 'shipping', amountPaise: 6000 },
      ],
      items: [],
    };

    const resolved = resolveOrderAppliedCoupons(order);
    expect(resolved).toEqual([
      { code: 'SPECIAL10', scope: 'cart', discountType: undefined, amountPaise: 1850 },
      { code: 'ZEWA1', scope: 'shipping', discountType: undefined, amountPaise: 6000 },
    ]);
  });

  it('resolves legacy orders with redemptions mapping FREE_SHIPPING to shipping scope and PERCENTAGE to cart', () => {
    const order: InvoiceOrder = {
      orderNo: '27ZFO104',
      invoiceNumber: '27ZFI009',
      placedAt: new Date(),
      email: 'test@example.com',
      phone: '9999999999',
      shippingAddress: {},
      subtotalPaise: 18500,
      discountPaise: 1850,
      shippingPaise: 0,
      totalPaise: 16650,
      redemptions: [
        {
          coupon: {
            code: 'ZEWA1',
            discountType: 'FREE_SHIPPING',
          },
          discountPaise: 6000,
        },
        {
          coupon: {
            code: 'SPECIAL10',
            discountType: 'PERCENTAGE',
          },
          discountPaise: 1850,
        },
      ],
      items: [],
    };

    const resolved = resolveOrderAppliedCoupons(order);
    expect(resolved).toHaveLength(2);
    expect(resolved.find((c) => c.code === 'ZEWA1')).toMatchObject({
      code: 'ZEWA1',
      scope: 'shipping',
      amountPaise: 6000,
    });
    expect(resolved.find((c) => c.code === 'SPECIAL10')).toMatchObject({
      code: 'SPECIAL10',
      scope: 'cart',
      amountPaise: 1850,
    });
  });

  it('falls back to single couponCode and discountPaise when no redemptions or snapshot', () => {
    const order: InvoiceOrder = {
      orderNo: '27ZFO101',
      invoiceNumber: '27ZFI001',
      placedAt: new Date(),
      email: 'test@example.com',
      phone: '9999999999',
      shippingAddress: {},
      subtotalPaise: 10000,
      discountPaise: 1000,
      shippingPaise: 6000,
      totalPaise: 15000,
      couponCode: 'SAVE10',
      items: [],
    };

    const resolved = resolveOrderAppliedCoupons(order);
    expect(resolved).toEqual([{ code: 'SAVE10', scope: 'cart', amountPaise: 1000 }]);
  });
});

describe('allocateCartDiscount', () => {
  it('allocates full discount to single item line', () => {
    const lines = [{ lineTotalPaise: 18500 }];
    const allocated = allocateCartDiscount(lines, 1850);
    expect(allocated).toEqual([1850]);
  });

  it('allocates pro-rata across multiple item lines according to gross value', () => {
    const lines = [
      { lineTotalPaise: 30000 }, // 60% of 50000
      { lineTotalPaise: 20000 }, // 40% of 50000
    ];
    const allocated = allocateCartDiscount(lines, 5000);
    expect(allocated).toEqual([3000, 2000]);
  });

  it('handles odd penny rounding remainder by assigning to highest gross line', () => {
    const lines = [
      { lineTotalPaise: 10000 },
      { lineTotalPaise: 10000 },
      { lineTotalPaise: 10000 },
    ];
    // 1000 / 3 = 333 each, remainder 1
    const allocated = allocateCartDiscount(lines, 1000);
    expect(allocated.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it('preserves pre-allocated discounts if already present on items', () => {
    const lines = [
      { lineTotalPaise: 20000, allocatedCouponDiscountPaise: 1200 },
      { lineTotalPaise: 10000, allocatedCouponDiscountPaise: 800 },
    ];
    const allocated = allocateCartDiscount(lines, 2000);
    expect(allocated).toEqual([1200, 800]);
  });
});

describe('generateInvoicePdf', () => {
  it('generates a valid PDF for the exact scenario from Zewa_Invoice_Template_Changes.docx (Order 27ZFO104)', async () => {
    const order: InvoiceOrder = {
      orderNo: '27ZFO104',
      invoiceNumber: '27ZFI009',
      placedAt: new Date('2026-03-10T10:00:00Z'),
      email: 'nikhildev@example.com',
      phone: '+91 9876543210',
      shippingAddress: {
        name: 'Nik Mulakkal',
        line1: 'Flat 402, Green Acre',
        city: 'Mumbai',
        state: 'Maharashtra',
        pincode: '400001',
      },
      subtotalPaise: 18500,
      discountPaise: 1850,
      shippingPaise: 0,
      totalPaise: 16650,
      appliedCoupons: [
        { code: 'SPECIAL10', scope: 'cart', amountPaise: 1850 },
        { code: 'ZEWA1', scope: 'shipping', amountPaise: 6000 },
      ],
      items: [
        {
          productName: 'Larvae Meal Sample',
          sku: 'G2-45G',
          pack: '45g',
          qty: 1,
          unitPricePaise: 18500,
          lineTotalPaise: 18500,
          allocatedCouponDiscountPaise: 1850,
          hsn: '23099090',
          taxRatePct: 0,
        },
      ],
    };

    const pdfBytes = await generateInvoicePdf(order, mockTaxConfig);

    // Basic PDF validation: begins with %PDF-
    expect(pdfBytes).toBeInstanceOf(Uint8Array);
    expect(pdfBytes.length).toBeGreaterThan(1000);
    const headerStr = Buffer.from(pdfBytes.slice(0, 5)).toString('ascii');
    expect(headerStr).toBe('%PDF-');
  });

  it('generates a valid PDF with inter-state IGST tax calculation', async () => {
    const order: InvoiceOrder = {
      orderNo: '27ZFO105',
      invoiceNumber: '27ZFI010',
      placedAt: new Date(),
      email: 'customer@karnataka.com',
      phone: '+91 9876543210',
      shippingAddress: {
        name: 'Karnataka Customer',
        line1: 'MG Road',
        city: 'Bengaluru',
        state: 'Karnataka',
        pincode: '560001',
      },
      subtotalPaise: 10000,
      discountPaise: 0,
      shippingPaise: 6000,
      totalPaise: 16000,
      items: [
        {
          productName: 'BSFL Dried Grubs',
          sku: 'G1-500G',
          pack: '500g',
          qty: 1,
          unitPricePaise: 10000,
          lineTotalPaise: 10000,
          hsn: '23099090',
          taxRatePct: 5,
        },
      ],
    };

    const pdfBytes = await generateInvoicePdf(order, mockTaxConfig);
    expect(pdfBytes).toBeInstanceOf(Uint8Array);
    expect(pdfBytes.length).toBeGreaterThan(1000);
  });
});
