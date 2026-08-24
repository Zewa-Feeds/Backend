/**
 * Cart pricing — the single source of truth for what an order costs.
 *
 * Used by BOTH `POST /cart/validate` (so the storefront can display totals) and
 * `POST /checkout` (so the order is priced authoritatively). Sharing one function
 * is deliberate: if the quote and the charge were computed separately they would
 * eventually disagree.
 *
 * Client-supplied prices are never trusted. The request says *what* and *how many*;
 * everything monetary is looked up server-side.
 */
import { MediaStatus, ProductStatus, type Category } from '@prisma/client';
import { resolveGallery } from '@/modules/products/media.resolver';
import { toResolvable, type TargetableMediaRow } from '@/modules/products/media.integrity';
import { pickHero } from '@/modules/products/media.presentation';
import { prisma } from '@/lib/prisma';
import { AppError, ErrorCode } from '@/lib/errors';
import * as settingsService from '@/modules/settings/settings.service';
import * as promotionEngine from '@/modules/promotions/engine';
import type { AppliedPromotion, PromotionRow } from '@/modules/promotions/types';
import { computeInvoiceTax } from '@/modules/orders/tax';

export interface CartLineInput {
  sku: string;
  qty: number;
}

export interface PricedLine {
  variantId: string;
  familyId: string;
  category: Category;
  sku: string;
  productName: string;
  productSlug: string;
  pack: string;
  qty: number;
  unitPricePaise: number;
  mrpPaise: number;
  lineTotalPaise: number;
  hsn: string;
  taxRatePct: number;
  /** Stock on hand right now — the storefront shows this when a line is short. */
  availableStock: number;
  imageUrl: string | null;
}

export interface PricedCart {
  lines: PricedLine[];
  subtotalPaise: number;
  discountPaise: number;
  shippingPaise: number;
  taxPaise: number;
  totalPaise: number;
  /** The primary applied promotion — first in the stack. Null when none applied. */
  coupon: { code: string; discountLabel: string; scope?: string; appliedTo?: string[] } | null;
  /** Every applied promotion, in the order the engine priced them. */
  coupons: AppliedPromotion[];
  /** True when a promotion waived the shipping charge. */
  freeShippingFromCoupon: boolean;
  freeShippingThresholdPaise: number;
  /** How much more to spend for free shipping; 0 when already qualified. */
  amountToFreeShippingPaise: number;
  /** Populated when a line cannot be fulfilled at the requested quantity. */
  issues: {
    sku: string;
    code: string;
    message: string;
    availableStock: number;
    /** Which code failed, when sku is the `__coupon__` sentinel. */
    couponCode?: string;
  }[];
  deliveryText: string;
  deliveryNote?: string;
  deliveryDays?: number;
  billableWeightGrams?: number;
  chargeableWeightKg?: number;
  isKerala?: boolean;
}

/** Helper to extract net weight in grams from variant or pack string. */
export function getVariantNetWeightGrams(variant: {
  weightGrams?: number | null;
  pack?: string | null;
  packMultiplier?: number | null;
}): number {
  if (typeof variant.weightGrams === 'number' && variant.weightGrams > 0) {
    return variant.weightGrams;
  }
  const packStr = (variant.pack || '').toLowerCase();
  const kgMatch = packStr.match(/(\d+(?:\.\d+)?)\s*kg/);
  if (kgMatch && kgMatch[1]) {
    return Math.round(parseFloat(kgMatch[1]) * 1000);
  }
  const gMatch = packStr.match(/(\d+(?:\.\d+)?)\s*g/);
  if (gMatch && gMatch[1]) {
    let grams = parseFloat(gMatch[1]);
    const multMatch = packStr.match(/x\s*(\d+)/i) || packStr.match(/(\d+)\s*pack/i);
    if (multMatch && multMatch[1]) {
      grams *= parseInt(multMatch[1], 10);
    } else if (variant.packMultiplier && variant.packMultiplier > 1) {
      grams *= variant.packMultiplier;
    }
    return Math.round(grams);
  }
  return 50;
}

