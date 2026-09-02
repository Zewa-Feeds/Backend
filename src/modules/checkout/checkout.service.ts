/**
 * Checkout — order creation.
 *
 * The transaction is the whole point of this file. Between reading stock and
 * writing the order, another checkout must not be able to sell the same unit.
 * That is enforced with a conditional UPDATE:
 *
 *     UPDATE "ProductVariant" SET stock = stock - qty
 *      WHERE id = ? AND stock >= qty
 *
 * If two requests race, the second sees `count = 0` and the whole transaction
 * rolls back with OUT_OF_STOCK. No overselling, and no row-level lock held for the
 * duration of a gateway call.
 *
 * Order numbers come from a per-day counter row incremented inside the same
 * transaction — never `COUNT(*)`, which would collide under concurrency.
 */
import {
  AuditModule,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  type Prisma,
} from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AppError, ErrorCode, conflict } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { env } from '@/config/env';
import { writeAudit, type AuditContext } from '@/modules/audit/audit.service';
import * as settingsService from '@/modules/settings/settings.service';
import { paymentProvider, enabledPaymentMethods } from '@/integrations/razorpay/payment.service';
import { MOCK_CONFIRM_DELAY_MS } from '@/integrations/razorpay/mock.provider';
import { nextOrderNo } from '@/modules/orders/numbering';
import { likelyStateForPincode, pincodeMatchesState } from '@/lib/pincode';
import { emailQueue, paymentQueue } from '@/jobs/queues';
import { serializeOrder, ORDER_SELECT } from '@/modules/orders/orders.serializer';
import { assertFulfillable, priceCart, type CartLineInput } from './pricing.service';
import { resolveAttribution } from './attribution';
import * as couponsService from '@/modules/coupons/coupons.service';

const log = logger.child({ module: 'checkout' });

export interface ShippingAddressInput {
  name: string;
  phone: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  pincode: string;
}

export interface CheckoutInput {
  lines: CartLineInput[];
  email: string;
  phone: string;
  shippingAddress: ShippingAddressInput;
  paymentMethod: PaymentMethod;
  couponCode?: string | null;
  /** Several codes, oldest first. Merged with `couponCode` when both are given. */
  couponCodes?: string[] | null;
  customerNote?: string;
  /** Guards against double-submit; a repeat returns the original order. */
  idempotencyKey?: string;
  customerId?: string | null;
  /** Keep this address in the customer's address book for next time. */
  saveAddress?: boolean;
}

export interface CheckoutResult {
  orderNo: string;
  totalPaise: number;
  paymentMethod: PaymentMethod;
  payment: {
    required: boolean;
    gatewayOrderId?: string;
    publicKey?: string | null;
    amountPaise?: number;
    /**
     * TEMPORARY — development only.
     * TODO: Replace with production Razorpay verification.
     * True when the gateway will auto-confirm; the storefront shows a test-mode
     * notice and polls instead of opening the payment widget.
     */
    simulated?: boolean;
    autoConfirmInSeconds?: number;
  };
}


/**
 * Enqueue without letting a queue outage fail the caller.
 *
 * Only for jobs scheduled AFTER the order is committed, where the request has
 * already done the part that matters. Anything the order's correctness depends
 * on must not use this.
 */
async function enqueueQuietly(
  jobName: string,
  orderNo: string,
  add: () => Promise<unknown>,
): Promise<void> {
  try {
    await add();
  } catch (err) {
    log.error(
      { err, jobName, orderNo },
      'could not queue a post-order job — the order stands, but this job will not run',
    );
  }
}

