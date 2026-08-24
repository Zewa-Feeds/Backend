/**
 * The promotion engine — the one authority on what a cart is discounted by.
 *
 * `POST /cart/validate`, `POST /coupons/validate` and `POST /checkout` all land
 * here, so the quote a customer is shown and the order they are charged for
 * cannot disagree about which promotions applied or what they were worth.
 *
 * Four passes, in this order, and the order is the design:
 *
 *   1. LOAD    every candidate in two queries — the codes the customer typed,
 *              plus every live automatic promotion.
 *   2. JUDGE   each promotion on its own merits: dates, targeting, minimums,
 *              customer history, limits. Failures are recorded, not thrown, so
 *              one bad code cannot void the rest of the cart's discounts.
 *   3. STACK   ask the stacking rule which survivors may coexist. Customer-typed
 *              codes are offered in the order they applied them; automatic ones
 *              compete for what is left, in deterministic ranked order.
 *   4. PRICE   compute discounts sequentially against a per-line residual, so
 *              the combined discount can never exceed the cart's worth.
 *
 * Nothing here trusts the caller about anything monetary. The context is built
 * from server-priced lines; the request contributes only SKUs, quantities and
 * the codes to try.
 */
import { CouponTrigger, DiscountType, type Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AppError } from '@/lib/errors';
import { assertEligible } from './eligibility';
import { resolveTargeting } from './targeting';
import { discountLabel, drawDown, intendedDiscount } from './discounts';
import { priceBxgy } from './bxgy';
import { resolveAll } from './stacking';
import { qualifyingOrderCount } from './orderHistory';
import {
  PROMOTION_SELECT,
  type AppliedPromotion,
  type Candidate,
  type PromotionContext,
  type PromotionOutcome,
  type PromotionRejection,
  type PromotionRow,
} from './types';

/** Cap on how many codes one request may try, before any database work. */
const MAX_CODES_PER_REQUEST = 10;

/**
 * Evaluate every promotion that could apply to this cart.
 *
 * `includeAutomatic` is false for the standalone coupon-check endpoint, which is
 * answering "is this code any good?" rather than pricing a cart.
 */
