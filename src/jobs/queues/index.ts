/**
 * BullMQ queue definitions.
 *
 * Three queues, each for work that must not happen inside a request:
 *
 *   email    ZeptoMail sends. A slow provider must never hold a DB transaction
 *            open or delay an HTTP response.
 *   payment  The 30s auto-confirm (test mode) and the unpaid-order stock sweep.
 *   maintenance  Periodic housekeeping.
 *
 * Producers import from here. The consumer process is src/jobs/worker.ts, run
 * separately (`npm run worker`) so mail throughput cannot starve the API.
 */
import { Queue, type JobsOptions } from 'bullmq';
import { queueRedis } from '@/lib/redis';
import type { CustomerTemplateName, StaffTemplateName } from '@/integrations/zeptomail/templates';

/** BullMQ forbids ':' in queue names — it is the Redis key separator. */
export const QUEUE_NAMES = {
  email: 'zewa-email',
  payment: 'zewa-payment',
  maintenance: 'zewa-maintenance',
} as const;

/**
 * Retry with exponential backoff. Mail and gateway calls fail transiently far
 * more often than permanently, so retrying is usually the right answer.
 *
 * Completed/failed jobs are retained briefly for debugging, then trimmed so Redis
 * does not grow without bound.
 */
const defaultJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
};

// ---- Job payloads ----------------------------------------------------------

export interface CustomerEmailJob {
  kind: 'customer';
  /** OrderEmail row to update on success — the audit of what was actually sent. */
  orderEmailId: string;
  orderNo: string;
  template: CustomerTemplateName;
  /** Attach the invoice PDF (order-confirmed only, §6.5). */
  attachInvoice?: boolean;
  extra?: Record<string, unknown>;
}

export interface StaffEmailJob {
  kind: 'staff';
  template: StaffTemplateName;
  context: Record<string, unknown>;
}

export type EmailJob = CustomerEmailJob | StaffEmailJob;

export interface AutoConfirmJob {
  /**
   * TEMPORARY — development only.
   * TODO: Replace with production Razorpay verification.
   * Simulates the gateway confirming a payment 30s after creation.
   */
  kind: 'auto-confirm';
  orderNo: string;
  gatewayOrderId: string;
}

export interface ReleaseStockJob {
  /** Cancels an unpaid online order and returns its stock. Production behaviour. */
  kind: 'release-unpaid';
  orderNo: string;
}

export type PaymentJob = AutoConfirmJob | ReleaseStockJob;

// ---- Queues ----------------------------------------------------------------

export const emailQueue = new Queue<EmailJob>(QUEUE_NAMES.email, {
  connection: queueRedis,
  defaultJobOptions,
});

export const paymentQueue = new Queue<PaymentJob>(QUEUE_NAMES.payment, {
  connection: queueRedis,
  defaultJobOptions: {
    ...defaultJobOptions,
    // A missed auto-confirm should surface fast rather than retry for minutes.
    attempts: 3,
  },
});

export const maintenanceQueue = new Queue(QUEUE_NAMES.maintenance, {
  connection: queueRedis,
  defaultJobOptions,
});

/** Close producers on shutdown so Redis connections drain cleanly. */
export async function closeQueues(): Promise<void> {
  await Promise.allSettled([emailQueue.close(), paymentQueue.close(), maintenanceQueue.close()]);
}
