/**
 * Product serialization — the CMS ↔ backend translation layer.
 *
 * The CMS was built against mock data using display strings and rupees
 * (`cat: "Betta"`, `status: "Active"`, `price: 249`). The database uses enums and
 * paise. Rather than force either side to change, translate here — one file owns
 * the mapping, and both the CMS pages and the schema stay idiomatic.
 *
 * Two rules:
 *   - Money crosses the wire as BOTH paise (authoritative) and rupees
 *     (convenience), so the CMS can render without maths and any write path still
 *     has an exact integer.
 *   - `stockStatus` is computed server-side from §5.1 thresholds, so the CMS and
 *     the low-stock dashboard counter cannot disagree.
 */
import {
  Badge,
  Category,
  MediaStatus,
  MediaType,
  ProductStatus,
  type Prisma,
} from '@prisma/client';
import { isEditorOnly } from '@/rbac/permissions';
import { resolveGallery, type ResolvedItem } from '@/modules/products/media.resolver';
import { toResolvable } from '@/modules/products/media.integrity';
import { presentDetail, presentListing } from '@/modules/products/media.presentation';
import { hoverVideoUrl } from '@/integrations/cloudinary/cloudinary.service';
import type { Role } from '@prisma/client';

// ---- Enum ↔ display string -------------------------------------------------

export const CATEGORY_LABELS: Record<Category, string> = {
  // Product type — how the catalogue is browsed.
  [Category.DRIED_BSF_LARVAE]: 'Dried BSF Larvae',
  [Category.FLOATING_PELLETS]: 'Floating Pellets',
  [Category.SLOW_SINKING_PELLETS]: 'Slow-Sinking Pellets',
  [Category.BOTTOM_DWELLERS]: 'Bottom Dwellers',
  [Category.HATCHERY_FEEDS]: 'Hatchery Feeds',
  // Legacy species values — kept so old rows still render. Not offered for new
  // products; species now lives in ProductFamily.tags.
  [Category.BETTA]: 'Betta',
  [Category.CICHLID]: 'Cichlid',
  [Category.HATCHERY]: 'Hatchery',
  [Category.GUPPY]: 'Guppy',
};

/** Only these are offered when creating or editing a product. */
export const ACTIVE_CATEGORIES: Category[] = [
  Category.DRIED_BSF_LARVAE,
  Category.SLOW_SINKING_PELLETS,
  Category.BOTTOM_DWELLERS,
  Category.FLOATING_PELLETS,
  Category.HATCHERY_FEEDS,
];

export const STATUS_LABELS: Record<ProductStatus, string> = {
  [ProductStatus.DRAFT]: 'Draft',
  [ProductStatus.ACTIVE]: 'Active',
  [ProductStatus.COMING_SOON]: 'Coming Soon',
  [ProductStatus.INACTIVE]: 'Inactive',
  [ProductStatus.DISCONTINUED]: 'Discontinued',
};

export const BADGE_LABELS: Record<Badge, string> = {
  [Badge.BESTSELLER]: 'BESTSELLER',
  [Badge.NEW]: 'NEW',
  [Badge.PRO]: 'PRO',
};

/** Accept either the enum or the CMS's display string. */
export const parseCategory = (v: string): Category | undefined =>
  (Object.entries(CATEGORY_LABELS).find(([k, label]) => k === v || label === v)?.[0] as Category) ??
  undefined;

export const parseStatus = (v: string): ProductStatus | undefined =>
  (Object.entries(STATUS_LABELS).find(([k, label]) => k === v || label === v)?.[0] as
    | ProductStatus
    | undefined) ?? undefined;

/** "None" is how the CMS represents "no badge". */
export const parseBadge = (v: string | null | undefined): Badge | null => {
  if (!v || v === 'None') return null;
  return (
    (Object.entries(BADGE_LABELS).find(([k, label]) => k === v || label === v)?.[0] as Badge) ?? null
  );
};

// ---- Money -----------------------------------------------------------------

