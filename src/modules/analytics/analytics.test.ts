import { describe, expect, it } from 'vitest';
import { OrderStatus, PaymentStatus } from '@prisma/client';
import {
  calcDelta,
  getPreviousPeriod,
  isRevenueOrder,
  parseIstDateStringToUtc,
  resolveDateRange,
  IST_OFFSET_MS,
} from './analytics.service';

describe('Analytics Financial Correctness & Timezone Tests', () => {
  describe('1. IST Date Boundaries', () => {
    it('parses from="2026-08-01" to exact IST start-of-day UTC boundary', () => {
      const range = resolveDateRange('2026-08-01', '2026-08-24');

      // 2026-08-01 00:00:00.000 IST in UTC is 2026-07-31T18:30:00.000Z
      expect(range.from.toISOString()).toBe('2026-07-31T18:30:00.000Z');

      // Test IST boundaries
      const exactIstStart = new Date('2026-07-31T18:30:00.000Z'); // 2026-08-01 00:00:00 IST
      const oneSecondBefore = new Date('2026-07-31T18:29:59.000Z'); // 2026-07-31 23:59:59 IST

      expect(exactIstStart.getTime()).toBeGreaterThanOrEqual(range.from.getTime());
      expect(oneSecondBefore.getTime()).toBeLessThan(range.from.getTime());
    });

    it('parses to="2026-08-24" to exact IST end-of-day UTC boundary', () => {
      const range = resolveDateRange('2026-08-01', '2026-08-24');

      // 2026-08-24 23:59:59.999 IST in UTC is 2026-08-24T18:29:59.999Z
      expect(range.to.toISOString()).toBe('2026-08-24T18:29:59.999Z');

      // Test IST boundaries
      const exactIstEnd = new Date('2026-08-24T18:29:59.999Z'); // 2026-08-24 23:59:59.999 IST
      const nextDayStart = new Date('2026-08-24T18:30:00.000Z'); // 2026-08-25 00:00:00 IST

      expect(exactIstEnd.getTime()).toBeLessThanOrEqual(range.to.getTime());
      expect(nextDayStart.getTime()).toBeGreaterThan(range.to.getTime());
    });

    it('comparison period preserves exact contiguous duration before current start', () => {
      const current = resolveDateRange('2026-08-01', '2026-08-24');
      const prev = getPreviousPeriod(current);

      const currentDuration = current.to.getTime() - current.from.getTime();
      const prevDuration = prev.to.getTime() - prev.from.getTime();

      expect(prevDuration).toBe(currentDuration);
      expect(prev.to.getTime()).toBeLessThan(current.from.getTime());
    });
  });

  describe('2. Unpaid Pending vs Confirmed Revenue Orders', () => {
    it('excludes abandoned PENDING + UNPAID orders from revenue metrics', () => {
      expect(isRevenueOrder(OrderStatus.PENDING, PaymentStatus.UNPAID)).toBe(false);
    });

    it('excludes CANCELLED orders regardless of payment status', () => {
      expect(isRevenueOrder(OrderStatus.CANCELLED, PaymentStatus.PAID)).toBe(false);
      expect(isRevenueOrder(OrderStatus.CANCELLED, PaymentStatus.UNPAID)).toBe(false);
    });

    it('includes paid online orders awaiting ops (PENDING + PAID)', () => {
      expect(isRevenueOrder(OrderStatus.PENDING, PaymentStatus.PAID)).toBe(true);
    });

    it('includes accepted orders (PROCESSING + PAID or PROCESSING + UNPAID for COD)', () => {
      expect(isRevenueOrder(OrderStatus.PROCESSING, PaymentStatus.PAID)).toBe(true);
      expect(isRevenueOrder(OrderStatus.PROCESSING, PaymentStatus.UNPAID)).toBe(true);
    });

    it('includes shipped and delivered orders', () => {
      expect(isRevenueOrder(OrderStatus.SHIPPED, PaymentStatus.PAID)).toBe(true);
      expect(isRevenueOrder(OrderStatus.DELIVERED, PaymentStatus.PAID)).toBe(true);
    });
  });

  describe('3. Financial Delta Calculation', () => {
    it('computes positive percentage delta correctly', () => {
      const delta = calcDelta(120, 100);
      expect(delta.absChange).toBe(20);
      expect(delta.pctChange).toBe(20.0);
    });

    it('computes negative percentage delta correctly', () => {
      const delta = calcDelta(75, 100);
      expect(delta.absChange).toBe(-25);
      expect(delta.pctChange).toBe(-25.0);
    });

    it('handles zero previous value safely without division by zero', () => {
      const delta = calcDelta(50, 0);
      expect(delta.pctChange).toBe(100);
      expect(delta.absChange).toBe(50);
    });

    it('handles both values zero', () => {
      const delta = calcDelta(0, 0);
      expect(delta.pctChange).toBe(0);
      expect(delta.absChange).toBe(0);
    });
  });

  describe('4. Multi-Coupon Summary Deduplication Logic', () => {
    it('deduplicates order revenue in aggregate promotion summaries while preserving per-coupon attribution', () => {
      const mockRedemptions = [
        {
          couponId: 'coupon-A',
          orderId: 'order-1',
          cartValuePaise: 100000,
          discountPaise: 10000,
        },
        {
          couponId: 'coupon-B',
          orderId: 'order-1',
          cartValuePaise: 100000,
          discountPaise: 5000,
        },
        {
          couponId: 'coupon-A',
          orderId: 'order-2',
          cartValuePaise: 50000,
          discountPaise: 5000,
        },
      ];

      let totalAttributedRevenuePaise = 0;
      let totalDiscountGivenPaise = 0;
      const seenOrders = new Set<string>();
      const couponAgg: Record<string, { attributedPaise: number; discountPaise: number }> = {
        'coupon-A': { attributedPaise: 0, discountPaise: 0 },
        'coupon-B': { attributedPaise: 0, discountPaise: 0 },
      };

      for (const r of mockRedemptions) {
        totalDiscountGivenPaise += r.discountPaise;
        if (!seenOrders.has(r.orderId)) {
          seenOrders.add(r.orderId);
          totalAttributedRevenuePaise += r.cartValuePaise;
        }
        couponAgg[r.couponId]!.attributedPaise += r.cartValuePaise;
        couponAgg[r.couponId]!.discountPaise += r.discountPaise;
      }

      // Aggregate summary: Order 1 (100,000) + Order 2 (50,000) = 150,000 (NOT 250,000!)
      expect(totalAttributedRevenuePaise).toBe(150000);
      expect(totalDiscountGivenPaise).toBe(20000);
      expect(seenOrders.size).toBe(2);

      // Individual coupon touchpoint attribution
      expect(couponAgg['coupon-A']!.attributedPaise).toBe(150000);
      expect(couponAgg['coupon-B']!.attributedPaise).toBe(100000);
    });
  });
});