/**
 * State-based delivery day estimation:
 * Kerala: 2 days
 * Karnataka, Tamil Nadu: 3 days
 * Telangana, Andhra Pradesh, Maharashtra: 4 days
 * Rest of India: 5 days
 * Rural note: *Rural areas may take 1 additional day.
 */
export function getDeliveryEstimateForState(state?: string | null): {
  days: number;
  deliveryText: string;
  ruralNote: string;
} {
  if (!state || !state.trim()) {
    return {
      days: 5,
      deliveryText: 'Enter your state to calculate shipping',
      ruralNote: '*Rural areas may take 1 additional day.',
    };
  }

  const s = state.trim().toLowerCase().replace(/\band\b/g, '&').replace(/[^a-z&]/g, '');

  let days = 5;
  if (s === 'kerala') {
    days = 2;
  } else if (s === 'karnataka' || s === 'tamilnadu') {
    days = 3;
  } else if (s === 'telangana' || s === 'andhrapradesh' || s === 'maharashtra') {
    days = 4;
  } else {
    days = 5;
  }

  return {
    days,
    deliveryText: `Estimated delivery: ${days} days*`,
    ruralNote: '*Rural areas may take 1 additional day.',
  };
}

/**
 * Price a cart.
 *
 * `state` is needed because GST splits CGST/SGST vs IGST by place of supply, and
 * at cart stage we may not know it yet — the seller's own state is assumed until
 * checkout supplies a delivery address.
 */