export async function checkout(
  input: CheckoutInput,
  ctx: AuditContext,
): Promise<CheckoutResult> {
  // ---- 0. Idempotency ------------------------------------------------------
  if (input.idempotencyKey) {
    const existing = await prisma.order.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { orderNo: true, totalPaise: true, paymentMethod: true, razorpayOrderId: true },
    });
    if (existing) {
      log.info({ orderNo: existing.orderNo }, 'idempotent replay — returning existing order');
      return {
        orderNo: existing.orderNo,
        totalPaise: existing.totalPaise,
        paymentMethod: existing.paymentMethod,
        payment: {
          required: existing.paymentMethod === PaymentMethod.RAZORPAY,
          gatewayOrderId: existing.razorpayOrderId ?? undefined,
        },
      };
    }
  }

  // ---- 1. Payment method availability -------------------------------------
  const methods = enabledPaymentMethods();
  if (input.paymentMethod === PaymentMethod.RAZORPAY && !methods.razorpay) {
    throw new AppError(
      503,
      ErrorCode.INTEGRATION_NOT_CONFIGURED,
      'Online payment is currently unavailable. Please choose Cash on Delivery.',
    );
  }
  if (input.paymentMethod === PaymentMethod.COD && !methods.cod) {
    throw new AppError(
      503,
      ErrorCode.INTEGRATION_NOT_CONFIGURED,
      'Cash on Delivery is currently unavailable. Please pay online.',
    );
  }

  // ---- 2. Maintenance mode -------------------------------------------------
  const { maintenance, shipping } = await settingsService.getAll();
  if (maintenance.on) {
    throw new AppError(
      503,
      ErrorCode.MAINTENANCE_MODE,
      'We are performing scheduled maintenance. Please try again shortly.',
    );
  }

  // ---- 3. Serviceable PIN code (§13) --------------------------------------
  if (shipping.pinBlacklist.includes(input.shippingAddress.pincode)) {
    throw new AppError(422, ErrorCode.VALIDATION_FAILED, 'We do not currently deliver to that PIN code.', {
      fields: { pincode: 'Not serviceable.' },
    });
  }

  // ---- 3b. PIN code must belong to the selected state ---------------------
  /*
   * Enforced on the SERVER, not only in the form. The customer's state decides
   * the GST split on the invoice (CGST+SGST intra-state vs IGST inter-state), so
   * a mismatch is a tax-correctness problem — and a client-side-only check can be
   * bypassed by posting straight to this endpoint.
   */
  if (!pincodeMatchesState(input.shippingAddress.pincode, input.shippingAddress.state)) {
    const likely = likelyStateForPincode(input.shippingAddress.pincode);
    throw new AppError(
      422,
      ErrorCode.VALIDATION_FAILED,
      likely
        ? `PIN code ${input.shippingAddress.pincode} is in ${likely}, not ${input.shippingAddress.state}.`
        : 'That PIN code does not match the selected state.',
      { fields: { pincode: likely ? `This PIN is in ${likely}.` : 'Does not match the state.' } },
    );
  }

  // ---- 4. Price server-side ------------------------------------------------
  /*
   * A disabled payment method must be rejected HERE, not just hidden in the UI.
   * `enabledPaymentMethods()` gated what the storefront displayed, but nothing
   * validated the incoming request — so a crafted POST could still place a COD
   * order after COD was switched off.
   */
  const enabled = enabledPaymentMethods();
  const allowed =
    (input.paymentMethod === PaymentMethod.COD && enabled.cod) ||
    (input.paymentMethod === PaymentMethod.RAZORPAY && enabled.razorpay);
  if (!allowed) {
    throw new AppError(
      422,
      ErrorCode.VALIDATION_FAILED,
      'That payment method is not available.',
      { fields: { paymentMethod: 'Not available.' } },
    );
  }

  const cart = await priceCart({
    lines: input.lines,
    couponCode: input.couponCode,
    couponCodes: input.couponCodes,
    email: input.email,
    customerId: input.customerId,
    state: input.shippingAddress.state,
  });

  // A coupon that failed validation must not silently drop — the customer expects
  // the discount they were quoted.
  const couponIssue = cart.issues.find((i) => i.sku === '__coupon__');
  const askedForACoupon = Boolean(input.couponCode) || (input.couponCodes?.length ?? 0) > 0;
  if (askedForACoupon && couponIssue) {
    throw new AppError(409, couponIssue.code as never, couponIssue.message);
  }
  assertFulfillable(cart);

  /*
   * Affiliate attribution, resolved BEFORE the transaction opens.
   *
   * It is a read against coupons the engine already accepted, and the checkout
   * transaction holds row locks on stock — keeping an extra round trip out of
   * it matters on a database this far away (see the note on transaction
   * timeouts in lib/prisma.ts).
   */
  const attribution = await resolveAttribution(cart.coupons);

  // ---- 5. The transaction --------------------------------------------------
  const created = await prisma.$transaction(
    async (tx) => {
      // 5a. Conditional stock decrement — the concurrency guard.
      for (const line of cart.lines) {
        const result = await tx.productVariant.updateMany({
          where: { id: line.variantId, stock: { gte: line.qty } },
          data: { stock: { decrement: line.qty } },
        });

        if (result.count === 0) {
          // Lost the race, or stock moved since pricing. Roll everything back.
          throw new AppError(
            409,
            ErrorCode.OUT_OF_STOCK,
            `${line.productName} (${line.pack}) just went out of stock.`,
            { details: { sku: line.sku } },
          );
        }
      }

      const orderNo = await nextOrderNo(tx);
      /*
       * NO invoice number here — it is issued when the order is accepted
       * (the transition to PROCESSING, in orders.service.ts).
       *
       * Issuing it at checkout consumed a number from the ZFI series for every
       * order placed, including ones that were never paid for or were
       * cancelled seconds later. GST requires the invoice series to be
       * continuous, so each abandoned order left a permanent hole in it: of
       * the first thirteen orders, ten burned a number without a sale behind
       * it.
       *
       * The order number (ZFO) is still issued now, because the customer needs
       * something to reference immediately. Gaps there carry no legal weight.
       */

      // Auto-link guest checkouts to a Customer profile so they appear in CMS Customers (§7.1)
      let customerId = input.customerId ?? null;
      if (!customerId) {
        const email = input.email.toLowerCase();
        const existing = await tx.customer.findUnique({
          where: { email },
          select: { id: true },
        });
        if (existing) {
          customerId = existing.id;
        } else {
          const nameParts = (input.shippingAddress.name || '').trim().split(/\s+/);
          const firstName = nameParts[0] || 'Customer';
          const lastName = nameParts.slice(1).join(' ') || '';
          const newCust = await tx.customer.create({
            data: {
              email,
              phone: input.phone,
              firstName,
              lastName,
            },
            select: { id: true },
          });
          customerId = newCust.id;
        }
      }

      /*
       * Save the delivery address to the address book, when asked.
       *
       * Runs for guests too, and that is the point: checkout already links a
       * guest to a Customer row by email above, so the address hangs off that
       * row. When the same person later registers with that email, registration
       * claims the existing row rather than creating a second one — so the
       * address is simply already there, with no migration step and no token to
       * email them.
       *
       * Deduplicated on the fields that make an address distinct. Re-ordering
       * the same address three times should not leave three identical entries.
       */
      if (input.saveAddress && customerId) {
        const a = input.shippingAddress;
        const duplicate = await tx.address.findFirst({
          where: {
            customerId,
            line1: a.line1,
            city: a.city,
            state: a.state,
            pincode: a.pincode,
          },
          select: { id: true },
        });

        if (!duplicate) {
          const existingCount = await tx.address.count({ where: { customerId } });
          await tx.address.create({
            data: {
              customerId,
              name: a.name,
              phone: input.phone,
              line1: a.line1,
              line2: a.line2 ?? null,
              city: a.city,
              state: a.state,
              pincode: a.pincode,
              // The first address saved becomes the default, matching the
              // account address book's own rule.
              isDefault: existingCount === 0,
            },
          });
        }
      }

      // 5b. COD orders are UNPAID and immediately actionable by ops. Online orders
      // stay UNPAID until the gateway confirms.
      const order = await tx.order.create({
        data: {
          orderNo,
          customerId,
          email: input.email.toLowerCase(),
          phone: input.phone,
          status: OrderStatus.PENDING,
          paymentStatus: PaymentStatus.UNPAID,
          paymentMethod: input.paymentMethod,
          subtotalPaise: cart.subtotalPaise,
          discountPaise: cart.discountPaise,
          shippingPaise: cart.shippingPaise,
          taxPaise: cart.taxPaise,
          totalPaise: cart.totalPaise,
          couponCode: cart.coupon?.code ?? null,
          couponCodes: cart.coupons.map((c) => c.code),
          /*
           * Affiliate attribution, written once and never updated. Derived from
           * promotions the engine actually priced, so the percentage and the
           * paise are the server's numbers — a client cannot name an influencer
           * or inflate a commission by editing the request.
           */
          ...(attribution ?? {}),
          shippingAddress: { ...input.shippingAddress } as Prisma.InputJsonValue,
          // The shopper's own words go to customerNote. internalNote is
          // staff-only and starts empty.
          customerNote: input.customerNote?.trim() || null,
          idempotencyKey: input.idempotencyKey ?? null,
          items: {
            // Snapshots — the invoice reads these, never the live catalogue.
            create: cart.lines.map((l) => ({
              variantId: l.variantId,
              productName: l.productName,
              sku: l.sku,
              pack: l.pack,
              unitPricePaise: l.unitPricePaise,
              qty: l.qty,
              hsn: l.hsn,
              taxRatePct: l.taxRatePct,
              lineTotalPaise: l.lineTotalPaise,
            })),
          },
        },
        select: { id: true, orderNo: true, totalPaise: true },
      });

      /*
       * 5c. Reserve every applied promotion.
       *
       * One redemption row per promotion per order — CouponRedemption is keyed
       * @@unique([couponId, orderId]), a pair, so stacking needed no schema
       * change here.
       *
       * The increment is CONDITIONAL, and that is the usage-limit guard. The
       * limit was checked during pricing, outside this transaction, so by now it
       * is a stale read: two checkouts racing for the last use both passed it.
       * Re-checking in the WHERE clause at write time is the same technique the
       * stock decrement above uses. Losing means `count === 0`, and throwing
       * rolls the whole transaction back — no order, and the stock returns.
       */
      for (const promo of cart.coupons) {
        const reserved = await tx.coupon.updateMany({
          where: {
            id: promo.couponId,
            OR: [
              { totalUsageLimit: null },
              // `usedCount < NULL` is NULL in SQL, not true, which is why
              // unlimited coupons need the branch above rather than this one.
              { usedCount: { lt: prisma.coupon.fields.totalUsageLimit } },
            ],
          },
          data: { usedCount: { increment: 1 } },
        });

        if (reserved.count === 0) {
          throw new AppError(
            409,
            ErrorCode.COUPON_LIMIT_REACHED,
            `${promo.code} has reached its usage limit.`,
          );
        }

        await tx.couponRedemption.create({
          data: {
            couponId: promo.couponId,
            orderId: order.id,
            customerId: input.customerId ?? null,
            email: input.email.toLowerCase(),
            /*
             * Snapshot for the per-coupon revenue report. The order's full value
             * is recorded against each promotion that helped win it — a stacked
             * order genuinely is attributable to both — while `discountPaise`
             * stays per-promotion, so what each one COST is never double
             * counted. `confirmedAt` stays null until the order is confirmed.
             */
            cartValuePaise: cart.totalPaise,
            discountPaise: promo.discountPaise,
          },
        });
      }

      // 5d. Audit. Actor is the customer, not staff — this is a public action.
      await writeAudit(
        { ...ctx, actorId: null, actorName: input.email, actorRole: 'Customer' },
        {
          module: AuditModule.ORDERS,
          action: `Order ${order.orderNo} placed via ${input.paymentMethod} — ₹${(cart.totalPaise / 100).toFixed(2)}`,
          recordId: order.orderNo,
        },
        tx,
      );

      return order;
    },
    // Serializable would be stricter, but the conditional UPDATE already prevents
    // overselling, and this avoids retry storms under load.
    // Deliberately tighter than the client-wide default: this transaction holds
    // decremented stock, so a stalled checkout must fail fast and roll back rather
    // than keep inventory reserved. Sized for a remote database — the body issues
    // one write per cart line plus the order and coupon rows.
    { isolationLevel: 'ReadCommitted', maxWait: 10_000, timeout: 20_000 },
  );

  // ---- 6. Post-commit side effects ----------------------------------------
  // Deliberately outside the transaction: a gateway or Redis hiccup must not roll
  // back a committed order with stock already reserved.

  const zeroStock = cart.lines.filter((l) => l.availableStock - l.qty <= 0);
  for (const line of zeroStock) {
    await emailQueue
      .add('staff-stock-zero', {
        kind: 'staff',
        template: 'staff-stock-zero',
        context: { sku: line.sku, productName: line.productName },
      })
      .catch((err) => log.error({ err, sku: line.sku }, 'failed to queue stock alert'));
  }

  // ---- 7. Payment ---------------------------------------------------------
  if (input.paymentMethod === PaymentMethod.COD) {
    // COD is complete on creation. Ops can accept it immediately; payment is
    // collected on delivery, so paymentStatus stays UNPAID until then.
    await queueCustomerEmail(created.id, created.orderNo, 'order-placed');
    await queueStaffNewOrderEmail(created.orderNo);

    log.info({ orderNo: created.orderNo, totalPaise: created.totalPaise }, 'COD order placed');
    return {
      orderNo: created.orderNo,
      totalPaise: created.totalPaise,
      paymentMethod: PaymentMethod.COD,
      payment: { required: false },
    };
  }

  // Online payment — create the gateway order.
  const provider = paymentProvider();
  if (!provider) {
    // Should be unreachable given step 1, but never leave an order stranded.
    throw new AppError(503, ErrorCode.INTEGRATION_NOT_CONFIGURED, 'Online payment is unavailable.');
  }

  const gatewayOrder = await provider.createOrder({
    orderNo: created.orderNo,
    amountPaise: created.totalPaise,
    email: input.email,
    phone: input.phone,
  });

  await prisma.order.update({
    where: { id: created.id },
    data: { razorpayOrderId: gatewayOrder.gatewayOrderId },
  });

  /*
   * Stock-release sweep: an abandoned online order must not hold inventory.
   *
   * Deliberately not allowed to fail the request. The order is ALREADY
   * committed by this point — the transaction closed above — so throwing here
   * returned a 500 to someone whose order genuinely exists, inviting them to
   * retry an order they had already placed.
   *
   * The queue is a safety net, not a precondition. If it is unreachable the
   * cost is an unpaid order sitting on its stock until someone cancels it by
   * hand, which is a far smaller problem than telling a paying customer their
   * checkout failed when it did not. The log line is what makes it findable.
   */
  await enqueueQuietly('release-unpaid', created.orderNo, () =>
    paymentQueue.add(
      'release-unpaid',
      { kind: 'release-unpaid', orderNo: created.orderNo },
      { delay: env.UNPAID_ORDER_TTL_MINUTES * 60_000, jobId: `release-${created.orderNo}` },
    ),
  );

  // ╔════════════════════════════════════════════════════════════════════════╗
  // ║ TEMPORARY — development only.                                          ║
  // ║ TODO: Replace with production Razorpay verification.                   ║
  // ║ Schedules the simulated capture 30s out. In production the provider is ║
  // ║ RazorpayProvider, isSimulated is false, and confirmation arrives via   ║
  // ║ POST /checkout/:orderNo/confirm plus the signed webhook instead.       ║
  // ╚════════════════════════════════════════════════════════════════════════╝
  if (gatewayOrder.isSimulated) {
    await enqueueQuietly('auto-confirm', created.orderNo, () =>
      paymentQueue.add(
        'auto-confirm',
        {
          kind: 'auto-confirm',
          orderNo: created.orderNo,
          gatewayOrderId: gatewayOrder.gatewayOrderId,
        },
        { delay: MOCK_CONFIRM_DELAY_MS, jobId: `autoconfirm-${created.orderNo}` },
      ),
    );
  }

  log.info(
    { orderNo: created.orderNo, gatewayOrderId: gatewayOrder.gatewayOrderId, simulated: gatewayOrder.isSimulated },
    'online order awaiting payment',
  );

  return {
    orderNo: created.orderNo,
    totalPaise: created.totalPaise,
    paymentMethod: PaymentMethod.RAZORPAY,
    payment: {
      required: true,
      gatewayOrderId: gatewayOrder.gatewayOrderId,
      publicKey: gatewayOrder.publicKey,
      amountPaise: gatewayOrder.amountPaise,
      simulated: gatewayOrder.isSimulated,
      ...(gatewayOrder.isSimulated
        ? { autoConfirmInSeconds: MOCK_CONFIRM_DELAY_MS / 1000 }
        : {}),
    },
  };
}

