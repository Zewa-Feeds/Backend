/**
 * Payment provider selection.
 *
 * One decision, made once at first use, based on config:
 *
 *   RAZORPAY_AUTO_CONFIRM=true   → MockPaymentProvider   (dev/test only)
 *   credentials present          → RazorpayProvider      (production)
 *   neither                      → null, and COD still works
 *
 * Everything downstream talks to the `PaymentProvider` interface, so going live is
 * an env change. See PAYMENTS.md for the switch-over checklist.
 */
import { env } from '@/config/env';
import { logger } from '@/lib/logger';
import { MockPaymentProvider } from './mock.provider';
import { RazorpayProvider } from './razorpay.provider';
import type { PaymentProvider } from './payment.types';

const log = logger.child({ module: 'payment' });

let provider: PaymentProvider | null | undefined;

/**
 * The active provider, or null when online payment is unavailable.
 *
 * Null is a legitimate state: a deployment can run COD-only, and checkout handles
 * that by rejecting RAZORPAY orders with a clear error rather than crashing.
 */
export function paymentProvider(): PaymentProvider | null {
  if (provider !== undefined) return provider;

  if (env.RAZORPAY_AUTO_CONFIRM) {
    // Constructor throws in production, so this cannot be reached there.
    provider = new MockPaymentProvider();
  } else if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) {
    provider = new RazorpayProvider();
    log.info('Razorpay provider active (live verification)');
  } else {
    provider = null;
    log.warn('no payment provider configured — online payment disabled, COD only');
  }

  return provider;
}

/** Which payment methods this deployment accepts (§13-adjacent config). */
export function enabledPaymentMethods(): { razorpay: boolean; cod: boolean } {
  return {
    razorpay: env.PAYMENT_RAZORPAY_ENABLED && paymentProvider() !== null,
    cod: env.PAYMENT_COD_ENABLED,
  };
}

/** Test helper — forces re-selection after env changes. */
export function resetPaymentProvider(): void {
  provider = undefined;
}
