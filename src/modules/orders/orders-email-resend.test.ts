import { describe, expect, it, vi } from 'vitest';
import { previewCustomerEmail } from '@/modules/customers/customers.service';
import { buildOrderEmailContext } from '@/modules/orders/orders.service';

describe('Order and Customer Email API Features', () => {
  it('buildOrderEmailContext properly extracts customer details and financials', () => {
    const mockOrder = {
      orderNo: '27ZFO350',
      email: 'customer@example.com',
      phone: '9876543210',
      shippingAddress: {
        name: 'Vikram Patel',
        line1: '123 Marine Drive',
        city: 'Mumbai',
        state: 'Maharashtra',
        pincode: '400020',
      },
      items: [
        {
          productName: 'Zewa Feeds Guppy Bites G2',
          sku: 'G2-45G',
          pack: '45g Bottle',
          qty: 2,
          unitPricePaise: 18500,
          lineTotalPaise: 37000,
        },
      ],
      totalPaise: 37000,
      subtotalPaise: 37000,
      discountPaise: 0,
      shippingPaise: 0,
      paymentMethod: 'RAZORPAY',
      paymentStatus: 'PAID',
    };

    const { ctx, email } = buildOrderEmailContext(mockOrder);

    expect(email).toBe('customer@example.com');
    expect(ctx.orderNo).toBe('27ZFO350');
    expect(ctx.customerName).toBe('Vikram Patel');
    expect(ctx.items).toHaveLength(1);
    expect(ctx.items[0].sku).toBe('G2-45G');
    expect(ctx.totalPaise).toBe(37000);
    expect(ctx.paymentMethod).toBe('RAZORPAY');
  });

  it('previewCustomerEmail generates valid HTML preview with branding and buttons', () => {
    const preview = previewCustomerEmail({
      heading: 'Summer Aquatic Care Update',
      message: 'Keep your aquarium water well oxygenated during the warmer months.\n\nCheck out our specialized feeds.',
      subject: 'Aquatic Care Tips from Zewa Feeds',
      ctaText: 'Explore Feed Collection',
      ctaUrl: 'https://zewafeeds.com/products',
      customerName: 'Ananya Roy',
    });

    expect(preview.subject).toBe('Aquatic Care Tips from Zewa Feeds');
    expect(preview.html).toContain('Summer Aquatic Care Update');
    expect(preview.html).toContain('Hi Ananya,');
    expect(preview.html).toContain('Keep your aquarium water well oxygenated');
    expect(preview.html).toContain('Explore Feed Collection');
    expect(preview.html).toContain('https://zewafeeds.com/products');
    expect(preview.html).toContain('Zewa&nbsp;Feeds');
  });
});
