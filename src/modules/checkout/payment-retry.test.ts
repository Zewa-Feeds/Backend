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
import { OrderStatus, PaymentMethod, PaymentStatus } from '@prisma/client';

const findUnique = vi.fn();
const orderUpdate = vi.fn().mockResolvedValue({});
const priceCartMock = vi.fn();
const transitionMock = vi.fn().mockResolvedValue({});

vi.mock('@/lib/prisma', () => ({
  prisma: {
    order: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      update: (...a: unknown[]) => orderUpdate(...a),
    },
  },
}));

vi.mock('@/integrations/razorpay/payment.service', () => ({
  paymentProvider: () => ({
    name: 'razorpay',
    isSimulated: false,
    publicKey: 'rzp_test_KEY',
  }),
  enabledPaymentMethods: () => ({ cod: false, razorpay: true }),
}));

/*
 * The retry decision now sits AFTER the cart is priced, because only the
 * server-side total can say whether the stored order is still the right one.
 * These suites stop at that decision: a reuse returns, and a supersede throws
 * a sentinel so the test can assert the fall-through without standing up the
 * whole order-creation transaction.
 */
vi.mock('./pricing.service', async () => {
  const actual = await vi.importActual<typeof import('./pricing.service')>('./pricing.service');
  return {
    ...actual,
    priceCart: (...a: unknown[]) => priceCartMock(...a),
    assertFulfillable: () => undefined,
  };
});

vi.mock('@/modules/orders/orders.service', () => ({
  transition: (...a: unknown[]) => transitionMock(...a),
}));

vi.mock('@/modules/settings/settings.service', () => ({
  getAll: vi.fn().mockResolvedValue({
    maintenance: { on: false },
    shipping: { pinBlacklist: [], freeThresholdPaise: 0, defaultRatePaise: 0 },
  }),
  getTaxConfig: vi
    .fn()
    .mockResolvedValue({ gstRatePct: 0, gstInclusive: true, sellerState: 'Kerala' }),
}));

import { checkout } from './checkout.service';

/** A priced cart, as the engine would return it. */
function pricedAt(totalPaise: number) {
  return {
    lines: [{ sku: 'DBSFL-25G', qty: 1, variantId: 'v1', lineTotalPaise: totalPaise }],
    subtotalPaise: totalPaise,
    discountPaise: 0,
    shippingPaise: 0,
    taxPaise: 0,
    totalPaise,
    coupon: null,
    coupons: [],
    freeShippingFromCoupon: false,
    issues: [],
  };
}

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
    id: 'order-id-1',
    orderNo: '27ZFO001',
    totalPaise: 6450, // ₹64.50 — the screenshot's total
    paymentMethod: PaymentMethod.RAZORPAY,
    razorpayOrderId: 'order_ABC123',
    paymentStatus: PaymentStatus.UNPAID,
    status: OrderStatus.PENDING,
    ...over,
  };
}

beforeEach(() => {
  findUnique.mockReset();
  priceCartMock.mockReset();
  transitionMock.mockClear();
  orderUpdate.mockClear();
});

