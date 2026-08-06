/**
 * Email worker — drains the email queue via ZeptoMail (§15).
 *
 * Runs in the worker process, not the API, so a slow mail provider cannot delay a
 * request. On success the `OrderEmail` row is flipped to SENT with the provider's
 * message id, which is what the CMS's "Customer Emails" card displays.
 *
 * Failures are RETHROWN so BullMQ retries with backoff. Only after all attempts
 * are exhausted is the row marked FAILED — visible in the CMS rather than silent.
 */
import { EmailStatus, PaymentMethod, Role } from '@prisma/client';
import { Worker, type Job } from 'bullmq';
import { queueRedis } from '@/lib/redis';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { sendEmail } from '@/integrations/zeptomail/zeptomail.client';
import { staffTemplates, templates, type OrderEmailContext } from '@/integrations/zeptomail/templates';
import { generateInvoicePdf } from '@/integrations/pdf/invoice';
import * as settingsService from '@/modules/settings/settings.service';
import { formatAddress } from '@/modules/orders/orders.serializer';
import { QUEUE_NAMES, type EmailJob } from '@/jobs/queues';

const log = logger.child({ module: 'worker.email' });

/** Build the template context from the order's own snapshot data. */
async function orderContext(orderNo: string): Promise<{ ctx: OrderEmailContext; email: string }> {
  const order = await prisma.order.findUniqueOrThrow({
    where: { orderNo },
    select: {
      orderNo: true,
      email: true,
      shippingAddress: true,
      subtotalPaise: true,
      discountPaise: true,
      shippingPaise: true,
      totalPaise: true,
      paymentMethod: true,
      invoiceNumber: true,
      carrier: true,
      trackingNumber: true,
      trackingUrl: true,
      cancelReason: true,
      deliveredAt: true,
      items: { select: { productName: true, pack: true, qty: true, lineTotalPaise: true } },
    },
  });

  const addr = (order.shippingAddress ?? {}) as { name?: string };

  return {
    email: order.email,
    ctx: {
      orderNo: order.orderNo,
      customerName: addr.name ?? 'Customer',
      items: order.items,
      subtotalPaise: order.subtotalPaise,
      discountPaise: order.discountPaise,
      shippingPaise: order.shippingPaise,
      totalPaise: order.totalPaise,
      paymentMethod: order.paymentMethod === PaymentMethod.COD ? 'COD' : 'RAZORPAY',
      addressLine: formatAddress(order.shippingAddress),
      invoiceNumber: order.invoiceNumber,
      carrier: order.carrier,
      trackingNumber: order.trackingNumber,
      trackingUrl: order.trackingUrl,
      cancelReason: order.cancelReason,
      deliveredOn: order.deliveredAt,
    },
  };
}

async function handleCustomerEmail(job: Job<EmailJob>): Promise<void> {
  const data = job.data;
  if (data.kind !== 'customer') return;

  const { ctx, email } = await orderContext(data.orderNo);
  const build = templates[data.template];
  const rendered = build({ ...ctx, ...(data.extra ?? {}) } as never, email);

  // §6.5 — the confirmation carries the tax invoice.
  const attachments: { name: string; content: string; mimeType: string }[] = [];
  if (data.attachInvoice && ctx.invoiceNumber) {
    const order = await prisma.order.findUniqueOrThrow({
      where: { orderNo: data.orderNo },
      select: {
        orderNo: true,
        invoiceNumber: true,
        placedAt: true,
        email: true,
        phone: true,
        shippingAddress: true,
        subtotalPaise: true,
        discountPaise: true,
        shippingPaise: true,
        totalPaise: true,
        couponCode: true,
        items: {
          select: {
            productName: true,
            sku: true,
            pack: true,
            qty: true,
            unitPricePaise: true,
            lineTotalPaise: true,
            hsn: true,
            taxRatePct: true,
          },
        },
      },
    });
    const pdf = await generateInvoicePdf(order, await settingsService.getTaxConfig());
    attachments.push({
      name: `invoice-${ctx.invoiceNumber.replace(/[^\w.-]/g, '-')}.pdf`,
      content: Buffer.from(pdf).toString('base64'),
      mimeType: 'application/pdf',
    });
  }

  const result = await sendEmail({
    to: [{ email, name: ctx.customerName }],
    subject: rendered.subject,
    htmlBody: rendered.html,
    attachments,
    reference: data.orderNo,
  });

  await prisma.orderEmail.update({
    where: { id: data.orderEmailId },
    data: {
      subject: rendered.subject,
      status: result.sent ? EmailStatus.SENT : EmailStatus.QUEUED,
      providerMessageId: result.messageId,
      sentAt: result.sent ? new Date() : null,
      // A skipped send (no credentials) is recorded rather than silently lost.
      error: result.skipped ? 'ZeptoMail not configured — send skipped' : null,
    },
  });
}

/**
 * Staff alerts (§15) go to every Ops Manager and Admin. No per-user toggles —
 * §15 is explicit that preferences were removed in v2.0.
 */
async function handleStaffEmail(job: Job<EmailJob>): Promise<void> {
  const data = job.data;
  if (data.kind !== 'staff') return;

  const recipients = await prisma.cmsUser.findMany({
    where: {
      status: 'ACTIVE',
      deletedAt: null,
      role: { in: [Role.OPS_MANAGER, Role.ADMIN] },
    },
    select: { email: true, name: true },
  });

  if (recipients.length === 0) {
    log.warn({ template: data.template }, 'no active Ops/Admin recipients for staff alert');
    return;
  }

  const build = staffTemplates[data.template];
  const rendered = build(data.context as never);

  await sendEmail({
    to: recipients.map((r) => ({ email: r.email, name: r.name })),
    subject: rendered.subject,
    htmlBody: rendered.html,
    reference: data.template,
  });
}

export function startEmailWorker(): Worker<EmailJob> {
  const worker = new Worker<EmailJob>(
    QUEUE_NAMES.email,
    async (job) => {
      if (job.data.kind === 'customer') return handleCustomerEmail(job);
      return handleStaffEmail(job);
    },
    {
      connection: queueRedis,
      // Mail providers rate-limit; modest concurrency avoids tripping it.
      concurrency: 5,
      limiter: { max: 20, duration: 1000 },
    },
  );

  worker.on('completed', (job) => {
    log.debug({ jobId: job.id, name: job.name }, 'email job completed');
  });

  worker.on('failed', (job, err) => {
    const exhausted = job ? job.attemptsMade >= (job.opts.attempts ?? 1) : false;
    log.error(
      { jobId: job?.id, name: job?.name, attemptsMade: job?.attemptsMade, exhausted, err },
      exhausted ? 'email job failed permanently' : 'email job failed, will retry',
    );

    // Surface a permanent failure in the CMS rather than losing it.
    if (exhausted && job?.data.kind === 'customer') {
      void prisma.orderEmail
        .update({
          where: { id: job.data.orderEmailId },
          data: { status: EmailStatus.FAILED, error: err.message.slice(0, 500) },
        })
        .catch(() => undefined);
    }
  });

  return worker;
}
