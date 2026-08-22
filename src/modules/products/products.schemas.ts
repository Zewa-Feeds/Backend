/**
 * Product request schemas (§5.2).
 *
 * Accepts the CMS editor's payload shape — display strings for enums, rupees for
 * money — and normalises to database form. Every string field that reaches a page
 * is sanitised here, on write: rich text through the allowlist, plain fields
 * stripped of markup entirely.
 */
import { z } from 'zod';
import { Badge, Category, MediaType, ProductStatus } from '@prisma/client';
import { plainText, richText } from '@/lib/sanitize';
import { paginationSchema, slugSchema } from '@/middleware/validate';

/**
 * Enums accept either the enum value or the CMS's display label
 * ("Coming Soon" → COMING_SOON).
 */
const normaliseEnum = (v: unknown) =>
  typeof v === 'string' ? v.toUpperCase().replace(/\s+/g, '_') : v;

/** Required on writes. */
const categorySchema = z.preprocess(normaliseEnum, z.nativeEnum(Category));
const statusSchema = z.preprocess(normaliseEnum, z.nativeEnum(ProductStatus));

/**
 * Filter variants, where "All" means "no filter".
 *
 * The CMS dropdowns use "All" as their unset sentinel, so 422-ing it would break
 * an unfiltered list. Kept separate from the write schemas above, where an absent
 * category is a genuine validation error.
 */
const ALL_SENTINEL = new Set(['ALL', '']);
const asFilter = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => {
    const norm = normaliseEnum(v);
    return typeof norm === 'string' && ALL_SENTINEL.has(norm) ? undefined : norm;
  }, inner.optional());

const categoryFilterSchema = asFilter(z.nativeEnum(Category));
const statusFilterSchema = asFilter(z.nativeEnum(ProductStatus));

const badgeSchema = z.preprocess(
  (v) => {
    if (v === 'None' || v === '' || v === null) return undefined;
    return typeof v === 'string' ? v.toUpperCase() : v;
  },
  z.nativeEnum(Badge).optional().nullable(),
);

/** HSN codes are 4–8 digits (§6.5 — printed on the invoice). */
const hsnSchema = z
  .string()
  .trim()
  .regex(/^\d{4,8}$/, 'HSN must be 4–8 digits.')
  .default('23099090');

/** SKU: uppercase alphanumeric with hyphens, e.g. F3-45G. */
const skuSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(2)
  .max(40)
  .regex(/^[A-Z0-9][A-Z0-9-]*$/, 'Use uppercase letters, numbers and hyphens only.');

/** Money arrives as rupees from the CMS and is stored as integer paise. */
const rupees = z.coerce
  .number()
  .nonnegative('Cannot be negative.')
  .max(1_000_000, 'That price looks wrong.');

export const variantSchema = z
  .object({
    /**
     * Stable identity, so a pack survives being renamed.
     *
     * Variants used to be reconciled by SKU alone: renaming one created a NEW
     * variant and deactivated the old, and every photograph stayed attached to
     * the deactivated row — a pack's whole gallery vanished from the storefront
     * and from the editor, silently. The id is what the pack IS; the SKU is a
     * label on it that operators are allowed to correct.
     *
     * Optional: a variant added in the editor has no id until it is saved, and
     * an older client may not send one. Both fall back to matching by SKU.
     */
    id: z.string().uuid().optional().nullable(),
    sku: skuSchema,
    pack: z.string().trim().min(1, 'Pack size is required.').max(40).transform(plainText),
    mrp: rupees,
    price: rupees,
    stock: z.coerce.number().int().min(0).max(1_000_000).default(0),
    hsn: hsnSchema,
    weightGrams: z.coerce.number().int().positive().max(100_000).optional().nullable(),
    isActive: z.boolean().optional().default(true),
    /**
     * The asset this pack leads with.
     *
     * Carried on the variant so choosing a main image persists through the
     * ordinary save rather than needing its own endpoint. Validated server-side
     * against the pack's RESOLVED gallery — a pointer the resolver would ignore
     * is rejected rather than stored.
     */
    heroMediaId: z.string().uuid().optional().nullable(),
  })
  // A selling price above MRP is a data-entry error, and the PDP renders MRP as a
  // strikethrough — it would display a negative discount.
  .refine((v) => v.price <= v.mrp, {
    message: 'Selling price cannot exceed MRP.',
    path: ['price'],
  });

/** Nutrition is free-form: fields vary per product (§5.2 tab 4). */
const nutritionSchema = z
  .record(z.string().max(40), z.string().max(60).transform(plainText))
  .default({});

