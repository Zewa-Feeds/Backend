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
import { prisma } from '@/lib/prisma';
import { paymentProvider } from '@/integrations/razorpay/payment.service';
import { auditContext } from '@/modules/audit/audit.service';
import * as checkoutService from '@/modules/checkout/checkout.service';
import { paymentQueue } from '@/jobs/queues';

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
        /** Captured amount in paise, as the gateway reports it. */
        amount?: number;
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
        let orderNo = payment?.notes?.orderNo;
        if (!orderNo && payment?.order_id) {
          const matching = await prisma.order.findFirst({
            where: { razorpayOrderId: payment.order_id },
            select: { orderNo: true },
          });
          if (matching) orderNo = matching.orderNo;
        }

        /*
         * The captured amount must match what the order says is owed.
         *
         * The webhook signature proves the message is Razorpay's, not that the
         * right amount was taken. Compared in integer paise against our own
         * record; a mismatch is logged and NOT confirmed, so it surfaces for a
         * human rather than silently marking an order paid for the wrong sum.
         */
        if (orderNo && payment?.amount !== undefined) {
          const ours = await prisma.order.findUnique({
            where: { orderNo },
            select: { totalPaise: true },
          });
          if (ours && Number(payment.amount) !== ours.totalPaise) {
            log.error(
              {
                orderNo,
                paidPaise: Number(payment.amount),
                expectedPaise: ours.totalPaise,
                paymentId: payment.id,
              },
              'webhook payment amount does not match the order total — not confirming',
            );
            res.json({ status: 'ok' });
            return;
          }
        }

        if (orderNo && payment?.id) {
          await checkoutService.confirmPayment(orderNo, payment.id, {
            ...auditContext(req),
            actorId: null,
            actorName: 'Razorpay Webhook',
            actorRole: 'System',
          });
        } else {
          log.warn({ event, paymentId: payment?.id, orderId: payment?.order_id }, 'webhook missing order reference');
        }
      } else if (event === 'payment.failed') {
        /*
         * Release the order's holds NOW rather than at the unpaid TTL.
         *
         * This used to be ignored, on the reasoning that the 30-minute sweep
         * handles abandonment anyway. It does — but half an hour is the wrong
         * answer at this moment. A declined card is a normal event and the
         * customer's normal response is to try again immediately, and until the
         * holds clear the retry is refused: a `perCustomerLimit: 1` coupon is
         * still attached to the order that just failed, so they are told they
         * have "already used" it, naming an order they never paid for and
         * cannot see. Coins are locked the same way.
         *
         * The storefront cannot solve this. It cancels the order on a dismissed
         * or failed modal, but a closed tab, a dead battery or a dropped
         * connection runs no client code at all. The webhook is the only signal
         * that always arrives.
         *
         * SAFETY. This does not cancel anything itself — it brings forward the
         * EXISTING `release-unpaid` job, which re-reads the order, skips
         * anything no longer PENDING+UNPAID, and queries the gateway before
         * cancelling. So a payment that actually succeeded is confirmed rather
         * than cancelled, even when `payment.failed` arrived first for an
         * earlier attempt on the same order.
         *
         * The jobId matches the one checkout scheduled, so this REPLACES the
         * delayed sweep instead of racing a second copy of it.
         */
        let orderNo = payment?.notes?.orderNo;
        if (!orderNo && payment?.order_id) {
          const matching = await prisma.order.findFirst({
            where: { razorpayOrderId: payment.order_id },
            select: { orderNo: true },
          });
          if (matching) orderNo = matching.orderNo;
        }

        if (orderNo) {
          /*
           * Not allowed to fail the webhook. Razorpay retries a non-2xx, and a
           * queue blip must not turn one failed payment into a retry storm —
           * the delayed sweep is still there as the backstop.
           */
          try {
            /*
             * Remove the delayed copy FIRST.
             *
             * Checkout already queued `release-<orderNo>` with the unpaid TTL as
             * its delay. BullMQ treats a duplicate jobId as a no-op rather than
             * a reschedule, so adding the immediate job while that one is still
             * pending would silently change nothing — the bug would look fixed
             * and the customer would still wait out the sweep.
             */
            await paymentQueue.remove(`release-${orderNo}`).catch(() => undefined);
            await paymentQueue.add(
              'release-unpaid',
              { kind: 'release-unpaid', orderNo },
              { jobId: `release-${orderNo}` },
            );
            log.info({ orderNo, paymentId: payment?.id }, 'payment failed — releasing holds now');
          } catch (err) {
            log.error({ err, orderNo }, 'could not bring the release forward; the TTL sweep still applies');
          }
        } else {
          log.warn({ event, paymentId: payment?.id }, 'payment.failed with no order reference');
        }
      } else {
        // Everything else is informational.
        log.debug({ event }, 'webhook event ignored');
      }
    } catch (err) {
      // Signature was valid, so acknowledge and investigate on our side.
      log.error({ err, event, paymentId: payment?.id }, 'webhook processing failed');
    }

    res.json({ received: true });
  }),
);
