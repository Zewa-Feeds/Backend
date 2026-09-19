/**
 * Payment integrity — an order may become PAID only on a verified payment.
 *
 * THE BUG THIS PINS. The checkout replay answered a CANCELLED order with
 * `payment.required: false`, and the storefront read that as "nothing to pay,
 * we're done" and showed its success screen. An order nobody had paid for was
 * presented as confirmed, without the Razorpay modal ever opening.
 *
 * Two separate mistakes met there:
 *   1. a dead order was being reported as a replayable one, and
 *   2. "no online payment is owed" was being conflated with "paid".
 *
 * Both are covered below, alongside the verification boundary itself: the
 * signature, the capture status, and the amount.
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
  paymentProvider: () => ({ name: 'razorpay', isSimulated: false, publicKey: 'rzp_test_KEY' }),
  enabledPaymentMethods: () => ({ cod: true, razorpay: true }),
}));

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

const ctx = { actorId: null, actorEmail: null, ip: null, userAgent: null } as never;

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

function order(over: Record<string, unknown> = {}) {
  return {
    id: 'order-id-1',
    orderNo: '27ZFO001',
    totalPaise: 6450,
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

describe('an unpaid order is never presented as complete', () => {
  it('refuses a replay against a cancelled order instead of reporting it done', async () => {
    findUnique.mockResolvedValue(order({ status: OrderStatus.CANCELLED }));

    /*
     * Previously this returned `{ required: false }`, which the storefront
     * showed as success — a confirmed order with no payment and no modal.
     */
    await expect(checkout(input, ctx)).rejects.toMatchObject({ status: 409 });
    expect(priceCartMock).not.toHaveBeenCalled();
  });

  it('never reports paymentSettled while the order is unpaid', async () => {
    findUnique.mockResolvedValue(order());
    priceCartMock.mockResolvedValue({
      lines: [], subtotalPaise: 6450, discountPaise: 0, shippingPaise: 0,
      taxPaise: 0, totalPaise: 6450, coupon: null, coupons: [],
      freeShippingFromCoupon: false, issues: [],
    });

    const result = await checkout(input, ctx);

    // Payment is still owed, so the widget must open — not a success screen.
    expect(result.payment.required).toBe(true);
    expect(result.payment.paymentSettled).toBeUndefined();
  });

  it('marks paymentSettled only once the order is actually PAID', async () => {
    findUnique.mockResolvedValue(order({ paymentStatus: PaymentStatus.PAID }));

    const result = await checkout(input, ctx);

    expect(result.payment.required).toBe(false);
    expect(result.payment.paymentSettled).toBe(true);
    expect(result.payment.publicKey).toBeUndefined();
  });

  it('does not mark a COD order as settled — nothing has been collected yet', async () => {
    findUnique.mockResolvedValue(
      order({ paymentMethod: PaymentMethod.COD, razorpayOrderId: null }),
    );

    const result = await checkout(input, ctx);

    // `required: false` is correct for COD, but it is NOT payment.
    expect(result.payment.required).toBe(false);
    expect(result.payment.paymentSettled).toBe(false);
  });
});

/**
 * The verification boundary itself.
 *
 * `confirmPayment()` deliberately does no verification of its own — it trusts
 * its caller, and every caller verifies first. These exercise the real
 * provider's checks directly, since that is where the trust actually lives.
 */
describe('Razorpay verification refuses anything it cannot prove', () => {
  const KEY_SECRET = 'test_secret_value';

  async function providerWith(paymentEntity: Record<string, unknown>) {
    vi.resetModules();
    const fetchMock = vi.fn().mockResolvedValue(paymentEntity);
    vi.doMock('razorpay', () => ({
      default: class {
        payments = { fetch: fetchMock };
        orders = { create: vi.fn() };
      },
    }));
    // Spread the real env so the logger keeps its LOG_LEVEL; override only the
    // gateway credentials this suite needs to control.
    const realEnv = await vi.importActual<typeof import('@/config/env')>('@/config/env');
    vi.doMock('@/config/env', () => ({
      env: {
        ...realEnv.env,
        RAZORPAY_KEY_ID: 'rzp_test_KEY',
        RAZORPAY_KEY_SECRET: KEY_SECRET,
        RAZORPAY_WEBHOOK_SECRET: 'whsec',
      },
    }));
    const { RazorpayProvider } = await import('@/integrations/razorpay/razorpay.provider');
    return new RazorpayProvider();
  }

  /** The signature Razorpay would send for this pair. */
  async function sign(orderId: string, paymentId: string) {
    const { createHmac } = await import('node:crypto');
    return createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
  }

  it('rejects a forged signature', async () => {
    const provider = await providerWith({ status: 'captured', amount: 6450 });

    const result = await provider.verifyPayment({
      gatewayOrderId: 'order_ABC123',
      gatewayPaymentId: 'pay_1',
      signature: 'deadbeef'.repeat(8),
      expectedAmountPaise: 6450,
    });

    expect(result.verified).toBe(false);
    expect(result.failureReason).toBe('signature_mismatch');
  });

  it('rejects a correctly signed payment that was never captured', async () => {
    const provider = await providerWith({ status: 'failed', amount: 6450 });

    const result = await provider.verifyPayment({
      gatewayOrderId: 'order_ABC123',
      gatewayPaymentId: 'pay_1',
      signature: await sign('order_ABC123', 'pay_1'),
      expectedAmountPaise: 6450,
    });

    expect(result.verified).toBe(false);
    expect(result.failureReason).toBe('payment_status_failed');
  });

  it('rejects a captured payment for the wrong amount', async () => {
    // Signed, captured — but ₹1.00 against a ₹64.50 order.
    const provider = await providerWith({ status: 'captured', amount: 100 });

    const result = await provider.verifyPayment({
      gatewayOrderId: 'order_ABC123',
      gatewayPaymentId: 'pay_1',
      signature: await sign('order_ABC123', 'pay_1'),
      expectedAmountPaise: 6450,
    });

    expect(result.verified).toBe(false);
    expect(result.failureReason).toBe('amount_mismatch');
  });

  it('accepts a signed, captured payment for the exact amount', async () => {
    const provider = await providerWith({ status: 'captured', amount: 6450 });

    const result = await provider.verifyPayment({
      gatewayOrderId: 'order_ABC123',
      gatewayPaymentId: 'pay_1',
      signature: await sign('order_ABC123', 'pay_1'),
      expectedAmountPaise: 6450,
    });

    expect(result.verified).toBe(true);
    expect(result.gatewayPaymentId).toBe('pay_1');
  });
});