/**
 * Mark an online order paid.
 *
 * Called from three places — the browser callback, the Razorpay webhook, and (in
 * test mode) the auto-confirm job. All three funnel here so the state change,
 * audit entry and email happen exactly once regardless of which arrives first.
 */
export async function confirmPayment(
  orderNo: string,
  gatewayPaymentId: string,
  ctx: AuditContext,
): Promise<ReturnType<typeof serializeOrder>> {
  const order = await prisma.order.findUnique({
    where: { orderNo },
    select: { id: true, orderNo: true, paymentStatus: true, status: true },
  });
  if (!order) throw new AppError(404, ErrorCode.NOT_FOUND, 'Order not found.');

  // Idempotent: whichever signal lands first wins, the rest are no-ops.
  if (order.paymentStatus === PaymentStatus.PAID) {
    log.info({ orderNo }, 'payment already confirmed — ignoring duplicate');
    const current = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: ORDER_SELECT,
    });
    return serializeOrder(current);
  }

  if (order.status === OrderStatus.CANCELLED) {
    // Paid after the release sweep cancelled it. Do not silently resurrect —
    // stock was returned and may have been resold.
    throw conflict(
      'This order was cancelled before payment completed. Please place a new order.',
      ErrorCode.CONFLICT,
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: order.id },
      data: { paymentStatus: PaymentStatus.PAID, razorpayPaymentId: gatewayPaymentId },
    });
    await writeAudit(
      { ...ctx, actorId: null, actorName: 'Payment Gateway', actorRole: 'System' },
      {
        module: AuditModule.ORDERS,
        action: `Payment confirmed (${gatewayPaymentId})`,
        recordId: orderNo,
      },
      tx,
    );

    // Payment captured => this coupon redemption is now real revenue.
    await couponsService.confirmRedemption(order.id, tx);

    return tx.order.findUniqueOrThrow({ where: { id: order.id }, select: ORDER_SELECT });
  });

  // The release sweep is no longer needed.
  await paymentQueue
    .remove(`release-${orderNo}`)
    .catch(() => undefined);

  await queueCustomerEmail(order.id, orderNo, 'order-placed');
  await queueStaffNewOrderEmail(orderNo);

  log.info({ orderNo, gatewayPaymentId }, 'payment confirmed');
  return serializeOrder(updated);
}

