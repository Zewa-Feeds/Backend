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
import { endOfDay } from '@/lib/date';
import { type AuditContext, writeAudit } from '@/modules/audit/audit.service';
import { listMeta, toSkipTake } from '@/middleware/validate';
import * as emailsService from '@/modules/emails/emails.service';
import { formatInr } from './tax';
import { nextInvoiceNo } from './numbering';
import {
  isValidTransition,
  customerCancelBlockedReason,
  nextStates,
  STATUS_TIMESTAMP,
  TRANSITIONS,
  validateTransitionFields,
} from './lifecycle';
import {
  ORDER_LIST_SELECT,
  ORDER_SELECT,
  ORDER_STATUS_LABELS,
  formatAddress,
  serializeListRow,
  serializeOrder,
} from './orders.serializer';
import { logger } from '@/lib/logger';
import { emailQueue } from '@/jobs/queues';
import { sendEmail } from '@/integrations/zeptomail/zeptomail.client';
import {
  buildCustomEmail,
  templates,
  type CustomerTemplateName,
  type OrderEmailContext,
} from '@/integrations/zeptomail/templates';
import { formatInvoiceFilename, generateInvoicePdf } from '@/integrations/pdf/invoice';
import * as settingsService from '@/modules/settings/settings.service';
import { paymentProvider } from '@/integrations/razorpay/payment.service';
import * as couponsService from '@/modules/coupons/coupons.service';
import * as loyaltyLifecycle from '@/modules/loyalty/lifecycle.service';
import * as loyaltyNotify from '@/modules/loyalty/notify.service';
import * as loyaltyRedemption from '@/modules/loyalty/redemption.service';

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
            // `to` arrives as a bare date (midnight UTC) from a `YYYY-MM-DD`
            // query param, so treat it as end-of-day or that whole day's
            // orders would be silently excluded.
            ...(params.to ? { lte: endOfDay(params.to) } : {}),
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
      select: ORDER_LIST_SELECT,
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
    /*
     * What the "coins earned" email needs, RETURNED out of the transaction
     * rather than assigned to a `let` declared outside it.
     *
     * Control-flow analysis does not trace into a callback: a `let` declared
     * outside and assigned in here stays narrowed to its initialiser (`null`)
     * at every later use, so spreading it fails to compile even though the
     * value is present at runtime. Returning it is also how `queuedEmailId`
     * already leaves this same transaction.
     */
    let earned: Awaited<ReturnType<typeof loyaltyLifecycle.onDelivered>> = null;
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
     * Issue the invoice number here — on Accept, not at checkout.
     *
     * This is the only place a ZFI number is minted. Checkout deliberately does
     * not, because GST requires the invoice series to be continuous: a number
     * consumed by an order that is never paid for, or is cancelled minutes
     * later, leaves a permanent hole that has to be explained. Accepting the
     * order is the first point at which a sale is real.
     *
     * The `!order.invoiceNumber` guard keeps this idempotent — re-entering
     * PROCESSING must not mint a second number for the same sale.
     */
    let issuedInvoiceNo: string | null = null;
    if (input.to === OrderStatus.PROCESSING && !order.invoiceNumber) {
      issuedInvoiceNo = await nextInvoiceNo(tx);
      data.invoiceNumber = issuedInvoiceNo;
    }

    /*
     * Compare-and-swap on the status column.
     *
     * The legality check above ran against a row read OUTSIDE this
     * transaction, so between that read and this write another actor can move
     * the order on — ops marking it shipped while a customer is cancelling is
     * the realistic case, and both requests validate happily against their own
     * stale snapshot.
     *
     * Matching on the status we validated turns that into a no-op: the second
     * writer updates zero rows and is told to look again, instead of both
     * transitions landing and the later one silently winning.
     *
     * `updateMany` rather than `update` purely because it accepts a non-unique
     * WHERE — the id still makes it a single row.
     */
    const swapped = await tx.order.updateMany({
      where: { id: order.id, status: order.status },
      data: data as Prisma.OrderUpdateManyMutationInput,
    });

    if (swapped.count === 0) {
      const current = await tx.order.findUnique({
        where: { id: order.id },
        select: { status: true },
      });
      throw new AppError(
        409,
        ErrorCode.INVALID_TRANSITION,
        `This order changed to ${ORDER_STATUS_LABELS[current?.status ?? order.status]} a moment ago. Reload and try again.`,
        { details: { from: current?.status ?? order.status, allowed: nextStates(current?.status ?? order.status) } },
      );
    }

    // 3b. Coupon revenue attribution.
    //
    // A COD order is revenue once ops ACCEPTS it (PROCESSING) — that is the
    // commitment point, since payment lands on delivery. Online orders were
    // already attributed at payment confirmation, and confirmRedemption is
    // idempotent so calling it twice counts once.
    if (input.to === OrderStatus.PROCESSING) {
      await couponsService.confirmRedemption(order.id, tx);
    }
    // Cancelling must undo the attribution, or reported revenue drifts upward,
    // AND hand the coupon use back — the order will never complete, so it must
    // not keep consuming a usage slot or the customer's per-customer allowance.
    if (input.to === OrderStatus.CANCELLED) {
      await couponsService.reverseRedemption(order.id, tx);
      await couponsService.releaseRedemption(order.id, tx);
    }

    /*
     * Z-Coin lifecycle hooks (ZSOP004 §3.5, §7.5, §8.2).
     *
     * DELIVERED starts the unlock clock: matures_at = delivered_at + the return
     * window, plus an extra hold above the large-order threshold. Coins are NOT
     * unlocked here — the scheduled job does that when the window actually
     * closes, which is the deferred-unlock fraud control (§12.1).
     *
     * CANCELLED restores any coins spent on the order and voids the pending
     * grant, so a cancelled order can never leave spendable coins behind. It is
     * idempotent on the source event, so a repeated cancellation is a no-op.
     */
    if (input.to === OrderStatus.DELIVERED) {
      const deliveredAt = (data.deliveredAt as Date | undefined) ?? new Date();
      // Returns what the "coins earned" email needs; sent after commit below,
      // because mail cannot be rolled back if this transaction fails.
      earned = await loyaltyLifecycle.onDelivered(tx, order.id, deliveredAt);
    }
    if (input.to === OrderStatus.CANCELLED) {
      await loyaltyRedemption.releaseForOrder(tx, order.id);
      await loyaltyLifecycle.voidPendingForOrder(tx, order.id, 'Order cancelled');
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
    if (input.notifyCustomer && spec.email) {
      const row = await tx.emailLog.create({
        data: {
          orderId: order.id,
          subject: spec.email.subject,
          toEmail: order.email,
          status: EmailStatus.QUEUED,
          template: spec.email.template,
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
    return { row, queuedEmailId, earned };
  });

  /*
   * The ONE Zewa Coins earning email (ZSOP004 §10.4, adjusted per product
   * decision: no separate "coins unlocked" message).
   *
   * After commit, for the same reason as the lifecycle email below — and
   * idempotent on the order, so a repeated delivery webhook sends once.
   * Failures are logged, never surfaced: a mail problem must not fail a
   * delivery that already happened.
   */
  /*
   * Bound to a const before spreading.
   *
   * `earnedNotice` is a `let` assigned inside the transaction callback, and
   * TypeScript will not narrow a closure-captured `let` across the await — so
   * the guard alone leaves it `EarnedNotice | null` at the spread. Copying to a
   * const gives the compiler something it can narrow, without weakening the
   * type or reaching for a cast.
   */
  const notice = updated.earned;
  if (notice) {
    await loyaltyNotify
      .notifyEarned({ ...notice, orderNo })
      .catch((err) => log.error({ err, orderNo }, 'failed to send coins-earned email'));
  }

  // 7. Dispatch the send AFTER commit. Enqueuing inside the transaction could
  // let the worker pick the job up before the status change was visible.
  if (updated.queuedEmailId && spec.email) {
    await emailQueue
      .add('customer-email', {
        kind: 'customer',
        orderEmailId: updated.queuedEmailId,
        orderNo,
        template: spec.email.template as CustomerTemplateName,
        // §6.5 — the dispatch email carries the invoice PDF. It used to ride
        // on the "being packed" notice, which is no longer sent.
        attachInvoice: input.to === OrderStatus.SHIPPED,
      })
      .catch((err) => log.error({ err, orderNo }, 'failed to enqueue lifecycle email'));
  }

  return serializeOrder(updated.row);
}

// ============================================================================
// CUSTOMER SELF-SERVICE CANCELLATION
// ============================================================================

export interface CustomerCancelInput {
  /** Who is asking. Ownership is enforced against this, not against a body field. */
  customer: { id: string; email: string };
  /** Optional free text from the customer. Empty means "no reason given". */
  reason?: string | null;
  ctx: AuditContext;
}

/**
 * Cancel an order on the customer's own request.
 *
 * A THIN POLICY WRAPPER, not a second cancellation implementation. The actual
 * state change goes through `transition()`, so restocking, coupon reversal,
 * the audit entries and the "Your order was cancelled" email are exactly the
 * ones an admin cancellation produces. Anything that gets fixed there is
 * fixed here for free, which is the entire reason this is shaped this way.
 *
 * What this adds on top:
 *
 *   OWNERSHIP — matched on customerId OR email, mirroring `ownedBy` in the
 *   account routes. Guest checkouts have no customerId, so an account that
 *   later registers with the same address still owns its earlier orders. A
 *   non-matching order is reported as not-found rather than forbidden, so
 *   order numbers cannot be probed.
 *
 *   A NARROWER STATUS GATE — see CUSTOMER_CANCELLABLE_STATES. The lifecycle
 *   permits cancelling a SHIPPED order; a customer may not.
 *
 * NO REFUND IS ISSUED HERE, deliberately. Refunds are a separate admin action
 * (`refund()` above) that calls the gateway and requires the orders.refund
 * permission. Cancelling a paid order leaves paymentStatus PAID and the money
 * with us until someone processes it — so the customer is told the refund is
 * being processed, never that it is done.
 */
export async function cancelByCustomer(
  orderNo: string,
  input: CustomerCancelInput,
): Promise<ReturnType<typeof serializeOrder>> {
  const { customer, ctx } = input;

  /*
   * Ownership is part of the WHERE clause, not a check afterwards. An order
   * belonging to someone else is simply not found, which reveals nothing about
   * whether that order number exists.
   */
  const order = await prisma.order.findFirst({
    where: {
      orderNo,
      OR: [{ customerId: customer.id }, { email: customer.email }],
    },
    select: { id: true, orderNo: true, status: true, paymentStatus: true, paymentMethod: true },
  });
  if (!order) throw notFound('Order');

  /*
   * Already cancelled is reported plainly rather than as an error state.
   *
   * A double-click, a retried request, or a second tab all land here, and
   * "your order is cancelled" is a truthful and useful answer to every one of
   * them. Throwing would make a successful outcome look like a failure.
   */
  if (order.status === OrderStatus.CANCELLED) {
    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: ORDER_SELECT,
    });
    return serializeOrder(row);
  }

  const blocked = customerCancelBlockedReason(order.status);
  if (blocked) {
    throw new AppError(409, ErrorCode.INVALID_TRANSITION, blocked, {
      details: { from: order.status },
    });
  }

  /*
   * cancelReason is REQUIRED by the transition spec, and the customer's is
   * optional — so a blank one is recorded as exactly that. The prefix marks
   * the origin in the CMS, where the same column also holds staff reasons and
   * "who cancelled this" is the first thing anyone asks.
   */
  const trimmed = (input.reason ?? '').trim();
  const cancelReason = trimmed
    ? `Cancelled by customer — ${trimmed}`
    : 'Cancelled by customer — no reason given';

  /*
   * `transition()` re-reads the order and performs a compare-and-swap on the
   * status, so an admin shipping this order between our check and this call
   * loses the race safely: it throws 409 rather than cancelling a parcel that
   * is already moving.
   */
  const result = await transition(
    orderNo,
    {
      to: OrderStatus.CANCELLED,
      fields: { cancelReason: cancelReason.slice(0, 500) },
      notifyCustomer: true,
    },
    ctx,
  );

  /*
   * Tell ops, AFTER the transition committed.
   *
   * A customer cancellation arrives unannounced, and a paid one leaves money
   * sitting with us that somebody has to send back by hand — the refund is a
   * separate admin action, so nothing else would raise it. Staff cancellations
   * need no such alert: the person who did it already knows.
   *
   * `jobId` keyed on the order makes this idempotent. A retried request that
   * gets past the already-cancelled short-circuit cannot produce a second
   * alert for the same order.
   *
   * Failure to enqueue is logged, never thrown: the cancellation is committed
   * and the customer's outcome must not depend on an internal alert.
   */
  await emailQueue
    .add(
      'staff-email',
      {
        kind: 'staff',
        template: 'staff-order-cancelled',
        context: {
          orderNo,
          cancelledBy: 'customer',
          cancelledAtDate: new Date(),
          /*
           * Captured money that has not been returned. Read from the payment
           * status BEFORE any refund exists, because cancelling never creates
           * one — this is precisely the flag that tells ops to act.
           */
          refundState:
            order.paymentStatus === PaymentStatus.PAID
              ? 'pending'
              : order.paymentStatus === PaymentStatus.REFUNDED
                ? 'processed'
                : order.paymentStatus === PaymentStatus.PARTIALLY_REFUNDED
                  ? 'partial'
                  : 'none',
        },
      },
      { jobId: `staff-cancelled-${order.id}` },
    )
    .catch((err) => log.error({ err, orderNo }, 'failed to enqueue staff cancellation alert'));

  return result;
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
    const refundRow = await tx.refund.create({
      data: {
        orderId: order.id,
        amountPaise,
        reason,
        processedById: actorId,
        razorpayRefundId: gatewayRefundId,
      },
      select: { id: true, createdAt: true },
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
      await couponsService.releaseRedemption(order.id, tx);
    }

    const row = await tx.emailLog.create({
      data: {
        orderId: order.id,
        subject: 'Your refund has been processed',
        toEmail: order.email,
        template: 'refund-processed',
      },
      select: { id: true },
    });

    return {
      order: await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: ORDER_SELECT }),
      emailId: row.id,
      refundId: refundRow.id,
      refundDate: refundRow.createdAt,
    };
  });

  // 1. Customer refund notification
  await emailQueue
    .add(
      'customer-email',
      {
        kind: 'customer',
        orderEmailId: updated.emailId,
        orderNo,
        template: 'refund-processed' as CustomerTemplateName,
        extra: { refundPaise: amountPaise, refundReason: reason },
      },
      { jobId: `customer-refund-${updated.refundId}` },
    )
    .catch((err) => log.error({ err, orderNo }, 'failed to enqueue customer refund email'));

  // 2. Internal staff refund alert (info@zewafeeds.com)
  await emailQueue
    .add(
      'staff-email',
      {
        kind: 'staff',
        template: 'staff-refund-processed',
        context: {
          orderNo,
          refundId: updated.refundId,
          refundPaise: amountPaise,
          refundReason: reason,
          gatewayRefundId,
          processedByName: ctx.actorName,
          refundDate: updated.refundDate,
        },
      },
      { jobId: `staff-refund-${updated.refundId}` },
    )
    .catch((err) => log.error({ err, orderNo }, 'failed to enqueue staff refund email'));

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