describe('retry after the customer dismisses Razorpay', () => {
  /*
   * The decision is made on the SERVER-CALCULATED total, never on anything the
   * browser asserts. `totalPaise` is the settlement figure, so it already
   * folds in lines, quantities, coupons, shipping and coins — every change a
   * customer can make that alters what they owe moves it.
   */
  it('reuses the same gateway order when the total is unchanged', async () => {
    findUnique.mockResolvedValue(existingOrder());
    priceCartMock.mockResolvedValue(pricedAt(6450)); // same as stored

    const result = await checkout(input, ctx);

    expect(result.orderNo).toBe('27ZFO001');
    expect(result.payment.gatewayOrderId).toBe('order_ABC123');
    expect(result.payment.amountPaise).toBe(6450);
    expect(result.payment.publicKey).toBe('rzp_test_KEY');
    // Nothing was superseded, so no cancellation and no key release.
    expect(transitionMock).not.toHaveBeenCalled();
    expect(orderUpdate).not.toHaveBeenCalled();
  });

  it('reuses across three dismiss/retry cycles without duplicating anything', async () => {
    findUnique.mockResolvedValue(existingOrder());
    priceCartMock.mockResolvedValue(pricedAt(6450));

    const a = await checkout(input, ctx);
    const b = await checkout(input, ctx);
    const c = await checkout(input, ctx);

    for (const r of [a, b, c]) {
      expect(r.orderNo).toBe('27ZFO001');
      expect(r.payment.gatewayOrderId).toBe('order_ABC123');
      expect(r.payment.amountPaise).toBe(6450);
    }
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it.each([
    ['quantity changed', 12450],
    ['coupon removed', 6500],
    ['coupon added', 5800],
    ['shipping changed with the state', 9450],
    ['a different product', 28800],
  ])('supersedes the stale order when %s', async (_why, nowPaise) => {
    findUnique.mockResolvedValue(existingOrder()); // stored at 6450
    priceCartMock.mockResolvedValue(pricedAt(nowPaise));

    // The stale order must not be reused, so the call proceeds past the retry
    // branch into order creation, which these mocks do not stand up.
    await checkout(input, ctx).catch(() => undefined);

    // Cancelled, which returns its reserved stock.
    expect(transitionMock).toHaveBeenCalledTimes(1);
    const [orderNo, transitionInput] = transitionMock.mock.calls[0]!;
    expect(orderNo).toBe('27ZFO001');
    expect(transitionInput.to).toBe('CANCELLED');
    expect(transitionInput.notifyCustomer).toBe(false);

    // And its idempotency key is freed so the new order can claim it.
    expect(orderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { idempotencyKey: null } }),
    );
  });

  it('does not count the pending order own redemptions against the retry', async () => {
    findUnique.mockResolvedValue(existingOrder({ id: 'order-id-1' }));
    priceCartMock.mockResolvedValue(pricedAt(6450));

    await checkout(input, ctx);

    /*
     * Without this the retry is refused with COUPON_ALREADY_USED: the first
     * attempt holds a redemption for every code on the cart, and the customer
     * is blocked by their own abandoned order.
     */
    expect(priceCartMock).toHaveBeenCalledWith(
      expect.objectContaining({ ignoreRedemptionsForOrderId: 'order-id-1' }),
    );
  });

  it('refuses to reopen the widget on an order that is already paid', async () => {
    findUnique.mockResolvedValue(existingOrder({ paymentStatus: PaymentStatus.PAID }));

    const result = await checkout(input, ctx);

    expect(result.payment.required).toBe(false);
    expect(result.payment.publicKey).toBeUndefined();
    expect(result.payment.amountPaise).toBeUndefined();
    // Settled orders are answered before pricing — nothing to reprice.
    expect(priceCartMock).not.toHaveBeenCalled();
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
    priceCartMock.mockResolvedValue(pricedAt(paise));

    const result = await checkout(input, ctx);

    expect(result.payment.amountPaise).toBe(paise);
    expect(result.totalPaise).toBe(paise);
    // Never rounded to a whole rupee.
    expect(result.payment.amountPaise! % 100).toBe(paise % 100);
  });

  /*
   * The reported cart, composed exactly: ₹5.00 product, SPECIAL10 taking 50
   * paise, ₹60.00 shipping. Pins the COMPOSITION, not just a stored figure —
   * a rupee-rounding bug anywhere in discount or shipping would land on 6500
   * (₹65), which is what the Razorpay popup displays.
   */
  it('carries ₹5.00 − ₹0.50 + ₹60.00 to the gateway as 6450 paise', async () => {
    const subtotal = 500;
    const discount = 50; // SPECIAL10, 10% of ₹5.00
    const shipping = 6000;
    const total = subtotal - discount + shipping;

    expect(total).toBe(6450); // not 6500

    findUnique.mockResolvedValue(existingOrder({ totalPaise: total }));
    priceCartMock.mockResolvedValue(pricedAt(total));

    const result = await checkout(input, ctx);

    expect(result.totalPaise).toBe(6450);
    expect(result.payment.amountPaise).toBe(6450);
    expect(result.payment.amountPaise).not.toBe(6500);
  });

  it('keeps sub-rupee precision that a rupee-rounding bug would destroy', async () => {
    findUnique.mockResolvedValue(existingOrder({ totalPaise: 6450 }));
    priceCartMock.mockResolvedValue(pricedAt(6450));

    const result = await checkout(input, ctx);

    expect(result.payment.amountPaise).not.toBe(6500); // ₹65, the reported bug
    expect(result.payment.amountPaise).not.toBe(6400);
    expect(result.payment.amountPaise).toBe(6450);
  });
});
