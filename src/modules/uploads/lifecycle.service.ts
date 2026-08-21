/**
 * The media lifecycle: what a Cloudinary asset is, and what may be done to it.
 *
 *   signature minted  → UploadTicket SIGNED
 *   bytes land        → UploadTicket UPLOADED       (webhook, or the sweep)
 *   saved on a product→ UploadTicket ATTACHED, ProductMedia PENDING or READY
 *   processing done   → ProductMedia READY          (webhook, or the sweep)
 *   processing failed → ProductMedia FAILED
 *   removed in CMS    → ProductMedia ARCHIVED, then the file destroyed if safe
 *
 * Everything here is idempotent. Cloudinary retries notifications, operators
 * double-click, and a sweep may race a webhook — so every transition is written
 * as "make it so" rather than "change it", and re-running any of them is a
 * no-op.
 */
import { MediaStatus, MediaType, Prisma, UploadTicketStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { destroyAssets } from '@/integrations/cloudinary/cloudinary.service';

const log = logger.child({ module: 'media-lifecycle' });

type Tx = Prisma.TransactionClient | typeof prisma;

/**
 * Whether a newly saved asset is finished or still being worked on.
 *
 * Images are transformed inline during upload — by the time Cloudinary responds
 * the derived asset exists and its URL resolves, so PENDING would be a state
 * that is true for zero milliseconds and would hide a perfectly good photograph
 * from customers if a notification were ever missed.
 *
 * Video is different and this is the whole reason the PENDING state exists: the
 * upload returns as soon as the bytes land, with transcoding still running (see
 * VIDEO_EAGER_TRANSFORM). The original plays, but the derived version the
 * storefront serves does not exist yet, so the asset is genuinely not ready.
 */
export function initialStatus(type: MediaType): MediaStatus {
  return type === MediaType.VIDEO ? MediaStatus.PENDING : MediaStatus.READY;
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

/** Record a minted signature, before the browser is told where to upload. */
export async function openTicket(input: {
  publicId: string;
  resourceType: string;
  folder: string;
  familyId?: string | null;
  requestedById?: string | null;
}): Promise<void> {
  await prisma.uploadTicket.upsert({
    where: { publicId: input.publicId },
    // Re-minting a signature for the same public_id is a retry, not a new asset.
    update: { status: UploadTicketStatus.SIGNED, failureReason: null },
    create: {
      publicId: input.publicId,
      resourceType: input.resourceType,
      folder: input.folder,
      familyId: input.familyId ?? null,
      requestedById: input.requestedById ?? null,
    },
  });
}

/**
 * Mark the tickets for these publicIds as attached.
 *
 * Called after a gallery save. An attached asset is referenced by a
 * ProductMedia row, so the orphan sweep must leave it alone.
 */
export async function markAttached(tx: Tx, publicIds: string[]): Promise<void> {
  if (publicIds.length === 0) return;
  await tx.uploadTicket.updateMany({
    where: { publicId: { in: publicIds } },
    data: { status: UploadTicketStatus.ATTACHED, attachedAt: new Date() },
  });
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export interface TransitionResult {
  ticket: 'updated' | 'absent';
  media: 'promoted' | 'failed' | 'unchanged' | 'absent';
}

/**
 * Apply a verified notification.
 *
 * Idempotent in both directions: promoting media that is already READY changes
 * nothing, and a late `upload` notification arriving after `eager` cannot demote
 * a READY asset back to PENDING — the update is scoped to `status: PENDING`, so
 * a duplicate or out-of-order delivery simply matches no rows.
 *
 * ARCHIVED is deliberately never revived here. An operator removing an asset
 * outranks a notification that was in flight when they did it.
 */
export async function applyNotification(input: {
  publicId: string;
  outcome: 'READY' | 'FAILED';
  reason?: string;
  url?: string | null;
  width?: number | null;
  height?: number | null;
  durationSec?: number | null;
}): Promise<TransitionResult> {
  const result: TransitionResult = { ticket: 'absent', media: 'absent' };

  const ticket = await prisma.uploadTicket.findUnique({
    where: { publicId: input.publicId },
    select: { id: true, status: true },
  });

  if (ticket) {
    result.ticket = 'updated';
    await prisma.uploadTicket.update({
      where: { id: ticket.id },
      data:
        input.outcome === 'FAILED'
          ? { status: UploadTicketStatus.FAILED, failureReason: input.reason ?? null }
          : {
              uploadedAt: new Date(),
              failureReason: null,
              // A ticket already ATTACHED stays attached: the media row exists,
              // and downgrading it to UPLOADED would make the orphan sweep
              // consider destroying a live asset.
              ...(ticket.status === UploadTicketStatus.ATTACHED
                ? {}
                : { status: UploadTicketStatus.UPLOADED }),
            },
    });
  }

  const media = await prisma.productMedia.findFirst({
    where: { publicId: input.publicId },
    select: { id: true, status: true },
  });
  if (!media) return result;

  if (input.outcome === 'FAILED') {
    const changed = await prisma.productMedia.updateMany({
      // Only something still waiting can fail. A READY asset that Cloudinary
      // later complains about is not retroactively broken, and an ARCHIVED one
      // is already gone.
      where: { id: media.id, status: MediaStatus.PENDING },
      data: { status: MediaStatus.FAILED },
    });
    result.media = changed.count > 0 ? 'failed' : 'unchanged';
    return result;
  }

  const changed = await prisma.productMedia.updateMany({
    where: { id: media.id, status: { in: [MediaStatus.PENDING, MediaStatus.FAILED] } },
    data: {
      status: MediaStatus.READY,
      ...(input.width ? { width: input.width } : {}),
      ...(input.height ? { height: input.height } : {}),
      ...(input.durationSec ? { durationSec: input.durationSec } : {}),
    },
  });
  result.media = changed.count > 0 ? 'promoted' : 'unchanged';
  return result;
}

// ---------------------------------------------------------------------------
// Destruction
// ---------------------------------------------------------------------------

/**
 * publicIds that are safe to destroy in Cloudinary.
 *
 * THE RULE THIS ENFORCES: a Cloudinary asset must never be destroyed while any
 * live ProductMedia row still points at it. Two rows can legitimately share one
 * file — the same photograph used by two products, or an asset re-added after
 * being archived — and destroying it because one of them was removed would break
 * the other, silently, with a 404 on a live storefront.
 *
 * Archived rows do NOT count as references: archiving is what schedules the
 * destruction. Only PENDING, READY and FAILED rows hold an asset alive.
 */
export async function destroyable(tx: Tx, publicIds: string[]): Promise<string[]> {
  const unique = [...new Set(publicIds.filter(Boolean))];
  if (unique.length === 0) return [];

  const stillReferenced = await tx.productMedia.findMany({
    where: {
      publicId: { in: unique },
      status: { not: MediaStatus.ARCHIVED },
    },
    select: { publicId: true },
  });

  const held = new Set(stillReferenced.map((m) => m.publicId));
  return unique.filter((id) => !held.has(id));
}

/**
 * Destroy assets that nothing references any more.
 *
 * Call AFTER the surrounding transaction commits: a destroy cannot be rolled
 * back, so running it inside a transaction that later aborts would delete an
 * asset the database still points at.
 *
 * A failure here is logged and left alone rather than retried into oblivion. The
 * ticket keeps the publicId, so the sweep can try again — the one outcome that
 * must never happen is a row losing its publicId while the file survives, which
 * is what makes an asset unreachable and bill forever.
 */
export async function destroySafely(publicIds: string[]): Promise<string[]> {
  const safe = await destroyable(prisma, publicIds);
  const skipped = publicIds.filter((id) => id && !safe.includes(id));

  if (skipped.length > 0) {
    log.info({ skipped }, 'kept Cloudinary assets that other media still reference');
  }
  if (safe.length === 0) return [];

  await destroyAssets(safe);
  await prisma.uploadTicket.updateMany({
    where: { publicId: { in: safe } },
    data: { status: UploadTicketStatus.DISCARDED },
  });
  return safe;
}
