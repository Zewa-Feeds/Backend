/**
 * The customer cancellation POLICY layer.
 *
 * These are pure predicates, but they carry a rule that is easy to break by
 * accident: the lifecycle deliberately permits SHIPPED → CANCELLED so ops can
 * handle a return-to-origin, and a customer deliberately may not. Anyone
 * widening the customer gate to "whatever the lifecycle allows" would let a
 * customer cancel a parcel already in transit — restocking goods that are on a
 * van and marking the order dead.
 *
 * The internal alert is asserted here too, because its whole job is telling
 * ops that money is sitting uncollected.
 */
import { describe, expect, it } from 'vitest';
import { OrderStatus } from '@prisma/client';
import {
  CUSTOMER_CANCELLABLE_STATES,
  customerCancelBlockedReason,
  isCustomerCancellable,
  isValidTransition,
  nextStates,
} from './lifecycle';
import {
  staffTemplates,
  templates,
  type StaffCancellationContext,
} from '@/integrations/zeptomail/templates';

describe('customer cancellation policy', () => {
  it('allows PENDING', () => {
    expect(isCustomerCancellable(OrderStatus.PENDING)).toBe(true);
    expect(customerCancelBlockedReason(OrderStatus.PENDING)).toBeNull();
  });

  it('allows PROCESSING — accepted but not yet dispatched', () => {
    expect(isCustomerCancellable(OrderStatus.PROCESSING)).toBe(true);
    expect(customerCancelBlockedReason(OrderStatus.PROCESSING)).toBeNull();
  });

  it('blocks SHIPPED', () => {
    expect(isCustomerCancellable(OrderStatus.SHIPPED)).toBe(false);
    expect(customerCancelBlockedReason(OrderStatus.SHIPPED)).toMatch(/already shipped/i);
  });

  it('blocks DELIVERED', () => {
    expect(isCustomerCancellable(OrderStatus.DELIVERED)).toBe(false);
    expect(customerCancelBlockedReason(OrderStatus.DELIVERED)).toMatch(/delivered/i);
  });

  it('blocks CANCELLED', () => {
    expect(isCustomerCancellable(OrderStatus.CANCELLED)).toBe(false);
    expect(customerCancelBlockedReason(OrderStatus.CANCELLED)).toMatch(/already cancelled/i);
  });

  it('is STRICTLY narrower than the admin lifecycle', () => {
    // The exact divergence that matters: ops keep SHIPPED → CANCELLED for
    // returns to origin; the customer does not get it.
    expect(isValidTransition(OrderStatus.SHIPPED, OrderStatus.CANCELLED)).toBe(true);
    expect(isCustomerCancellable(OrderStatus.SHIPPED)).toBe(false);
  });

  it('never permits a state the lifecycle itself forbids', () => {
    for (const status of CUSTOMER_CANCELLABLE_STATES) {
      expect(nextStates(status)).toContain(OrderStatus.CANCELLED);
    }
  });

  it('gives a customer-readable reason for every blocked state', () => {
    for (const status of [OrderStatus.SHIPPED, OrderStatus.DELIVERED, OrderStatus.CANCELLED]) {
      const reason = customerCancelBlockedReason(status);
      expect(reason).toBeTruthy();
      // No enum names or status codes leaking into customer-facing copy.
      expect(reason).not.toMatch(/PENDING|PROCESSING|SHIPPED|DELIVERED|CANCELLED|409/);
    }
  });
});

describe('internal cancellation alert', () => {
  const base: StaffCancellationContext = {
    orderNo: '27ZFO123',
    customerName: 'Aarav Sharma',
    customerEmail: 'aarav@example.com',
    customerPhone: '9876543210',
    placedAt: new Date('2026-08-23T10:00:00.000Z'),
    items: [],
    subtotalPaise: 50000,
    discountPaise: 0,
    shippingPaise: 0,
    taxPaise: 0,
    totalPaise: 50000,
    paymentMethod: 'RAZORPAY',
    paymentStatus: 'PAID',
    razorpayOrderId: 'order_test_abc',
    razorpayPaymentId: 'pay_test_xyz',
    addressLine: 'Somewhere',
    cancelReason: 'Cancelled by customer — Changed my mind',
    cancelledBy: 'customer',
    cancelledAtDate: new Date('2026-08-23T11:00:00.000Z'),
    refundState: 'pending',
  };

  it('names the customer as the canceller in the subject', () => {
    const r = staffTemplates['staff-order-cancelled'](base);
    expect(r.subject).toBe('Order Cancelled by Customer — #27ZFO123');
  });

  it('carries every operational field ops need to act', () => {
    const r = staffTemplates['staff-order-cancelled'](base);
    for (const needle of [
      '27ZFO123',
      'Aarav Sharma',
      'aarav@example.com',
      '9876543210',
      'RAZORPAY',
      'order_test_abc',
      'pay_test_xyz',
      'Changed my mind',
    ]) {
      expect(r.html).toContain(needle);
    }
  });

  it('flags a captured-but-unrefunded payment as needing action', () => {
    const r = staffTemplates['staff-order-cancelled'](base);
    expect(r.html).toMatch(/ACTION REQUIRED/);
    expect(r.html).toMatch(/refund not yet processed/i);
  });

  it('does NOT claim a refund was made', () => {
    const r = staffTemplates['staff-order-cancelled'](base);
    expect(r.html).not.toMatch(/refund (has been |was )?(completed|processed successfully)/i);
  });

  it('says no refund is due for an unpaid COD cancellation', () => {
    const r = staffTemplates['staff-order-cancelled']({
      ...base,
      paymentMethod: 'COD',
      paymentStatus: 'UNPAID',
      refundState: 'none',
    });
    expect(r.html).toMatch(/No refund due/i);
    expect(r.html).not.toMatch(/ACTION REQUIRED/);
  });

  it('reports an already-refunded order as refunded', () => {
    const r = staffTemplates['staff-order-cancelled']({ ...base, refundState: 'processed' });
    expect(r.html).toMatch(/Already refunded/i);
  });
});

describe('customer cancellation email', () => {
  it('reuses the existing order-cancelled template and never promises a completed refund', () => {
    const r = templates['order-cancelled'](
      {
        orderNo: '27ZFO123',
        cancelReason: 'Cancelled by customer — Changed my mind',
        customerName: 'Aarav',
        items: [],
        subtotalPaise: 50000,
        discountPaise: 0,
        shippingPaise: 0,
        taxPaise: 0,
        totalPaise: 50000,
        paymentMethod: 'RAZORPAY',
        placedAt: new Date('2026-08-23T10:00:00.000Z'),
        addressLine: 'Somewhere',
      },
      'aarav@example.com',
    );
    expect(r.subject).toBe('Order 27ZFO123 was cancelled');
    expect(r.html).toContain('Changed my mind');
    // "will be refunded" is a promise the system keeps; "has been" is not.
    expect(r.html).not.toMatch(/refund (has been|was) (processed|completed)/i);
  });
});
