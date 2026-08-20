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
import { reconcileMedia } from '@/modules/products/media.integrity';
import { listMeta, toSkipTake } from '@/middleware/validate';
import { destroyAssets } from '@/integrations/cloudinary/cloudinary.service';
import type { Role } from '@prisma/client';
import {
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

  return serializeFamily(created, role);
}

/**
 * Save an edit (§5.2).
 *
 * Routing depends on whether the product is live:
 *   - never published → write through to the live rows
 *   - published       → write to the draft overlay, leaving live untouched
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

  const isLive = Boolean(existing.publishedAt);

  if (isLive) {
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
     * This matches the dedicated setStatus() endpoint, which always wrote live.
     */
    const statusChanged = Boolean(body.status) && body.status !== existing.status;

    await prisma.$transaction(async (tx) => {
      if (statusChanged) {
        await tx.productFamily.update({
          where: { id: existing.id },
          data: {
            status: body.status,
            // First time going ACTIVE counts as publishing.
            ...(body.status === ProductStatus.ACTIVE && !existing.publishedAt
              ? { publishedAt: new Date() }
              : {}),
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
    });

    return bySlug(slug, role);
  }

  // Not yet live — safe to write through.
  await assertSkusAvailable(
    body.variants.map((v) => v.sku),
    existing.id,
  );

  // Per-request, so concurrent saves cannot destroy each other's assets.
  const orphaned: string[] = [];

  const updated = await prisma.$transaction(async (tx) => {
    await applyToLive(tx, existing.id, body, actorId, orphaned);
    const family = await tx.productFamily.findUniqueOrThrow({
      where: { id: existing.id },
      select: FAMILY_SELECT,
    });
    await writeAudit(
      ctx,
      { module: AuditModule.PRODUCTS, action: `Updated draft product "${body.name}"`, recordId: slug },
      tx,
    );
    return family;
  });

  // After commit: a destroy cannot be rolled back, so it must not run for a
  // transaction that aborted. Best-effort — never fails the save.
  await destroyAssets(orphaned);

  return serializeFamily(updated, role);
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
  await destroyAssets(orphaned);

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
        // Going ACTIVE for the first time counts as publishing.
        ...(status === ProductStatus.ACTIVE && !family.publishedAt
          ? { publishedAt: new Date() }
          : {}),
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
      ...(body.status === ProductStatus.ACTIVE && !current.publishedAt
        ? { publishedAt: new Date() }
        : {}),
      updatedById: actorId,
    },
  });

  const existing = await tx.productVariant.findMany({
    where: { familyId },
    select: { id: true, sku: true },
  });
  const existingBySku = new Map(existing.map((v) => [v.sku, v.id]));
  const incomingSkus = new Set(body.variants.map((v) => v.sku));

  for (const [i, v] of body.variants.entries()) {
    const data = {
      pack: v.pack,
      mrpPaise: toPaise(v.mrp),
      pricePaise: toPaise(v.price),
      stock: v.stock,
      hsn: v.hsn,
      weightGrams: v.weightGrams ?? null,
      position: i,
      isActive: v.isActive,
    };

    const id = existingBySku.get(v.sku);
    if (id) {
      await tx.productVariant.update({ where: { id }, data });
    } else {
      await tx.productVariant.create({ data: { ...data, familyId, sku: v.sku } });
    }
  }

  // Removed from the editor => deactivate, preserving order history.
  const removed = existing.filter((v) => !incomingSkus.has(v.sku));
  if (removed.length > 0) {
    await tx.productVariant.updateMany({
      where: { id: { in: removed.map((v) => v.id) } },
      data: { isActive: false },
    });
  }

  await applyMediaToLive(tx, familyId, body, orphanSink);
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

  const result = await reconcileMedia(tx, familyId, body.media, skuToId);
  orphanSink.push(...result.archivedPublicIds);

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
      status: { not: MediaStatus.ARCHIVED },
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
