/**
 * Media integrity: stable identity, safe targeting, safe removal.
 *
 * Three rules live here, none of which a foreign key can express:
 *
 *   1. A media row keeps its id across product saves.
 *   2. A pack's hero must be an asset that pack actually shows.
 *   3. Removing a pack never silently changes what its photography is scoped to.
 *
 * Everything is written to be safe to retry. Assignment lands on a composite
 * primary key, reconciliation is keyed on identity rather than array order, and
 * archiving is idempotent — running any of it twice changes nothing the second
 * time.
 */
import { MediaStatus, MediaType, type Prisma, type PrismaClient } from '@prisma/client';
import { resolveGallery, type ResolvableMedia } from '@/modules/products/media.resolver';

type Tx = Prisma.TransactionClient | PrismaClient;

// ---------------------------------------------------------------------------
// 1. Stable identity
// ---------------------------------------------------------------------------

/** One gallery item as the CMS sends it. */
export interface IncomingMedia {
  /** Present for an asset already in the gallery. Absent means "new". */
  id?: string | null;
  type: MediaType;
  url: string;
  publicId?: string | null;
  alt?: string | null;
  posterUrl?: string | null;
  width?: number | null;
  height?: number | null;
  durationSec?: number | null;
  /** Legacy single-pack targeting, by SKU. */
  sku?: string | null;
  /** Explicit multi-pack targeting, by SKU. Wins over `sku` when present. */
  skus?: string[] | null;
}

export interface ReconcileResult {
  kept: number;
  created: number;
  updated: number;
  archived: number;
  /** publicIds whose rows were archived, for the Cloudinary sweep. */
  archivedPublicIds: string[];
}

/**
 * Match an incoming item to the row it already is.
 *
 * By id first, because that is the only identifier the CMS can round-trip. Then
 * publicId, then url — both cover payloads written before ids were sent, and
 * both are stable for a given Cloudinary asset. Array position is deliberately
 * NOT used: reordering a gallery would otherwise look like replacing every item
 * in it.
 */
function matchExisting<T extends { id: string; publicId: string | null; url: string }>(
  incoming: IncomingMedia,
  existing: T[],
  claimed: Set<string>,
): T | undefined {
  const free = (row: T) => !claimed.has(row.id);

  if (incoming.id) {
    const byId = existing.find((r) => r.id === incoming.id && free(r));
    if (byId) return byId;
  }
  if (incoming.publicId) {
    const byPublicId = existing.find((r) => r.publicId === incoming.publicId && free(r));
    if (byPublicId) return byPublicId;
  }
  return existing.find((r) => r.url === incoming.url && free(r));
}

/**
 * Reconcile a product's gallery in place.
 *
 * REPLACES delete-and-recreate. That approach gave every asset a new primary key
 * on every save, which made a hero pointer, a join table, audit-by-asset and
 * undo all impossible — anything holding a media id would have been pointing at
 * a row that no longer existed seconds later.
 *
 * Assets that disappear from the payload are ARCHIVED, not deleted: the row and
 * its publicId survive so the Cloudinary asset can be destroyed deliberately
 * later rather than orphaned and billed indefinitely.
 */
