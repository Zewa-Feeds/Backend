/**
 * Reconciliation: make Cloudinary and the database agree.
 *
 * Two failure modes this repairs, both of which are invisible without it.
 *
 * STUCK MEDIA. A video sits PENDING because its notification never arrived — a
 * deploy mid-flight, an outage, a URL that was wrong for an hour. Nothing else
 * would ever move it, so a perfectly good asset would stay hidden from customers
 * forever. Asking Cloudinary directly resolves it.
 *
 * ORPHANS. A signature was minted, the browser uploaded, and the CMS never
 * saved — the tab closed, the network dropped, the save failed validation. The
 * asset exists in the account and bills, and no row references it. The ticket
 * ledger is what makes those findable at all.
 *
 * Both are conservative by construction: anything uncertain is left alone. An
 * asset is only destroyed when Cloudinary confirms it exists, no ProductMedia
 * references it, and it is old enough that no upload could still be in flight.
 */
import { MediaStatus, MediaType, UploadTicketStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { probeAsset } from '@/integrations/cloudinary/cloudinary.service';
import { applyNotification, destroySafely } from './lifecycle.service';

const log = logger.child({ module: 'media-reconcile' });

/**
 * How long an upload gets before it is considered abandoned.
 *
 * Generous on purpose. A 100 MB video on a slow connection can take many
 * minutes, and the operator may then spend longer still editing before saving.
 * Destroying an asset somebody is about to attach is far worse than paying for
 * an extra hour of storage.
 */
const ORPHAN_GRACE_MS = 6 * 60 * 60 * 1000;

/**
 * How long media may stay PENDING before we go and ask.
 *
 * Long enough that the webhook is genuinely late rather than merely in transit.
 */
const STUCK_PENDING_MS = 10 * 60 * 1000;

export interface ReconcileReport {
  pendingChecked: number;
  promoted: number;
  failed: number;
  orphansFound: number;
  orphansDestroyed: number;
  skippedUnknown: number;
}

/**
 * Resolve media stuck in PENDING by asking Cloudinary.
 *
 * Uses the same transition as the webhook, so a sweep and a late notification
 * racing each other produce one outcome rather than two.
 */
export async function resolveStuckPending(now = Date.now()): Promise<Partial<ReconcileReport>> {
  /*
   * Aged by the TICKET's clock, not the media row's — ProductMedia has no
   * timestamp of its own. The ticket is written when the signature is minted, so
   * its age is the age of the upload, which is exactly the thing being waited on.
   *
   * Media without a ticket (anything predating this system) is checked too:
   * there is nothing to age it by, and a stuck row is worth resolving whatever
   * created it.
   */
  const cutoff = new Date(now - STUCK_PENDING_MS);
  const recentTickets = await prisma.uploadTicket.findMany({
    where: { createdAt: { gte: cutoff } },
    select: { publicId: true },
  });
  const tooRecent = recentTickets.map((t) => t.publicId);

  const stuck = await prisma.productMedia.findMany({
    where: {
      status: MediaStatus.PENDING,
      NOT: [{ publicId: null }, ...(tooRecent.length ? [{ publicId: { in: tooRecent } }] : [])],
    },
    select: { id: true, publicId: true, type: true },
    take: 100,
  });

  let promoted = 0;
  let failed = 0;
  let skippedUnknown = 0;

  for (const media of stuck) {
    const probe = await probeAsset(
      media.publicId as string,
      media.type === MediaType.VIDEO ? 'video' : 'image',
    );

    // null means the question could not be answered. Leave it PENDING and try
    // again next sweep rather than guessing.
    if (!probe) {
      skippedUnknown += 1;
      continue;
    }

    if (!probe.exists) {
      await applyNotification({
        publicId: media.publicId as string,
        outcome: 'FAILED',
        reason: 'asset not found in Cloudinary',
      });
      failed += 1;
      continue;
    }

    if (!probe.ready) continue; // still transcoding; genuinely pending

    await applyNotification({
      publicId: media.publicId as string,
      outcome: 'READY',
      width: probe.width ?? null,
      height: probe.height ?? null,
      durationSec: probe.durationSec ?? null,
    });
    promoted += 1;
  }

  return { pendingChecked: stuck.length, promoted, failed, skippedUnknown };
}

/**
 * Destroy assets that were uploaded but never attached to anything.
 *
 * Four conditions must ALL hold before anything is destroyed: the ticket is past
 * the grace period, it is not ATTACHED, no ProductMedia row references the
 * publicId, and Cloudinary confirms the asset exists. `destroySafely` re-checks
 * the reference itself, so a race between this sweep and an operator saving the
 * asset resolves in the operator's favour.
 */
export async function sweepOrphans(now = Date.now()): Promise<Partial<ReconcileReport>> {
  const candidates = await prisma.uploadTicket.findMany({
    where: {
      status: { in: [UploadTicketStatus.SIGNED, UploadTicketStatus.UPLOADED] },
      createdAt: { lt: new Date(now - ORPHAN_GRACE_MS) },
    },
    select: { id: true, publicId: true, resourceType: true },
    take: 100,
  });

  if (candidates.length === 0) return { orphansFound: 0, orphansDestroyed: 0 };

  // A ticket whose asset is referenced is not an orphan, whatever its status says.
  const referenced = await prisma.productMedia.findMany({
    where: {
      publicId: { in: candidates.map((c) => c.publicId) },
      status: { not: MediaStatus.ARCHIVED },
    },
    select: { publicId: true },
  });
  const held = new Set(referenced.map((r) => r.publicId));

  const orphans = candidates.filter((c) => !held.has(c.publicId));
  let destroyed = 0;

  for (const orphan of orphans) {
    const probe = await probeAsset(
      orphan.publicId,
      orphan.resourceType === 'video' ? 'video' : 'image',
    );

    if (!probe) continue; // unknown — try again next sweep

    if (!probe.exists) {
      // The signature was never used. Close the ticket; there is nothing to bill.
      await prisma.uploadTicket.update({
        where: { id: orphan.id },
        data: { status: UploadTicketStatus.DISCARDED },
      });
      continue;
    }

    const removed = await destroySafely([orphan.publicId]);
    if (removed.length > 0) destroyed += 1;
  }

  if (orphans.length > 0) {
    log.info({ found: orphans.length, destroyed }, 'orphaned Cloudinary assets swept');
  }
  return { orphansFound: orphans.length, orphansDestroyed: destroyed };
}

/** Both sweeps. Safe to run repeatedly; nothing here is destructive by accident. */
export async function reconcileMediaLifecycle(now = Date.now()): Promise<ReconcileReport> {
  const pending = await resolveStuckPending(now);
  const orphans = await sweepOrphans(now);
  return {
    pendingChecked: 0, promoted: 0, failed: 0,
    orphansFound: 0, orphansDestroyed: 0, skippedUnknown: 0,
    ...pending, ...orphans,
  };
}