export const toRupees = (paise: number): number => paise / 100;
export const toPaise = (rupees: number): number => Math.round(rupees * 100);

// ---- Stock status (§5.1) ---------------------------------------------------

export type StockStatus = 'In Stock' | 'Low Stock' | 'Out of Stock';

/** §5.1: fewer than 10 units is Low Stock. Mirrors CMS/lib/utils.js stockStatus. */
export const LOW_STOCK_THRESHOLD = 10;

/**
 * Ceiling on a single cart line, independent of stock.
 *
 * A retail PDP has no legitimate reason to let one shopper take 99 units; that is
 * a wholesale enquiry (the "Find a dealer" path), and it also caps the damage from
 * a scripted grab. Checkout re-validates against real stock either way.
 */
export const MAX_QTY_PER_LINE = 10;

export function stockStatus(units: number): StockStatus {
  if (units <= 0) return 'Out of Stock';
  if (units < LOW_STOCK_THRESHOLD) return 'Low Stock';
  return 'In Stock';
}

// ---- Selects ---------------------------------------------------------------

export const VARIANT_SELECT = {
  id: true,
  sku: true,
  pack: true,
  mrpPaise: true,
  pricePaise: true,
  stock: true,
  hsn: true,
  weightGrams: true,
  position: true,
  isActive: true,
  /** Whose photography this pack borrows when it has none. See media.resolver.ts. */
  baseVariantId: true,
  packMultiplier: true,
  /** The pack's chosen main image, so the CMS can show and keep the star. */
  heroMediaId: true,
} satisfies Prisma.ProductVariantSelect;

export const FAMILY_SELECT = {
  id: true,
  slug: true,
  name: true,
  category: true,
  status: true,
  badge: true,
  shortDesc: true,
  fullDescHtml: true,
  proteinPct: true,
  benefits: true,
  tags: true,
  feedFreq: true,
  feedPortion: true,
  feedNotesHtml: true,
  nutrition: true,
  presentation: true,
  seoTitle: true,
  seoDesc: true,
  publishedAt: true,
  createdAt: true,
  updatedAt: true,
  /** The pack whose photography represents this product on listing surfaces. */
  representativeVariantId: true,
  variants: { select: VARIANT_SELECT, orderBy: { position: 'asc' } },
  media: {
    /*
     * READY ONLY, for the storefront and for the editor's gallery.
     *
     * Each of the other three states is a distinct reason an asset must not be
     * rendered: ARCHIVED was removed by an operator; FAILED never processed and
     * its URL would 404; PENDING is a video whose derived version does not exist
     * yet, so serving it shows a broken player.
     *
     * This used to be `not: ARCHIVED`, which was correct only while PENDING and
     * FAILED could not occur. They can now, so the filter is positive rather
     * than an exclusion list — a new state added later is hidden by default,
     * which is the safe direction to be wrong in.
     */
    where: { status: MediaStatus.READY },
    select: {
      id: true,
      type: true,
      url: true,
      alt: true,
      position: true,
      posterUrl: true,
      width: true,
      height: true,
      durationSec: true,
      publicId: true,
      variantId: true,
      variant: { select: { sku: true } },
      /* Every pack this asset targets, so the editor can round-trip a
         multi-pack assignment instead of flattening it to the first one, and so
         the storefront resolves against the authoritative targeting rather than
         the legacy single-value column. */
      variantLinks: { select: { variantId: true, variant: { select: { sku: true } } } },
    },
    orderBy: { position: 'asc' },
  },
  updatedBy: { select: { id: true, name: true } },
  draft: { select: { id: true, updatedAt: true } },
} satisfies Prisma.ProductFamilySelect;

type FamilyRow = Prisma.ProductFamilyGetPayload<{ select: typeof FAMILY_SELECT }>;
type VariantRow = Prisma.ProductVariantGetPayload<{ select: typeof VARIANT_SELECT }>;

// ---- Serializers -----------------------------------------------------------