/** Create the OrderEmail row and enqueue the send idempotently. */
async function queueCustomerEmail(
  orderId: string,
  orderNo: string,
  template: 'order-placed',
): Promise<void> {
  try {
    const existing = await prisma.orderEmail.findFirst({
      where: {
        orderId,
        subject: { in: [`Order ${orderNo} confirmed`, `We've received your order ${orderNo}`] },
      },
      select: { id: true },
    });
    if (existing) {
      log.info({ orderNo }, 'customer order-placed email already queued/sent — skipping duplicate');
      return;
    }

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { email: true },
    });

    const row = await prisma.orderEmail.create({
      data: {
        orderId,
        subject: `Order ${orderNo} confirmed`,
        toEmail: order.email,
      },
      select: { id: true },
    });

    await emailQueue.add(
      'customer-email',
      {
        kind: 'customer',
        orderEmailId: row.id,
        orderNo,
        template,
      },
      {
        jobId: `customer-order-placed-${orderNo}`,
      },
    );
  } catch (err) {
    // Never fail a paid order because email queueing failed.
    log.error({ err, orderNo }, 'failed to queue customer email');
  }
}

/** Enqueue internal notification for info@zewafeeds.com idempotently. */
async function queueStaffNewOrderEmail(orderNo: string): Promise<void> {
  try {
    await emailQueue.add(
      'staff-new-order',
      {
        kind: 'staff',
        template: 'staff-new-order',
        context: { orderNo },
      },
      {
        jobId: `staff-order-placed-${orderNo}`,
      },
    );
  } catch (err) {
    log.error({ err, orderNo }, 'failed to queue staff new order email');
  }
}