export async function priceCart(input: {
  lines: CartLineInput[];
  /** Single code — the original contract, still honoured. */
  couponCode?: string | null;
  /** Several codes, oldest first. Merged with `couponCode` when both are given. */
  couponCodes?: string[] | null;
  email?: string;
  customerId?: string | null;
  state?: string;
  overlayPromotions?: PromotionRow[];
}): Promise<PricedCart> {
  if (input.lines.length === 0) {
    throw new AppError(400, ErrorCode.CART_EMPTY, 'Your cart is empty.');
  }

  // Collapse duplicate SKUs so a client sending the same line twice cannot
  // bypass per-line stock checks.
  const wanted = new Map<string, number>();
  for (const line of input.lines) {
    const sku = line.sku.toUpperCase().trim();
    wanted.set(sku, (wanted.get(sku) ?? 0) + line.qty);
  }

  const variants = await prisma.productVariant.findMany({
    where: { sku: { in: [...wanted.keys()] }, isActive: true },
    select: {
      id: true,
      sku: true,
      pack: true,
      pricePaise: true,
      mrpPaise: true,
      stock: true,
      hsn: true,
      weightGrams: true,
      packMultiplier: true,
      /* Inheritance and the chosen main image, so the thumbnail is resolved for
         THIS pack rather than for the product as a whole. */
      baseVariantId: true,
      heroMediaId: true,
      family: {
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          category: true,
          deletedAt: true,
          media: {
            where: { status: MediaStatus.READY },
            select: {
              id: true,
              type: true,
              url: true,
              alt: true,
              position: true,
              variantId: true,
              posterUrl: true,
              width: true,
              height: true,
              variantLinks: { select: { variantId: true } },
            },
            orderBy: { position: 'asc' },
          },
        },
      },
    },
  });

  const bySku = new Map(variants.map((v) => [v.sku, v]));
  const { tax: taxSettings, shipping } = await settingsService.getAll();

  const lines: PricedLine[] = [];
  const issues: PricedCart['issues'] = [];

  for (const [sku, qty] of wanted) {
    const variant = bySku.get(sku);

    if (!variant || variant.family.deletedAt) {
      issues.push({
        sku,
        code: 'UNAVAILABLE',
        message: 'This item is no longer available.',
        availableStock: 0,
      });
      continue;
    }

    // Only ACTIVE products are purchasable. DRAFT and COMING_SOON must not be
    // buyable even if someone knows the SKU.
    if (variant.family.status !== ProductStatus.ACTIVE) {
      issues.push({
        sku,
        code: 'NOT_PURCHASABLE',
        message: 'This item is not currently on sale.',
        availableStock: 0,
      });
      continue;
    }

    if (variant.stock < qty) {
      issues.push({
        sku,
        code: variant.stock === 0 ? 'OUT_OF_STOCK' : 'INSUFFICIENT_STOCK',
        message:
          variant.stock === 0
            ? 'This item is out of stock.'
            : `Only ${variant.stock} left in stock.`,
        availableStock: variant.stock,
      });
      // Still priced, so the storefront can show the line with a warning rather
      // than silently dropping it from the cart.
    }

    const unitPricePaise = variant.pricePaise;
    const lineTotalPaise = unitPricePaise * qty;
    const taxRatePct = (taxSettings.gstRatePct ?? 0);

    lines.push({
      variantId: variant.id,
      familyId: variant.family.id,
      category: variant.family.category,
      sku: variant.sku,
      productName: variant.family.name,
      productSlug: variant.family.slug,
      pack: variant.pack,
      qty,
      unitPricePaise,
      mrpPaise: variant.mrpPaise,
      lineTotalPaise,
      hsn: variant.hsn,
      taxRatePct,
      availableStock: variant.stock,
      imageUrl: packThumbnail(variant),
    });
  }

  const subtotalPaise = lines.reduce((sum, l) => sum + l.lineTotalPaise, 0);

  /*
   * Promotions.
   *
   * A failure here does NOT fail the quote — the cart is still valid without a
   * discount, and the storefront needs the reason in order to explain itself.
   * Rejections ride in `issues` under the sentinel sku `__coupon__`, which cart
   * and checkout both filter on to decide fulfillability; the sku string is part
   * of that contract, so each rejection carries the offending `code` alongside
   * rather than encoding it into the sku.
   */
  const requestedCodes = [
    ...(input.couponCode ? [input.couponCode] : []),
    ...(input.couponCodes ?? []),
  ];

  const promotions = await promotionEngine.evaluate({
    lines: lines.map((l) => ({
      variantId: l.variantId,
      familyId: l.familyId,
      category: l.category,
      sku: l.sku,
      productName: l.productName,
      qty: l.qty,
      unitPricePaise: l.unitPricePaise,
      lineTotalPaise: l.lineTotalPaise,
    })),
    subtotalPaise,
    email: input.email,
    customerId: input.customerId,
    state: input.state,
    requestedCodes,
  }, {
    overlayPromotions: input.overlayPromotions,
  });

  const discountPaise = promotions.totalDiscountPaise;
  const primary = promotions.applied[0];
  const coupon: PricedCart['coupon'] = primary
    ? {
        code: primary.code,
        discountLabel: primary.discountLabel,
        appliedTo: primary.appliedTo,
      }
    : null;

  for (const rejection of promotions.rejected) {
    issues.push({
      sku: '__coupon__',
      code: rejection.errorCode,
      message: rejection.message,
      availableStock: 0,
      couponCode: rejection.code,
    });
  }

  // ---- Authoritative Weight & Shipping Calculation ----
  let totalProductWeightGrams = 0;
  for (const line of lines) {
    const variant = bySku.get(line.sku);
    if (variant) {
      const unitWeight = getVariantNetWeightGrams(variant);
      totalProductWeightGrams += unitWeight * line.qty;
    }
  }

  const packagingWeightGrams = shipping.packagingWeightGrams ?? 100;
  const totalShipmentWeightGrams = totalProductWeightGrams + packagingWeightGrams;
  const slabGrams = shipping.slabWeightGrams && shipping.slabWeightGrams > 0 ? shipping.slabWeightGrams : 500;
  const chargeableWeightGrams = Math.max(slabGrams, Math.ceil(totalShipmentWeightGrams / slabGrams) * slabGrams);
  const chargeableWeightKg = chargeableWeightGrams / 1000;

  const hasState = Boolean(input.state && input.state.trim());
  const isKerala = hasState && input.state!.trim().toLowerCase() === 'kerala';
  const ratePerKgPaise = isKerala
    ? (shipping.keralaRatePerKgPaise ?? 4500)
    : (shipping.outsideKeralaRatePerKgPaise ?? 7000);

  const calculatedShippingPaise = Math.round(chargeableWeightKg * ratePerKgPaise);

  const payable = subtotalPaise - discountPaise;
  const isFreeShipping = shipping.freeThresholdPaise > 0 && payable >= shipping.freeThresholdPaise;
  /*
   * A FREE_SHIPPING promotion WAIVES the charge; it does not compute one.
   *
   * The weight, slab and per-kg rate above are untouched and still decide what
   * shipping costs — this only zeroes the result, exactly as the CMS free-shipping
   * threshold does. There is deliberately no second free-shipping configuration.
   */
  const shippingPaise =
    isFreeShipping || promotions.freeShipping ? 0 : hasState ? calculatedShippingPaise : 0;
  const totalPaise = payable + shippingPaise;

  const deliveryInfo = getDeliveryEstimateForState(input.state);

  // GST is informational at cart stage; the invoice recomputes it from snapshots.
  const taxSummary = computeInvoiceTax(
    lines.map((l) => ({ lineTotalPaise: l.lineTotalPaise, taxRatePct: l.taxRatePct })),
    {
      gstRatePct: taxSettings.gstRatePct,
      gstInclusive: taxSettings.gstInclusive,
      sellerState: (await settingsService.getTaxConfig()).sellerState,
    },
    input.state ?? (await settingsService.getTaxConfig()).sellerState,
  );

  return {
    lines,
    subtotalPaise,
    discountPaise,
    shippingPaise,
    taxPaise: taxSummary.totalTaxPaise,
    totalPaise,
    coupon,
    coupons: promotions.applied,
    freeShippingFromCoupon: promotions.freeShipping,
    freeShippingThresholdPaise: shipping.freeThresholdPaise,
    amountToFreeShippingPaise: Math.max(0, shipping.freeThresholdPaise - payable),
    issues,
    deliveryText: deliveryInfo.deliveryText,
    deliveryNote: deliveryInfo.ruralNote,
    deliveryDays: deliveryInfo.days,
    billableWeightGrams: totalShipmentWeightGrams,
    chargeableWeightKg,
    isKerala,
  };
}

