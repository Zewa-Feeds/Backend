import { describe, expect, it, vi } from 'vitest';

const refundMock = vi.fn();
vi.mock('razorpay', () => ({
  default: class {
    payments = { refund: (...args: unknown[]) => refundMock(...args) };
    orders = {};
  },
}));
vi.mock('@/config/env', () => ({
  env: { RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 'secret', RAZORPAY_WEBHOOK_SECRET: 'wh' },
}));

vi.mock('@/lib/logger', () => {
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return { logger: { ...log, child: () => log } };
});

import { RazorpayProvider, gatewayRefusal } from './razorpay.provider';

const refuse = (statusCode: number, description?: string) =>
  Object.assign(new Error('rzp'), { statusCode, error: { code: 'BAD_REQUEST_ERROR', description } });

describe('refund errors', () => {
  it("passes Razorpay's reason through when it refuses the refund", async () => {
    refundMock.mockRejectedValueOnce(
      refuse(400, 'Your account does not have enough balance to carry out the refund operation.'),
    );
    await expect(
      new RazorpayProvider().refund({ gatewayPaymentId: 'pay_1', amountPaise: 6900 }),
    ).rejects.toMatchObject({
      status: 422,
      code: 'REFUND_NOT_ALLOWED',
      message:
        'Razorpay refused the refund: Your account does not have enough balance to carry out the refund operation.',
    });
  });

  it('still reports an outage as unavailable', async () => {
    refundMock.mockRejectedValueOnce(refuse(502, 'Bad gateway'));
    await expect(
      new RazorpayProvider().refund({ gatewayPaymentId: 'pay_1', amountPaise: 6900 }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_FAILED' });

    refundMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(
      new RazorpayProvider().refund({ gatewayPaymentId: 'pay_1', amountPaise: 6900 }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_FAILED' });
  });

  it('needs a description to call it a refusal', () => {
    expect(gatewayRefusal(refuse(400))).toBeNull();
    expect(gatewayRefusal(refuse(400, '  '))).toBeNull();
    expect(gatewayRefusal(null)).toBeNull();
  });
});
