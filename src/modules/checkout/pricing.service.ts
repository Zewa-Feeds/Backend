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
import { MediaType, ProductStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AppError, ErrorCode } from '@/lib/errors';
import * as settingsService from '@/modules/settings/settings.service';
import * as couponsService from '@/modules/coupons/coupons.service';
import { computeInvoiceTax } from '@/modules/orders/tax';

export interface CartLineInput {
  sku: string;
  qty: number;
}

export interface PricedLine {
  variantId: string;
  familyId: string;
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
  coupon: { code: string; discountLabel: string; scope?: string; appliedTo?: string[] } | null;
  freeShippingThresholdPaise: number;
  /** How much more to spend for free shipping; 0 when already qualified. */
  amountToFreeShippingPaise: number;
  /** Populated when a line cannot be fulfilled at the requested quantity. */
  issues: { sku: string; code: string; message: string; availableStock: number }[];
  deliveryText: string;
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
  couponCode?: string | null;
  email?: string;
  state?: string;
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
      family: {
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          deletedAt: true,
          // Cart thumbnail: the first IMAGE, never the video — a video URL in an
          // <img> renders as a broken thumbnail.
          media: {
            where: { type: MediaType.IMAGE },
            select: { url: true },
            orderBy: { position: 'asc' },
            take: 1,
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

    lines.push({
      variantId: variant.id,
      familyId: variant.family.id,
      sku: variant.sku,
      productName: variant.family.name,
      productSlug: variant.family.slug,
      pack: variant.pack,
      qty,
      unitPricePaise: variant.pricePaise,
      mrpPaise: variant.mrpPaise,
      lineTotalPaise: variant.pricePaise * qty,
      hsn: variant.hsn,
      taxRatePct: taxSettings.gstRatePct,
      availableStock: variant.stock,
      imageUrl: variant.family.media[0]?.url ?? null,
    });
  }

  const subtotalPaise = lines.reduce((sum, l) => sum + l.lineTotalPaise, 0);

  // Coupon failures do not fail the whole quote — the cart is still valid without
  // it, and the storefront needs the reason to explain itself.
  let discountPaise = 0;
  let coupon: PricedCart['coupon'] = null;
  if (input.couponCode) {
    try {
      const result = await couponsService.validateForCart(
        input.couponCode,
        subtotalPaise,
        input.email,
        // Lines are required for SPECIFIC_PRODUCTS scope, so the discount lands
        // only on eligible products.
        lines.map((l) => ({
          familyId: l.familyId,
          productName: l.productName,
          lineTotalPaise: l.lineTotalPaise,
        })),
      );
      discountPaise = result.discountPaise;
      coupon = {
        code: result.code,
        discountLabel: result.discountLabel,
        scope: result.scope,
        appliedTo: result.appliedTo,
      };
    } catch (err) {
      if (err instanceof AppError) {
        issues.push({
          sku: '__coupon__',
          code: err.code,
          message: err.message,
          availableStock: 0,
        });
      } else {
        throw err;
      }
    }
  }

  // Shipping is assessed on the post-discount value, so a coupon can drop an
  // order below the free-shipping threshold. That is the intended reading of
  // "free shipping on orders over ₹X".
  const payable = subtotalPaise - discountPaise;
  const shippingPaise = payable >= shipping.freeThresholdPaise ? 0 : shipping.standardRatePaise;

  const totalPaise = payable + shippingPaise;

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
    freeShippingThresholdPaise: shipping.freeThresholdPaise,
    amountToFreeShippingPaise: Math.max(0, shipping.freeThresholdPaise - payable),
    issues,
    deliveryText: shipping.deliveryText,
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
