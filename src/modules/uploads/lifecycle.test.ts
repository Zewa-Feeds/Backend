/**
 * Media lifecycle against the real database.
 *
 * PENDING → READY → ARCHIVED, and the two rules that protect real money and a
 * live storefront: a shared Cloudinary asset is never destroyed because one
 * reference went away, and nothing that is not READY reaches a customer.
 *
 * Runs against the local Postgres from `npm run test:setup`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { MediaStatus, MediaType, PrismaClient, UploadTicketStatus } from '@prisma/client';
import { ns, sweepFixtures } from '@/test/fixtures';
import * as cloudinary from '@/integrations/cloudinary/cloudinary.service';
import {
  applyNotification, destroyable, destroySafely, initialStatus, markAttached, openTicket,
} from './lifecycle.service';

const prisma = new PrismaClient();
const CDN = 'https://res.cloudinary.com/test';

beforeAll(async () => { await sweepFixtures(prisma); });
afterAll(async () => {
  await sweepFixtures(prisma);
  await prisma.uploadTicket.deleteMany({ where: { publicId: { startsWith: 'zz' } } });
  await prisma.$disconnect();
});

let destroySpy: MockInstance<(publicIds: string[]) => Promise<void>>;
beforeEach(() => {
  // Never call Cloudinary from a test. What matters is WHICH ids we would have
  // destroyed, and that is the whole point of the guard being tested.
  destroySpy = vi.spyOn(cloudinary, 'destroyAssets').mockResolvedValue(undefined);
});

/** A product with one variant, and a media row in a given state. */
async function seed(opts: {
  type?: MediaType;
  status?: MediaStatus;
  publicId?: string;
}) {
  const slug = ns('life');
  const family = await prisma.productFamily.create({
    data: { slug, name: 'Lifecycle Test', shortDesc: 'x', category: 'BETTA', status: 'DRAFT' },
    select: { id: true },
  });
  const variant = await prisma.productVariant.create({
    data: {
      familyId: family.id, sku: `${slug.toUpperCase()}-1KG`, pack: '1kg',
      mrpPaise: 100, pricePaise: 100, stock: 1, position: 0,
    },
    select: { id: true },
  });
  const type = opts.type ?? MediaType.IMAGE;
  const publicId = opts.publicId ?? `zz/${slug}/asset`;
  const media = await prisma.productMedia.create({
    data: {
      familyId: family.id, type, url: `${CDN}/${slug}.jpg`, alt: 'a', position: 0,
      publicId, status: opts.status ?? initialStatus(type), variantId: variant.id,
    },
    select: { id: true, status: true },
  });
  return { familyId: family.id, variantId: variant.id, mediaId: media.id, publicId, slug };
}

describe('initial status', () => {
  it('an image is READY: its ingest transform runs inline', () => {
    expect(initialStatus(MediaType.IMAGE)).toBe(MediaStatus.READY);
  });

  it('a video is PENDING: transcoding continues after the upload returns', () => {
    expect(initialStatus(MediaType.VIDEO)).toBe(MediaStatus.PENDING);
  });
});

describe('notifications', () => {
  it('promotes a PENDING video to READY', async () => {
    const s = await seed({ type: MediaType.VIDEO });
    expect((await prisma.productMedia.findUniqueOrThrow({ where: { id: s.mediaId } })).status)
      .toBe(MediaStatus.PENDING);

    const r = await applyNotification({ publicId: s.publicId, outcome: 'READY', width: 1920, height: 1080 });
    expect(r.media).toBe('promoted');

    const after = await prisma.productMedia.findUniqueOrThrow({ where: { id: s.mediaId } });
    expect(after.status).toBe(MediaStatus.READY);
    expect(after.width).toBe(1920);
  });

  it('marks a failed upload FAILED', async () => {
    const s = await seed({ type: MediaType.VIDEO });
    const r = await applyNotification({ publicId: s.publicId, outcome: 'FAILED', reason: 'too big' });
    expect(r.media).toBe('failed');
    expect((await prisma.productMedia.findUniqueOrThrow({ where: { id: s.mediaId } })).status)
      .toBe(MediaStatus.FAILED);
  });

  it('is idempotent — a duplicate notification changes nothing', async () => {
    const s = await seed({ type: MediaType.VIDEO });
    const first = await applyNotification({ publicId: s.publicId, outcome: 'READY' });
    const second = await applyNotification({ publicId: s.publicId, outcome: 'READY' });
    expect(first.media).toBe('promoted');
    expect(second.media).toBe('unchanged');
  });

  it('a late FAILED cannot demote an asset that is already READY', async () => {
    const s = await seed({ type: MediaType.VIDEO });
    await applyNotification({ publicId: s.publicId, outcome: 'READY' });
    const late = await applyNotification({ publicId: s.publicId, outcome: 'FAILED', reason: 'stale' });
    expect(late.media).toBe('unchanged');
    expect((await prisma.productMedia.findUniqueOrThrow({ where: { id: s.mediaId } })).status)
      .toBe(MediaStatus.READY);
  });

  it('never revives an ARCHIVED asset — the operator outranks a stale notification', async () => {
    const s = await seed({ type: MediaType.VIDEO, status: MediaStatus.ARCHIVED });
    const r = await applyNotification({ publicId: s.publicId, outcome: 'READY' });
    expect(r.media).toBe('unchanged');
    expect((await prisma.productMedia.findUniqueOrThrow({ where: { id: s.mediaId } })).status)
      .toBe(MediaStatus.ARCHIVED);
  });

  it('lets a retry rescue a FAILED asset', async () => {
    const s = await seed({ type: MediaType.VIDEO, status: MediaStatus.FAILED });
    const r = await applyNotification({ publicId: s.publicId, outcome: 'READY' });
    expect(r.media).toBe('promoted');
  });

  it('handles a notification for an asset no row references', async () => {
    const r = await applyNotification({ publicId: 'zz/nothing/here', outcome: 'READY' });
    expect(r).toEqual({ ticket: 'absent', media: 'absent' });
  });

  it('creates no duplicate media row, ever', async () => {
    const s = await seed({ type: MediaType.VIDEO });
    for (let i = 0; i < 5; i++) await applyNotification({ publicId: s.publicId, outcome: 'READY' });
    expect(await prisma.productMedia.count({ where: { publicId: s.publicId } })).toBe(1);
  });
});

