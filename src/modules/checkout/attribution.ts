/**
 * Affiliate attribution for an order.
 *
 * ── WHY A SNAPSHOT AND NOT A JOIN ───────────────────────────────────────────
 * An influencer's name, code and rate all change over time, and their profile
 * can be deactivated. A commission report for March must still show what March
 * actually was, so the order carries its own copy of every figure. The
 * `influencerId` beside them is for grouping, not for reading the truth back
 * out of the current profile.
 *
 * ── WHY IT IS DERIVED FROM THE PRICED CART ──────────────────────────────────
 * Everything here comes from promotions the ENGINE accepted and priced. The
 * client sends a code, never a discount: the percentage and the paise below are
 * the server's own numbers, so a tampered request cannot inflate a commission
 * or a customer's discount.
 */
import { DiscountType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { AppliedPromotion } from '@/modules/promotions/types';

export interface AffiliateAttribution {
  influencerId: string;
  influencerName: string;
  influencerCouponCode: string;
  influencerDiscountPct: number | null;
  influencerDiscountPaise: number;
  influencerAppliedAt: Date;
}

/**
 * Which of the applied promotions belongs to an affiliate, if any.
 *
 * Only ONE order can be attributed, and the house rule already guarantees that:
 * affiliate codes are NON_STACKABLE, so two can never be accepted together. If
 * that ever changed, the first accepted wins — the engine returns promotions in
 * the order it applied them, so this is the one the customer chose first.
 */
export async function resolveAttribution(
  applied: readonly AppliedPromotion[],
): Promise<AffiliateAttribution | null> {
  if (applied.length === 0) return null;

  const couponIds = applied.map((p) => p.couponId);
  const affiliateCoupons = await prisma.coupon.findMany({
    where: { id: { in: couponIds }, influencerId: { not: null } },
    select: {
      id: true,
      code: true,
      discountType: true,
      discountValue: true,
      influencerId: true,
      influencer: { select: { id: true, name: true } },
    },
  });
  if (affiliateCoupons.length === 0) return null;

  const byId = new Map(affiliateCoupons.map((c) => [c.id, c]));
  const hit = applied.find((p) => byId.has(p.couponId));
  if (!hit) return null;

  const coupon = byId.get(hit.couponId)!;
  if (!coupon.influencer) return null;

  return {
    influencerId: coupon.influencer.id,
    influencerName: coupon.influencer.name,
    influencerCouponCode: coupon.code,
    // Only meaningful for a percentage coupon; a flat affiliate code has none.
    influencerDiscountPct:
      coupon.discountType === DiscountType.PERCENTAGE ? coupon.discountValue : null,
    // The engine's figure, not the client's.
    influencerDiscountPaise: hit.discountPaise,
    influencerAppliedAt: new Date(),
  };
}
