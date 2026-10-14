/**
 * The library side of an upload, with Cloudinary's Admin API simulated.
 *
 * Proves what the server does with an upload the browser just finished:
 * facts come from Cloudinary (never the client), only uploads this API signed
 * are accepted, the ticket is marked ATTACHED so the orphan sweep keeps it,
 * and a replacement keeps the old file recorded rather than destroyed.
 *
 * The real network round trip to Cloudinary is NOT exercised here.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MediaType, PrismaClient, UploadTicketStatus } from '@prisma/client';
import { ns, sweepFixtures, testActor, testCtx } from '@/test/fixtures';

const probe = vi.fn();
vi.mock('@/integrations/cloudinary/cloudinary.service', async (orig) => ({
  ...(await orig<object>()),
  probeAsset: (...a: unknown[]) => probe(...a),
}));
vi.mock('@/config/env', async (orig) => {
  const actual = (await orig<{ env: Record<string, unknown> }>()).env;
  return { env: { ...actual, CLOUDINARY_CLOUD_NAME: 'testcloud', STOREFRONT_ORIGIN: 'https://shop.example' } };
});

// vi.mock is hoisted above imports, so a static import receives the mocks.
import * as media from './media.service';

const prisma = new PrismaClient();
let actorId = '';
const publicIds: string[] = [];

async function ticket(label: string, resourceType = 'image') {
  const publicId = `zewa/site/${ns(label)}`;
  publicIds.push(publicId);
  await prisma.uploadTicket.create({ data: { publicId, resourceType, folder: 'zewa/site', status: UploadTicketStatus.UPLOADED } });
  return publicId;
}

beforeAll(async () => {
  await sweepFixtures(prisma);
  actorId = await testActor(prisma);
});

afterAll(async () => {
  await prisma.mediaAsset.deleteMany({ where: { OR: [{ publicId: { in: publicIds } }, { previousPublicIds: { hasSome: publicIds } }] } });
  await prisma.uploadTicket.deleteMany({ where: { publicId: { in: publicIds } } });
  await prisma.$disconnect();
});

describe('registering an upload', () => {
  it('takes dimensions and format from Cloudinary and marks the ticket ATTACHED', async () => {
    const publicId = await ticket('reg');
    probe.mockResolvedValueOnce({ exists: true, ready: true, width: 1920, height: 814, format: 'jpg', bytes: 250_000, secureUrl: `https://res.cloudinary.com/testcloud/image/upload/v1/${publicId}.jpg` });

    const row = await media.registerUpload({ publicId, title: 'Hero', altText: 'Hero banner' }, actorId, testCtx(actorId));
    expect(row).toMatchObject({ storage: 'CLOUDINARY', type: MediaType.IMAGE, width: 1920, height: 814, format: 'jpg', mimeType: 'image/jpeg', displayUrl: row.url });
    expect((await prisma.uploadTicket.findUnique({ where: { publicId } }))?.status).toBe(UploadTicketStatus.ATTACHED);

    // A double-click registers once.
    const again = await media.registerUpload({ publicId }, actorId, testCtx(actorId));
    expect(again.id).toBe(row.id);
  });

  it('refuses a publicId this API never signed', async () => {
    await expect(media.registerUpload({ publicId: 'zewa/site/forged' }, actorId, testCtx(actorId))).rejects.toMatchObject({ status: 422 });
  });

  it('refuses when Cloudinary has no such file, and reports an unreachable Cloudinary as retryable', async () => {
    const missing = await ticket('missing');
    probe.mockResolvedValueOnce({ exists: false, ready: false });
    await expect(media.registerUpload({ publicId: missing }, actorId, testCtx(actorId))).rejects.toMatchObject({ status: 422 });
    probe.mockResolvedValueOnce(null);
    await expect(media.registerUpload({ publicId: missing }, actorId, testCtx(actorId))).rejects.toMatchObject({ status: 502 });
  });
});

describe('replacing a file', () => {
  it('keeps the id, records the old file, and refuses a different kind', async () => {
    const first = await ticket('v1');
    probe.mockResolvedValueOnce({ exists: true, ready: true, width: 800, height: 800, format: 'png', bytes: 1, secureUrl: `https://res.cloudinary.com/testcloud/image/upload/${first}.png` });
    const row = await media.registerUpload({ publicId: first }, actorId, testCtx(actorId));

    const second = await ticket('v2');
    probe.mockResolvedValueOnce({ exists: true, ready: true, width: 1600, height: 1600, format: 'png', bytes: 2, secureUrl: `https://res.cloudinary.com/testcloud/image/upload/${second}.png` });
    const replaced = await media.replaceFile(row.id, second, testCtx(actorId));
    expect(replaced).toMatchObject({ id: row.id, width: 1600, revision: 2 });
    const stored = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.previousPublicIds).toEqual([first]);

    const video = await ticket('vid', 'video');
    probe.mockResolvedValueOnce({ exists: true, ready: true, width: 1920, height: 1080, format: 'mp4', bytes: 3 });
    await expect(media.replaceFile(row.id, video, testCtx(actorId))).rejects.toMatchObject({ status: 422 });
  });
});

describe('display URLs', () => {
  it('makes storefront-served files loadable from the CMS, encoding every path segment', () => {
    expect(media.displayUrlFor('STATIC', '/Website_ Milestones/Incorporation& first office.jpg')).toBe(
      'https://shop.example/Website_%20Milestones/Incorporation%26%20first%20office.jpg',
    );
    expect(media.displayUrlFor('CLOUDINARY', 'https://res.cloudinary.com/x.jpg')).toBe('https://res.cloudinary.com/x.jpg');
  });
});
