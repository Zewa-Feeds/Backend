/**
 * Razorpay webhook — /api/v1/webhooks/razorpay
 *
 * PRODUCTION CODE. This is the authoritative payment signal: browsers close
 * mid-redirect, users lose connectivity, and the confirm callback is best-effort.
 * The webhook is what guarantees a captured payment eventually marks the order paid.
 *
 * Security:
 *   - the body arrives RAW (express.raw() in app.ts) because the HMAC is computed
 *     over exact bytes; re-serialising a parsed object breaks it
 *   - an unsigned or mis-signed request is rejected before anything is read
 *   - no auth and no CORS, because Razorpay is not a browser
 *
 * Always answers 200 once the signature is valid, even if our own processing
 * fails — otherwise Razorpay retries for days over a bug on our side. Failures are
 * logged loudly instead.
 */
import { Router, type Request } from 'express';
import { asyncHandler } from '@/middleware/asyncHandler';
import { logger } from '@/lib/logger';
import { paymentProvider } from '@/integrations/razorpay/payment.service';
import { auditContext } from '@/modules/audit/audit.service';
import * as checkoutService from '@/modules/checkout/checkout.service';

const log = logger.child({ module: 'webhook.razorpay' });

export const webhookRouter = Router();

interface RazorpayWebhookBody {
  event?: string;
  payload?: {
    payment?: {
      entity?: {
        id?: string;
        order_id?: string;
        status?: string;
        notes?: { orderNo?: string };
      };
    };
  };
}

webhookRouter.post(
  '/razorpay',
  asyncHandler(async (req: Request, res) => {
    const signature = req.get('x-razorpay-signature');
    const raw = req.body as Buffer;

    if (!signature || !Buffer.isBuffer(raw)) {
      log.warn('webhook rejected: missing signature or non-raw body');
      res.status(400).json({ error: { code: 'INVALID_WEBHOOK', message: 'Bad request.' } });
      return;
    }

    const provider = paymentProvider();
    if (!provider || !provider.verifyWebhookSignature(raw, signature)) {
      // 401 rather than 200: an unverifiable request is not ours to acknowledge.
      log.warn('webhook rejected: signature verification failed');
      res.status(401).json({ error: { code: 'INVALID_SIGNATURE', message: 'Unauthorized.' } });
      return;
    }

    let body: RazorpayWebhookBody;
    try {
      body = JSON.parse(raw.toString('utf8')) as RazorpayWebhookBody;
    } catch {
      log.error('webhook body was signed but is not valid JSON');
      res.status(400).json({ error: { code: 'INVALID_WEBHOOK', message: 'Bad request.' } });
      return;
    }

    const event = body.event ?? 'unknown';
    const payment = body.payload?.payment?.entity;

    log.info({ event, paymentId: payment?.id, orderId: payment?.order_id }, 'webhook received');

    try {
      if (event === 'payment.captured' || event === 'order.paid') {
        // `notes.orderNo` is set when the gateway order is created, so our order
        // number travels with the payment.
        const orderNo = payment?.notes?.orderNo;
        if (orderNo && payment?.id) {
          await checkoutService.confirmPayment(orderNo, payment.id, {
            ...auditContext(req),
            actorId: null,
            actorName: 'Razorpay Webhook',
            actorRole: 'System',
          });
        } else {
          log.warn({ event, paymentId: payment?.id }, 'webhook missing orderNo in notes');
        }
      } else {
        // payment.failed and others need no action — the release sweep handles
        // abandonment, and a failed payment leaves the order UNPAID as intended.
        log.debug({ event }, 'webhook event ignored');
      }
    } catch (err) {
      // Signature was valid, so acknowledge and investigate on our side.
      log.error({ err, event, paymentId: payment?.id }, 'webhook processing failed');
    }

    res.json({ received: true });
  }),
);
