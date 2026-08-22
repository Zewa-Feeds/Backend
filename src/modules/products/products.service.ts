/**
 * Product catalogue — spec §5.
 *
 * The defining behaviour is Draft → Preview → Publish (§5.2): *nothing goes live
 * on save alone*. Two cases, one mechanism:
 *
 *   - A NEW product is created with status DRAFT. It has no live presence, so
 *     edits write straight to its own rows.
 *   - An ALREADY-PUBLISHED product writes edits to a `ProductDraft` overlay —
 *     a JSON snapshot of the whole editable payload. The live rows are untouched
 *     until Publish, so the storefront is unaffected while staff work.
 *
 * Preview renders from the overlay; Publish applies it and deletes it.
 */
import { AuditModule, MediaType, ProductStatus, type Prisma, MediaStatus} from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { conflict, ErrorCode, notFound } from '@/lib/errors';
import { AppError } from '@/lib/errors';
import { type AuditContext, writeAudit } from '@/modules/audit/audit.service';
import { checkHero, reconcileMedia } from '@/modules/products/media.integrity';
import { resolveGallery, type ResolvableMedia } from '@/modules/products/media.resolver';
import { presentDetail, presentListing } from '@/modules/products/media.presentation';
import { listMeta, toSkipTake } from '@/middleware/validate';
/*
 * destroySafely, not destroyAssets.
 *
 * A publicId leaving one gallery does not mean the file is unused: two rows can
 * share it — the same photograph on two products, or an asset re-added after
 * being archived — and destroying it because one reference went away would 404 a
 * live storefront. destroySafely re-checks every id against the committed state
 * before anything is destroyed.
 */
import { destroySafely, markAttached } from '@/modules/uploads/lifecycle.service';
import { revalidateStorefront } from '@/integrations/storefront/revalidate';
import type { Role } from '@prisma/client';
import {
  CATEGORY_LABELS,
  FAMILY_SELECT,
  LOW_STOCK_THRESHOLD,
  serializeFamily,
  serializeListRow,
  toPaise,
} from './products.serializer';
import type { ProductBody } from './products.schemas';
import type { productListQuerySchema } from './products.schemas';
import type { z } from 'zod';

type ListQuery = z.infer<typeof productListQuerySchema>;

/** Slug from a product name, matching CMS/lib/utils.js slugify. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ============================================================================
// READS
// ============================================================================

export async function list(params: ListQuery, role: Role) {
  const where: Prisma.ProductFamilyWhereInput = {
    deletedAt: null,
    ...(params.category ? { category: params.category } : {}),
    ...(params.status ? { status: params.status } : {}),
    ...(params.q
      ? {
          OR: [
            { name: { contains: params.q, mode: 'insensitive' } },
            { slug: { contains: params.q, mode: 'insensitive' } },
            // §5.1 allows searching by SKU as well as name.
            { variants: { some: { sku: { contains: params.q.toUpperCase() } } } },
          ],
        }
      : {}),
  };

  // Stock filters need a per-family SUM, which Prisma cannot express in a
  // findMany where-clause. Filter after serialization — the catalogue is small
  // (tens of products), so this is cheaper than a raw query and stays typed.
  const needsStockFilter = params.stock !== 'All';

  const [rows, total] = await Promise.all([
    prisma.productFamily.findMany({
      where,
      select: FAMILY_SELECT,
      orderBy: { updatedAt: 'desc' },
      ...(needsStockFilter ? {} : toSkipTake(params)),
    }),
    prisma.productFamily.count({ where }),
  ]);

  let serialized = rows.map((r) => serializeListRow(r, role));

  if (needsStockFilter) {
    serialized = serialized.filter((p) =>
      params.stock === 'Out' ? p.stock === 0 : p.stock < LOW_STOCK_THRESHOLD,
    );
    const filteredTotal = serialized.length;
    const { skip, take } = toSkipTake(params);
    return {
      data: serialized.slice(skip, skip + take),
      meta: listMeta(params.page, params.limit, filteredTotal),
    };
  }

  return { data: serialized, meta: listMeta(params.page, params.limit, total) };
}

/**
 * One product for the editor.
 *
 * Returns the live rows plus the pending draft payload (if any) so the CMS can
 * load the draft into the form while still showing what is currently live.
 */
export async function bySlug(slug: string, role: Role) {
  const family = await prisma.productFamily.findFirst({
    where: { slug, deletedAt: null },
    select: { ...FAMILY_SELECT, draft: { select: { id: true, payload: true, updatedAt: true } } },
  });
  if (!family) throw notFound('Product');

  const { draft, ...live } = family;

  return {
    ...serializeFamily({ ...live, draft: draft ? { id: draft.id, updatedAt: draft.updatedAt } : null }, role),
    draftPayload: draft?.payload ?? null,
  };
}

// ============================================================================
// WRITES
// ============================================================================

/**
 * Map a validated body onto family columns.
 *
 * `status` is deliberately NOT here — see applyToLive. It needs publishedAt
 * side-effects and must not be applied on create (a new product is always DRAFT),
 * so it is handled separately rather than folded into the generic column map.
 */
function familyData(body: ProductBody) {
  return {
    name: body.name,
    category: body.category,
    badge: body.badge ?? null,
    shortDesc: body.shortDesc,
    fullDescHtml: body.fullDesc,
    proteinPct: body.protein,
    benefits: body.benefits,
    ...(body.tags ? { tags: body.tags } : {}),
    feedFreq: body.feedFreq ?? null,
    feedPortion: body.feedPortion ?? null,
    feedNotesHtml: body.feedNotes ?? null,
    nutrition: body.nutrition as Prisma.InputJsonValue,
    ...(body.presentation ? { presentation: body.presentation as Prisma.InputJsonValue } : {}),
    seoTitle: body.seoTitle ?? null,
    seoDesc: body.seoDesc ?? null,
  };
}

/**
 * Map validated gallery input to ProductMedia rows.
 *
 * `position` comes from the ARRAY INDEX, never from the client — that keeps the
 * sequence contiguous from 0 and makes the array order the single source of truth
 * for how the gallery renders.
 */