export async function reconcileMedia(
  tx: Tx,
  familyId: string,
  incoming: IncomingMedia[],
  variantIdBySku: Map<string, string>,
): Promise<ReconcileResult> {
  const existing = await tx.productMedia.findMany({
    where: { familyId },
    select: { id: true, publicId: true, url: true, status: true },
  });

  const claimed = new Set<string>();
  const result: ReconcileResult = {
    kept: 0,
    created: 0,
    updated: 0,
    archived: 0,
    archivedPublicIds: [],
  };

  for (const [position, item] of incoming.entries()) {
    const match = matchExisting(item, existing, claimed);

    const fields = {
      type: item.type,
      url: item.url,
      publicId: item.publicId ?? null,
      alt: item.alt ?? null,
      position,
      posterUrl: item.type === MediaType.VIDEO ? (item.posterUrl ?? null) : null,
      width: item.width ?? null,
      height: item.height ?? null,
      durationSec: item.type === MediaType.VIDEO ? (item.durationSec ?? null) : null,
      // A row present in the payload is live, even if a previous save archived it.
      // That is what makes "undo a removal" work by simply saving it back.
      status: MediaStatus.READY,
      archivedAt: null,
      // Legacy column stays in step for dual-read.
      variantId: resolveLegacyVariantId(item, variantIdBySku),
    };

    let mediaId: string;
    if (match) {
      claimed.add(match.id);
      await tx.productMedia.update({ where: { id: match.id }, data: fields });
      mediaId = match.id;
      result.kept += 1;
      result.updated += 1;
    } else {
      const created = await tx.productMedia.create({
        data: { ...fields, familyId },
        select: { id: true },
      });
      mediaId = created.id;
      result.created += 1;
    }

    await syncAssignments(tx, mediaId, targetVariantIds(item, variantIdBySku));
  }

  // Anything not claimed has left the gallery.
  const gone = existing.filter((r) => !claimed.has(r.id) && r.status !== MediaStatus.ARCHIVED);
  if (gone.length > 0) {
    await tx.productMedia.updateMany({
      where: { id: { in: gone.map((r) => r.id) } },
      data: { status: MediaStatus.ARCHIVED, archivedAt: new Date() },
    });
    result.archived = gone.length;
    result.archivedPublicIds = gone.map((r) => r.publicId).filter((p): p is string => Boolean(p));
  }

  return result;
}

/** SKUs an item targets. `skus` wins; `sku` is the legacy single-pack form. */
function targetVariantIds(item: IncomingMedia, bySku: Map<string, string>): string[] {
  const names = item.skus?.length ? item.skus : item.sku ? [item.sku] : [];
  const ids = names
    .map((s) => bySku.get(s.toUpperCase()))
    .filter((id): id is string => Boolean(id));
  return [...new Set(ids)];
}

/**
 * The legacy column's value.
 *
 * Holds the FIRST target so single-pack assignments keep behaving exactly as
 * before. A multi-pack asset cannot be represented here at all — that is the
 * limitation the join table exists to remove — so the column is best-effort
 * during dual-read and the join table is authoritative.
 */
function resolveLegacyVariantId(item: IncomingMedia, bySku: Map<string, string>): string | null {
  return targetVariantIds(item, bySku)[0] ?? null;
}

/**
 * Make the asset's assignments exactly `variantIds`.
 *
 * Idempotent by construction: creates are guarded by the composite primary key,
 * and deletes are scoped to links that should no longer exist. Running it twice
 * with the same input is a no-op.
 */
export async function syncAssignments(
  tx: Tx,
  productMediaId: string,
  variantIds: string[],
): Promise<void> {
  const wanted = new Set(variantIds);

  const current = await tx.productMediaVariant.findMany({
    where: { productMediaId },
    select: { variantId: true },
  });
  const have = new Set(current.map((c) => c.variantId));

  const toAdd = [...wanted].filter((id) => !have.has(id));
  const toRemove = [...have].filter((id) => !wanted.has(id));

  if (toAdd.length > 0) {
    await tx.productMediaVariant.createMany({
      data: toAdd.map((variantId) => ({ productMediaId, variantId })),
      // The primary key already forbids duplicates; this makes a retry silent
      // rather than an error.
      skipDuplicates: true,
    });
  }
  if (toRemove.length > 0) {
    await tx.productMediaVariant.deleteMany({
      where: { productMediaId, variantId: { in: toRemove } },
    });
  }
}

// ---------------------------------------------------------------------------
// 2. Hero integrity
// ---------------------------------------------------------------------------

export const HeroRejection = {
  NOT_FOUND: 'NOT_FOUND',
  WRONG_PRODUCT: 'WRONG_PRODUCT',
  ARCHIVED: 'ARCHIVED',
  NOT_IN_GALLERY: 'NOT_IN_GALLERY',
} as const;
export type HeroRejection = (typeof HeroRejection)[keyof typeof HeroRejection];

export interface HeroCheck {
  ok: boolean;
  reason?: HeroRejection;
  message?: string;
}