/** Throw if anything blocks checkout. Called before an order is created. */
export function assertFulfillable(cart: PricedCart): void {
  const blocking = cart.issues.filter((i) => i.sku !== '__coupon__');
  if (blocking.length > 0) {
    const first = blocking[0]!;
    throw new AppError(409, ErrorCode.OUT_OF_STOCK, first.message, {
      details: { issues: blocking },
    });
  }
  if (cart.lines.length === 0) {
    throw new AppError(400, ErrorCode.CART_EMPTY, 'Your cart is empty.');
  }
}


/**
 * The thumbnail for one cart line.
 *
 * Goes through the canonical resolver and the presentation layer, exactly as the
 * listing card and the product page do, so all three agree about what a shopper
 * is buying. An IMAGE or nothing: a video URL in an <img> renders as a broken
 * thumbnail, and a pack with no suitable photography is better represented by a
 * gap the storefront fills with a placeholder than by another pack's photo.
 */
function packThumbnail(variant: {
  id: string;
  sku: string;
  baseVariantId: string | null;
  heroMediaId: string | null;
  family: { media: TargetableMediaRow[] };
}): string | null {
  const gallery = resolveGallery(toResolvable(variant.family.media), {
    id: variant.id,
    sku: variant.sku,
    baseVariantId: variant.baseVariantId,
  });
  return pickHero(gallery, { heroMediaId: variant.heroMediaId })?.url ?? null;
}