// ============================================================================
// PAYMENT RECONCILIATION
// ============================================================================

export async function reconcilePayment(
  orderNo: string,
  gatewayPaymentIdInput: string | undefined,
  ctx: AuditContext,
): Promise<{
  reconciled: boolean;
  message: string;
  order?: ReturnType<typeof serializeOrder>;
  paymentId?: string;
  amountPaise?: number;
}> {
  const order = await prisma.order.findUnique({
    where: { orderNo },
    select: ORDER_SELECT,
  });
  if (!order) throw notFound('Order');

  const provider = paymentProvider();
  if (!provider) {
    throw new AppError(503, ErrorCode.INTEGRATION_NOT_CONFIGURED, 'Payment gateway not configured.');
  }

  let capturedPaymentId: string | null = gatewayPaymentIdInput || null;
  let capturedAmountPaise: number = order.totalPaise;

  if (!capturedPaymentId && order.razorpayOrderId) {
    const payments = await provider.fetchOrderPayments(order.razorpayOrderId);
    const captured = payments.find((p) => p.status === 'captured' || p.status === 'authorized');
    if (captured) {
      capturedPaymentId = captured.id;
      capturedAmountPaise = captured.amountPaise;
    }
  }

  if (!capturedPaymentId) {
    return {
      reconciled: false,
      message: 'No captured payment was found on the gateway for this order.',
    };
  }

  // If order is already settled and paid with this paymentId
  if (order.paymentStatus === PaymentStatus.PAID && order.razorpayPaymentId === capturedPaymentId) {
    return {
      reconciled: true,
      message: 'Order payment is already recorded and verified.',
      order: serializeOrder(order),
      paymentId: capturedPaymentId,
      amountPaise: capturedAmountPaise,
    };
  }

  // Restore and confirm
  const updated = await prisma.$transaction(async (tx) => {
    // If order was cancelled, re-decrement stock for items
    if (order.status === OrderStatus.CANCELLED) {
      for (const item of order.items) {
        if (item.variantId) {
          await tx.productVariant.updateMany({
            where: { id: item.variantId },
            data: { stock: { decrement: item.qty } },
          });
        }
      }
    }

    const nextStatus = order.status === OrderStatus.CANCELLED ? OrderStatus.PENDING : order.status;

    await tx.order.update({
      where: { id: order.id },
      data: {
        status: nextStatus,
        paymentStatus: PaymentStatus.PAID,
        razorpayPaymentId: capturedPaymentId,
      },
    });

    await writeAudit(
      ctx,
      {
        module: AuditModule.ORDERS,
        action: `Payment reconciled with gateway (${capturedPaymentId}) — Order restored & confirmed`,
        recordId: orderNo,
      },
      tx,
    );

    await couponsService.confirmRedemption(order.id, tx);

    const emailRow = await tx.emailLog.create({
      data: {
        orderId: order.id,
        subject: `We've received your order ${orderNo}`,
        toEmail: order.email,
        status: EmailStatus.QUEUED,
        template: 'order-placed',
      },
      select: { id: true },
    });

    return {
      order: await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: ORDER_SELECT }),
      emailId: emailRow.id,
    };
  });

  await emailQueue
    .add('customer-email', {
      kind: 'customer',
      orderEmailId: updated.emailId,
      orderNo,
      template: 'order-placed',
    })
    .catch((err) => log.error({ err, orderNo }, 'failed to enqueue reconciled customer email'));

  await emailQueue
    .add('staff-email', {
      kind: 'staff',
      template: 'staff-new-order',
      context: { orderNo },
    })
    .catch((err) => log.error({ err, orderNo }, 'failed to enqueue reconciled staff email'));

  log.info({ orderNo, capturedPaymentId }, 'order payment reconciled successfully');

  return {
    reconciled: true,
    message: `Payment ${capturedPaymentId} verified and order successfully confirmed!`,
    order: serializeOrder(updated.order),
    paymentId: capturedPaymentId,
    amountPaise: capturedAmountPaise,
  };
}

