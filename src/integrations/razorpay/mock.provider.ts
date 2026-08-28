/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  TEMPORARY — DEVELOPMENT ONLY                                            ║
 * ║                                                                          ║
 * ║  TODO: Replace with production Razorpay verification.                    ║
 * ║                                                                          ║
 * ║  Simulates Razorpay Test Mode: an order created here auto-confirms 30    ║
 * ║  seconds later with no real payment, so checkout is testable without     ║
 * ║  sandbox credentials or a card.                                          ║
 * ║                                                                          ║
 * ║  TO GO LIVE: set RAZORPAY_AUTO_CONFIRM=false and supply                  ║
 * ║  RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET.        ║
 * ║  payment.service.ts then selects RazorpayProvider instead. No other      ║
 * ║  file changes — the confirmation path, order state machine, stock        ║
 * ║  transaction, audit trail and emails are all production code.            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Two safety properties, so this cannot become an accidental hole:
 *
 *  1. It REFUSES TO CONSTRUCT when NODE_ENV=production. A production deploy that
 *     leaves RAZORPAY_AUTO_CONFIRM=true crashes at boot rather than silently
 *     accepting fake payments.
 *  2. Verification is not a rubber stamp. Ids are HMAC-signed with a server-side
 *     secret and checked, so a client still cannot confirm an arbitrary order —
 *     the shape of the trust boundary matches the real provider.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';
import type {
  GatewayOrder,
  PaymentProvider,
  PaymentVerification,
  RefundResult,
  VerificationPayload,
} from './payment.types';

const log = logger.child({ module: 'payment.mock' });

/**
 * How long the simulated gateway "takes" before confirming.
 *
 * 10s, not 30s: long enough to exercise the real "awaiting payment" state the
 * production flow has, short enough that testing checkout is not a chore.
 * Irrelevant in production — RazorpayProvider runs there and confirmation comes
 * from the gateway webhook, not a timer.
 */
export const MOCK_CONFIRM_DELAY_MS = 10_000;

const MOCK_PREFIX = 'mock_';

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock' as const;
  readonly isSimulated = true;

  /** Signs mock ids so they cannot be fabricated client-side. */
  private readonly secret: string;

  constructor() {
    // Hard stop: simulated payments must never run in production.
    if (env.isProd) {
      throw new Error(
        'MockPaymentProvider cannot run in production. Set RAZORPAY_AUTO_CONFIRM=false ' +
          'and provide real Razorpay credentials.',
      );
    }
    this.secret = env.JWT_ACCESS_SECRET;

    log.warn(
      { autoConfirmSeconds: MOCK_CONFIRM_DELAY_MS / 1000 },
      'TEST MODE: payments auto-confirm without real money. Not for production.',
    );
  }

  private sign(value: string): string {
    return createHmac('sha256', this.secret).update(value).digest('hex').slice(0, 32);
  }

  async createOrder(input: {
    orderNo: string;
    amountPaise: number;
  }): Promise<GatewayOrder> {
    // Embeds our order number plus a signature over it, so verifyPayment can
    // confirm the id was issued by us for this order.
    const nonce = randomBytes(6).toString('hex');
    const base = `${MOCK_PREFIX}order_${input.orderNo}_${nonce}`;
    const gatewayOrderId = `${base}.${this.sign(base)}`;

    log.info(
      { orderNo: input.orderNo, gatewayOrderId },
      'TEST MODE: gateway order created, will auto-confirm',
    );

    return {
      gatewayOrderId,
      amountPaise: input.amountPaise,
      currency: 'INR',
      // No public key — the storefront shows a test-mode notice rather than a widget.
      publicKey: null,
      isSimulated: true,
    };
  }

  /**
   * Verify a simulated payment.
   *
   * Still checks a signature: the order id must be one we minted, and the payment
   * id must be signed for that order. So the mock exercises the same
   * client-cannot-forge property the real provider has.
   */
  async verifyPayment(payload: VerificationPayload): Promise<PaymentVerification> {
    const [base, signature] = payload.gatewayOrderId.split('.');
    if (!base || !signature || !safeCompare(this.sign(base), signature)) {
      return { verified: false, gatewayPaymentId: null, failureReason: 'unknown_mock_order' };
    }

    const expectedPaymentSig = this.sign(`pay:${payload.gatewayOrderId}`);
    if (!safeCompare(payload.signature, expectedPaymentSig)) {
      return { verified: false, gatewayPaymentId: null, failureReason: 'signature_mismatch' };
    }

    return { verified: true, gatewayPaymentId: payload.gatewayPaymentId };
  }

  /**
   * The signature the auto-confirm job presents. Server-side only — never sent to
   * a client, so a browser cannot self-confirm an order.
   */
  paymentSignatureFor(gatewayOrderId: string): string {
    return this.sign(`pay:${gatewayOrderId}`);
  }

  /** A plausible payment id for the simulated capture. */
  paymentIdFor(gatewayOrderId: string): string {
    return `${MOCK_PREFIX}pay_${this.sign(gatewayOrderId).slice(0, 14)}`;
  }

  verifyWebhookSignature(): boolean {
    // No real webhooks in test mode; the auto-confirm job stands in for them.
    log.warn('TEST MODE: webhook signature verification skipped');
    return false;
  }

  async refund(input: { gatewayPaymentId: string; amountPaise: number }): Promise<RefundResult> {
    log.warn(
      { paymentId: input.gatewayPaymentId, amountPaise: input.amountPaise },
      'TEST MODE: refund simulated, no money moved',
    );
    return { gatewayRefundId: `${MOCK_PREFIX}rfnd_${randomBytes(7).toString('hex')}`, settled: true };
  }

  async fetchOrderPayments(): Promise<Array<{
    id: string;
    amountPaise: number;
    status: string;
    method?: string;
  }>> {
    return [];
  }
}
