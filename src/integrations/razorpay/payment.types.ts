/**
 * Payment provider contract.
 *
 * Everything the checkout and refund flows need from a payment gateway, expressed
 * as an interface. Two implementations satisfy it:
 *
 *   razorpay.provider.ts   real API calls + HMAC signature verification
 *   mock.provider.ts       test-mode stand-in that auto-confirms after 30s
 *
 * The point of the interface is that `payment.service.ts` picks one at startup and
 * nothing downstream knows which is active. Swapping the mock for the real
 * provider is a config change, not a code change — see PAYMENTS.md.
 */

export type PaymentProviderName = 'razorpay' | 'mock';

/** A gateway order, created before the customer pays. */
export interface GatewayOrder {
  /** Provider's order id — stored on Order.razorpayOrderId. */
  gatewayOrderId: string;
  amountPaise: number;
  currency: 'INR';
  /** Public key the browser checkout widget needs. Never the secret. */
  publicKey: string | null;
  /**
   * True when this order will confirm itself without a real payment.
   * The storefront uses it to show a "test mode" notice instead of the widget.
   */
  isSimulated: boolean;
}

/** Result of verifying a payment attempt. */
export interface PaymentVerification {
  verified: boolean;
  gatewayPaymentId: string | null;
  /** Present when verification failed, for logging — never shown to a customer. */
  failureReason?: string;
}

export interface RefundResult {
  gatewayRefundId: string | null;
  /** False when the provider accepted the request but settlement is pending. */
  settled: boolean;
}

/** Payload the browser posts back after the gateway redirects. */
export interface VerificationPayload {
  gatewayOrderId: string;
  gatewayPaymentId: string;
  signature: string;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  /** True when this provider confirms payments without real money moving. */
  readonly isSimulated: boolean;

  createOrder(input: {
    orderNo: string;
    amountPaise: number;
    email: string;
    phone: string;
  }): Promise<GatewayOrder>;

  /**
   * Verify a completed payment.
   *
   * The real provider checks an HMAC over `orderId|paymentId` with the key secret.
   * The mock accepts its own generated ids and rejects anything else, so it cannot
   * be used to confirm an arbitrary order.
   */
  verifyPayment(payload: VerificationPayload): Promise<PaymentVerification>;

  /** Verify a webhook body's signature before trusting it. */
  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean;

  refund(input: {
    gatewayPaymentId: string;
    amountPaise: number;
    notes?: Record<string, string>;
  }): Promise<RefundResult>;

  /** Fetch payment attempts from the gateway for an order. */
  fetchOrderPayments(gatewayOrderId: string): Promise<Array<{
    id: string;
    amountPaise: number;
    status: string;
    method?: string;
  }>>;
}