/**
 * Is this asset allowed to lead this pack?
 *
 * The foreign key only guarantees the row exists. Three rules it cannot express
 * matter more:
 *
 *   - the asset must belong to the same product;
 *   - it must not be archived, or the pack leads with something customers cannot
 *     see;
 *   - it must actually appear in that pack's RESOLVED gallery. Pointing a 1kg
 *     pack at a 45g photograph would otherwise be accepted and then silently
 *     ignored at render time, which is the worst of both.
 */
export async function checkHero(
  tx: Tx,
  variantId: string,
  mediaId: string,
): Promise<HeroCheck> {
  const variant = await tx.productVariant.findUnique({
    where: { id: variantId },
    select: { id: true, sku: true, familyId: true, baseVariantId: true },
  });
  if (!variant) return { ok: false, reason: HeroRejection.NOT_FOUND, message: 'Pack not found.' };

  const media = await tx.productMedia.findUnique({
    where: { id: mediaId },
    select: { id: true, familyId: true, status: true },
  });
  if (!media) {
    return { ok: false, reason: HeroRejection.NOT_FOUND, message: 'That image no longer exists.' };
  }
  if (media.familyId !== variant.familyId) {
    return {
      ok: false,
      reason: HeroRejection.WRONG_PRODUCT,
      message: 'That image belongs to a different product.',
    };
  }
  if (media.status === MediaStatus.ARCHIVED) {
    return {
      ok: false,
      reason: HeroRejection.ARCHIVED,
      message: 'That image has been removed, so it cannot lead the gallery.',
    };
  }

  const gallery = await loadResolvable(tx, variant.familyId);
  const resolved = resolveGallery(gallery, variant);
  if (!resolved.items.some((m) => m.id === mediaId)) {
    return {
      ok: false,
      reason: HeroRejection.NOT_IN_GALLERY,
      message: `That image is not shown for ${variant.sku}, so it cannot be its main image.`,
    };
  }

  return { ok: true };
}

/** Live (non-archived) media for a product, in the resolver's shape. */
export async function loadResolvable(tx: Tx, familyId: string): Promise<ResolvableMedia[]> {
  const rows = await tx.productMedia.findMany({
    where: { familyId, status: { not: MediaStatus.ARCHIVED } },
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
      durationSec: true,
      variantLinks: { select: { variantId: true } },
    },
    orderBy: { position: 'asc' },
  });

  /*
   * Dual-read.
   *
   * The join table is authoritative where it has rows; the legacy column is the
   * fallback for anything not yet backfilled. Because the resolver takes a single
   * `variantId`, a multi-target asset is expanded into one resolvable entry per
   * target — same id, so the resolver's own de-duplication collapses it back to a
   * single gallery item.
   */
  return rows.flatMap((r) => {
    const targets = r.variantLinks.length > 0
      ? r.variantLinks.map((l) => l.variantId)
      : r.variantId
        ? [r.variantId]
        : [null];

    return targets.map((variantId) => ({
      id: r.id,
      type: r.type,
      url: r.url,
      alt: r.alt,
      position: r.position,
      variantId,
      posterUrl: r.posterUrl,
      width: r.width,
      height: r.height,
      durationSec: r.durationSec,
    }));
  });
}

// ---------------------------------------------------------------------------
// 3. Removal safety
// ---------------------------------------------------------------------------

/** What a pack takes with it if it goes. */
export interface VariantImpact {
  variantId: string;
  sku: string;
  /** Assets shown only for this pack. */
  ownMediaCount: number;
  /** Packs that lead with one of those assets. */
  heroOfSkus: string[];
  /** Packs that borrow this one's photography. */
  dependentSkus: string[];
  /** True when removing this pack would leave something to decide. */
  needsDecision: boolean;
}

/**
 * What removing a pack would affect.
 *
 * Called BEFORE the removal so the CMS can say "45g x 2 borrows photography from
 * 45g, which is being removed" rather than discovering it afterwards.
 */