function mediaRows(
  media: NonNullable<ProductBody['media']>,
  /** SKU -> variant id, so a media item can name its pack by SKU. */
  variantIdBySku: Map<string, string> = new Map(),
) {
  return media.map((m, i) => ({
    type: m.type,
    // Unknown SKU -> null -> shared. Better a shared asset than a broken link.
    variantId: m.sku ? (variantIdBySku.get(m.sku.toUpperCase()) ?? null) : null,
    url: m.url,
    publicId: m.publicId ?? null,
    alt: m.alt ?? null,
    position: i,
    posterUrl: m.type === MediaType.VIDEO ? (m.posterUrl ?? null) : null,
    width: m.width ?? null,
    height: m.height ?? null,
    durationSec: m.type === MediaType.VIDEO ? (m.durationSec ?? null) : null,
  }));
}

/**
 * Resolve galleries for the CMS media manager.
 *
 * Takes the gallery as the editor currently has it — unsaved edits included —
 * and runs it through the SAME resolver the storefront uses, so the preview is
 * the storefront's answer rather than a second implementation of the rules.
 *
 * Read-only: nothing is written, so an operator can preview freely.
 */
export async function previewMedia(
  slug: string,
  input: {
    media: ProductBody['media'];
    variants?: { sku: string; baseSku?: string | null; heroMediaId?: string | null }[];
    representativeSku?: string | null;
  },
) {
  const family = await prisma.productFamily.findUnique({
    where: { slug },
    select: {
      id: true,
      representativeVariantId: true,
      variants: {
        where: { isActive: true },
        select: {
          id: true,
          sku: true,
          pack: true,
          position: true,
          baseVariantId: true,
          heroMediaId: true,
        },
        orderBy: { position: 'asc' },
      },
    },
  });
  if (!family) throw notFound('Product');

  const bySku = new Map(family.variants.map((v) => [v.sku.toUpperCase(), v.id]));

  /*
   * Inheritance as STAGED, when the editor sent it. A pack whose base was just
   * changed on screen should preview with the new source, not the saved one.
   */
  const stagedBase = new Map<string, string | null>();
  for (const v of input.variants ?? []) {
    const id = bySku.get(v.sku.toUpperCase());
    if (!id) continue;
    stagedBase.set(id, v.baseSku ? (bySku.get(v.baseSku.toUpperCase()) ?? null) : null);
  }

  /** Main image chosen on screen but not yet saved. */
  const stagedHero = new Map<string, string | null>();
  for (const v of input.variants ?? []) {
    const id = bySku.get(v.sku.toUpperCase());
    if (id && v.heroMediaId !== undefined) stagedHero.set(id, v.heroMediaId ?? null);
  }

  const variants = family.variants.map((v) => ({
    ...v,
    baseVariantId: stagedBase.has(v.id) ? (stagedBase.get(v.id) ?? null) : v.baseVariantId,
    heroMediaId: stagedHero.has(v.id) ? (stagedHero.get(v.id) ?? null) : v.heroMediaId,
  }));

  /*
   * The staged gallery in the resolver's shape. Items are keyed by their own id
   * where they have one; a freshly uploaded asset has none yet, so it gets a
   * temporary key that is stable for this request only — enough for ordering,
   * de-duplication and hero selection to behave exactly as they will once saved.
   */
  const resolvable = (input.media ?? []).flatMap((m, i): ResolvableMedia[] => {
    const id = m.id ?? `staged-${i}`;
    const targets = m.skus?.length
      ? m.skus.map((sku) => bySku.get(sku.toUpperCase()) ?? null).filter((x): x is string => Boolean(x))
      : m.sku
        ? [bySku.get(m.sku.toUpperCase()) ?? null].filter((x): x is string => Boolean(x))
        : [];

    const base = {
      id,
      type: m.type,
      url: m.url,
      alt: m.alt ?? null,
      position: i,
      posterUrl: m.posterUrl ?? null,
      width: m.width ?? null,
      height: m.height ?? null,
      durationSec: m.durationSec ?? null,
    };

    return targets.length > 0
      ? targets.map((variantId) => ({ ...base, variantId }))
      : [{ ...base, variantId: null }];
  });

  const skuById = new Map(family.variants.map((v) => [v.id, v.sku]));

  /*
   * The listing card, from the SAME payload the storefront gets.
   *
   * `presentListing` is the storefront's own function, so the "Listing card"
   * panel in the media manager is not a second implementation that can drift —
   * it is the answer, computed against the gallery as the operator currently
   * has it on screen.
   *
   * Hover-video optimisation is deliberately NOT applied: the preview plays the
   * asset the operator uploaded, and a Cloudinary derivative can lag the master
   * by a few seconds on first request.
   */
  const stagedRepresentative =
    input.representativeSku === undefined
      ? family.representativeVariantId
      : (bySku.get((input.representativeSku ?? '').toUpperCase()) ?? null);

  const listing = presentListing(resolvable, variants, stagedRepresentative);

  return {
    listing: {
      ...listing,
      /** The dropdown shows SKUs, not ids. */
      representativeSku: listing.representativeVariantId
        ? (skuById.get(listing.representativeVariantId) ?? null)
        : null,
      /** True when the operator picked it; false when it is the position fallback. */
      isExplicit: Boolean(
        listing.representativeVariantId &&
          stagedRepresentative === listing.representativeVariantId,
      ),
      /** How many further images the card can cycle after the hero. */
      extraImageCount: Math.max(
        0,
        (() => {
          const rep = variants.find((v) => v.id === listing.representativeVariantId);
          if (!rep) return 0;
          const g = resolveGallery(resolvable, rep);
          const images = g.items.filter((m) => m.type === MediaType.IMAGE);
          return images.length - (listing.heroUrl ? 1 : 0);
        })(),
      ),
    },
    packs: variants.map((v) => {
      const r = resolveGallery(resolvable, v);

      /*
       * An operator's explicit choice outranks the resolver's default, but only
       * while it names something this pack actually shows. A hero that has since
       * been un-assigned or removed falls back rather than pointing at nothing.
       */
      const chosen =
        v.heroMediaId && r.items.some((m) => m.id === v.heroMediaId) ? v.heroMediaId : null;

      /*
       * Order and hero from the SAME function the product page uses, so the
       * panel is what a customer would actually see rather than the raw gallery
       * in CMS order. `items` deliberately stays in CMS order — that is the
       * operator's arrangement and what the rest of the editor reads — and the
       * presentation view sits alongside it.
       */
      const presentation = presentDetail(r, v);
      const heroMediaId = presentation.heroId;

      return {
        sku: v.sku,
        pack: v.pack,
        coverage: r.coverage,
        inheritedFromSku: r.inheritedFromVariantId
          ? (skuById.get(r.inheritedFromVariantId) ?? null)
          : null,
        heroMediaId,
        /** Whether that is the operator's pick or the resolver's default. */
        heroIsExplicit: Boolean(chosen) && chosen === heroMediaId,
        presentation: {
          orderedIds: presentation.orderedIds,
          heroId: presentation.heroId,
          videoId: presentation.videoId,
          videoSource: presentation.videoSource,
        },
        items: r.items.map((m) => ({
          id: m.id,
          type: m.type,
          url: m.url,
          alt: m.alt,
          source: m.source,
          isPrimary: m.id === heroMediaId,
          width: m.width ?? null,
          height: m.height ?? null,
          posterUrl: m.posterUrl ?? null,
        })),
      };
    }),
  };
}

