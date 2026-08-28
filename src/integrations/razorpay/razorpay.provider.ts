/**
 * Real Razorpay provider — production path.
 *
 * This is complete and production-ready. It is NOT the mock. When
 * `RAZORPAY_AUTO_CONFIRM=false` and credentials are present, this is what runs.
 *
 * Signature verification is the security-critical part: Razorpay signs
 * `${orderId}|${paymentId}` with the key secret, so a client cannot claim a
 * payment succeeded without the secret. Compared in constant time.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import Razorpay from 'razorpay';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';
import { notConfigured, upstreamFailed } from '@/lib/errors';
import type {
  GatewayOrder,
  PaymentProvider,
  PaymentVerification,
  RefundResult,
  VerificationPayload,
} from './payment.types';

const log = logger.child({ module: 'razorpay' });

/** Length-safe constant-time comparison of two hex digests. */
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay' as const;
  readonly isSimulated = false;

  private readonly client: Razorpay;
  private readonly keyId: string;
  private readonly keySecret: string;
  private readonly webhookSecret: string | undefined;

  constructor() {
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
      throw notConfigured('Razorpay');
    }
    this.keyId = env.RAZORPAY_KEY_ID;
    this.keySecret = env.RAZORPAY_KEY_SECRET;
    this.webhookSecret = env.RAZORPAY_WEBHOOK_SECRET;
    this.client = new Razorpay({ key_id: this.keyId, key_secret: this.keySecret });
  }

  async createOrder(input: {
    orderNo: string;
    amountPaise: number;
    email: string;
    phone: string;
  }): Promise<GatewayOrder> {
    try {
      const order = await this.client.orders.create({
        amount: input.amountPaise,
        currency: 'INR',
        // Our order number, so a gateway record can be traced back to ours.
        receipt: input.orderNo,
        notes: { orderNo: input.orderNo, email: input.email },
      });

      return {
        gatewayOrderId: order.id,
        amountPaise: Number(order.amount),
        currency: 'INR',
        publicKey: this.keyId,
        isSimulated: false,
      };
    } catch (err) {
      log.error({ err, orderNo: input.orderNo }, 'razorpay order creation failed');
      throw upstreamFailed('Razorpay');
    }
  }

  /**
   * Verify a payment via HMAC-SHA256 over `orderId|paymentId`.
   *
   * This is the whole trust boundary for a browser-reported success: without the
   * key secret an attacker cannot forge a valid signature, so they cannot mark an
   * unpaid order as paid.
   */
  async verifyPayment(payload: VerificationPayload): Promise<PaymentVerification> {
    const expected = createHmac('sha256', this.keySecret)
      .update(`${payload.gatewayOrderId}|${payload.gatewayPaymentId}`)
      .digest('hex');

    if (!safeCompare(expected, payload.signature)) {
      log.warn({ gatewayOrderId: payload.gatewayOrderId }, 'razorpay signature mismatch');
      return { verified: false, gatewayPaymentId: null, failureReason: 'signature_mismatch' };
    }

    // Signature proves the payload came from Razorpay. Also confirm the payment
    // is actually captured — a signed-but-failed payment must not pass.
    try {
      const payment = await this.client.payments.fetch(payload.gatewayPaymentId);
      const captured = payment.status === 'captured' || payment.status === 'authorized';

      if (!captured) {
        return {
          verified: false,
          gatewayPaymentId: payload.gatewayPaymentId,
          failureReason: `payment_status_${payment.status}`,
        };
      }
      return { verified: true, gatewayPaymentId: payload.gatewayPaymentId };
    } catch (err) {
      log.error({ err, paymentId: payload.gatewayPaymentId }, 'razorpay payment fetch failed');
      throw upstreamFailed('Razorpay');
    }
  }

  /**
   * Webhook signature check.
   *
   * Uses the RAW request body — a parsed and re-serialised object produces
   * different bytes and would never match. See the express.raw() mount in app.ts.
   */
  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
    if (!this.webhookSecret) {
      log.error('RAZORPAY_WEBHOOK_SECRET is not set — rejecting webhook');
      return false;
    }
    const expected = createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
    return safeCompare(expected, signature);
  }

  async refund(input: {
    gatewayPaymentId: string;
    amountPaise: number;
    notes?: Record<string, string>;
  }): Promise<RefundResult> {
    try {
      const refund = await this.client.payments.refund(input.gatewayPaymentId, {
        amount: input.amountPaise,
        notes: input.notes,
      });
      return {
        gatewayRefundId: refund.id,
        settled: refund.status === 'processed',
      };
    } catch (err) {
      log.error({ err, paymentId: input.gatewayPaymentId }, 'razorpay refund failed');
      throw upstreamFailed('Razorpay');
    }
  }

  async fetchOrderPayments(gatewayOrderId: string): Promise<Array<{
    id: string;
    amountPaise: number;
    status: string;
    method?: string;
  }>> {
    try {
      const response = (await this.client.orders.fetchPayments(gatewayOrderId)) as any;
      const items = (response?.items ?? []) as Array<any>;
      return items.map((p) => ({
        id: String(p.id),
        amountPaise: Number(p.amount),
        status: String(p.status),
        method: p.method ? String(p.method) : undefined,
      }));
    } catch (err) {
      log.error({ err, gatewayOrderId }, 'failed to fetch payments for razorpay order');
      return [];
    }
  }
}
