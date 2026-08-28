/**
 * Payment worker — two jobs.
 *
 * `release-unpaid` is PRODUCTION behaviour: an online order that is never paid must
 * return its stock, or abandoned carts slowly consume the whole catalogue.
 *
 * `auto-confirm` is the TEMPORARY test-mode capture. It is the only mock in the
 * system and it calls the same `confirmPayment()` the real webhook will call — so
 * removing it changes nothing downstream.
 */
import { OrderStatus, PaymentStatus } from '@prisma/client';
import { Worker, type Job } from 'bullmq';
import { queueRedis } from '@/lib/redis';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { paymentProvider } from '@/integrations/razorpay/payment.service';
import { MockPaymentProvider } from '@/integrations/razorpay/mock.provider';
import { confirmPayment } from '@/modules/checkout/checkout.service';
import { transition } from '@/modules/orders/orders.service';
import { QUEUE_NAMES, type PaymentJob } from '@/jobs/queues';
import { guardWorker } from '@/jobs/workers/guard';

const log = logger.child({ module: 'worker.payment' });

/** System actor for machine-initiated audit entries. */
const systemCtx = {
  actorId: null,
  actorName: 'System',
  actorRole: 'System',
  ip: '127.0.0.1',
  userAgent: 'zewa-worker',
};

/**
 * ╔════════════════════════════════════════════════════════════════════════╗
 * ║ TEMPORARY — development only.                                          ║
 * ║ TODO: Replace with production Razorpay verification.                   ║
 * ║                                                                        ║
 * ║ Stands in for the gateway's success callback. Note it still goes        ║
 * ║ through provider.verifyPayment() with a server-side signature, so the  ║
 * ║ trust boundary has the same shape as production. Deleting this handler ║
 * ║ and the enqueue in checkout.service.ts is the whole removal.           ║
 * ╚════════════════════════════════════════════════════════════════════════╝
 */
async function handleAutoConfirm(job: Job<PaymentJob>): Promise<void> {
  const data = job.data;
  if (data.kind !== 'auto-confirm') return;

  const provider = paymentProvider();
  if (!(provider instanceof MockPaymentProvider)) {
    // Config changed to the real provider while a job was queued — correct to skip.
    log.warn({ orderNo: data.orderNo }, 'auto-confirm skipped: live provider is active');
    return;
  }

  const order = await prisma.order.findUnique({
    where: { orderNo: data.orderNo },
    select: { paymentStatus: true, status: true },
  });
  if (!order) {
    log.warn({ orderNo: data.orderNo }, 'auto-confirm skipped: order not found');
    return;
  }
  if (order.paymentStatus === PaymentStatus.PAID || order.status === OrderStatus.CANCELLED) {
    log.info({ orderNo: data.orderNo, status: order.status }, 'auto-confirm skipped: already settled');
    return;
  }

  const paymentId = provider.paymentIdFor(data.gatewayOrderId);
  const verification = await provider.verifyPayment({
    gatewayOrderId: data.gatewayOrderId,
    gatewayPaymentId: paymentId,
    signature: provider.paymentSignatureFor(data.gatewayOrderId),
  });

  if (!verification.verified) {
    log.error(
      { orderNo: data.orderNo, reason: verification.failureReason },
      'auto-confirm verification failed',
    );
    return;
  }

  await confirmPayment(data.orderNo, paymentId, systemCtx);
  log.info({ orderNo: data.orderNo, paymentId }, 'TEST MODE: payment auto-confirmed');
}

/**
 * Release stock from an unpaid online order — production behaviour.
 *
 * Reuses the order lifecycle's CANCELLED transition rather than writing stock
 * directly, so restocking, the audit entry and the customer email all follow the
 * same path a staff cancellation would.
 */
async function handleReleaseUnpaid(job: Job<PaymentJob>): Promise<void> {
  const data = job.data;
  if (data.kind !== 'release-unpaid') return;

  const order = await prisma.order.findUnique({
    where: { orderNo: data.orderNo },
    select: { paymentStatus: true, status: true, paymentMethod: true, razorpayOrderId: true },
  });
  if (!order) return;

  // Paid in the meantime, or already moved on — nothing to release.
  if (order.paymentStatus !== PaymentStatus.UNPAID || order.status !== OrderStatus.PENDING) {
    log.debug({ orderNo: data.orderNo }, 'release skipped: order no longer pending+unpaid');
    return;
  }
  // COD orders are legitimately unpaid until delivery — never sweep them.
  if (order.paymentMethod === 'COD') return;

  // CRITICAL SAFETY CHECK: Query gateway before cancelling. If customer paid on Razorpay, confirm the order instead.
  const provider = paymentProvider();
  if (provider && order.razorpayOrderId) {
    try {
      const payments = await provider.fetchOrderPayments(order.razorpayOrderId);
      const captured = payments.find((p) => p.status === 'captured' || p.status === 'authorized');
      if (captured) {
        log.info(
          { orderNo: data.orderNo, paymentId: captured.id },
          'found captured gateway payment during release sweep — confirming order instead of cancelling',
        );
        await confirmPayment(data.orderNo, captured.id, systemCtx);
        return;
      }
    } catch (err) {
      log.error({ err, orderNo: data.orderNo }, 'failed to query gateway during release sweep');
    }
  }

  await transition(
    data.orderNo,
    {
      to: OrderStatus.CANCELLED,
      fields: { cancelReason: 'Payment was not completed in time. Stock released automatically.' },
      notifyCustomer: true,
    },
    systemCtx,
  );

  log.info({ orderNo: data.orderNo }, 'unpaid order cancelled, stock released');
}

export function startPaymentWorker(): Worker<PaymentJob> {
  const worker = new Worker<PaymentJob>(
    QUEUE_NAMES.payment,
    async (job) => {
      if (job.data.kind === 'auto-confirm') return handleAutoConfirm(job);
      return handleReleaseUnpaid(job);
    },
    { connection: queueRedis, concurrency: 5 },
  );

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, name: job?.name, err }, 'payment job failed');
  });

  // Without this, a Redis outage prints a raw ReplyError several times a second.
  guardWorker(worker, 'payment');

  return worker;
}