describe('tickets', () => {
  it('records a minted signature', async () => {
    const publicId = `zz/${ns('t')}/a`;
    await openTicket({ publicId, resourceType: 'image', folder: 'zewa/products' });
    const t = await prisma.uploadTicket.findUniqueOrThrow({ where: { publicId } });
    expect(t.status).toBe(UploadTicketStatus.SIGNED);
  });

  it('re-minting the same id is a retry, not a second asset', async () => {
    const publicId = `zz/${ns('t')}/a`;
    await openTicket({ publicId, resourceType: 'image', folder: 'zewa/products' });
    await openTicket({ publicId, resourceType: 'image', folder: 'zewa/products' });
    expect(await prisma.uploadTicket.count({ where: { publicId } })).toBe(1);
  });

  it('a ticket already ATTACHED is not demoted by a later notification', async () => {
    const s = await seed({ type: MediaType.VIDEO });
    await openTicket({ publicId: s.publicId, resourceType: 'video', folder: 'zewa/products' });
    await markAttached(prisma, [s.publicId]);

    await applyNotification({ publicId: s.publicId, outcome: 'READY' });

    const t = await prisma.uploadTicket.findUniqueOrThrow({ where: { publicId: s.publicId } });
    expect(t.status).toBe(UploadTicketStatus.ATTACHED);
  });
});

describe('destruction safety', () => {
  it('destroys an asset nothing references any more', async () => {
    const s = await seed({});
    await prisma.productMedia.update({
      where: { id: s.mediaId }, data: { status: MediaStatus.ARCHIVED, archivedAt: new Date() },
    });
    expect(await destroyable(prisma, [s.publicId])).toEqual([s.publicId]);
  });

  it('REFUSES to destroy an asset another row still shows', async () => {
    /*
     * The case that costs real money and breaks a live page: two rows share one
     * file, one is archived, and destroying it 404s the other.
     */
    const s = await seed({});
    const other = await prisma.productMedia.create({
      data: {
        familyId: s.familyId, type: MediaType.IMAGE, url: `${CDN}/shared.jpg`, alt: 'a',
        position: 1, publicId: s.publicId, status: MediaStatus.READY,
      },
      select: { id: true },
    });
    await prisma.productMedia.update({
      where: { id: s.mediaId }, data: { status: MediaStatus.ARCHIVED, archivedAt: new Date() },
    });

    expect(await destroyable(prisma, [s.publicId])).toEqual([]);
    await destroySafely([s.publicId]);
    expect(destroySpy).not.toHaveBeenCalled();
    // The surviving row is untouched.
    expect((await prisma.productMedia.findUniqueOrThrow({ where: { id: other.id } })).status)
      .toBe(MediaStatus.READY);
  });

  it('counts a PENDING row as a live reference', async () => {
    const s = await seed({ type: MediaType.VIDEO });
    expect(await destroyable(prisma, [s.publicId])).toEqual([]);
  });

  it('counts a FAILED row as a live reference — a retry may still rescue it', async () => {
    const s = await seed({ status: MediaStatus.FAILED });
    expect(await destroyable(prisma, [s.publicId])).toEqual([]);
  });

  it('closes the ticket once the asset is destroyed', async () => {
    const s = await seed({});
    await openTicket({ publicId: s.publicId, resourceType: 'image', folder: 'zewa/products' });
    await prisma.productMedia.update({
      where: { id: s.mediaId }, data: { status: MediaStatus.ARCHIVED, archivedAt: new Date() },
    });

    await destroySafely([s.publicId]);
    expect(destroySpy).toHaveBeenCalledWith([s.publicId]);
    expect((await prisma.uploadTicket.findUniqueOrThrow({ where: { publicId: s.publicId } })).status)
      .toBe(UploadTicketStatus.DISCARDED);
  });

  it('ignores empty and duplicate ids', async () => {
    expect(await destroyable(prisma, [])).toEqual([]);
    const s = await seed({});
    await prisma.productMedia.update({
      where: { id: s.mediaId }, data: { status: MediaStatus.ARCHIVED, archivedAt: new Date() },
    });
    expect(await destroyable(prisma, [s.publicId, s.publicId])).toEqual([s.publicId]);
  });
});
