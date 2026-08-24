/**
 * Is one promotion usable on this cart, ignoring every other promotion?
 *
 * Every check throws an AppError carrying a DISTINCT code, because "expired" and
 * "you have already used this" need different words on screen. That was a
 * deliberate decision in the original coupon service and it is preserved here:
 * a generic "invalid" would be worse UX for no security gain, since the customer
 * already holds the code. Enumeration is controlled by rate limiting instead.
 *
 * Nothing here consults another promotion. Stacking is decided afterwards, on
 * the survivors — which is what stops an expired coupon from occupying the one
 * slot a NON_STACKABLE cart has and knocking out a coupon that would have worked.
 */
import { CustomerEligibility, DiscountType } from '@prisma/client';
import { AppError, ErrorCode } from '@/lib/errors';
import { formatInr } from '@/modules/orders/tax';
import type { PromotionContext, PromotionRow } from './types';
import type { Targeting } from './targeting';

export type CouponStatus = 'Active' | 'Inactive' | 'Expired';

/** Derived status (§10.2) — never stored, so it can never contradict the dates. */
export function promotionStatus(coupon: {
  isActive: boolean;
  startsAt: Date;
  endsAt: Date;
}): CouponStatus {
  const now = new Date();
  if (coupon.endsAt < now) return 'Expired';
  if (!coupon.isActive || coupon.startsAt > now) return 'Inactive';
  return 'Active';
}

/** Case- and punctuation-insensitive state match, so "Tamil Nadu" == "tamilnadu". */
const normaliseState = (s: string) => s.trim().toLowerCase().replace(/[^a-z]/g, '');

export interface EligibilityInput {
  coupon: PromotionRow;
  ctx: PromotionContext;
  targeting: Targeting;
  /** Qualifying orders this customer has already placed. */
  priorOrders: number;
  /** Unreleased redemptions this customer already holds for this coupon. */
  priorRedemptions: number;
  /** False when the caller has no email, so per-customer rules cannot be judged. */
  identified: boolean;
}

/** Throws the first failing rule, or returns for an eligible promotion. */
export function assertEligible(input: EligibilityInput): void {
  const { coupon, ctx, targeting, priorOrders, priorRedemptions, identified } = input;

  const status = promotionStatus(coupon);
  if (status === 'Expired') {
    throw new AppError(409, ErrorCode.COUPON_EXPIRED, `${coupon.code} has expired.`);
  }
  if (status === 'Inactive') {
    throw new AppError(
      409,
      ErrorCode.COUPON_INACTIVE,
      coupon.startsAt > new Date()
        ? `${coupon.code} is not active yet.`
        : `${coupon.code} is not currently active.`,
    );
  }

  /*
   * Minimum order is assessed on the PRE-discount subtotal.
   *
   * Otherwise stacked coupons would each drag the cart under the next one's
   * minimum, and the order the customer happened to type them in would decide
   * who qualifies.
   */
  if (ctx.subtotalPaise < coupon.minOrderPaise) {
    throw new AppError(
      409,
      ErrorCode.COUPON_MIN_ORDER,
      `Spend ${formatInr(coupon.minOrderPaise)} or more to use ${coupon.code}.`,
      { details: { minOrderPaise: coupon.minOrderPaise } },
    );
  }

  if (coupon.minQty !== null && targeting.qualifyingQty < coupon.minQty) {
    throw new AppError(
      409,
      ErrorCode.COUPON_MIN_QTY,
      `Add ${coupon.minQty} or more qualifying items to use ${coupon.code}.`,
      { details: { minQty: coupon.minQty } },
    );
  }
  if (coupon.maxQty !== null && targeting.qualifyingQty > coupon.maxQty) {
    throw new AppError(
      409,
      ErrorCode.COUPON_MAX_QTY,
      `${coupon.code} applies to orders of ${coupon.maxQty} items or fewer.`,
    );
  }

  if (!targeting.qualifies) {
    throw new AppError(
      409,
      ErrorCode.COUPON_PRODUCT_REQUIRED,
      `${coupon.code} only applies when specific products are in your cart.`,
    );
  }

  /*
   * A discount with nothing to come off is not eligible. Without this a
   * product-specific coupon would "apply" for ₹0 and look broken rather than
   * refused. FREE_SHIPPING is exempt — it takes nothing off the goods by design.
   */
  if (
    coupon.discountType !== DiscountType.FREE_SHIPPING &&
    targeting.discountableIdx.length === 0
  ) {
    throw new AppError(
      409,
      ErrorCode.COUPON_PRODUCT_REQUIRED,
      `${coupon.code} does not apply to anything in your cart.`,
    );
  }

  // Location restriction. Unknown state passes: the cart is priced before an
  // address exists, and checkout re-evaluates once one does.
  if (coupon.allowedStates.length > 0 && ctx.state) {
    const wanted = coupon.allowedStates.map(normaliseState);
    if (!wanted.includes(normaliseState(ctx.state))) {
      throw new AppError(
        409,
        ErrorCode.COUPON_STATE_RESTRICTED,
        `${coupon.code} is not available for delivery to ${ctx.state}.`,
      );
    }
  }

  // ---- Customer eligibility ------------------------------------------------
  switch (coupon.customerEligibility) {
    case CustomerEligibility.FIRST_ORDER:
      if (identified && priorOrders > 0) {
        throw new AppError(
          409,
          ErrorCode.COUPON_NOT_ELIGIBLE,
          `${coupon.code} is valid only on your first order.`,
        );
      }
      break;

    case CustomerEligibility.FIRST_N_ORDERS: {
      const n = coupon.firstNOrders ?? 1;
      if (identified && priorOrders >= n) {
        throw new AppError(
          409,
          ErrorCode.COUPON_NOT_ELIGIBLE,
          `${coupon.code} is valid only for your first ${n} orders.`,
        );
      }
      break;
    }

    case CustomerEligibility.EXISTING_CUSTOMER:
      if (!identified || priorOrders === 0) {
        throw new AppError(
          409,
          ErrorCode.COUPON_NOT_ELIGIBLE,
          `${coupon.code} is for returning customers.`,
        );
      }
      break;

    case CustomerEligibility.SPECIFIC_CUSTOMERS: {
      const allowed = new Set(coupon.customers.map((c) => c.email.toLowerCase()));
      if (!identified || !ctx.email || !allowed.has(ctx.email.toLowerCase())) {
        throw new AppError(
          409,
          ErrorCode.COUPON_NOT_ELIGIBLE,
          `${coupon.code} is not available for your account.`,
        );
      }
      break;
    }

    case CustomerEligibility.ALL_CUSTOMERS:
    default:
      break;
  }

  // ---- Usage limits --------------------------------------------------------
  // A stale read by design: the authoritative check is the conditional UPDATE in
  // the checkout transaction. This one exists so a customer is told before they
  // reach payment, not after.
  if (coupon.totalUsageLimit !== null && coupon.usedCount >= coupon.totalUsageLimit) {
    throw new AppError(
      409,
      ErrorCode.COUPON_LIMIT_REACHED,
      `${coupon.code} has reached its usage limit.`,
    );
  }

  if (identified && priorRedemptions >= coupon.perCustomerLimit) {
    throw new AppError(
      409,
      ErrorCode.COUPON_ALREADY_USED,
      coupon.perCustomerLimit === 1
        ? `You have already used ${coupon.code}.`
        : `You have already used ${coupon.code} ${coupon.perCustomerLimit} times.`,
    );
  }
}