export async function evaluate(
  ctx: PromotionContext,
  opts: { includeAutomatic?: boolean; overlayPromotions?: PromotionRow[] } = {},
): Promise<PromotionOutcome> {
  const includeAutomatic = opts.includeAutomatic ?? true;
  const overlayPromotions = opts.overlayPromotions ?? [];

  const wanted: string[] = [];
  for (const raw of ctx.requestedCodes.slice(0, MAX_CODES_PER_REQUEST)) {
    const code = raw.toUpperCase().trim();
    if (code) wanted.push(code);
  }

  const empty: PromotionOutcome = {
    applied: [],
    rejected: [],
    totalDiscountPaise: 0,
    freeShipping: false,
  };
  if (wanted.length === 0 && !includeAutomatic && overlayPromotions.length === 0) return empty;
  if (ctx.lines.length === 0) return empty;

  // ---- 1. Load -------------------------------------------------------------
  const overlayCodes = new Set(overlayPromotions.map((o) => o.code));
  const distinct = [...new Set(wanted)].filter((code) => !overlayCodes.has(code));
  const where: Prisma.CouponWhereInput[] = [];
  if (distinct.length > 0) where.push({ code: { in: distinct } });
  if (includeAutomatic) {
    where.push({ trigger: CouponTrigger.AUTOMATIC, isActive: true });
  }

  const rows = where.length > 0
    ? await prisma.coupon.findMany({
        where: { deletedAt: null, OR: where },
        select: PROMOTION_SELECT,
      })
    : [];

  if (rows.length === 0 && wanted.length === 0 && overlayPromotions.length === 0) return empty;

  const byCode = new Map(rows.map((r) => [r.code, r]));
  for (const overlay of overlayPromotions) {
    byCode.set(overlay.code, overlay);
  }
  const identified = Boolean(ctx.email);

  /*
   * Two batched lookups for the whole evaluation, never one per promotion.
   * At ~950ms to a remote database, a per-coupon query inside the loop would
   * dominate checkout latency.
   */
  const [priorOrders, redemptionRows] = await Promise.all([
    identified ? qualifyingOrderCount(ctx.email, ctx.customerId) : Promise.resolve(0),
    identified && rows.length > 0
      ? prisma.couponRedemption.findMany({
          where: {
            couponId: { in: rows.map((r) => r.id) },
            email: ctx.email!.toLowerCase(),
            // A released redemption — cancelled or fully refunded order — must
            // stop counting against the customer's allowance.
            releasedAt: null,
          },
          select: { couponId: true },
        })
      : Promise.resolve([] as { couponId: string }[]),
  ]);

  const redemptionsByCoupon = new Map<string, number>();
  for (const r of redemptionRows) {
    redemptionsByCoupon.set(r.couponId, (redemptionsByCoupon.get(r.couponId) ?? 0) + 1);
  }

  // ---- 2. Judge ------------------------------------------------------------
  const rejected: PromotionRejection[] = [];

  const judge = (coupon: PromotionRow, automatic: boolean): Candidate | null => {
    const targeting = resolveTargeting(coupon, ctx.lines);
    try {
      assertEligible({
        coupon,
        ctx,
        targeting,
        priorOrders,
        priorRedemptions: redemptionsByCoupon.get(coupon.id) ?? 0,
        identified,
      });
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      // Automatic promotions fail silently — the customer never asked for one,
      // so telling them it was refused would be noise they cannot act on.
      if (!automatic) {
        rejected.push({
          code: coupon.code,
          errorCode: err.code,
          message: err.message,
          conflictsWith: [],
        });
      }
      return null;
    }

    // A BXGY offer the cart cannot actually earn is not eligible.
    if (coupon.discountType === DiscountType.BUY_X_GET_Y) {
      const preview = priceBxgy(coupon, ctx.lines, targeting);
      if (preview.rewardedUnits === 0) {
        if (!automatic) {
          rejected.push({
            code: coupon.code,
            errorCode: 'COUPON_MIN_QTY',
            message: `Add more qualifying items to earn ${coupon.code}.`,
            conflictsWith: [],
          });
        }
        return null;
      }
    }

    return {
      coupon,
      code: coupon.code,
      stackingMode: coupon.stackingMode,
      priority: coupon.priority,
      automatic,
      discountableIdx: targeting.discountableIdx,
      appliedTo: targeting.appliedTo,
    };
  };

  const requestedCandidates: Candidate[] = [];
  for (const code of wanted) {
    const coupon = byCode.get(code);
    if (!coupon) {
      rejected.push({
        code,
        errorCode: 'COUPON_NOT_FOUND',
        message: `${code} is not a recognised coupon code.`,
        conflictsWith: [],
      });
      continue;
    }
    /*
     * An AUTOMATIC promotion is not a code to be typed. Refusing it by name
     * stops a customer discovering an automatic promotion's code and applying it
     * twice — once implicitly, once explicitly.
     */
    if (coupon.trigger === CouponTrigger.AUTOMATIC) {
      rejected.push({
        code,
        errorCode: 'COUPON_NOT_FOUND',
        message: `${code} is not a recognised coupon code.`,
        conflictsWith: [],
      });
      continue;
    }
    const candidate = judge(coupon, false);
    if (candidate) requestedCandidates.push(candidate);
  }

  const requestedCodes = new Set(wanted);
  const automaticCandidates: Candidate[] = [];
  if (includeAutomatic) {
    const allAuto = [
      ...rows.filter((r) => r.trigger === CouponTrigger.AUTOMATIC),
      ...overlayPromotions.filter((r) => r.trigger === CouponTrigger.AUTOMATIC),
    ];
    for (const coupon of allAuto) {
      if (requestedCodes.has(coupon.code)) continue;
      const candidate = judge(coupon, true);
      if (candidate) automaticCandidates.push(candidate);
    }
  }

  // ---- 3. Stack ------------------------------------------------------------
  const { accepted, rejected: stackRejections } = resolveAll(
    requestedCandidates,
    automaticCandidates,
  );
  rejected.push(...stackRejections);

  // ---- 4. Price ------------------------------------------------------------
  // Each promotion discounts what is LEFT of its lines, so the residual is the
  // cap and no combination can exceed the cart's worth.
  const remaining = ctx.lines.map((l) => l.lineTotalPaise);
  const applied: AppliedPromotion[] = [];
  let totalDiscountPaise = 0;
  let freeShipping = false;

  for (const candidate of accepted) {
    const { coupon } = candidate;
    let takenPaise = 0;
    let isFreeShipping = false;

    if (coupon.discountType === DiscountType.FREE_SHIPPING) {
      isFreeShipping = true;
      freeShipping = true;
    } else if (coupon.discountType === DiscountType.BUY_X_GET_Y) {
      const targeting = resolveTargeting(coupon, ctx.lines);
      const result = priceBxgy(coupon, ctx.lines, targeting);
      takenPaise = drawDown(remaining, result.rewardedIdx, result.discountPaise);
    } else {
      const basePaise = candidate.discountableIdx.reduce((sum, i) => sum + remaining[i]!, 0);
      takenPaise = drawDown(
        remaining,
        candidate.discountableIdx,
        intendedDiscount(coupon, basePaise),
      );
    }

    totalDiscountPaise += takenPaise;
    applied.push({
      couponId: coupon.id,
      code: coupon.code,
      name: coupon.name,
      discountType: coupon.discountType,
      discountPaise: takenPaise,
      discountLabel: discountLabel(coupon),
      stackingMode: coupon.stackingMode,
      trigger: coupon.trigger,
      automatic: candidate.automatic,
      appliedTo: candidate.appliedTo,
      freeShipping: isFreeShipping,
    });
  }

  return { applied, rejected, totalDiscountPaise, freeShipping };
}