/**
 * What removing one asset would do.
 *
 * Answers from the staged gallery and the canonical resolver, so the numbers
 * match what the operator is looking at and what a customer would get. The
 * before/after coverage per pack is the part that matters: the old behaviour let
 * someone delete the last photograph of a pack with no warning at all.
 *
 * Read-only.
 */
export async function mediaRemovalImpact(
  slug: string,
  input: { media: ProductBody['media']; mediaId: string },
) {
  const before = await previewMedia(slug, { media: input.media });
  const after = await previewMedia(slug, {
    media: (input.media ?? []).filter((m, i) => (m.id ?? `staged-${i}`) !== input.mediaId),
  });

  const target = (input.media ?? []).find((m, i) => (m.id ?? `staged-${i}`) === input.mediaId);

  const usedBy = before.packs
    .filter((p) => p.items.some((m) => m.id === input.mediaId))
    .map((p) => ({
      sku: p.sku,
      pack: p.pack,
      /** How this pack gets it: its own, inherited, or shared. */
      source: p.items.find((m) => m.id === input.mediaId)?.source ?? 'SHARED',
      isPrimary: p.heroMediaId === input.mediaId,
    }));

  const changes = before.packs
    .map((b) => {
      const a = after.packs.find((x) => x.sku === b.sku);
      if (!a || a.coverage === b.coverage) return null;
      return { sku: b.sku, pack: b.pack, from: b.coverage, to: a.coverage };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  return {
    /** True when the asset is not tied to any pack. */
    isShared: !(target?.skus?.length || target?.sku),
    usedBy,
    primaryFor: usedBy.filter((u) => u.isPrimary).map((u) => u.pack),
    /** Packs whose coverage would change, e.g. EXACT -> EMPTY. */
    coverageChanges: changes,
    /** Packs left with nothing at all. The loudest case. */
    leavesEmpty: changes.filter((c) => c.to === 'EMPTY').map((c) => c.pack),
  };
}

/**
 * Create a product. Always DRAFT (§5.2) — a new product is never live on save.
 */
export async function create(body: ProductBody, actorId: string, ctx: AuditContext, role: Role) {
  const slug = body.slug ?? slugify(body.name);

  const clash = await prisma.productFamily.findUnique({ where: { slug }, select: { id: true } });
  if (clash) {
    throw conflict('A product with that URL slug already exists.', ErrorCode.SLUG_TAKEN, {
      field: 'slug',
    });
  }
  await assertSkusAvailable(body.variants.map((v) => v.sku));

  const created = await prisma.$transaction(async (tx) => {
    const family = await tx.productFamily.create({
      data: {
        ...familyData(body),
        slug,
        status: ProductStatus.DRAFT,
        updatedById: actorId,
        variants: {
          create: body.variants.map((v, i) => ({
            sku: v.sku,
            pack: v.pack,
            mrpPaise: toPaise(v.mrp),
            pricePaise: toPaise(v.price),
            stock: v.stock,
            hsn: v.hsn,
            weightGrams: v.weightGrams ?? null,
            position: i,
            isActive: v.isActive,
          })),
        },
      },
      select: FAMILY_SELECT,
    });

    /*
     * Media is attached AFTER the family, not in the nested create: a media item
     * names its pack by SKU, and the variant ids do not exist until the nested
     * variant insert above has run.
     */
    if (body.media?.length) {
      const skuToId = new Map(family.variants.map((v) => [v.sku.toUpperCase(), v.id]));
      await tx.productMedia.createMany({
        data: mediaRows(body.media, skuToId).map((row) => ({ ...row, familyId: family.id })),
      });
    }

    await writeAudit(
      ctx,
      {
        module: AuditModule.PRODUCTS,
        action: `Created product "${body.name}" as Draft`,
        recordId: family.slug,
      },
      tx,
    );
    return family;
  });

  /* create() writes live rows, so a new product must appear on the grid without
     waiting out the hour. Slug-less: the listing and homepage are what change. */
  await revalidateStorefront();

  return serializeFamily(created, role);
}

/**
 * Statuses a customer can actually see.
 *
 * The storefront filters on status alone — `publishedAt` has never gated
 * visibility — so these two are what "live" means. DRAFT, INACTIVE and
 * DISCONTINUED are invisible.
 */
const CUSTOMER_VISIBLE: ProductStatus[] = [ProductStatus.ACTIVE, ProductStatus.COMING_SOON];

/**
 * `publishedAt` has exactly one meaning: the moment this product's content
 * FIRST became customer-visible.
 *
 * It used to mean three things depending on which path you took. `setStatus()`
 * stamped it when a product went ACTIVE; `applyToLive()` stamped it on the same
 * condition; the status branch of `saveDraft()` stamped nothing at all. So the
 * same operator action — choosing "Active" in the editor versus through the
 * status endpoint — left different rows behind, and a product could be on sale
 * with `publishedAt` still NULL. That mattered beyond tidiness: the slug lock
 * ("editable only before first publish") reads this column, so a product could
 * be public and still have a rewritable URL.
 *
 * COMING_SOON counts. It is a listed, linkable, indexable page; treating only
 * ACTIVE as publication meant a teased product had a mutable slug.
 *
 * Stamped once and never moved: it is a first-publication timestamp, not a
 * last-modified one.
 */
function firstPublishStamp(
  next: ProductStatus | undefined,
  current: Date | null,
): { publishedAt?: Date } {
  if (!next || current) return {};
  return CUSTOMER_VISIBLE.includes(next) ? { publishedAt: new Date() } : {};
}

/**
 * Save an edit (§5.2).
 *
 * Always writes the draft overlay, whatever the product's state. Live content
 * and `publishedAt` change in exactly one place — `publish()`.
 *
 * The one exception is `status`, which applies immediately and deliberately;
 * see the comment inside. It decides whether the product is listed at all, not
 * what the listing says, and taking something off sale must not require
 * publishing unrelated draft edits.
 */
export async function saveDraft(
  slug: string,
  body: ProductBody,
  actorId: string,
  ctx: AuditContext,
  role: Role,
) {
  const existing = await prisma.productFamily.findFirst({
    where: { slug, deletedAt: null },
    select: { id: true, slug: true, name: true, publishedAt: true, status: true },
  });
  if (!existing) throw notFound('Product');

  // §5.2: the slug is editable only before first publish — it is the storefront
  // URL, and changing it after launch breaks links and SEO.
  if (body.slug && body.slug !== slug && existing.publishedAt) {
    throw new AppError(
      409,
      ErrorCode.SLUG_IMMUTABLE,
      'The URL slug cannot change after a product has been published.',
      { fields: { slug: 'Locked after first publish.' } },
    );
  }

  /*
   * SAVE NEVER PUBLISHES.
   *
   * This used to branch on `publishedAt`: a product that had never been
   * published was treated as "safe to write through", so Save Draft applied the
   * whole payload to the live rows AND stamped publishedAt — publishing it. The
   * editor says "Nothing goes live on save alone" directly above the button,
   * and for nine of the thirteen products in the catalogue that was untrue.
   *
   * Every save now writes the overlay and nothing else. `publish()` is the only
   * path that touches live content or publishedAt.
   */
  await assertSkusAvailable(
    body.variants.map((v) => v.sku),
    existing.id,
  );

  /** Set inside the transaction; acted on after it commits. */
  let purge = false;

  await prisma.$transaction(async (tx) => {
    /*
     * STATUS IS NOT EDITORIAL CONTENT — it applies IMMEDIATELY, even on a live
     * product, and is never held in the overlay.
     *
     * Draft→Preview→Publish exists so copy and pricing changes can be reviewed
     * before customers see them. Status is the opposite: it is the switch that
     * decides whether customers see the product AT ALL. Parking "Coming Soon" or
     * "Inactive" behind a Publish step meant choosing it did visibly nothing —
     * the dropdown snapped back and the product stayed on sale. Taking something
     * off sale must not require publishing unrelated draft edits.
     *
     * It no longer sets publishedAt as a side effect. Making a product visible
     * and publishing pending edits are separate acts, and conflating them is
     * what let a save go live.
     */
    const statusChanged = Boolean(body.status) && body.status !== existing.status;

    if (statusChanged) {
      await tx.productFamily.update({
        where: { id: existing.id },
        data: {
          status: body.status,
          /*
           * Making a product visible IS its first publication, so the timestamp
           * is stamped here too — the same rule `setStatus()` applies.
           *
           * This publishes the product, NOT the pending draft: customers see the
           * live rows, and the operator's unsaved-to-live edits stay in the
           * overlay until Publish. Those are different things and only one of
           * them happens here.
           */
          ...firstPublishStamp(body.status, existing.publishedAt),
          updatedById: actorId,
        },
      });
      await writeAudit(
        ctx,
        {
          module: AuditModule.PRODUCTS,
          action: `Changed status of "${existing.name}" to ${body.status}`,
          recordId: slug,
        },
        tx,
      );
    }

    await tx.productDraft.upsert({
      where: { familyId: existing.id },
      create: {
        familyId: existing.id,
        payload: body as unknown as Prisma.InputJsonValue,
        updatedById: actorId,
      },
      update: { payload: body as unknown as Prisma.InputJsonValue, updatedById: actorId },
    });
    await writeAudit(
      ctx,
      {
        module: AuditModule.PRODUCTS,
        action: `Saved draft changes to "${existing.name}"`,
        recordId: slug,
      },
      tx,
    );

    purge = statusChanged;
  });

  /*
   * A draft-only save changes nothing a customer can see, so it must NOT purge:
   * evicting the catalogue cache on every keystroke-triggered save would make
   * the invalidation hook the most expensive thing in the system, and would
   * refill the cache with identical data.
   *
   * A status change is the exception — it decides whether the product is listed
   * at all, and it applies immediately.
   */
  if (purge) await revalidateStorefront(slug);

  return bySlug(slug, role);
}

/**
 * Publish (§5.2).
 *
 * Applies any pending overlay, sets the product live, and clears the draft. If
 * there is no overlay this just flips a DRAFT product to ACTIVE.
 */
export async function publish(slug: string, actorId: string, ctx: AuditContext, role: Role) {
  const existing = await prisma.productFamily.findFirst({
    where: { slug, deletedAt: null },
    select: { id: true, name: true, status: true, publishedAt: true },
  });
  if (!existing) throw notFound('Product');

  const draft = await prisma.productDraft.findUnique({
    where: { familyId: existing.id },
    select: { payload: true },
  });

  const alreadyLive = existing.status === ProductStatus.ACTIVE && Boolean(existing.publishedAt);
  if (!draft && alreadyLive) {
    throw new AppError(400, ErrorCode.NOTHING_TO_PUBLISH, 'There are no pending changes to publish.');
  }

  // Per-request, so concurrent publishes cannot destroy each other's assets.
  const orphaned: string[] = [];

  const published = await prisma.$transaction(async (tx) => {
    if (draft) {
      const body = draft.payload as unknown as ProductBody;
      /*
       * Strip `status` from the overlay before applying it. Status is applied
       * immediately on save (see saveDraft), so the snapshot's copy is stale —
       * publishing an older draft would otherwise silently revert a status change
       * made after that draft was saved.
       */
      const { status: _staleStatus, ...bodyWithoutStatus } = body;
      await applyToLive(tx, existing.id, bodyWithoutStatus as ProductBody, actorId, orphaned);
      await tx.productDraft.delete({ where: { familyId: existing.id } });
    }

    await tx.productFamily.update({
      where: { id: existing.id },
      data: {
        // Only DRAFT becomes ACTIVE on publish. COMING_SOON and DISCONTINUED are
        // deliberate states that publishing must not silently override.
        ...(existing.status === ProductStatus.DRAFT ? { status: ProductStatus.ACTIVE } : {}),
        publishedAt: existing.publishedAt ?? new Date(),
        updatedById: actorId,
      },
    });

    await writeAudit(
      ctx,
      {
        module: AuditModule.PRODUCTS,
        action: draft
          ? `Published pending changes to "${existing.name}"`
          : `Published product "${existing.name}"`,
        recordId: slug,
      },
      tx,
    );

    return tx.productFamily.findUniqueOrThrow({ where: { id: existing.id }, select: FAMILY_SELECT });
  });

  // See saveDraft: after commit only, best-effort.
  await destroySafely(orphaned);
  /* The only path that changes live content, so the only one that must purge. */
  await revalidateStorefront(slug);

  return serializeFamily(published, role);
}

/** Discard a pending overlay, reverting the editor to what is live. */
export async function discardDraft(slug: string, ctx: AuditContext): Promise<void> {
  const family = await prisma.productFamily.findFirst({
    where: { slug, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!family) throw notFound('Product');

  const deleted = await prisma.productDraft.deleteMany({ where: { familyId: family.id } });
  if (deleted.count === 0) {
    throw new AppError(400, ErrorCode.NOTHING_TO_PUBLISH, 'There are no pending changes to discard.');
  }

  await writeAudit(ctx, {
    module: AuditModule.PRODUCTS,
    action: `Discarded draft changes to "${family.name}"`,
    recordId: slug,
  });
}

/** Change status directly (Active ↔ Coming Soon ↔ Discontinued). */
export async function setStatus(
  slug: string,
  status: ProductStatus,
  actorId: string,
  ctx: AuditContext,
  role: Role,
) {
  const family = await prisma.productFamily.findFirst({
    where: { slug, deletedAt: null },
    select: { id: true, name: true, status: true, publishedAt: true },
  });
  if (!family) throw notFound('Product');

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.productFamily.update({
      where: { id: family.id },
      data: {
        status,
        // One rule, shared with saveDraft() and applyToLive(). See firstPublishStamp.
        ...firstPublishStamp(status, family.publishedAt),
        updatedById: actorId,
      },
      select: FAMILY_SELECT,
    });
    await writeAudit(
      ctx,
      {
        module: AuditModule.PRODUCTS,
        action: `Changed status of "${family.name}" from ${family.status} to ${status}`,
        recordId: slug,
      },
      tx,
    );
    return row;
  });

  /* Status decides whether the product is listed at all — the most visible
     change there is, and the one most likely to be made in a hurry. */
  await revalidateStorefront(slug);

  return serializeFamily(updated, role);
}

/**
 * Stock quick-update (§5.3) — the most common daily ops action.
 *
 * Writes go through a transaction and each audit line records the before/after
 * numbers, matching §12.1's example ("Updated stock for F3-45G from 200 to 150").
 * Stock changes apply to LIVE rows immediately: inventory is operational truth,
 * not editorial content, so it deliberately bypasses draft/publish.
 */
export async function updateStock(
  slug: string,
  updates: { sku: string; stock: number }[],
  actorId: string,
  ctx: AuditContext,
  role: Role,
) {
  const family = await prisma.productFamily.findFirst({
    where: { slug, deletedAt: null },
    select: { id: true, name: true, variants: { select: { id: true, sku: true, stock: true } } },
  });
  if (!family) throw notFound('Product');

  const bySku = new Map(family.variants.map((v) => [v.sku, v]));

  const unknown = updates.filter((u) => !bySku.has(u.sku)).map((u) => u.sku);
  if (unknown.length > 0) {
    throw new AppError(422, ErrorCode.VALIDATION_FAILED, `Unknown SKU: ${unknown.join(', ')}`);
  }

  const updated = await prisma.$transaction(async (tx) => {
    for (const update of updates) {
      const variant = bySku.get(update.sku);
      if (!variant || variant.stock === update.stock) continue;

      await tx.productVariant.update({
        where: { id: variant.id },
        data: { stock: update.stock },
      });

      await writeAudit(
        ctx,
        {
          module: AuditModule.PRODUCTS,
          action: `Updated stock for ${update.sku} from ${variant.stock} to ${update.stock}`,
          recordId: update.sku,
          diff: { stock: { from: variant.stock, to: update.stock } },
        },
        tx,
      );
    }

    await tx.productFamily.update({
      where: { id: family.id },
      data: { updatedById: actorId },
    });

    return tx.productFamily.findUniqueOrThrow({ where: { id: family.id }, select: FAMILY_SELECT });
  });

  return serializeFamily(updated, role);
}

/**
 * Soft delete (§17.1 — Admin only, and the route requires typing the name).
 *
 * Soft rather than hard because OrderItem rows reference variants; a hard delete
 * would break invoice history.
 */
export async function remove(slug: string, ctx: AuditContext): Promise<void> {
  const family = await prisma.productFamily.findFirst({
    where: { slug, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!family) throw notFound('Product');

  await prisma.$transaction(async (tx) => {
    await tx.productFamily.update({
      where: { id: family.id },
      data: { deletedAt: new Date(), status: ProductStatus.DISCONTINUED },
    });
    // Hide from the storefront without deleting purchase history.
    await tx.productVariant.updateMany({
      where: { familyId: family.id },
      data: { isActive: false },
    });
    await writeAudit(
      ctx,
      { module: AuditModule.PRODUCTS, action: `Deleted product "${family.name}"`, recordId: slug },
      tx,
    );
  });

  /* A deleted product must leave the grid now, not within the hour. */
  await revalidateStorefront(slug);
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Apply a payload to the live rows.
 *
 * Variants are reconciled rather than deleted and recreated: a delete would null
 * the `variantId` on historical OrderItems. SKUs present in the payload are
 * upserted; SKUs absent from it are deactivated, not removed.
 */
async function applyToLive(
  tx: Prisma.TransactionClient,
  familyId: string,
  body: ProductBody,
  actorId: string,
  /** Collects Cloudinary publicIds orphaned by this write. See applyMediaToLive. */
  orphanSink: string[],
): Promise<void> {
  /*
   * Status is part of the editable payload, and used to be DROPPED here:
   * familyData() never included it, so choosing "Coming Soon" or "Inactive" in
   * the editor and pressing Save appeared to work and changed nothing. The
   * dedicated setStatus() endpoint existed but the editor never called it.
   *
   * Going ACTIVE for the first time also counts as publishing, matching
   * setStatus() — otherwise a product could be live with publishedAt still null.
   */
  const current = await tx.productFamily.findUniqueOrThrow({
    where: { id: familyId },
    select: { publishedAt: true },
  });

  await tx.productFamily.update({
    where: { id: familyId },
    data: {
      ...familyData(body),
      ...(body.status ? { status: body.status } : {}),
      ...firstPublishStamp(body.status, current.publishedAt),
      updatedById: actorId,
    },
  });

  const existing = await tx.productVariant.findMany({
    where: { familyId },
    select: { id: true, sku: true },
  });
  const existingById = new Map(existing.map((v) => [v.id, v]));
  const existingBySku = new Map(existing.map((v) => [v.sku, v]));

  /**
   * Which existing pack each payload entry refers to.
   *
   * IDENTITY FIRST, SKU ONLY AS A FALLBACK, AND EACH ROW CLAIMED ONCE.
   *
   * Matching on SKU alone meant renaming a pack created a second variant and
   * deactivated the first, stranding every photograph on the deactivated row.
   * The id says which pack this IS; the SKU is a label operators may correct.
   *
   * TWO PASSES, not one, and this is the whole subtlety. Consider a single save
   * that renames A to B and adds a new pack reusing the freed name A. With one
   * pass the outcome depended on payload order: the new entry could match A's
   * row through the pre-loop SKU map — a map that no longer describes the
   * database — and either undo the rename or steal the renamed row's identity
   * along with all of its photography. Resolving every id first, then filling in
   * by SKU from what is left, makes the result the same in either order.
   *
   * `claimed` is what stops two entries resolving to one row. The same guard
   * exists in `matchExisting` for media, for the same reason.
   *
   * An id is honoured only when it belongs to THIS family: `existingById` is
   * built from `where: { familyId }`, so a payload naming another product's
   * variant simply misses and falls through to SKU.
   */
  const resolved = new Map<number, { id: string; sku: string }>();
  const claimed = new Set<string>();

  body.variants.forEach((v, i) => {
    if (!v.id) return;
    const row = existingById.get(v.id);
    if (row && !claimed.has(row.id)) {
      resolved.set(i, row);
      claimed.add(row.id);
    }
  });

  body.variants.forEach((v, i) => {
    if (resolved.has(i)) return;
    const row = existingBySku.get(v.sku);
    if (row && !claimed.has(row.id)) {
      resolved.set(i, row);
      claimed.add(row.id);
    }
  });

  /**
   * Old SKU -> new SKU for anything renamed in this save.
   *
   * Media rows carry SKU strings, so a rename would otherwise leave them
   * pointing at a name that no longer exists — and `targetVariantIds` drops
   * unknown names, which would silently turn pack photography into shared
   * photography. The alias keeps those references resolvable.
   *
   * A freed name that another pack takes over in the same save is NOT aliased:
   * `renamedFrom` is only consulted for names that no live variant answers to,
   * so the new owner wins and the alias never competes with it.
   */
  const renamedFrom = new Map<string, string>();

  const keptIds = new Set<string>();

  const fields = (v: ProductBody['variants'][number], i: number) => ({
    pack: v.pack,
    mrpPaise: toPaise(v.mrp),
    pricePaise: toPaise(v.price),
    stock: v.stock,
    hsn: v.hsn,
    weightGrams: v.weightGrams ?? null,
    position: i,
    isActive: v.isActive,
  });

  /*
   * UPDATES BEFORE CREATES, and this ordering is load-bearing.
   *
   * SKU is unique. If one save renames A to B while a new pack takes over the
   * freed name A, creating the new row first collides with the row that still
   * holds A — the insert fails and the whole save is rejected. Applying the
   * rename first frees the name, and the create then succeeds.
   *
   * `position` comes from the payload index, so the two phases cannot disturb
   * the operator's ordering.
   */
  /*
   * Park renamed packs on a temporary SKU first.
   *
   * SKU is unique, and a rename can collide with a row that has not been
   * updated yet. The plain swap is the clearest case: A becomes B while B
   * becomes A, so whichever is written first hits the name the other still
   * holds. The database rejects it, the transaction rolls back, and the
   * operator sees a raw unique-constraint error for an operation that is
   * perfectly legal.
   *
   * Parking every renamed row on a value nothing else can hold empties the
   * namespace before any final name is claimed, so swaps, three-way rotations
   * and rename-then-reuse all resolve without special cases. The park value is
   * the row's own uuid, which is unique by definition and never valid input —
   * the DTO only accepts `[A-Z0-9][A-Z0-9-]*`, so it cannot arrive from a
   * client, and it exists only between two statements of one transaction.
   *
   * Only renames pay for this; an ordinary save does no extra writes.
   */
  const renames = [...resolved.entries()]
    .map(([i, row]) => ({ i, row, to: body.variants[i]!.sku }))
    .filter(({ row, to }) => row.sku !== to);

  for (const { row } of renames) {
    await tx.productVariant.update({
      where: { id: row.id },
      data: { sku: `PARK-${row.id}` },
    });
  }

  for (const [i, v] of body.variants.entries()) {
    const row = resolved.get(i);
    if (!row) continue;
    keptIds.add(row.id);
    if (row.sku !== v.sku) renamedFrom.set(row.sku, v.sku);
    // `sku` is written too: this is the rename, off the park value if it took one.
    await tx.productVariant.update({
      where: { id: row.id },
      data: { ...fields(v, i), sku: v.sku },
    });
  }

  for (const [i, v] of body.variants.entries()) {
    if (resolved.has(i)) continue;
    const created = await tx.productVariant.create({
      data: { ...fields(v, i), familyId, sku: v.sku },
      select: { id: true },
    });
    keptIds.add(created.id);
  }

  /*
   * Removed from the editor => deactivate, preserving order history.
   *
   * Keyed on the ids actually matched above, not on SKUs. With SKU matching a
   * renamed pack appeared in neither set and was deactivated as a side effect
   * of its own rename.
   */
  const removed = existing.filter((v) => !keptIds.has(v.id));
  if (removed.length > 0) {
    await tx.productVariant.updateMany({
      where: { id: { in: removed.map((v) => v.id) } },
      data: { isActive: false },
    });
  }

  await applyMediaToLive(tx, familyId, body, orphanSink, renamedFrom);
  await applyHeroes(tx, familyId, body);
  await applyRepresentative(tx, familyId, body);
}

/**
 * Persist the product's listing representative.
 *
 * Runs after the variants are written, so a pack created in this same save can
 * be chosen as the representative immediately.
 *
 * Two invariants the database cannot express are enforced here: the pack must
 * belong to THIS family (a foreign key would happily accept another product's
 * variant, which would put a stranger's photograph on the card), and it must be
 * active (a retired pack must not represent a live product). A choice failing
 * either is cleared rather than rejected — the same forgiving treatment a hero
 * gets, because the fallback is well defined and losing an entire product save
 * over a stale dropdown value would be worse.
 */
async function applyRepresentative(
  tx: Prisma.TransactionClient,
  familyId: string,
  body: ProductBody,
): Promise<void> {
  // Absent means "not editing it" — leave whatever is stored.
  if (body.representativeSku === undefined) return;

  const wantedSku = body.representativeSku?.trim().toUpperCase() || null;

  const chosen = wantedSku
    ? await tx.productVariant.findFirst({
        where: { familyId, sku: wantedSku, isActive: true },
        select: { id: true },
      })
    : null;

  await tx.productFamily.update({
    where: { id: familyId },
    data: { representativeVariantId: chosen?.id ?? null },
  });
}

/**
 * Persist each pack's chosen main image.
 *
 * Runs AFTER the gallery is reconciled, because a hero is only valid against the
 * gallery that now exists — validating it against the previous one would accept
 * a pointer the resolver immediately ignores.
 *
 * Uses the Phase 1 checker rather than repeating its rules: same product, not
 * archived, and actually present in that pack's resolved gallery. An invalid
 * choice clears the hero instead of failing the whole save; the resolver then
 * falls back to its default pick and the CMS shows which image won.
 */
async function applyHeroes(
  tx: Prisma.TransactionClient,
  familyId: string,
  body: ProductBody,
): Promise<void> {
  if (!body.variants) return;

  const variants = await tx.productVariant.findMany({
    where: { familyId },
    select: { id: true, sku: true, heroMediaId: true },
  });
  const byId = new Map(variants.map((v) => [v.sku.toUpperCase(), v]));

  for (const incoming of body.variants) {
    const row = byId.get(incoming.sku.toUpperCase());
    if (!row) continue;

    // Absent means "not editing the main image" — leave whatever is stored.
    if (incoming.heroMediaId === undefined) continue;

    const wanted = incoming.heroMediaId ?? null;
    if (wanted === row.heroMediaId) continue;

    const valid = wanted ? (await checkHero(tx, row.id, wanted)).ok : true;
    await tx.productVariant.update({
      where: { id: row.id },
      data: { heroMediaId: valid ? wanted : null },
    });
  }
}

/**
 * Replace a product's gallery.
 *
 * Delete-then-recreate rather than diffing: the gallery is a short ordered list
 * where every row's `position` can shift when one item moves, so a diff would
 * touch nearly every row anyway. Doing it inside the caller's transaction keeps
 * it atomic — a failure cannot leave a half-reordered gallery.
 *
 * Assets whose Cloudinary publicId is no longer referenced are collected for
 * deletion. That happens AFTER the transaction commits: destroying a remote asset
 * is not rollback-able, so it must not run for a transaction that then aborts.
 */
async function applyMediaToLive(
  tx: Prisma.TransactionClient,
  familyId: string,
  body: ProductBody,
  /**
   * Collector for orphaned publicIds. Passed in per-call rather than held at
   * module scope: two concurrent product saves would otherwise drain each
   * other's pending deletions and destroy assets belonging to the other request.
   */
  orphanSink: string[],
  /** Old SKU -> new SKU for packs renamed in this same save. See below. */
  renamedFrom: Map<string, string> = new Map(),
): Promise<void> {
  // Absent `media` means "not editing the gallery" — leave it alone.
  if (!body.media) return;

  /*
   * Reconciled by identity, not rebuilt.
   *
   * This used to delete every row for the product and re-create the payload,
   * which handed each asset a NEW primary key on every save. Anything holding a
   * media id — a hero pointer, a targeting row, an audit entry — was pointing at
   * something that ceased to exist the next time anyone pressed Save.
   *
   * Rows now keep their ids: existing assets are updated in place, genuinely new
   * ones are created, and departed ones are ARCHIVED rather than deleted so their
   * publicId survives for a deliberate Cloudinary sweep.
   */
  const variants = await tx.productVariant.findMany({
    where: { familyId },
    select: { id: true, sku: true },
  });
  const skuToId = new Map(variants.map((v) => [v.sku.toUpperCase(), v.id]));

  /*
   * Let a rename resolve under its OLD name too.
   *
   * The gallery in the payload was built before the rename, so its rows still
   * say "G2-45G" while the variant now says "G2-45GNEW". Unknown names are
   * dropped by `targetVariantIds`, which would have quietly turned that pack's
   * photography into shared photography shown on every pack. Aliasing the old
   * name onto the same variant keeps the assignment exactly where it was.
   *
   * Scoped to this family's own variants, so an alias can never point at
   * another product.
   */
  for (const [oldSku, newSku] of renamedFrom) {
    // Never shadow a live pack: if another variant now answers to the freed
    // name, that variant owns it and the alias must not steal it back.
    if (skuToId.has(oldSku.toUpperCase())) continue;
    const id = skuToId.get(newSku.toUpperCase());
    if (id) skuToId.set(oldSku.toUpperCase(), id);
  }

  const result = await reconcileMedia(tx, familyId, body.media, skuToId);
  orphanSink.push(...result.archivedPublicIds);

  /*
   * Close the tickets for everything this save attached.
   *
   * Until a publicId is referenced by a ProductMedia row it looks like an
   * abandoned upload, and the orphan sweep is entitled to destroy it. Marking
   * them here is what stops the sweep deleting assets an operator has just
   * saved.
   */
  await markAttached(
    tx,
    (body.media ?? []).map((m) => m.publicId).filter((id): id is string => Boolean(id)),
  );

  /*
   * A hero can be invalidated by the very save that archived its target. Clearing
   * it here keeps the invariant "a hero is always something this pack shows"
   * true at rest, rather than leaving a pointer the resolver would ignore.
   */
  await clearInvalidHeroes(tx, familyId);
}

/**
 * Drop hero pointers that no longer name a visible asset.
 *
 * Runs after every gallery save. The foreign key already nulls a hero whose row
 * is deleted, but archiving is not deletion — and an archived asset is exactly as
 * unusable as a deleted one from a customer's point of view.
 */
async function clearInvalidHeroes(tx: Prisma.TransactionClient, familyId: string): Promise<void> {
  const withHero = await tx.productVariant.findMany({
    where: { familyId, heroMediaId: { not: null } },
    select: { id: true, heroMediaId: true },
  });
  if (withHero.length === 0) return;

  const live = await tx.productMedia.findMany({
    where: {
      id: { in: withHero.map((v) => v.heroMediaId).filter((id): id is string => Boolean(id)) },
      // READY only: a hero that is still processing or has failed is as unusable
      // as a removed one, and it renders into an <img>.
      status: MediaStatus.READY,
    },
    select: { id: true },
  });
  const liveIds = new Set(live.map((m) => m.id));

  const stale = withHero.filter((v) => !v.heroMediaId || !liveIds.has(v.heroMediaId));
  if (stale.length > 0) {
    await tx.productVariant.updateMany({
      where: { id: { in: stale.map((v) => v.id) } },
      data: { heroMediaId: null },
    });
  }
}

/** SKUs are globally unique — they appear on invoices and in stock reports. */
async function assertSkusAvailable(skus: string[], exceptFamilyId?: string): Promise<void> {
  const clashes = await prisma.productVariant.findMany({
    where: {
      sku: { in: skus },
      ...(exceptFamilyId ? { familyId: { not: exceptFamilyId } } : {}),
    },
    select: { sku: true },
  });

  if (clashes.length > 0) {
    throw conflict(
      `SKU already in use: ${clashes.map((c) => c.sku).join(', ')}`,
      ErrorCode.CONFLICT,
      { skus: clashes.map((c) => c.sku) },
    );
  }
}

// ============================================================================
// DISPLAY ORDER (§5.1) — the sequence products appear in on the storefront
// ============================================================================
//
// PRODUCT order only. `ProductVariant.position` (packs inside one product) and
// `ProductMedia.position` (gallery) are separate systems and nothing here reads
// or writes either of them.

/** One row of the CMS reorder list. */
export type DisplayOrderRow = {
  slug: string;
  name: string;
  category: string;
  status: ProductStatus;
  position: number;
};

/**
 * The catalogue in merchandising order, for the CMS reorder screen.
 *
 * Includes COMING_SOON and DISCONTINUED as well as ACTIVE: an operator
 * sequencing the catalogue needs to see the whole thing, and a product being
 * temporarily off sale is not a reason for it to lose its place. Soft-deleted
 * rows are excluded — they are gone, not hidden.
 *
 * `name` breaks ties so the list is stable while the column is still all
 * zeroes on a database that has not been reordered yet.
 */
export async function listDisplayOrder(): Promise<DisplayOrderRow[]> {
  const rows = await prisma.productFamily.findMany({
    where: { deletedAt: null },
    orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    select: { slug: true, name: true, category: true, status: true, displayOrder: true },
  });

  /*
   * Positions are RENUMBERED for display rather than sent raw.
   *
   * The stored values can legitimately be sparse or duplicated — a product
   * created after the last reorder arrives with the default 0 — and showing an
   * operator "0, 0, 3, 7" would be alarming and useless. What the screen needs
   * is the rank, which is exactly the array index.
   */
  return rows.map((r, i) => ({
    slug: r.slug,
    name: r.name,
    category: CATEGORY_LABELS[r.category],
    status: r.status,
    position: i,
  }));
}

/**
 * Rewrite the whole catalogue sequence.
 *
 * Takes the complete ordered list of slugs, not a "move X to position 4" delta.
 * That is what makes duplicate and skipped positions impossible: the stored
 * column is not patched, it is replaced with a dense 0..n-1 sequence derived
 * from the array index. It also makes the operation idempotent — sending the
 * same list twice is a no-op — which is what protects against a double-click
 * on Save.
 *
 * The submitted set must match the current catalogue EXACTLY. A slug that has
 * been deleted, or a product created, since the operator loaded the screen
 * means they are sequencing a catalogue that no longer exists, and silently
 * accepting it would drop the new product to position 0. They are told to
 * reload instead.
 */
export async function reorder(slugs: string[], ctx: AuditContext): Promise<DisplayOrderRow[]> {
  const duplicates = slugs.filter((s, i) => slugs.indexOf(s) !== i);
  if (duplicates.length > 0) {
    throw new AppError(422, ErrorCode.VALIDATION_FAILED, 'The same product appears twice in the order.', {
      fields: { order: `Duplicated: ${[...new Set(duplicates)].join(', ')}` },
    });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const current = await tx.productFamily.findMany({
      where: { deletedAt: null },
      select: { id: true, slug: true },
    });

    const known = new Set(current.map((f) => f.slug));
    const submitted = new Set(slugs);

    const unknown = slugs.filter((s) => !known.has(s));
    const missing = current.map((f) => f.slug).filter((s) => !submitted.has(s));

    if (unknown.length > 0 || missing.length > 0) {
      /*
       * 422 rather than 409, matching reorderSpotlights, which is the same
       * operation on a sibling collection. The MESSAGE carries the useful part:
       * this is nearly always a stale screen, not a malformed request.
       */
      throw new AppError(
        422,
        ErrorCode.VALIDATION_FAILED,
        'The catalogue changed while you were reordering it. Reload and try again.',
        {
          fields: {
            ...(unknown.length ? { unknown: unknown.join(', ') } : {}),
            ...(missing.length ? { missing: missing.join(', ') } : {}),
          },
        },
      );
    }

    const idBySlug = new Map(current.map((f) => [f.slug, f.id]));

    /*
     * One UPDATE per row, inside one transaction.
     *
     * Thirteen statements against a database ~180ms away is not free, but a
     * partially applied reorder is worse than a slow one: the catalogue would
     * be left with two products claiming the same slot. The transaction is what
     * makes the whole sequence land or none of it.
     */
    for (const [index, slug] of slugs.entries()) {
      await tx.productFamily.update({
        where: { id: idBySlug.get(slug)! },
        data: { displayOrder: index },
      });
    }

    await writeAudit(
      ctx,
      {
        module: AuditModule.PRODUCTS,
        action: `Reordered the product catalogue (${slugs.length} products)`,
        diff: { displayOrder: { to: slugs } },
      },
      tx,
    );

    return tx.productFamily.findMany({
      where: { deletedAt: null },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
      select: { slug: true, name: true, category: true, status: true, displayOrder: true },
    });
  });

  /*
   * The sequence is what every listing surface renders, so the shop grid and
   * the homepage are both stale the moment it changes. Same purge the publish
   * path uses — no slug, because this is a catalogue-wide change.
   */
  await revalidateStorefront();

  return updated.map((r, i) => ({
    slug: r.slug,
    name: r.name,
    category: CATEGORY_LABELS[r.category],
    status: r.status,
    position: i,
  }));
}