/**
 * Only our own Cloudinary account, and only over https.
 *
 * Without this the field is a stored-XSS and hotlink vector: an attacker with
 * products.edit could point a gallery entry at any origin, and the storefront
 * would render it on a public page. The upload flow always produces
 * res.cloudinary.com URLs, so legitimate values are unaffected.
 */
const cloudinaryUrl = (label: string) =>
  z
    .string()
    .trim()
    .max(600)
    .url(`${label} must be a valid URL.`)
    .refine(
      (u) => /^https:\/\/res\.cloudinary\.com\//.test(u),
      `${label} must be an uploaded Cloudinary asset.`,
    );

/**
 * One gallery entry. The array's ORDER is the gallery order — `position` is
 * assigned from the array index on write, so the client cannot send a sparse or
 * conflicting sequence.
 */
export const mediaSchema = z.object({
  /**
   * The asset's own id, round-tripped by the editor.
   *
   * This is what makes a save UPDATE an existing row rather than replace it, so
   * hero pointers and pack assignments survive editing. Absent means "new".
   */
  id: z.string().uuid().optional().nullable(),
  type: z.nativeEnum(MediaType).default(MediaType.IMAGE),
  /**
   * Which pack this asset shows, by SKU. Null/omitted = SHARED, shown for every
   * pack (fish photos, nutrition panels, the product video).
   *
   * Keyed on SKU rather than variant id because the CMS edits by SKU and a new
   * product's variant ids do not exist until after they are inserted.
   */
  sku: z.string().trim().max(40).optional().nullable(),
  /**
   * Every pack this asset is shown for.
   *
   * Supersedes `sku`, which can only ever name one. A photo of the 45g bottle is
   * equally correct for "45g x 2" and "45g x 3", and duplicating the file three
   * times to say so was the thing the join table removed.
   */
  skus: z.array(z.string().trim().max(40)).max(50).optional().nullable(),
  url: cloudinaryUrl('Media URL'),
  /** Needed to destroy the asset when it is removed; absent on legacy rows. */
  publicId: z.string().trim().max(200).optional().nullable(),
  alt: z.string().trim().max(300).transform(plainText).optional().nullable(),
  /** Video poster frame. Derived from Cloudinary, so same-origin rule applies. */
  posterUrl: cloudinaryUrl('Poster URL').optional().nullable(),
  width: z.coerce.number().int().positive().max(20_000).optional().nullable(),
  height: z.coerce.number().int().positive().max(20_000).optional().nullable(),
  durationSec: z.coerce.number().positive().max(3600).optional().nullable(),
});

/**
 * Payload for the CMS media preview.
 *
 * The editor sends the gallery as it stands on screen — including edits that have
 * not been saved — and the server resolves it with the SAME function the
 * storefront uses. That is the whole point: an operator sees what a customer
 * would get, without the CMS reimplementing any of the rules.
 */
export const mediaPreviewSchema = z.object({
  media: z.array(mediaSchema).max(50),
  /**
   * Pack ordering and inheritance as staged in the editor. Optional — omitted,
   * the saved variants are used, which is what a preview before any variant edit
   * should show.
   */
  variants: z
    .array(
      z.object({
        sku: z.string().trim().max(40),
        /** SKU of the pack this one borrows photography from. */
        baseSku: z.string().trim().max(40).optional().nullable(),
        /** Main image chosen on screen but not yet saved. */
        heroMediaId: z.string().uuid().optional().nullable(),
      }),
    )
    .max(50)
    .optional(),
  /**
   * Listing representative as staged in the editor, so the "Listing card"
   * preview updates the moment the operator changes the dropdown rather than
   * only after a save.
   */
  representativeSku: z.string().trim().max(40).optional().nullable(),
});

/**
 * Payload for the "what happens if I remove this" check.
 *
 * Takes the staged gallery so the answer reflects what is on screen, and the
 * asset in question. Read-only — it reports, it does not remove.
 */
export const mediaImpactSchema = z.object({
  media: z.array(mediaSchema).max(50),
  /** The asset being considered for removal. */
  mediaId: z.string().min(1).max(200),
});

