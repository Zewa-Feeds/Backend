/**
 * Shared shapes for the promotion engine.
 *
 * Kept in one place because five modules pass these between them, and because
 * the boundary they describe matters: everything the engine decides is computed
 * from a `PromotionContext` the SERVER built. Nothing in here can carry a price,
 * a discount or an eligibility claim that came from a browser.
 */
import type {
  Category,
  CouponStacking,
  CouponTrigger,
  CustomerEligibility,
  DiscountType,
  Prisma,
} from '@prisma/client';

/** One priced cart line, as the promotion rules see it. */
export interface PromoLine {
  variantId: string;
  familyId: string;
  category: Category;
  sku: string;
  productName: string;
  qty: number;
  unitPricePaise: number;
  lineTotalPaise: number;
}

/**
 * Everything an evaluation depends on.
 *
 * `state` is the delivery state, for location-restricted promotions; `email` and
 * `customerId` together identify the shopper for order-history and per-customer
 * rules. All three are optional because the cart is priced long before checkout
 * knows any of them.
 */
export interface PromotionContext {
  lines: PromoLine[];
  subtotalPaise: number;
  email?: string;
  customerId?: string | null;
  state?: string;
  /** Codes the customer applied, oldest first. Order is their intent, not a rule. */
  requestedCodes: string[];
}

/** A promotion that applied, and what it did. */
export interface AppliedPromotion {
  couponId: string;
  code: string;
  name: string | null;
  discountType: DiscountType;
  discountPaise: number;
  discountLabel: string;
  stackingMode: CouponStacking;
  trigger: CouponTrigger;
  /** True when the engine applied it without the customer entering a code. */
  automatic: boolean;
  /** Product names this promotion came off, for the storefront to show. */
  appliedTo: string[];
  /** True for a FREE_SHIPPING promotion — pricing waives the shipping charge. */
  freeShipping: boolean;
}

/** A code that did not apply, and why — in words a customer can read. */
export interface PromotionRejection {
  code: string;
  errorCode: string;
  message: string;
  /** Applied codes this one collided with, for stacking conflicts. */
  conflictsWith: string[];
}

export interface PromotionOutcome {
  applied: AppliedPromotion[];
  rejected: PromotionRejection[];
  /** Sum of every applied discount. Never exceeds the cart's worth. */
  totalDiscountPaise: number;
  /** True when any applied promotion waives shipping. */
  freeShipping: boolean;
}

/**
 * The coupon row the engine needs, with its targeting loaded.
 *
 * Selected once per evaluation; nothing below re-queries per coupon.
 */
export const PROMOTION_SELECT = {
  id: true,
  code: true,
  name: true,
  description: true,
  discountType: true,
  discountValue: true,
  maxDiscountPaise: true,
  minOrderPaise: true,
  minQty: true,
  maxQty: true,
  startsAt: true,
  endsAt: true,
  totalUsageLimit: true,
  perCustomerLimit: true,
  usedCount: true,
  isActive: true,
  scope: true,
  stackingMode: true,
  priority: true,
  trigger: true,
  combinesWithAutomatic: true,
  customerEligibility: true,
  firstNOrders: true,
  allowedStates: true,
  requireAllQualifiers: true,
  products: { select: { familyId: true, role: true } },
  variants: { select: { variantId: true, role: true } },
  categories: { select: { category: true, role: true } },
  customers: { select: { email: true } },
  bxgy: { select: { buyQty: true, getQty: true, rewardPercentOff: true, maxRepeats: true } },
} satisfies Prisma.CouponSelect;

export type PromotionRow = Prisma.CouponGetPayload<{ select: typeof PROMOTION_SELECT }>;

/** A promotion that passed every individual check and may now compete for a slot. */
export interface Candidate {
  coupon: PromotionRow;
  code: string;
  stackingMode: CouponStacking;
  priority: number;
  automatic: boolean;
  /** Indexes into the context's lines this promotion may discount. */
  discountableIdx: number[];
  appliedTo: string[];
}

export type { CustomerEligibility };
