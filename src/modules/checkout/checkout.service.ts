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
import { transition } from '@/modules/orders/orders.service';
import { assertFulfillable, priceCart, type CartLineInput } from './pricing.service';
import { resolveAttribution } from './attribution';
import * as couponsService from '@/modules/coupons/coupons.service';
import * as loyaltyEarn from '@/modules/loyalty/earn.service';
import * as loyaltyFraud from '@/modules/loyalty/fraud.service';
import * as loyaltyRedemption from '@/modules/loyalty/redemption.service';

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
  /** The cart's Zewa Coins hold, if any (ZSOP004 §4.3). */
  coinCartKey?: string;
}

export interface CheckoutResult {
  orderNo: string;
  totalPaise: number;
  paymentMethod: PaymentMethod;
  payment: {
    required: boolean;
    /**
     * Money has actually been taken for this order.
     *
     * Distinct from `!required`, which only means no online payment is owed
     * RIGHT NOW — true for a COD order too. The storefront may show its
     * success screen only on this flag, so "nothing to pay online" can never
     * be mistaken for "paid".
     */
    paymentSettled?: boolean;
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
  /*
   * An existing order for this key is a RETRY, not necessarily a replay.
   *
   * The browser holds one key for the life of a checkout session, so a second
   * Pay Online lands here whether the customer changed nothing (dismissed the
   * modal and tried again) or edited their cart in between. Those need
   * different answers, and only the server can tell them apart — so the
   * decision waits until the cart has been priced, below. Anything settled or
   * already moved on is answered immediately, since no repricing can change it.
   */
  const existing = input.idempotencyKey
    ? await prisma.order.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: {
          id: true,
          orderNo: true,
          totalPaise: true,
          paymentMethod: true,
          razorpayOrderId: true,
          paymentStatus: true,
          status: true,
        },
      })
    : null;

  if (existing) {
    /*
     * CANCELLED is not a replay — it is a dead order.
     *
     * Returning it with `required: false` told the storefront "no payment
     * needed", which it reads as a completed checkout. An order that was
     * cancelled by the unpaid sweep is neither paid nor payable, and
     * presenting it as done confirms an order nobody paid for. Its stock has
     * already been returned, so there is nothing to resurrect: refuse, and let
     * the customer start a fresh checkout.
     */
    if (existing.status === OrderStatus.CANCELLED) {
      log.warn(
        { orderNo: existing.orderNo },
        'checkout replayed against a cancelled order — refusing',
      );
      throw conflict(
        'That order was cancelled because payment was not completed. Please place a new order.',
        ErrorCode.CONFLICT,
      );
    }

    /*
     * Genuinely settled: paid, or moved on to fulfilment, or COD (which is
     * payable on delivery, never online). Nothing repricing could say would
     * change any of them.
     *
     * `paymentSettled` is what the storefront keys its success screen on. It
     * is true ONLY for money actually taken — never merely because no online
     * payment is required — so a COD order cannot be mistaken for a paid one.
     */
    const settled =
      existing.paymentStatus === PaymentStatus.PAID ||
      existing.status !== OrderStatus.PENDING ||
      existing.paymentMethod === PaymentMethod.COD;

    if (settled) {
      log.info({ orderNo: existing.orderNo }, 'idempotent replay — order already settled');
      return {
        orderNo: existing.orderNo,
        totalPaise: existing.totalPaise,
        paymentMethod: existing.paymentMethod,
        payment: {
          required: false,
          paymentSettled: existing.paymentStatus === PaymentStatus.PAID,
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

  /*
   * Per-account COD restriction (ZSOP004 §12.1).
   *
   * "Rolling RTO counter. Earning disabled after 3 in 90 days; account moves to
   * prepaid-only." Disabling earning is applied when the RTO is recorded; this
   * is the prepaid-only half, and it belongs here because it must hold whether
   * or not the order involves coins.
   *
   * The message deliberately says nothing about coins: the restriction is about
   * refused deliveries, each of which costs real shipping money, and blaming a
   * loyalty account would be both confusing and inaccurate.
   */
  const codBlocked = await loyaltyFraud.codBlockedReason(input.customerId, input.paymentMethod);
  if (codBlocked) {
    throw new AppError(403, ErrorCode.FORBIDDEN, codBlocked);
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
    /*
     * A retry must not be refused its own coupon.
     *
     * The PENDING order from the dismissed attempt already holds a redemption
     * for every code on it. Counting those would make the second Pay Online
     * fail with "You have already used X" — the customer blocked by their own
     * abandoned attempt. Excluding that one order is exactly the same
     * allowance a cancellation gives back.
     */
    ignoreRedemptionsForOrderId: existing?.id ?? null,
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
   * ---- 4b. Retry: is the existing order still the right one? ---------------
   *
   * The cart has now been priced by the server, so the stored total can be
   * compared against what this checkout would actually cost. The comparison is
   * deliberately on the AUTHORITATIVE total rather than a fingerprint the
   * browser sends: the client never gets to assert that its cart is unchanged.
   *
   * `totalPaise` is the settlement figure — it already folds in line items,
   * quantities, coupons, shipping (which moves with state and weight) and coin
   * redemption. Any change a customer can make that alters what they owe moves
   * this number, and a change that does not alter it does not need a new
   * gateway order.
   *
   * SAME TOTAL → reuse. A dismissal leaves the Razorpay order payable, so the
   * customer reopens the one they already had. No second application order, no
   * second gateway order, no double charge.
   *
   * DIFFERENT TOTAL → the old order must not be paid. It is cancelled, which
   * returns its reserved stock (the CANCELLED transition restocks), and this
   * request falls through to create a fresh order priced at the current total.
   * Leaving it PENDING would strand that stock until the unpaid sweep, and
   * leave a payable gateway order for an amount the customer no longer owes.
   */
  if (existing) {
    const provider = paymentProvider();
    const unchanged = existing.totalPaise === cart.totalPaise;

    if (unchanged && existing.razorpayOrderId) {
      log.info(
        { orderNo: existing.orderNo, totalPaise: existing.totalPaise },
        'retry with an unchanged total — reusing the existing gateway order',
      );
      return {
        orderNo: existing.orderNo,
        totalPaise: existing.totalPaise,
        paymentMethod: existing.paymentMethod,
        payment: {
          required: true,
          gatewayOrderId: existing.razorpayOrderId,
          // The order's own stored total, never recomputed here.
          amountPaise: existing.totalPaise,
          ...(provider?.publicKey ? { publicKey: provider.publicKey } : {}),
          ...(provider?.isSimulated
            ? { simulated: true, autoConfirmInSeconds: MOCK_CONFIRM_DELAY_MS / 1000 }
            : { simulated: false }),
        },
      };
    }

    log.info(
      {
        orderNo: existing.orderNo,
        wasPaise: existing.totalPaise,
        nowPaise: cart.totalPaise,
      },
      'checkout changed since the last attempt — superseding the stale order',
    );

    /*
     * Cancelling must not fail the checkout. If it does the customer still gets
     * a correct new order; the stale one is left to the unpaid sweep, which
     * checks the gateway before cancelling anything and so cannot cancel an
     * order that was paid in the meantime.
     */
    try {
      await transition(
        existing.orderNo,
        {
          to: OrderStatus.CANCELLED,
          fields: { cancelReason: 'Superseded — the cart changed before payment was completed.' },
          notifyCustomer: false,
        },
        ctx,
      );
    } catch (err) {
      log.error(
        { err, orderNo: existing.orderNo },
        'could not cancel the superseded order — leaving it to the unpaid sweep',
      );
    }

    /*
     * The key is unique per order, so it has to be freed before the new order
     * can claim it. The cancelled order keeps its own identity and audit trail;
     * it simply stops answering for this checkout session.
     */
    await prisma.order
      .update({ where: { id: existing.id }, data: { idempotencyKey: null } })
      .catch((err) => {
        log.error({ err, orderNo: existing.orderNo }, 'could not release the idempotency key');
      });
  }

  /*
   * Affiliate attribution, resolved BEFORE the transaction opens.
   *
   * It is a read against coupons the engine already accepted, and the checkout
   * transaction holds row locks on stock — keeping an extra round trip out of
   * it matters on a database this far away (see the note on transaction
   * timeouts in lib/prisma.ts).
   */
  const attribution = await resolveAttribution(cart.coupons);

  /*
   * Loyalty snapshots, also resolved before the transaction (ZSOP004 §7.4).
   *
   * Two things a later return cannot re-derive and therefore must be frozen now:
   *
   *   1. How the coupon discount was split across lines. `cart.discountPaise` is
   *      an order-level total, but a partial return has to unwind ONE line, and
   *      the promotions that produced the total may not even exist by then.
   *
   *   2. Which SKUs were earn-eligible and coin-redeemable at purchase time. A
   *      clearance flag flipped next month must not rewrite what this order
   *      earned.
   *
   * Allocation is pro rata by line value in integer paise, with the rounding
   * remainder given to the highest-value line so the parts sum to the whole
   * exactly — an allocation that does not sum makes a later return restore the
   * wrong amount.
   */
  const couponAllocation: number[] = (() => {
    const out = cart.lines.map(() => 0);
    const total = cart.lines.reduce((sum, l) => sum + l.lineTotalPaise, 0);
    if (cart.discountPaise <= 0 || total <= 0) return out;

    let assigned = 0;
    for (let i = 0; i < cart.lines.length; i++) {
      const share = Math.floor((cart.discountPaise * cart.lines[i]!.lineTotalPaise) / total);
      out[i] = share;
      assigned += share;
    }
    const remainder = cart.discountPaise - assigned;
    if (remainder > 0) {
      let biggest = 0;
      for (let i = 1; i < cart.lines.length; i++) {
        if (cart.lines[i]!.lineTotalPaise > cart.lines[biggest]!.lineTotalPaise) biggest = i;
      }
      out[biggest] = (out[biggest] ?? 0) + remainder;
    }
    return out;
  })();

  /*
   * Resolve the customer's coin hold (ZSOP004 §4.1 step 5, §4.3).
   *
   * The AMOUNT comes from the server-side reservation, never from the request:
   * the client supplies only the cart key it applied under. A reservation that
   * has expired, been released, or belongs to someone else simply yields zero
   * coins and the order prices at full value — failing CLOSED, which is the safe
   * direction for redemption (§8.1 #11).
   *
   * Read before the transaction opens, like the affiliate attribution above, to
   * keep an extra round trip out of a transaction holding stock locks.
   */
  let coinHold: { id: string; coins: number } | null = null;
  // `input.customerId` is the SIGNED-IN customer. A guest cannot hold coins, so
  // this is also the gate that stops an anonymous checkout claiming a hold.
  if (input.coinCartKey && input.customerId) {
    const account = await prisma.loyaltyAccount.findUnique({
      where: { customerId: input.customerId },
      select: { id: true },
    });
    if (account) {
      const reservation = await prisma.coinReservation.findFirst({
        where: {
          accountId: account.id,
          cartKey: input.coinCartKey,
          status: 'PENDING',
          expiresAt: { gt: new Date() },
        },
        select: { id: true, coins: true },
      });
      if (reservation) coinHold = reservation;
    }
  }
  const coinDiscountPaise = coinHold?.coins ? coinHold.coins * 100 : 0;

  const loyaltyVariants = await prisma.productVariant.findMany({
    where: { id: { in: cart.lines.map((l) => l.variantId) } },
    select: { id: true, earnEligible: true, coinRedeemable: true },
  });
  const loyaltyById = new Map(loyaltyVariants.map((v) => [v.id, v]));
  const loyaltyFlags = cart.lines.map((l) => loyaltyById.get(l.variantId));

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
          /*
           * Coins are a DISCOUNT on the invoice, not a payment method (§11.2).
           *
           * "Do not treat coin redemption as a payment method settling a
           * full-value invoice. That charges GST on value the customer never
           * paid." At Zewa's 0% GST the tax consequence is nil, but the
           * accounting shape still matters: the discount reduces the taxable
           * value, which is what makes a later credit note correct.
           */
          discountPaise: cart.discountPaise + coinDiscountPaise,
          shippingPaise: cart.shippingPaise,
          taxPaise: cart.taxPaise,
          // Coins never pay for shipping or fees — those stay payable in cash
          // (§4). `cart.totalPaise` already includes shipping, so subtracting
          // here reduces only the product portion the coins were capped against.
          totalPaise: Math.max(0, cart.totalPaise - coinDiscountPaise),
          couponCode: cart.coupon?.code ?? null,
          couponCodes: cart.coupons.map((c) => c.code),
          appliedCoupons: cart.coupons.map((c) => ({
            code: c.code,
            name: c.name,
            scope: c.freeShipping
              ? 'shipping'
              : c.appliedTo?.length
                ? 'item'
                : 'cart',
            discountType: c.discountType,
            amountPaise: c.freeShipping
              ? (cart.calculatedShippingPaise || 6000)
              : c.discountPaise,
          })) as Prisma.InputJsonValue,
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
            //
            // The loyalty allocation fields are written here, at creation, and
            // never recomputed (ZSOP004 §7.4): a return happens weeks later, by
            // which time catalogue prices and promotions have moved, and
            // unwinding against today's numbers would refund money nobody paid.
            create: cart.lines.map((l, i) => ({
              variantId: l.variantId,
              productName: l.productName,
              sku: l.sku,
              pack: l.pack,
              unitPricePaise: l.unitPricePaise,
              qty: l.qty,
              hsn: l.hsn,
              taxRatePct: l.taxRatePct,
              lineTotalPaise: l.lineTotalPaise,
              allocatedCouponDiscountPaise: couponAllocation[i] ?? 0,
              earnEligible: loyaltyFlags[i]?.earnEligible ?? true,
              coinRedeemable: loyaltyFlags[i]?.coinRedeemable ?? true,
              // Net paid starts as the line minus its coupon share; the earning
              // engine rewrites it once the coin discount is known.
              preTaxNetPaidPaise: Math.max(0, l.lineTotalPaise - (couponAllocation[i] ?? 0)),
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
      /*
       * Bind the coin hold to this order (ZSOP004 §4.3).
       *
       * Inside the transaction, so an order can never exist without its hold
       * attached. `CoinReservation.orderId` is UNIQUE, which is what stops one
       * hold backing two orders — a second checkout racing on the same cart key
       * violates the index and rolls back rather than double-spending.
       *
       * The coins are not consumed yet: that happens at payment confirmation
       * (prepaid) or immediately for COD, both via `confirmForOrder`.
       */
      if (coinHold) {
        await tx.coinReservation.update({
          where: { id: coinHold.id },
          data: { orderId: order.id },
        });
      }

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
    //
    // Z-Coin §8.1 #5: "Coins redeemed at placement; the amount collected at the
    // door is already net of the discount." So a COD order confirms its
    // redemption and earns now, at placement, rather than waiting for a payment
    // event that will never arrive. `earnForOrderSafe` fails open (§8.1 #11) —
    // a loyalty outage must never cost the customer their order.
    await prisma
      .$transaction((tx) => loyaltyRedemption.confirmForOrder(tx, created.id))
      .catch((err) => log.error({ err, orderNo: created.orderNo }, 'COD coin redemption failed'));
    await loyaltyEarn.earnForOrderSafe(created.id);

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

    /*
     * Z-Coin (ZSOP004 §5, §8.1 #4).
     *
     * Redemption is confirmed and coins are earned inside the SAME transaction
     * that marks the order paid, so the three facts commit together or not at
     * all. Both calls are idempotent on the order id, which is what makes a
     * duplicate payment webhook — §8.1 #4, and Razorpay retries on any timeout —
     * a no-op rather than a second grant.
     *
     * Earning is deliberately inside the transaction here, not fire-and-forget:
     * the order is already known-good at this point, so the fail-open path
     * (which exists for checkout-time failures) is not needed.
     */
    await loyaltyRedemption.confirmForOrder(tx, order.id);
    await loyaltyEarn.earnForOrder(tx, order.id);

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

/** Create the EmailLog row and enqueue the send idempotently. */
async function queueCustomerEmail(
  orderId: string,
  orderNo: string,
  template: 'order-placed',
): Promise<void> {
  try {
    const existing = await prisma.emailLog.findFirst({
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

    const row = await prisma.emailLog.create({
      data: {
        orderId,
        subject: `Order ${orderNo} confirmed`,
        toEmail: order.email,
        template,
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
