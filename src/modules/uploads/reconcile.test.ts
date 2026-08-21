/**
 * Reconciliation: what happens when the webhook never arrives.
 *
 * Notifications get lost — a deploy mid-flight, an outage, a URL that was wrong
 * for an hour. Without a way to ask Cloudinary directly, a video sits PENDING
 * forever and an abandoned upload bills forever. Both sweeps are deliberately
 * conservative, and what these pin is the conservatism: anything uncertain is
 * left alone.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { MediaStatus, MediaType, PrismaClient, UploadTicketStatus } from '@prisma/client';
import { ns, sweepFixtures } from '@/test/fixtures';
import * as cloudinary from '@/integrations/cloudinary/cloudinary.service';
import { resolveStuckPending, sweepOrphans } from './reconcile.service';

const prisma = new PrismaClient();
const CDN = 'https://res.cloudinary.com/test';
const HOUR = 60 * 60 * 1000;

beforeAll(async () => { await sweepFixtures(prisma); });
afterAll(async () => {
  await sweepFixtures(prisma);
  await prisma.uploadTicket.deleteMany({ where: { publicId: { startsWith: 'zz' } } });
  await prisma.$disconnect();
});

let probe: MockInstance<typeof cloudinary.probeAsset>;
let destroy: MockInstance<(ids: string[]) => Promise<void>>;
beforeEach(() => {
  probe = vi.spyOn(cloudinary, 'probeAsset');
  destroy = vi.spyOn(cloudinary, 'destroyAssets').mockResolvedValue(undefined);
});

async function pendingVideo() {
  const slug = ns('recon');
  const family = await prisma.productFamily.create({
    data: { slug, name: 'Reconcile Test', shortDesc: 'x', category: 'BETTA', status: 'DRAFT' },
    select: { id: true },
  });
  const media = await prisma.productMedia.create({
    data: {
      familyId: family.id, type: MediaType.VIDEO, url: `${CDN}/${slug}.mp4`, alt: 'a',
      position: 0, publicId: `zz/${slug}/vid`, status: MediaStatus.PENDING,
    },
    select: { id: true, publicId: true },
  });
  return { familyId: family.id, mediaId: media.id, publicId: media.publicId as string };
}

const statusOf = async (id: string) =>
  (await prisma.productMedia.findUniqueOrThrow({ where: { id } })).status;

describe('stuck PENDING media', () => {
  it('is promoted when Cloudinary says the derivative is done', async () => {
    const v = await pendingVideo();
    probe.mockResolvedValue({ exists: true, ready: true, width: 1920, height: 1080, durationSec: 30 });

    const r = await resolveStuckPending();
    expect(r.promoted).toBeGreaterThanOrEqual(1);
    expect(await statusOf(v.mediaId)).toBe(MediaStatus.READY);
  });

  it('is FAILED when the asset is genuinely absent', async () => {
    const v = await pendingVideo();
    probe.mockResolvedValue({ exists: false, ready: false });

    await resolveStuckPending();
    expect(await statusOf(v.mediaId)).toBe(MediaStatus.FAILED);
  });

  it('is left alone while it is still transcoding', async () => {
    const v = await pendingVideo();
    probe.mockResolvedValue({ exists: true, ready: false });

    await resolveStuckPending();
    expect(await statusOf(v.mediaId)).toBe(MediaStatus.PENDING);
  });

  it('is left alone when Cloudinary cannot be reached', async () => {
    /*
     * The important negative. A network failure must never be read as "the asset
     * is missing" — that would fail perfectly good media on every outage.
     */
    const v = await pendingVideo();
    probe.mockResolvedValue(null);

    const r = await resolveStuckPending();
    expect(r.skippedUnknown).toBeGreaterThanOrEqual(1);
    expect(await statusOf(v.mediaId)).toBe(MediaStatus.PENDING);
  });

  it('skips media whose upload is still recent', async () => {
    const v = await pendingVideo();
    // A ticket minted just now means the upload could still be in flight.
    await prisma.uploadTicket.create({
      data: { publicId: v.publicId, resourceType: 'video', folder: 'zewa/products' },
    });
    probe.mockResolvedValue({ exists: false, ready: false });

    await resolveStuckPending();
    expect(await statusOf(v.mediaId)).toBe(MediaStatus.PENDING);
    // Scoped to THIS asset: earlier tests leave their own PENDING rows behind,
    // and the sweep is entitled to look at those.
    expect(probe).not.toHaveBeenCalledWith(v.publicId, expect.anything());
  });
});

describe('orphan sweep', () => {
  /** A ticket old enough to be considered abandoned. */
  async function oldTicket(status: UploadTicketStatus = UploadTicketStatus.UPLOADED) {
    const publicId = `zz/${ns('orph')}/a`;
    await prisma.uploadTicket.create({
      data: {
        publicId, resourceType: 'image', folder: 'zewa/products', status,
        createdAt: new Date(Date.now() - 12 * HOUR),
      },
    });
    return publicId;
  }

  it('destroys an asset that was uploaded and never attached', async () => {
    const publicId = await oldTicket();
    probe.mockResolvedValue({ exists: true, ready: true });

    const r = await sweepOrphans();
    expect(r.orphansDestroyed).toBeGreaterThanOrEqual(1);
    expect(destroy).toHaveBeenCalledWith(expect.arrayContaining([publicId]));
  });

  it('leaves an asset alone when a ProductMedia row references it', async () => {
    const publicId = await oldTicket();
    const slug = ns('held');
    const family = await prisma.productFamily.create({
      data: { slug, name: 'Held', shortDesc: 'x', category: 'BETTA', status: 'DRAFT' },
      select: { id: true },
    });
    await prisma.productMedia.create({
      data: {
        familyId: family.id, type: MediaType.IMAGE, url: `${CDN}/${slug}.jpg`, alt: 'a',
        position: 0, publicId, status: MediaStatus.READY,
      },
    });
    probe.mockResolvedValue({ exists: true, ready: true });

    await sweepOrphans();
    expect(destroy).not.toHaveBeenCalledWith(expect.arrayContaining([publicId]));
  });

  it('never touches an ATTACHED ticket', async () => {
    await oldTicket(UploadTicketStatus.ATTACHED);
    probe.mockResolvedValue({ exists: true, ready: true });

    const r = await sweepOrphans();
    expect(r.orphansFound).toBe(0);
  });

  it('spares anything inside the grace period', async () => {
    const publicId = `zz/${ns('fresh')}/a`;
    await prisma.uploadTicket.create({
      data: { publicId, resourceType: 'image', folder: 'zewa/products', status: UploadTicketStatus.UPLOADED },
    });
    probe.mockResolvedValue({ exists: true, ready: true });

    await sweepOrphans();
    expect(destroy).not.toHaveBeenCalledWith(expect.arrayContaining([publicId]));
  });

  it('closes a ticket whose signature was never used', async () => {
    const publicId = await oldTicket(UploadTicketStatus.SIGNED);
    probe.mockResolvedValue({ exists: false, ready: false });

    await sweepOrphans();
    expect((await prisma.uploadTicket.findUniqueOrThrow({ where: { publicId } })).status)
      .toBe(UploadTicketStatus.DISCARDED);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('destroys nothing when Cloudinary cannot be reached', async () => {
    await oldTicket();
    probe.mockResolvedValue(null);

    await sweepOrphans();
    expect(destroy).not.toHaveBeenCalled();
  });
});
