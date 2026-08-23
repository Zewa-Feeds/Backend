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
import { accountTemplates, staffTemplates, templates, type OrderEmailContext } from '@/integrations/zeptomail/templates';
import { generateInvoicePdf } from '@/integrations/pdf/invoice';
import * as settingsService from '@/modules/settings/settings.service';
import { formatAddress } from '@/modules/orders/orders.serializer';
import { QUEUE_NAMES, type EmailJob } from '@/jobs/queues';
import { guardWorker } from '@/jobs/workers/guard';

const log = logger.child({ module: 'worker.email' });

/** Build the template context from the order's own snapshot data. */
async function orderContext(orderNo: string): Promise<{ ctx: OrderEmailContext; email: string }> {
  const order = await prisma.order.findUniqueOrThrow({
    where: { orderNo },
    select: {
      orderNo: true,
      email: true,
      phone: true,
      shippingAddress: true,
      subtotalPaise: true,
      discountPaise: true,
      shippingPaise: true,
      taxPaise: true,
      totalPaise: true,
      paymentMethod: true,
      paymentStatus: true,
      razorpayOrderId: true,
      razorpayPaymentId: true,
      customerNote: true,
      internalNote: true,
      placedAt: true,
      invoiceNumber: true,
      carrier: true,
      trackingNumber: true,
      trackingUrl: true,
      cancelReason: true,
      deliveredAt: true,
      items: {
        select: {
          productName: true,
          sku: true,
          pack: true,
          qty: true,
          unitPricePaise: true,
          lineTotalPaise: true,
        },
      },
    },
  });

  const addr = (order.shippingAddress ?? {}) as { name?: string; phone?: string };

  return {
    email: order.email,
    ctx: {
      orderNo: order.orderNo,
      customerName: addr.name ?? 'Customer',
      customerEmail: order.email,
      customerPhone: order.phone || addr.phone || '',
      items: order.items,
      subtotalPaise: order.subtotalPaise,
      discountPaise: order.discountPaise,
      shippingPaise: order.shippingPaise,
      taxPaise: order.taxPaise,
      totalPaise: order.totalPaise,
      paymentMethod: order.paymentMethod === PaymentMethod.COD ? 'COD' : 'RAZORPAY',
      paymentStatus: order.paymentStatus === 'PAID' ? 'PAID' : 'UNPAID',
      addressLine: formatAddress(order.shippingAddress),
      placedAt: order.placedAt,
      customerNote: order.customerNote,
      internalNote: order.internalNote,
      razorpayOrderId: order.razorpayOrderId,
      razorpayPaymentId: order.razorpayPaymentId,
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
 * Staff alerts (§15).
 *
 * New order alerts are sent directly to info@zewafeeds.com (as well as active
 * Ops Managers and Admins) with full order breakdown, items with SKUs,
 * gateway IDs, and clearly separated customer vs internal notes.
 */
/**
 * info@ first, then every active Ops Manager and Admin.
 *
 * The inbox is the operational address of record, so it leads and is never
 * duplicated when a staff account happens to use it too.
 */
async function opsRecipients(inboxName: string): Promise<{ email: string; name?: string }[]> {
  const recipients: { email: string; name?: string }[] = [
    { email: 'info@zewafeeds.com', name: inboxName },
  ];

  const staffUsers = await prisma.cmsUser.findMany({
    where: { status: 'ACTIVE', deletedAt: null, role: { in: [Role.OPS_MANAGER, Role.ADMIN] } },
    select: { email: true, name: true },
  });

  for (const u of staffUsers) {
    if (u.email.toLowerCase() !== 'info@zewafeeds.com') {
      recipients.push({ email: u.email, name: u.name });
    }
  }

  return recipients;
}

async function handleStaffEmail(job: Job<EmailJob>): Promise<void> {
  const data = job.data;
  if (data.kind !== 'staff') return;

  if (data.template === 'staff-new-order') {
    const orderNo = data.context.orderNo as string;
    const { ctx } = await orderContext(orderNo);
    const build = staffTemplates['staff-new-order'];
    const rendered = build(ctx);

    const recipients: { email: string; name?: string }[] = [
      { email: 'info@zewafeeds.com', name: 'Zewa Feeds Orders' },
    ];

    const staffUsers = await prisma.cmsUser.findMany({
      where: {
        status: 'ACTIVE',
        deletedAt: null,
        role: { in: [Role.OPS_MANAGER, Role.ADMIN] },
      },
      select: { email: true, name: true },
    });

    for (const u of staffUsers) {
      if (u.email.toLowerCase() !== 'info@zewafeeds.com') {
        recipients.push({ email: u.email, name: u.name });
      }
    }

    await sendEmail({
      to: recipients,
      subject: rendered.subject,
      htmlBody: rendered.html,
      reference: `staff-${orderNo}`,
    });
    return;
  }

  if (data.template === 'staff-refund-processed') {
    const orderNo = data.context.orderNo as string;
    const { ctx } = await orderContext(orderNo);
    const build = staffTemplates['staff-refund-processed'];
    const rendered = build({ ...ctx, ...(data.context as any) });

    const recipients: { email: string; name?: string }[] = [
      { email: 'info@zewafeeds.com', name: 'Zewa Feeds Team' },
    ];

    const staffUsers = await prisma.cmsUser.findMany({
      where: {
        status: 'ACTIVE',
        deletedAt: null,
        role: { in: [Role.OPS_MANAGER, Role.ADMIN] },
      },
      select: { email: true, name: true },
    });

    for (const u of staffUsers) {
      if (u.email.toLowerCase() !== 'info@zewafeeds.com') {
        recipients.push({ email: u.email, name: u.name });
      }
    }

    await sendEmail({
      to: recipients,
      subject: rendered.subject,
      htmlBody: rendered.html,
      reference: `staff-refund-${orderNo}-${data.context.refundId ?? '1'}`,
    });
    return;
  }

  if (data.template === 'staff-order-cancelled') {
    const orderNo = data.context.orderNo as string;
    const { ctx } = await orderContext(orderNo);
    const build = staffTemplates['staff-order-cancelled'];
    const rendered = build({ ...ctx, ...(data.context as Record<string, unknown>) } as never);

    await sendEmail({
      to: await opsRecipients('Zewa Feeds Orders'),
      subject: rendered.subject,
      htmlBody: rendered.html,
      reference: `staff-cancelled-${orderNo}`,
    });
    return;
  }

  // Other staff alerts (staff-stock-zero, staff-new-review)
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

async function handleInvitationEmail(job: Job<EmailJob>): Promise<void> {
  const data = job.data;
  if (data.kind !== 'invitation') return;

  const build = accountTemplates['cms-user-invitation'];
  const rendered = build({
    recipientName: data.recipientName,
    recipientEmail: data.recipientEmail,
    roleLabel: data.roleLabel,
    inviteUrl: data.inviteUrl,
    expiresInHours: data.expiresInHours,
  });

  await sendEmail({
    to: [{ email: data.recipientEmail, name: data.recipientName }],
    subject: rendered.subject,
    htmlBody: rendered.html,
    reference: `invite-${data.recipientEmail}`,
  });
}

export function startEmailWorker(): Worker<EmailJob> {
  const worker = new Worker<EmailJob>(
    QUEUE_NAMES.email,
    async (job) => {
      if (job.data.kind === 'customer') return handleCustomerEmail(job);
      if (job.data.kind === 'staff') return handleStaffEmail(job);
      return handleInvitationEmail(job);
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

  // Without this, a Redis outage prints a raw ReplyError several times a second.
  guardWorker(worker, 'email');

  return worker;
}
