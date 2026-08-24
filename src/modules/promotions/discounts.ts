/**
 * Discount arithmetic. Integer paise only — never a float, never rupees.
 *
 * Two invariants hold for every function here, and the tests pin both:
 *
 *   1. A discount never exceeds what it applies to. Stacked promotions price
 *      against a RESIDUAL, so two 60%-off coupons take 60% then 24% of the
 *      original — never 120%. The residual is the cap, which is why nothing
 *      downstream needs a separate "don't go negative" check.
 *   2. The total drawn equals the total intended. Proportional splitting floors,
 *      losing a paisa or two to rounding; a remainder pass places them.
 */
import { DiscountType } from '@prisma/client';
import { formatInr } from '@/modules/orders/tax';
import type { PromotionRow } from './types';

/**
 * What a promotion wants to take off a given base.
 *
 * The cap applies to PERCENTAGE, where an uncapped percentage of a large cart
 * can be unbounded. It is applied to FLAT too — a flat amount is already
 * absolute, so a cap can only ever lower it, and honouring it uniformly means
 * the CMS field never silently does nothing.
 */
export function intendedDiscount(coupon: PromotionRow, basePaise: number): number {
  if (basePaise <= 0) return 0;

  let raw: number;
  switch (coupon.discountType) {
    case DiscountType.PERCENTAGE:
      raw = Math.round((basePaise * coupon.discountValue) / 100);
      break;
    case DiscountType.FLAT:
      raw = coupon.discountValue;
      break;
    // Shipping is waived by a flag, not by a discount off the goods.
    case DiscountType.FREE_SHIPPING:
      return 0;
    // Priced by the bxgy module, which knows about units.
    case DiscountType.BUY_X_GET_Y:
      return 0;
    default:
      return 0;
  }

  if (coupon.maxDiscountPaise !== null && coupon.maxDiscountPaise >= 0) {
    raw = Math.min(raw, coupon.maxDiscountPaise);
  }
  // Never more than the lines are worth.
  return Math.max(0, Math.min(raw, basePaise));
}

/**
 * Take `wantPaise` off the given lines, proportionally, returning what was
 * actually taken.
 *
 * Proportional so a flat ₹100 off a two-line cart reduces both lines rather
 * than gutting the first — which matters because the NEXT promotion in the
 * stack prices against whatever is left.
 *
 * Mutates `remaining` in place: it is the running residual for the whole
 * evaluation, and each promotion draws from what its predecessors left.
 */
export function drawDown(
  remaining: number[],
  idx: readonly number[],
  wantPaise: number,
): number {
  const basePaise = idx.reduce((sum, i) => sum + remaining[i]!, 0);
  if (wantPaise <= 0 || basePaise <= 0) return 0;

  const target = Math.min(wantPaise, basePaise);
  let taken = 0;

  for (const i of idx) {
    const share = Math.floor((target * remaining[i]!) / basePaise);
    const take = Math.min(share, remaining[i]!, target - taken);
    remaining[i] = remaining[i]! - take;
    taken += take;
  }

  // Flooring remainder — spread across whatever lines still have value.
  for (const i of idx) {
    if (taken >= target) break;
    const take = Math.min(remaining[i]!, target - taken);
    remaining[i] = remaining[i]! - take;
    taken += take;
  }

  return taken;
}

/** How this promotion reads on a cart summary. */
export function discountLabel(coupon: PromotionRow): string {
  switch (coupon.discountType) {
    case DiscountType.PERCENTAGE: {
      const cap =
        coupon.maxDiscountPaise !== null
          ? ` (up to ${formatInr(coupon.maxDiscountPaise)})`
          : '';
      return `${coupon.discountValue}% off${cap}`;
    }
    case DiscountType.FLAT:
      return `${formatInr(coupon.discountValue)} off`;
    case DiscountType.FREE_SHIPPING:
      return 'Free shipping';
    case DiscountType.BUY_X_GET_Y: {
      const b = coupon.bxgy;
      if (!b) return 'Buy X get Y';
      return b.rewardPercentOff >= 100
        ? `Buy ${b.buyQty} get ${b.getQty} free`
        : `Buy ${b.buyQty} get ${b.getQty} at ${b.rewardPercentOff}% off`;
    }
    default:
      return 'Discount';
  }
}
