/**
 * Order management — spec §6.
 *
 * The lifecycle is the important part. Every transition runs in ONE transaction
 * that: validates legality against the state machine, checks the fields that step
 * requires, writes the order, restocks if cancelling, records the audit entry, and
 * queues the customer email. If any part fails the whole thing rolls back — so an
 * order can never end up shipped-but-unlogged, or cancelled without its stock
 * returned.
 */
import {
  AuditModule,
  EmailStatus,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  type Prisma,
} from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AppError, ErrorCode, notFound } from '@/lib/errors';
import { type AuditContext, writeAudit } from '@/modules/audit/audit.service';
import { listMeta, toSkipTake } from '@/middleware/validate';
import { formatInr } from './tax';
import { nextInvoiceNo } from './numbering';
import {
  isValidTransition,
  nextStates,
  STATUS_TIMESTAMP,
  TRANSITIONS,
  validateTransitionFields,
} from './lifecycle';
import { ORDER_SELECT, ORDER_STATUS_LABELS, serializeListRow, serializeOrder } from './orders.serializer';
import { logger } from '@/lib/logger';
import { emailQueue } from '@/jobs/queues';
import type { CustomerTemplateName } from '@/integrations/zeptomail/templates';
import { paymentProvider } from '@/integrations/razorpay/payment.service';
import * as couponsService from '@/modules/coupons/coupons.service';

const log = logger.child({ module: 'orders.service' });

export interface ListParams {
  page: number;
  limit: number;
  q?: string;
  status?: OrderStatus;
  paymentStatus?: PaymentStatus;
  from?: Date;
  to?: Date;
}

// ============================================================================
// READS
// ============================================================================