export function serializeVariant(v: VariantRow) {
  return {
    id: v.id,
    sku: v.sku,
    pack: v.pack,
    mrpPaise: v.mrpPaise,
    pricePaise: v.pricePaise,
    mrp: toRupees(v.mrpPaise),
    price: toRupees(v.pricePaise),
    stock: v.stock,
    stockStatus: stockStatus(v.stock),
    hsn: v.hsn,
    weightGrams: v.weightGrams,
    position: v.position,
    isActive: v.isActive,
  };
}

/**
 * Full product for the CMS.
 *
 * `role` gates field-level access: a Content Editor holds `products.view` but must
 * not see commercial data. Route guards cannot express that — it has to happen
 * here, at serialization (§2.1 "Products — view: ◑ View").
 */
export function serializeFamily(family: FamilyRow, role?: Role) {
  const totalStock = family.variants.reduce((sum, v) => sum + v.stock, 0);

  const base = {
    id: family.id,
    slug: family.slug,
    name: family.name,
    category: family.category,
    cat: CATEGORY_LABELS[family.category],
    status: family.status,
    statusLabel: STATUS_LABELS[family.status],
    badge: family.badge ? BADGE_LABELS[family.badge] : 'None',
    shortDesc: family.shortDesc,
    fullDesc: family.fullDescHtml,
    protein: family.proteinPct,
    benefits: family.benefits,
    tags: family.tags,
    feedFreq: family.feedFreq,
    feedPortion: family.feedPortion,
    feedNotes: family.feedNotesHtml,
    nutrition: family.nutrition,
    presentation: family.presentation,
    seoTitle: family.seoTitle,
    seoDesc: family.seoDesc,
    stock: totalStock,
    stockStatus: stockStatus(totalStock),
    /*
     * Flatten variant.sku onto each asset so the CMS editor can show and edit
     * which pack it belongs to. Without this the editor cannot round-trip the
     * assignment and every save would reset it to shared.
     */
    media: family.media.map((m) => {
      const row = m as typeof m & {
        variant?: { sku: string } | null;
        variantLinks?: { variant: { sku: string } }[];
      };
      const skus = (row.variantLinks ?? []).map((l) => l.variant.sku);
      return {
        ...m,
        /** Legacy single-pack field, kept so older editor builds keep working. */
        sku: row.variant?.sku ?? skus[0] ?? null,
        /** Every pack this asset is shown for. */
        skus,
      };
    }),
    /**
     * The pack whose photography represents this product on listing surfaces.
     *
     * Sent as a SKU, not an id: the editor identifies packs by SKU everywhere
     * else, and a variant added but not yet saved has no id to refer to. The
     * service maps it back on write.
     */
    representativeSku:
      family.variants.find((v) => v.id === family.representativeVariantId)?.sku ?? null,
    publishedAt: family.publishedAt,
    updatedAt: family.updatedAt,
    // §5.1 shows who last changed the product.
    updatedBy: family.updatedBy?.name ?? null,
    /** Drives the "· draft pending" marker in the CMS list. */
    hasDraft: Boolean(family.draft),
    draftUpdatedAt: family.draft?.updatedAt ?? null,
  };

  if (isEditorOnly(role ?? ('' as Role))) {
    // Editors get the catalogue without pricing: they hold products.view for
    // context, not commercial visibility. Stock counts stay (harmless, and the
    // low-stock dashboard tile is visible to all roles per §4).
    return {
      ...base,
      variants: family.variants.map((v) => ({
        id: v.id,
        sku: v.sku,
        pack: v.pack,
        stock: v.stock,
        stockStatus: stockStatus(v.stock),
        position: v.position,
        isActive: v.isActive,
      })),
      readOnly: true,
    };
  }

  return { ...base, variants: family.variants.map(serializeVariant), readOnly: false };
}