/**
 * Builds OrderEmailContext from order details for deterministic rendering and resending.
 */
export function buildOrderEmailContext(order: any): { ctx: OrderEmailContext; email: string } {
  const addr = (order.shippingAddress ?? {}) as { name?: string; phone?: string };
  const customerName =
    addr.name ??
    (order.customer ? `${order.customer.firstName} ${order.customer.lastName}`.trim() : 'Customer');

  return {
    email: order.email,
    ctx: {
      orderNo: order.orderNo,
      customerName,
      customerEmail: order.email,
      customerPhone: order.phone || addr.phone || '',
      items: (order.items || []).map((i: any) => ({
        productName: i.productName,
        sku: i.sku,
        pack: i.pack || '',
        qty: i.qty,
        unitPricePaise: i.unitPricePaise,
        lineTotalPaise: i.lineTotalPaise,
      })),
      subtotalPaise: order.subtotalPaise ?? order.totalPaise,
      discountPaise: order.discountPaise ?? 0,
      shippingPaise: order.shippingPaise ?? 0,
      taxPaise: order.taxPaise ?? 0,
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

/**
 * Resend a previously queued/sent/failed order email (§6.3, §15).
 *
 * Delegates to the shared email service rather than re-implementing the send.
 *
 * It used to do its own: render, send, then UPDATE the same row in place. That
 * left the product with two different resend behaviours — this one overwrote the
 * failed attempt, while the `/emails` page preserves it as a new row — so whether
 * an outage stayed reconstructible depended on which button an operator happened
 * to press. It also never set SKIPPED, leaving an unconfigured provider looking
 * like mail still in flight, and it was gated on `orders.status` (OPS + ADMIN),
 * which quietly bypassed the ADMIN-only `emails.resend`.
 *
 * The shared path fixes all three at once. The return value is unchanged — the
 * CMS order page re-renders from the serialized order.
 */
export async function resendEmail(orderNo: string, emailId: string, ctx: AuditContext) {
  const order = await prisma.order.findUnique({
    where: { orderNo },
    select: { id: true },
  });
  if (!order) throw notFound('Order');

  /*
   * Scoped to THIS order. Without the orderId check, an email id from another
   * order would resend happily via a URL the operator can edit.
   */
  const emailRow = await prisma.emailLog.findFirst({
    where: { id: emailId, orderId: order.id },
    select: { id: true },
  });
  if (!emailRow) throw notFound('Email record');

  await emailsService.resend(emailRow.id, ctx);

  const updatedOrder = await prisma.order.findUniqueOrThrow({
    where: { id: order.id },
    select: ORDER_SELECT,
  });
  return serializeOrder(updatedOrder);
}

export interface SendOrderEmailInput {
  template?: 'order-placed' | 'order-confirmed' | 'order-shipped' | 'order-delivered' | 'order-cancelled' | 'custom';
  subject?: string;
  heading?: string;
  message?: string;
  attachInvoice?: boolean;
  toEmail?: string;
}

/**
 * Send an email directly for an order (either standard template or custom message).
 */
export async function sendOrderEmail(
  orderNo: string,
  input: SendOrderEmailInput,
  ctx: AuditContext,
) {
  const order = await prisma.order.findUnique({
    where: { orderNo },
    select: {
      ...ORDER_SELECT,
      subtotalPaise: true,
      discountPaise: true,
      shippingPaise: true,
      taxPaise: true,
      paymentMethod: true,
    },
  });

  if (!order) throw notFound('Order');

  const { ctx: emailCtx, email } = buildOrderEmailContext(order);
  const recipientEmail = input.toEmail?.trim() || email;

  let renderedSubject = input.subject?.trim() || '';
  let renderedHtml = '';
  const attachments: { name: string; content: string; mimeType: string }[] = [];

  const templateChoice = input.template || (input.message ? 'custom' : 'order-placed');

  if (templateChoice !== 'custom' && templates[templateChoice as CustomerTemplateName]) {
    const build = templates[templateChoice as CustomerTemplateName];
    const res = build(emailCtx as never, recipientEmail);
    renderedSubject = renderedSubject || res.subject;
    renderedHtml = res.html;
  } else {
    renderedSubject = renderedSubject || `Update regarding your order ${orderNo}`;
    const heading = input.heading?.trim() || `Update regarding order ${orderNo}`;
    const res = buildCustomEmail({
      heading,
      message: input.message?.trim() || 'Please review your order update.',
      customerName: emailCtx.customerName,
      subject: renderedSubject,
    });
    renderedHtml = res.html;
  }

  if (input.attachInvoice) {
    try {
      const taxConfig = await settingsService.getTaxConfig();
      const pdf = await generateInvoicePdf(order as any, taxConfig);
      const invoiceNo = order.invoiceNumber || orderNo;
      attachments.push({
        name: formatInvoiceFilename(invoiceNo, emailCtx.customerName),
        content: Buffer.from(pdf).toString('base64'),
        mimeType: 'application/pdf',
      });
    } catch (err) {
      log.warn({ err, orderNo }, 'failed to generate invoice PDF for order email');
    }
  }

  const row = await prisma.emailLog.create({
    data: {
      orderId: order.id,
      template: templateChoice,
      subject: renderedSubject,
      toEmail: recipientEmail,
      status: EmailStatus.QUEUED,
      bodyHtml: renderedHtml,
    },
  });

  try {
    const result = await sendEmail({
      to: [{ email: recipientEmail, name: emailCtx.customerName }],
      subject: renderedSubject,
      htmlBody: renderedHtml,
      attachments,
      reference: orderNo,
    });

    await prisma.emailLog.update({
      where: { id: row.id },
      data: {
        status: result.sent ? EmailStatus.SENT : EmailStatus.QUEUED,
        sentAt: result.sent ? new Date() : null,
        providerMessageId: result.messageId,
        error: result.skipped ? 'ZeptoMail not configured — send skipped' : null,
      },
    });

    await writeAudit(ctx, {
      module: AuditModule.ORDERS,
      action: `Sent email "${renderedSubject}" to ${recipientEmail}`,
      recordId: orderNo,
    });

    const updatedOrder = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: ORDER_SELECT,
    });
    return serializeOrder(updatedOrder);
  } catch (err: any) {
    const errorMsg = (err?.message || 'Failed to send email').slice(0, 500);
    await prisma.emailLog.update({
      where: { id: row.id },
      data: {
        status: EmailStatus.FAILED,
        error: errorMsg,
      },
    });
    throw err;
  }
}