export async function list(params: ListParams) {
  const where: Prisma.OrderWhereInput = {
    ...(params.status ? { status: params.status } : {}),
    ...(params.paymentStatus ? { paymentStatus: params.paymentStatus } : {}),
    ...(params.from || params.to
      ? {
          placedAt: {
            ...(params.from ? { gte: params.from } : {}),
            ...(params.to ? { lte: params.to } : {}),
          },
        }
      : {}),
    ...(params.q
      ? {
          OR: [
            { orderNo: { contains: params.q, mode: 'insensitive' } },
            { email: { contains: params.q, mode: 'insensitive' } },
            { phone: { contains: params.q } },
            { customer: { firstName: { contains: params.q, mode: 'insensitive' } } },
            { customer: { lastName: { contains: params.q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.order.findMany({
      where,
      select: ORDER_SELECT,
      orderBy: { placedAt: 'desc' },
      ...toSkipTake(params),
    }),
    prisma.order.count({ where }),
  ]);

  return { data: rows.map(serializeListRow), meta: listMeta(params.page, params.limit, total) };
}

export async function byOrderNo(orderNo: string) {
  const order = await prisma.order.findUnique({ where: { orderNo }, select: ORDER_SELECT });
  if (!order) throw notFound('Order');
  return serializeOrder(order);
}

/** Raw row for internal use (invoice generation, emails). */
export async function rawByOrderNo(orderNo: string) {
  const order = await prisma.order.findUnique({ where: { orderNo }, select: ORDER_SELECT });
  if (!order) throw notFound('Order');
  return order;
}

// ============================================================================
// LIFECYCLE (§6.3)
// ============================================================================

export interface TransitionInput {
  to: OrderStatus;
  /** Field values the step requires — invoiceNumber, carrier, trackingNumber, … */
  fields: Record<string, unknown>;
  internalNote?: string;
  /** §6.3 "Notify Customer" checkbox. */
  notifyCustomer: boolean;
}

export async function transition(
  orderNo: string,
  input: TransitionInput,
  ctx: AuditContext,
): Promise<ReturnType<typeof serializeOrder>> {
  const order = await prisma.order.findUnique({
    where: { orderNo },
    select: {
      id: true,
      orderNo: true,
      status: true,
      email: true,
      invoiceNumber: true,
      items: { select: { variantId: true, qty: true, sku: true } },
    },
  });
  if (!order) throw notFound('Order');

  // 1. Legality — cannot skip states, cannot leave a terminal one.
  if (!isValidTransition(order.status, input.to)) {
    const allowed = nextStates(order.status);
    throw new AppError(
      409,
      ErrorCode.INVALID_TRANSITION,
      allowed.length === 0
        ? `This order is ${ORDER_STATUS_LABELS[order.status]} and cannot change.`
        : `Cannot move from ${ORDER_STATUS_LABELS[order.status]} to ${ORDER_STATUS_LABELS[input.to]}.`,
      { details: { from: order.status, allowed } },
    );
  }

  // 2. Required fields for this step.
  const fieldErrors = validateTransitionFields(input.to, input.fields);
  if (fieldErrors) {
    throw new AppError(422, ErrorCode.MISSING_TRANSITION_FIELD, 'Some fields are required.', {
      fields: fieldErrors,
    });
  }

  /*
   * 3. §6.5 — an order cannot ship without an invoice number.
   *
   * New orders are issued one automatically at checkout, so this only fires for
   * rows created before auto-numbering existed. Kept as a safety net rather than
   * deleted: shipping an un-invoiced order is a compliance problem, not a UX one.
   */
  if (
    (input.to === OrderStatus.SHIPPED || input.to === OrderStatus.DELIVERED) &&
    !order.invoiceNumber &&
    !input.fields.invoiceNumber
  ) {
    throw new AppError(
      422,
      ErrorCode.INVOICE_REQUIRED,
      'Enter the invoice number before the order can be shipped.',
      { fields: { invoiceNumber: 'Required before dispatch.' } },
    );
  }

  const spec = TRANSITIONS[input.to as Exclude<OrderStatus, 'PENDING'>];
  const timestampField = STATUS_TIMESTAMP[input.to];

  const updated = await prisma.$transaction(async (tx) => {
    // Map the step's fields onto columns. Only keys the spec declares are read,
    // so a client cannot set arbitrary order columns through this endpoint.
    const data: Prisma.OrderUpdateInput = { status: input.to };

    for (const field of spec.fields) {
      const value = input.fields[field.key];
      if (value === undefined || value === null || value === '') continue;

      if (field.key === 'deliveredOn') {
        // Optional override; otherwise the timestamp below defaults to now.
        const parsed = new Date(String(value));
        if (!Number.isNaN(parsed.getTime())) data.deliveredAt = parsed;
        continue;
      }
      (data as Record<string, unknown>)[field.key] = String(value).trim();
    }

    if (timestampField && timestampField !== 'placedAt' && !data[timestampField]) {
      (data as Record<string, unknown>)[timestampField] = new Date();
    }
    if (input.internalNote?.trim()) data.internalNote = input.internalNote.trim();

    /*
     * Issue an invoice number on Accept if the order does not already have one.
     *
     * New orders get theirs at checkout, so this only fires for rows created
     * before auto-numbering existed — they would otherwise be stuck, unable to
     * ship because §6.5 requires an invoice number that nothing now supplies.
     */
    let issuedInvoiceNo: string | null = null;
    if (input.to === OrderStatus.PROCESSING && !order.invoiceNumber) {
      issuedInvoiceNo = await nextInvoiceNo(tx);
      data.invoiceNumber = issuedInvoiceNo;
    }

    await tx.order.update({ where: { id: order.id }, data });

    // 3b. Coupon revenue attribution.
    //
    // A COD order is revenue once ops ACCEPTS it (PROCESSING) — that is the
    // commitment point, since payment lands on delivery. Online orders were
    // already attributed at payment confirmation, and confirmRedemption is
    // idempotent so calling it twice counts once.
    if (input.to === OrderStatus.PROCESSING) {
      await couponsService.confirmRedemption(order.id, tx);
    }
    // Cancelling must undo the attribution, or reported revenue drifts upward.
    if (input.to === OrderStatus.CANCELLED) {
      await couponsService.reverseRedemption(order.id, tx);
    }

    // 4. Cancelling before delivery returns the stock.
    if (spec.restocks) {
      for (const item of order.items) {
        if (!item.variantId) continue;
        await tx.productVariant.update({
          where: { id: item.variantId },
          data: { stock: { increment: item.qty } },
        });
      }
      log.info(
        { orderNo, items: order.items.length },
        'restocked variants after cancellation',
      );
    }

    // 5. Audit — inside the transaction, so a logged change is a real change.
    await writeAudit(
      ctx,
      {
        module: AuditModule.ORDERS,
        action: `Changed order status to ${ORDER_STATUS_LABELS[input.to]}`,
        recordId: orderNo,
      },
      tx,
    );

    // §12.1 calls out the invoice number as its own entry.
    if (issuedInvoiceNo) {
      await writeAudit(
        ctx,
        {
          module: AuditModule.ORDERS,
          action: `Issued invoice number ${issuedInvoiceNo}`,
          recordId: orderNo,
        },
        tx,
      );
    }
    if (input.to === OrderStatus.CANCELLED && input.fields.cancelReason) {
      await writeAudit(
        ctx,
        {
          module: AuditModule.ORDERS,
          action: `Cancelled order — reason: ${String(input.fields.cancelReason)}`,
          recordId: orderNo,
        },
        tx,
      );
    }

    // 6. Queue the customer email (§6.3, §15).
    // The row is created inside the transaction so a committed status change
    // always has its email recorded; the actual send is dispatched after commit.
    let queuedEmailId: string | null = null;
    if (input.notifyCustomer) {
      const row = await tx.orderEmail.create({
        data: {
          orderId: order.id,
          subject: spec.email.subject,
          toEmail: order.email,
          status: EmailStatus.QUEUED,
        },
        select: { id: true },
      });
      queuedEmailId = row.id;

      await writeAudit(
        ctx,
        {
          module: AuditModule.ORDERS,
          action: `Sent "${spec.email.subject}" to ${order.email}`,
          recordId: orderNo,
        },
        tx,
      );
    }

    const row = await tx.order.findUniqueOrThrow({
      where: { id: order.id },
      select: ORDER_SELECT,
    });
    return { row, queuedEmailId };
  });

  // 7. Dispatch the send AFTER commit. Enqueuing inside the transaction could
  // let the worker pick the job up before the status change was visible.
  if (updated.queuedEmailId) {
    await emailQueue
      .add('customer-email', {
        kind: 'customer',
        orderEmailId: updated.queuedEmailId,
        orderNo,
        template: spec.email.template as CustomerTemplateName,
        // §6.5 — the confirmation email carries the invoice PDF.
        attachInvoice: input.to === OrderStatus.PROCESSING,
      })
      .catch((err) => log.error({ err, orderNo }, 'failed to enqueue lifecycle email'));
  }

  return serializeOrder(updated.row);
}

// ============================================================================
// REFUNDS (§6.4) — Admin only, enforced at the route
// ============================================================================

export async function refund(
  orderNo: string,
  amountPaise: number,
  reason: string,
  actorId: string,
  ctx: AuditContext,
): Promise<ReturnType<typeof serializeOrder>> {
  const order = await prisma.order.findUnique({
    where: { orderNo },
    select: {
      id: true,
      orderNo: true,
      email: true,
      totalPaise: true,
      paymentStatus: true,
      paymentMethod: true,
      razorpayPaymentId: true,
      refunds: { select: { amountPaise: true } },
    },
  });
  if (!order) throw notFound('Order');

  // §6.4: only when payment was actually captured.
  if (
    order.paymentStatus !== PaymentStatus.PAID &&
    order.paymentStatus !== PaymentStatus.PARTIALLY_REFUNDED
  ) {
    throw new AppError(
      409,
      ErrorCode.REFUND_NOT_ALLOWED,
      'This order has no captured payment to refund.',
    );
  }

  const alreadyRefunded = order.refunds.reduce((sum, r) => sum + r.amountPaise, 0);
  const remaining = order.totalPaise - alreadyRefunded;

  if (remaining <= 0) {
    throw new AppError(409, ErrorCode.REFUND_NOT_ALLOWED, 'This order is already fully refunded.');
  }
  // Guards against over-refunding across repeated partial refunds.
  if (amountPaise > remaining) {
    throw new AppError(
      422,
      ErrorCode.REFUND_NOT_ALLOWED,
      `The most that can still be refunded is ${formatInr(remaining)}.`,
      { fields: { amount: `Maximum ${formatInr(remaining)}.` } },
    );
  }

  // Call the gateway BEFORE recording, so a failed refund is never logged as
  // successful. The reverse order would leave the books claiming a refund that
  // never happened, which is worse than a retryable error.
  let gatewayRefundId: string | null = null;
  const provider = paymentProvider();

  if (provider && order.razorpayPaymentId && order.paymentMethod === PaymentMethod.RAZORPAY) {
    const result = await provider.refund({
      gatewayPaymentId: order.razorpayPaymentId,
      amountPaise,
      notes: { orderNo, reason: reason.slice(0, 200) },
    });
    gatewayRefundId = result.gatewayRefundId;
  } else if (order.paymentMethod === PaymentMethod.COD) {
    // COD refunds are settled by hand — there is no captured payment to reverse.
    log.info({ orderNo, amountPaise }, 'COD refund recorded — settle manually');
  } else {
    log.warn(
      { orderNo, amountPaise },
      'no payment provider or gateway payment id — refund recorded only',
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    await tx.refund.create({
      data: {
        orderId: order.id,
        amountPaise,
        reason,
        processedById: actorId,
        razorpayRefundId: gatewayRefundId,
      },
    });

    const totalRefunded = alreadyRefunded + amountPaise;
    await tx.order.update({
      where: { id: order.id },
      data: {
        paymentStatus:
          totalRefunded >= order.totalPaise
            ? PaymentStatus.REFUNDED
            : PaymentStatus.PARTIALLY_REFUNDED,
      },
    });

    await writeAudit(
      ctx,
      {
        module: AuditModule.ORDERS,
        action: `Processed refund of ${formatInr(amountPaise)} — reason: ${reason}`,
        recordId: orderNo,
      },
      tx,
    );

    // A fully refunded order is no longer revenue. Partial refunds keep the
    // attribution: the order still happened and most of it stands.
    if (totalRefunded >= order.totalPaise) {
      await couponsService.reverseRedemption(order.id, tx);
    }

    const row = await tx.orderEmail.create({
      data: {
        orderId: order.id,
        subject: 'Your refund has been processed',
        toEmail: order.email,
      },
      select: { id: true },
    });

    return {
      order: await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: ORDER_SELECT }),
      emailId: row.id,
    };
  });

  await emailQueue
    .add('customer-email', {
      kind: 'customer',
      orderEmailId: updated.emailId,
      orderNo,
      template: 'refund-processed' as CustomerTemplateName,
      extra: { refundPaise: amountPaise, refundReason: reason },
    })
    .catch((err) => log.error({ err, orderNo }, 'failed to enqueue refund email'));

  return serializeOrder(updated.order);
}

/** Internal note update — not sent to the customer (§6.3). */
export async function updateNote(
  orderNo: string,
  note: string,
  ctx: AuditContext,
): Promise<ReturnType<typeof serializeOrder>> {
  const order = await prisma.order.findUnique({ where: { orderNo }, select: { id: true } });
  if (!order) throw notFound('Order');

  const updated = await prisma.$transaction(async (tx) => {
    await tx.order.update({ where: { id: order.id }, data: { internalNote: note } });
    await writeAudit(
      ctx,
      { module: AuditModule.ORDERS, action: 'Updated internal note', recordId: orderNo },
      tx,
    );
    return tx.order.findUniqueOrThrow({ where: { id: order.id }, select: ORDER_SELECT });
  });

  return serializeOrder(updated);
}

// ============================================================================
// CSV EXPORT (§6.1) — Admin only
// ============================================================================

/** Escape a CSV cell. Quotes doubled; anything risky quoted. */
function csvCell(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  // A leading =, +, -, @ is interpreted as a formula by Excel — prefix with a
  // quote so an exported field cannot execute in a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export async function exportCsv(params: ListParams): Promise<string> {
  const { data } = await list({ ...params, page: 1, limit: 5000 });

  const headers = [
    'Order Number',
    'Date',
    'Customer',
    'Email',
    'Phone',
    'Items',
    'Total (INR)',
    'Payment',
    'Payment Method',
    'Razorpay Payment ID',
    'Status',
    'Invoice Number',
  ];

  const rows = data.map((o) =>
    [
      o.orderNo,
      o.placedAt.toISOString(),
      o.customerName,
      o.email,
      o.phone,
      o.itemCount,
      o.total.toFixed(2),
      o.paymentLabel,
      o.paymentMethod,
      o.razorpayPaymentId ?? '',
      o.statusLabel,
      o.invoiceNumber ?? '',
    ].map(csvCell),
  );

  return [headers.map(csvCell).join(','), ...rows.map((r) => r.join(','))].join('\r\n');
}
