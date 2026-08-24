/**
 * Which cart lines a promotion qualifies on, and which it comes off.
 *
 * The distinction is the whole point of this file. "Buy product A, get 10% off
 * product B" has two different product sets in it, and conflating them is the
 * classic promotion bug: the customer buys A and gets 10% off A as well.
 *
 *   QUALIFY   must be in the cart for the promotion to fire. Never discounted
 *             on that basis alone.
 *   DISCOUNT  what the money actually comes off. When no DISCOUNT row exists,
 *             the promotion is cart-wide.
 *   EXCLUDE   carved out of the discountable set, whatever else selected it.
 *
 * Each role can be expressed at three levels — variant, family, category — and a
 * line matches a role if ANY level matches. That is what lets one promotion say
 * "all bottom-dweller feeds except the 1kg pack".
 */
import { CouponScope, CouponTargetRole } from '@prisma/client';
import type { PromoLine, PromotionRow } from './types';

/** The three targeting levels for one role, pre-indexed for O(1) matching. */
interface RoleSets {
  families: Set<string>;
  variants: Set<string>;
  categories: Set<string>;
}

function roleSets(coupon: PromotionRow, role: CouponTargetRole): RoleSets {
  return {
    families: new Set(coupon.products.filter((p) => p.role === role).map((p) => p.familyId)),
    variants: new Set(coupon.variants.filter((v) => v.role === role).map((v) => v.variantId)),
    categories: new Set(coupon.categories.filter((c) => c.role === role).map((c) => c.category)),
  };
}

const isEmpty = (s: RoleSets) =>
  s.families.size === 0 && s.variants.size === 0 && s.categories.size === 0;

const matches = (s: RoleSets, line: PromoLine) =>
  s.variants.has(line.variantId) || s.families.has(line.familyId) || s.categories.has(line.category);

export interface Targeting {
  /** Line indexes the discount may come off. */
  discountableIdx: number[];
  /** Line indexes that satisfy the qualifying condition. */
  qualifyingIdx: number[];
  /** Total units across the qualifying lines (or the whole cart when unrestricted). */
  qualifyingQty: number;
  /** False when a QUALIFY condition is declared and the cart does not meet it. */
  qualifies: boolean;
  /** Product names the discount will land on. */
  appliedTo: string[];
}

/**
 * Resolve one promotion against a cart.
 *
 * Backward compatibility note: a legacy coupon has `scope =
 * SPECIFIC_PRODUCTS` and CouponProduct rows that predate roles — the migration
 * defaulted every one of them to DISCOUNT. Such a coupon therefore lands here
 * with a DISCOUNT family set and no QUALIFY rows, and comes out restricted to
 * exactly the lines it always was. No special case is needed for it.
 */
export function resolveTargeting(coupon: PromotionRow, lines: readonly PromoLine[]): Targeting {
  const discount = roleSets(coupon, CouponTargetRole.DISCOUNT);
  const qualify = roleSets(coupon, CouponTargetRole.QUALIFY);
  const exclude = roleSets(coupon, CouponTargetRole.EXCLUDE);

  /*
   * A SPECIFIC_PRODUCTS coupon with no DISCOUNT rows left would silently become
   * cart-wide — the opposite of what it says. Treat it as matching nothing
   * instead, so it is refused rather than over-applied.
   */
  const cartWide = isEmpty(discount);
  const scopeBroken = coupon.scope === CouponScope.SPECIFIC_PRODUCTS && cartWide;

  const discountableIdx: number[] = [];
  const qualifyingIdx: number[] = [];

  lines.forEach((line, i) => {
    if (!isEmpty(qualify) && matches(qualify, line)) qualifyingIdx.push(i);

    if (scopeBroken) return;
    const selected = cartWide || matches(discount, line);
    if (!selected) return;
    if (!isEmpty(exclude) && matches(exclude, line)) return;
    discountableIdx.push(i);
  });

  // With no QUALIFY rows the whole cart is the qualifying set, so a bare
  // minimum-quantity rule counts every unit rather than none.
  const qualifyingLines = isEmpty(qualify)
    ? lines.map((_, i) => i)
    : qualifyingIdx;

  const qualifyingQty = qualifyingLines.reduce((sum, i) => sum + lines[i]!.qty, 0);

  let qualifies = true;
  if (!isEmpty(qualify)) {
    if (coupon.requireAllQualifiers) {
      // "Buy A AND B": every declared target must be represented in the cart.
      // Checked per level so a promotion naming two families needs both, while
      // one naming a category needs only something from it.
      const present = (values: Set<string>, pick: (l: PromoLine) => string) =>
        [...values].every((v) => lines.some((l) => pick(l) === v));
      qualifies =
        present(qualify.variants, (l) => l.variantId) &&
        present(qualify.families, (l) => l.familyId) &&
        present(qualify.categories, (l) => l.category);
    } else {
      qualifies = qualifyingIdx.length > 0;
    }
  }

  return {
    discountableIdx,
    qualifyingIdx,
    qualifyingQty,
    qualifies: qualifies && !scopeBroken,
    // De-duplicated: two packs of one product should read as one name.
    appliedTo: [...new Set(discountableIdx.map((i) => lines[i]!.productName))],
  };
}
