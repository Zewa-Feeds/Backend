/**
 * Email log read + resend.
 *
 * The two rules that shape this file:
 *
 *   1. **A resend writes a NEW row**, pointing at the one it replaces via
 *      `resentFromId`. The original is never mutated, because the failed attempt
 *      IS the incident record — overwriting it loses the fact that anything went
 *      wrong, which is the history you need when reconstructing an outage.
 *   2. **A security email is never replayed.** OTP, invitation, password-reset and
 *      verification mail carry single-use, time-limited tokens. Re-sending the
 *      stored body delivers a code that is already spent or expired — worse than
 *      sending nothing, because the recipient gets mail that cannot work and reads
 *      it as the system being broken.
 */
import { AuditModule, EmailStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { AppError, ErrorCode, notFound } from '@/lib/errors';
import { writeAudit, type AuditContext } from '@/modules/audit/audit.service';
import { templates } from '@/integrations/zeptomail/templates';
import { logAndSend, isSecurityTemplate } from './email-log.service';

const log = logger.child({ module: 'emails.service' });

type Row = {
  id: string;
  template: string | null;
  subject: string;
  toEmail: string;
  status: EmailStatus;
  error?: string | null;
  providerMessageId?: string | null;
  queuedAt: Date;
  sentAt: Date | null;
  lastAttemptAt?: Date | null;
  resentFromId?: string | null;
  orderId?: string | null;
  customerId?: string | null;
  order?: { orderNo: string } | null;
  customer?: { firstName: string; lastName: string; email?: string } | null;
};

/** Shape the CMS list renders. */
export function serialize(row: Row) {
  return {
    id: row.id,
    template: row.template,
    subject: row.subject,
    toEmail: row.toEmail,
    status: row.status,
    error: row.error ?? null,
    providerMessageId: row.providerMessageId ?? null,
    queuedAt: row.queuedAt,
    sentAt: row.sentAt,
    lastAttemptAt: row.lastAttemptAt ?? null,
    /** True when this row is itself a resend of an earlier one. */
    isResend: Boolean(row.resentFromId),
    resentFromId: row.resentFromId ?? null,
    orderId: row.orderId ?? null,
    orderNo: row.order?.orderNo ?? null,
    customerId: row.customerId ?? null,
    customerName: row.customer
      ? `${row.customer.firstName} ${row.customer.lastName}`.trim()
      : null,
    /*
     * Computed server-side so the CMS cannot disagree with the API about what is
     * resendable, and so the reason is phrased once.
     */
    resendable: !isSecurityTemplate(row.template),
    resendBlockedReason: isSecurityTemplate(row.template)
      ? 'This email contains a single-use code that has expired. Ask the recipient to request a new one.'
      : null,
  };
}

/**
 * Resend one logged email.
 *
 * Order mail is RE-RENDERED from the order's current state rather than replayed
 * from `bodyHtml`, so a resent confirmation reflects the order as it stands — the
 * existing order-email resend already worked this way and it is the right call. A
 * stored body is the fallback for mail whose template is unknown.
 */
export async function resend(id: string, ctx: AuditContext) {
  const row = await prisma.emailLog.findUnique({
    where: { id },
    include: {
      order: { select: { orderNo: true } },
      customer: { select: { firstName: true, lastName: true } },
    },
  });
  if (!row) throw notFound('Email record');

  /*
   * Refused, not silently skipped.
   *
   * The alternative — minting a fresh token from here — would give the CMS a
   * button that issues password-reset links for any account. That is a privilege
   * escalation for a convenience the customer-facing "resend verification" flow
   * already covers properly, and it is rarely needed.
   */
  if (isSecurityTemplate(row.template)) {
    throw new AppError(
      422,
      ErrorCode.VALIDATION_FAILED,
      'This email contains a single-use code and cannot be resent. Ask the recipient to request a new one from the sign-in page.',
    );
  }

  let subject = row.subject;
  let html = row.bodyHtml;

  const templateName = row.template as keyof typeof templates | null;
  if (templateName && templateName in templates && row.orderId) {
    const order = await prisma.order.findUnique({
      where: { id: row.orderId },
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
        placedAt: true,
        invoiceNumber: true,
        carrier: true,
        trackingNumber: true,
        trackingUrl: true,
        cancelReason: true,
        deliveredAt: true,
        customerNote: true,
        internalNote: true,
        razorpayOrderId: true,
        razorpayPaymentId: true,
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

    if (order) {
      const addr = (order.shippingAddress ?? {}) as { name?: string; phone?: string };
      const build = templates[templateName];
      const rendered = build(
        {
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
          paymentMethod: order.paymentMethod,
          paymentStatus: order.paymentStatus,
          placedAt: order.placedAt,
          invoiceNumber: order.invoiceNumber,
          carrier: order.carrier,
          trackingNumber: order.trackingNumber,
          trackingUrl: order.trackingUrl,
          cancelReason: order.cancelReason,
          deliveredAt: order.deliveredAt,
          customerNote: order.customerNote,
          internalNote: order.internalNote,
          razorpayOrderId: order.razorpayOrderId,
          razorpayPaymentId: order.razorpayPaymentId,
        } as never,
        row.toEmail || order.email,
      );
      subject = rendered.subject;
      html = rendered.html;
    }
  }

  if (!html) {
    throw new AppError(
      422,
      ErrorCode.VALIDATION_FAILED,
      'This email has no stored content and its template cannot be re-rendered.',
    );
  }

  /*
   * A NEW row, linked to the original. The original keeps its FAILED status and
   * its error text, so "what happened during the outage" stays answerable after
   * recovery.
   */
  const result = await logAndSend({
    to: [{ email: row.toEmail }],
    subject,
    htmlBody: html,
    reference: row.order?.orderNo ?? row.template ?? 'resend',
    template: row.template,
    orderId: row.orderId,
    customerId: row.customerId,
    resentFromId: row.id,
  });

  await writeAudit(ctx, {
    module: row.orderId ? AuditModule.ORDERS : AuditModule.CUSTOMERS,
    action: `Resent email "${subject}" to ${row.toEmail}`,
    recordId: row.order?.orderNo ?? row.customerId ?? row.id,
  });

  log.info({ from: row.id, to: result.id, sent: result.sent }, 'email resent');
  return { id: result.id, sent: result.sent, resentFromId: row.id };
}