/** Compact row for the §5.1 list — avoids shipping full rich text per row. */
export function serializeListRow(family: FamilyRow, role?: Role) {
  const full = serializeFamily(family, role);
  return {
    id: full.id,
    slug: full.slug,
    name: full.name,
    category: full.category,
    cat: full.cat,
    status: full.status,
    statusLabel: full.statusLabel,
    badge: full.badge,
    protein: full.protein,
    stock: full.stock,
    stockStatus: full.stockStatus,
    variantCount: family.variants.length,
    variants: full.variants,
    // Position 0 is the lead asset, but a thumbnail must be an image: a video
    // URL in an <img> renders broken. isPrimary is gone — order is the truth.
    thumbnail: family.media.find((m) => m.type === MediaType.IMAGE)?.url ?? null,
    updatedAt: full.updatedAt,
    updatedBy: full.updatedBy,
    hasDraft: full.hasDraft,
    readOnly: full.readOnly,
  };
}

/**
 * Public storefront shape.
 *
 * Deliberately narrower than the CMS shape: no internal ids, no HSN, no MRP-cost
 * data beyond what the PDP displays, and only active variants.
 */
export function serializePublic(family: FamilyRow) {
  const variants = family.variants.filter((v) => v.isActive);
  const totalStock = variants.reduce((sum, v) => sum + v.stock, 0);

  /*
   * Targeting, dual-read, in the resolver's shape.
   *
   * This used to pass `family.media` straight in, so the storefront resolved
   * against the LEGACY `variantId` column and every multi-pack assignment made
   * through the media manager was invisible to customers — an asset an operator
   * put on three packs appeared on one. The CMS preview read the join table via
   * `loadResolvable` and therefore disagreed with the storefront it was
   * previewing. Both now go through the same function.
   */
  const resolvable = toResolvable(family.media);

  /*
   * The card's imagery, decided here rather than on the storefront.
   *
   * The card used to pick its own: filter the raw media by the first IN-STOCK
   * pack, take the first image, and fall back to the product's first image of
   * any pack when that came up empty. Two bugs followed — a pack selling out
   * changed which photograph the catalogue showed, and Cichlid C4's card, which
   * sells the 45g, showed the 1kg pouch. There is no cross-pack fallback here.
   */
  const listing = presentListing(
    resolvable,
    variants,
    family.representativeVariantId,
    (url) => hoverVideoUrl(url) ?? url,
  );

  return {
    slug: family.slug,
    name: family.name,
    category: CATEGORY_LABELS[family.category],
    badge: family.badge ? BADGE_LABELS[family.badge] : null,
    /*
     * Status reaches the storefront so a COMING_SOON product can say so.
     * Previously omitted, which made "coming soon" indistinguishable from
     * "out of stock" — the PDP showed a dead Add-to-cart button and no banner.
     * Only ACTIVE and COMING_SOON are ever served publicly (see catalog.routes).
     */
    status: family.status,
    isComingSoon: family.status === ProductStatus.COMING_SOON,
    shortDesc: family.shortDesc,
    fullDescHtml: family.fullDescHtml,
    proteinPct: family.proteinPct,
    benefits: family.benefits,
    tags: family.tags,
    feeding: {
      frequency: family.feedFreq,
      portion: family.feedPortion,
      notesHtml: family.feedNotesHtml,
    },
    nutrition: family.nutrition,
    presentation: family.presentation,
    seo: { title: family.seoTitle, description: family.seoDesc },
    /*
     * Ordered gallery: photos and (at most one) video interleaved, exactly as
     * arranged in the CMS. The storefront walks this in order and picks the
     * element by `type`, so "photo, video, photo, photo" needs no special case.
     */
    media: family.media.map((m) => ({
      /* Stable identifier. The client keys the hero and de-duplication on this
         rather than on the URL, since two records can legitimately share a file. */
      id: m.id,
      type: m.type,
      url: m.url,
      alt: m.alt,
      /*
       * Which pack this asset shows, or null for a shared asset (fish photo,
       * nutrition panel, the product video). The storefront filters the gallery
       * on the selected pack so a shopper buying a 45g bottle is not shown 1kg
       * pouch photography.
       */
      sku: m.variant?.sku ?? null,
      ...(m.type === MediaType.VIDEO
        ? { posterUrl: m.posterUrl, durationSec: m.durationSec }
        : {}),
      width: m.width,
      height: m.height,
    })),
    /*
     * Kept for compatibility: images-only, so any consumer written before video
     * existed keeps working and never receives a video URL in an <img>.
     */
    images: family.media
      .filter((m) => m.type === MediaType.IMAGE)
      .map((m) => ({ url: m.url, alt: m.alt })),
    /**
     * What listing surfaces show: the shop grid card and the homepage range.
     *
     * IMAGERY ONLY. Price, availability and the Add-to-Cart SKU still follow the
     * first purchasable pack — a shopper must never be offered a sold-out SKU
     * because it happens to be the photogenic one.
     */
    listing,
    inStock: totalStock > 0,
    packs: variants.map((v) => ({
      sku: v.sku,
      pack: v.pack,
      /*
       * The gallery this pack actually shows, resolved on the server.
       *
       * The storefront used to work this out itself — filtering by SKU, deriving
       * multipack inheritance from an "X2" suffix, and falling back to the whole
       * gallery when a pack had no photography of its own. That last rule showed
       * customers a 1kg pouch when they had selected a 45g bottle.
       *
       * Sending the resolved result means one implementation of the rules, shared
       * by the storefront, SSR and the CMS preview. `coverage` says WHY this
       * gallery is what it is, which is what lets the CMS report gaps instead of
       * hiding them.
       */
      gallery: (() => {
        const r = resolveGallery(resolvable, v);
        /*
         * `heroMediaId` and `isPrimary` now honour the operator's star.
         *
         * The column has existed and been written by the CMS since Phase 3, and
         * only the CMS PREVIEW applied it — the storefront sent the resolver's
         * default instead, so choosing a main image changed what the operator
         * saw and nothing a customer saw. Same input, same answer, both sides.
         */
        const presentation = presentDetail(r, v);
        return {
          coverage: r.coverage,
          inheritedFromSku:
            variants.find((x) => x.id === r.inheritedFromVariantId)?.sku ?? null,
          heroMediaId: presentation.heroId,
          items: r.items.map((m: ResolvedItem) => ({
            id: m.id,
            type: m.type,
            url: m.url,
            alt: m.alt,
            width: m.width ?? null,
            height: m.height ?? null,
            posterUrl: m.posterUrl ?? null,
            source: m.source,
            isPrimary: m.id === presentation.heroId,
          })),
          /*
           * Presentation order, kept separate from `items`.
           *
           * `items` stays in CMS gallery order because that is what the operator
           * arranged and what existing consumers already read. This says what to
           * LEAD with — a different question about the same list, which is why it
           * is a derived view and not a second position column.
           */
          presentation: {
            orderedIds: presentation.orderedIds,
            heroId: presentation.heroId,
            videoId: presentation.videoId,
            videoSource: presentation.videoSource,
          },
        };
      })(),
      pricePaise: v.pricePaise,
      mrpPaise: v.mrpPaise,
      price: toRupees(v.pricePaise),
      mrp: toRupees(v.mrpPaise),
      inStock: v.stock > 0,
      /*
       * How many can actually be bought, so the storefront can cap its quantity
       * stepper. Without this the PDP only knew in-stock/out-of-stock and let a
       * shopper build a 99-unit cart for a 10-unit item, failing at checkout.
       *
       * Capped at 10 rather than exposing the true count: the number is a
       * competitive signal ("they only have 3 left") and the shopper only needs
       * to know the ceiling on THIS purchase. Checkout re-validates against the
       * real figure regardless — this is a UX hint, never the enforcement point.
       */
      maxQty: Math.min(v.stock, MAX_QTY_PER_LINE),
    })),
  };
}