export async function assessVariantRemoval(tx: Tx, variantId: string): Promise<VariantImpact> {
  const variant = await tx.productVariant.findUniqueOrThrow({
    where: { id: variantId },
    select: { id: true, sku: true },
  });

  const links = await tx.productMediaVariant.findMany({
    where: { variantId },
    select: { productMediaId: true },
  });
  const legacy = await tx.productMedia.findMany({
    where: { variantId, status: { not: MediaStatus.ARCHIVED } },
    select: { id: true },
  });
  const mediaIds = [...new Set([...links.map((l) => l.productMediaId), ...legacy.map((m) => m.id)])];

  const heroOf = mediaIds.length
    ? await tx.productVariant.findMany({
        where: { heroMediaId: { in: mediaIds } },
        select: { sku: true },
      })
    : [];

  const dependents = await tx.productVariant.findMany({
    where: { baseVariantId: variantId },
    select: { sku: true },
  });

  return {
    variantId: variant.id,
    sku: variant.sku,
    ownMediaCount: mediaIds.length,
    heroOfSkus: heroOf.map((v) => v.sku),
    dependentSkus: dependents.map((v) => v.sku),
    needsDecision: mediaIds.length > 0 || dependents.length > 0,
  };
}

/**
 * What to do with a pack's photography when the pack goes.
 *
 * There is deliberately no default. The old behaviour was a database-level
 * SetNull, which turned pack-specific photography into SHARED photography with
 * nobody deciding and nothing recorded — a 1kg pouch shot silently appearing on
 * every other size.
 */
export const MediaDisposition = {
  /** Keep it attached to the now-inactive pack. Nothing becomes visible elsewhere. */
  KEEP_WITH_VARIANT: 'KEEP_WITH_VARIANT',
  /** Hide it. Recoverable — the row and publicId survive. */
  ARCHIVE: 'ARCHIVE',
  /** Reassign to another pack of the same product. */
  MOVE: 'MOVE',
  /** Deliberately show it for every pack. The one that used to happen by accident. */
  MAKE_SHARED: 'MAKE_SHARED',
} as const;
export type MediaDisposition = (typeof MediaDisposition)[keyof typeof MediaDisposition];

/**
 * Deactivate a pack, having decided what happens to its photography.
 *
 * The pack is deactivated rather than deleted, because OrderItem rows reference
 * variants and order history must survive. KEEP_WITH_VARIANT is therefore the
 * conservative default a caller should choose unless the operator says otherwise:
 * the media stays scoped to a pack nobody can select, which shows it to nobody
 * and loses nothing.
 */
export async function deactivateVariantWithMedia(
  tx: Tx,
  variantId: string,
  disposition: MediaDisposition,
  moveToVariantId?: string,
): Promise<VariantImpact> {
  const impact = await assessVariantRemoval(tx, variantId);

  const links = await tx.productMediaVariant.findMany({
    where: { variantId },
    select: { productMediaId: true },
  });
  const legacy = await tx.productMedia.findMany({
    where: { variantId },
    select: { id: true },
  });
  const mediaIds = [...new Set([...links.map((l) => l.productMediaId), ...legacy.map((m) => m.id)])];

  switch (disposition) {
    case MediaDisposition.KEEP_WITH_VARIANT:
      // Nothing to do — and that is the point. The assignment survives untouched.
      break;

    case MediaDisposition.ARCHIVE:
      if (mediaIds.length > 0) {
        await tx.productMedia.updateMany({
          where: { id: { in: mediaIds } },
          data: { status: MediaStatus.ARCHIVED, archivedAt: new Date() },
        });
      }
      break;

    case MediaDisposition.MOVE: {
      if (!moveToVariantId) throw new Error('MOVE needs a destination pack.');
      for (const id of mediaIds) await syncAssignments(tx, id, [moveToVariantId]);
      await tx.productMedia.updateMany({
        where: { id: { in: mediaIds } },
        data: { variantId: moveToVariantId },
      });
      break;
    }

    case MediaDisposition.MAKE_SHARED:
      for (const id of mediaIds) await syncAssignments(tx, id, []);
      await tx.productMedia.updateMany({
        where: { id: { in: mediaIds } },
        data: { variantId: null },
      });
      break;
  }

  await tx.productVariant.update({ where: { id: variantId }, data: { isActive: false } });

  /*
   * Packs that borrowed this one's photography keep pointing at it. The pointer
   * stays valid — the pack still exists, it is simply inactive — so inheritance
   * still resolves and nothing silently changes. The CMS surfaces the dependency
   * from `dependentSkus` so an operator can decide whether to re-point it.
   */
  return impact;
}