export const productBodySchema = z.object({
  name: z.string().trim().min(2, 'Product name is required.').max(160).transform(plainText),
  // Immutable after first publish — enforced in the service, not here.
  slug: slugSchema.optional(),
  category: categorySchema,
  status: statusSchema.optional(),
  badge: badgeSchema,

  // §5.2: max 200 characters, plain text (it renders under the product name).
  shortDesc: z
    .string()
    .trim()
    .min(1, 'Short description is required.')
    .max(200, 'Maximum 200 characters.')
    .transform(plainText),

  // Rich text — sanitised against the allowlist.
  fullDesc: z.string().max(50_000).optional().default('').transform(richText),

  protein: z.coerce.number().int().min(0).max(100).default(0),

  // §5.2: up to 8 bullet points. Blanks dropped so an empty editor row is ignored.
  benefits: z
    .array(z.string().trim().max(120).transform(plainText))
    .max(8, 'Up to 8 key benefits.')
    .default([])
    .transform((list) => list.filter((b) => b.length > 0)),

  /** Species / search tags, e.g. ["betta","halfmoon"]. Many per product. */
  tags: z
    .array(z.string().trim().max(60).transform(plainText))
    .max(40)
    .optional()
    .transform((list) => list?.filter((s) => s.length > 0)),

  feedFreq: z.string().trim().max(120).transform(plainText).optional().nullable(),
  feedPortion: z.string().trim().max(120).transform(plainText).optional().nullable(),
  feedNotes: z.string().max(20_000).transform(richText).optional().nullable(),

  nutrition: nutritionSchema,
  /** Storefront-only presentation the CMS does not edit yet — passed through. */
  presentation: z.record(z.string(), z.unknown()).optional(),

  /*
   * Ordered gallery. Optional so a payload that omits it leaves media untouched
   * — otherwise any partial update would silently wipe the gallery.
   */
  media: z
    .array(mediaSchema)
    .max(20, 'A product can have at most 20 gallery items.')
    .optional()
    .refine(
      (list) => !list || list.filter((m) => m.type === MediaType.VIDEO).length <= 1,
      'A product can have at most one video.',
    )
    .refine(
      (list) => !list || new Set(list.map((m) => m.url)).size === list.length,
      'The same asset is in the gallery twice.',
    )
    .refine(
      // A poster on an image row means the client mixed up the types; better to
      // reject than to store a row the storefront will misrender.
      (list) => !list || list.every((m) => m.type === MediaType.VIDEO || !m.posterUrl),
      'Only a video can have a poster image.',
    ),

  // Meta tags must be plain: markup would corrupt them (§5.2).
  seoTitle: z.string().trim().max(70).transform(plainText).optional().nullable(),
  seoDesc: z.string().trim().max(180).transform(plainText).optional().nullable(),

  /**
   * The pack whose photography represents this product on listing surfaces.
   *
   * A SKU rather than an id, matching how the editor identifies packs
   * everywhere else and letting a variant created in the same save be chosen.
   * Validated server-side against the family's own active packs; anything else
   * clears the choice rather than failing the save, exactly as a hero does.
   *
   * Absent means "not editing it". Explicit null means "back to the default".
   */
  representativeSku: z.string().trim().max(40).optional().nullable(),

  variants: z
    .array(variantSchema)
    .min(1, 'At least one variant is required.')
    .max(20)
    // A duplicate SKU inside one payload would silently collapse on upsert.
    .refine(
      (list) => new Set(list.map((v) => v.sku)).size === list.length,
      'Duplicate SKU in this product.',
    ),
});

export type ProductBody = z.infer<typeof productBodySchema>;

/** §5.3 stock quick-update — every SKU in the family, in one modal. */
export const stockUpdateSchema = z.object({
  updates: z
    .array(
      z.object({
        sku: skuSchema,
        stock: z.coerce.number().int().min(0).max(1_000_000),
      }),
    )
    .min(1, 'Nothing to update.')
    .max(20),
});

/** §5.1 list filters. `stock` mirrors the CMS's URL-driven filter values. */
export const productListQuerySchema = paginationSchema.extend({
  category: categoryFilterSchema,
  status: statusFilterSchema,
  stock: z.enum(['All', 'Low/Out', 'Out']).optional().default('All'),
});

export const slugParamSchema = z.object({ slug: slugSchema });

/**
 * Catalogue reorder payload.
 *
 * The COMPLETE ordered list of slugs, not a move instruction. Position is the
 * array index, which is what makes duplicate or skipped positions
 * unrepresentable: there is no field for a caller to get wrong. The service
 * additionally checks the set matches the live catalogue exactly.
 *
 * Capped well above the current thirteen products; the bound exists so a
 * malformed client cannot make the server open a transaction over an unbounded
 * list, not because the catalogue is expected to approach it.
 */
export const reorderBodySchema = z.object({
  order: z.array(slugSchema).min(1, 'Nothing to reorder.').max(500),
});
