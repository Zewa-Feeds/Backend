/**
 * Retrying payment after the customer dismisses Razorpay — and the amount.
 *
 * THE BUG THIS PINS. The idempotent replay returned only `gatewayOrderId`,
 * omitting `publicKey`, `amountPaise` and `simulated`. The browser holds one
 * idempotency key for the life of a checkout session, so the second click
 * after a dismissal always replayed — and built the widget with
 * `key: undefined`, which cannot open. The storefront then routed to its
 * failure screen, turning "I closed the popup" into "PAYMENT FAILED" with no
 * way back.
 *
 * Dismissal is not failure, so the replay has to hand back everything needed
 * to open the widget again.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PaymentMethod, PaymentStatus } from '@prisma/client';

const findUnique = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: { order: { findUnique: (...a: unknown[]) => findUnique(...a) } },
}));

vi.mock('@/integrations/razorpay/payment.service', () => ({
  paymentProvider: () => ({
    name: 'razorpay',
    isSimulated: false,
    publicKey: 'rzp_test_KEY',
  }),
  enabledPaymentMethods: () => ({ cod: false, razorpay: true }),
}));

import { checkout } from './checkout.service';

const ctx = { actorId: null, actorEmail: null, ip: null, userAgent: null } as never;

/** The shape the storefront sends. Only the replay path is exercised here. */
const input = {
  lines: [{ sku: 'DBSFL-25G', qty: 1 }],
  email: 'buyer@example.com',
  phone: '9999999999',
  shippingAddress: {
    name: 'A B',
    phone: '9999999999',
    line1: '1 St',
    city: 'Kochi',
    state: 'Kerala',
    pincode: '682001',
  },
  paymentMethod: PaymentMethod.RAZORPAY,
  idempotencyKey: 'buyer@example.com:chk-1',
} as never;

function existingOrder(over: Record<string, unknown> = {}) {
  return {
    orderNo: '27ZFO001',
    totalPaise: 6450, // ₹64.50 — the screenshot's total
    paymentMethod: PaymentMethod.RAZORPAY,
    razorpayOrderId: 'order_ABC123',
    paymentStatus: PaymentStatus.UNPAID,
    ...over,
  };
}

beforeEach(() => {
  findUnique.mockReset();
});

describe('retry after the customer dismisses Razorpay', () => {
  it('returns everything the widget needs, so it can open again', async () => {
    findUnique.mockResolvedValue(existingOrder());

    const result = await checkout(input, ctx);

    expect(result.payment.required).toBe(true);
    // The three fields the old replay dropped:
    expect(result.payment.publicKey).toBe('rzp_test_KEY');
    expect(result.payment.amountPaise).toBe(6450);
    expect(result.payment.simulated).toBe(false);
  });

  it('reuses the same gateway order rather than creating a second one', async () => {
    findUnique.mockResolvedValue(existingOrder());

    const first = await checkout(input, ctx);
    const second = await checkout(input, ctx);
    const third = await checkout(input, ctx);

    // Dismiss → retry → dismiss → retry keeps one application order and one
    // gateway order. Two live gateway orders for one order is the double-charge
    // shape this guards against.
    for (const r of [first, second, third]) {
      expect(r.orderNo).toBe('27ZFO001');
      expect(r.payment.gatewayOrderId).toBe('order_ABC123');
      expect(r.payment.amountPaise).toBe(6450);
    }
  });

  it('refuses to reopen the widget on an order that is already paid', async () => {
    findUnique.mockResolvedValue(existingOrder({ paymentStatus: PaymentStatus.PAID }));

    const result = await checkout(input, ctx);

    expect(result.payment.required).toBe(false);
    // No key and no amount, so a stale tab cannot re-present settled money.
    expect(result.payment.publicKey).toBeUndefined();
    expect(result.payment.amountPaise).toBeUndefined();
  });
});

describe('the amount handed to the gateway', () => {
  /*
   * ₹64.50 must reach Razorpay as 6450 paise. The order's stored total is the
   * single source of truth — the replay echoes it and never recomputes, so a
   * display-formatting helper can never leak into the payment amount.
   */
  it.each([
    ['₹64.50', 6450],
    ['₹99.99', 9999],
    ['₹125.50', 12550],
    ['₹1000.00', 100000],
    ['₹0.50', 50],
  ])('passes %s through as %i paise, exactly', async (_label, paise) => {
    findUnique.mockResolvedValue(existingOrder({ totalPaise: paise }));

    const result = await checkout(input, ctx);

    expect(result.payment.amountPaise).toBe(paise);
    expect(result.totalPaise).toBe(paise);
    // Never rounded to a whole rupee.
    expect(result.payment.amountPaise! % 100).toBe(paise % 100);
  });

  it('keeps sub-rupee precision that a rupee-rounding bug would destroy', async () => {
    findUnique.mockResolvedValue(existingOrder({ totalPaise: 6450 }));

    const result = await checkout(input, ctx);

    expect(result.payment.amountPaise).not.toBe(6500); // ₹65, the reported bug
    expect(result.payment.amountPaise).not.toBe(6400);
    expect(result.payment.amountPaise).toBe(6450);
  });
});
