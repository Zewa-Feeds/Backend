/**
 * Only READY media reaches a customer.
 *
 * Each of the other three states is a distinct way to break a live page:
 * ARCHIVED was removed by an operator, FAILED never processed so its URL 404s,
 * and PENDING is a video whose derived version does not exist yet. This walks
 * the real serializer for each one, across every customer-facing field.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MediaStatus, MediaType, PrismaClient } from '@prisma/client';
import { FAMILY_SELECT, serializePublic } from './products.serializer';
import { ns, sweepFixtures } from '@/test/fixtures';

const prisma = new PrismaClient();
const CDN = 'https://res.cloudinary.com/test';

beforeAll(async () => { await sweepFixtures(prisma); });
afterAll(async () => { await sweepFixtures(prisma); await prisma.$disconnect(); });

/** One product, one pack, and one media row in the given state. */
async function build(status: MediaStatus, type: MediaType = MediaType.IMAGE) {
  const slug = ns('filter');
  const family = await prisma.productFamily.create({
    data: { slug, name: 'Filter Test', shortDesc: 'x', category: 'BETTA', status: 'ACTIVE' },
    select: { id: true },
  });
  const variant = await prisma.productVariant.create({
    data: {
      familyId: family.id, sku: `${slug.toUpperCase()}-1KG`, pack: '1kg',
      mrpPaise: 100, pricePaise: 100, stock: 5, position: 0,
    },
    select: { id: true },
  });
  const media = await prisma.productMedia.create({
    data: {
      familyId: family.id, type, url: `${CDN}/${slug}.jpg`, alt: 'a', position: 0,
      publicId: `zz/${slug}`, status, variantId: variant.id,
      ...(type === MediaType.VIDEO ? { posterUrl: `${CDN}/${slug}-poster.jpg` } : {}),
    },
    select: { id: true },
  });
  return { slug, familyId: family.id, variantId: variant.id, mediaId: media.id };
}

const load = async (slug: string) =>
  serializePublic(
    await prisma.productFamily.findUniqueOrThrow({ where: { slug }, select: FAMILY_SELECT }),
  );

describe.each([
  [MediaStatus.PENDING, 'still processing'],
  [MediaStatus.FAILED, 'never processed'],
  [MediaStatus.ARCHIVED, 'removed by an operator'],
])('%s media (%s)', (status, _why) => {
  it('never reaches any customer-facing field', async () => {
    const b = await build(status);
    const p = await load(b.slug);

    expect(p.media).toHaveLength(0);
    expect(p.images).toHaveLength(0);
    expect(p.packs[0]!.gallery.items).toHaveLength(0);
    expect(p.packs[0]!.gallery.coverage).toBe('EMPTY');
    expect(p.packs[0]!.gallery.heroMediaId).toBeNull();
    expect(p.packs[0]!.gallery.presentation.orderedIds).toHaveLength(0);
    // Listing card, which feeds the grid, the homepage, OG and JSON-LD.
    expect(p.listing.heroUrl).toBeNull();
    expect(p.listing.videoUrl).toBeNull();
    expect(p.listing.posterUrl).toBeNull();
    expect(p.listing.coverage).toBe('EMPTY');
  });

  it('cannot be the hero even when a variant points at it', async () => {
    const b = await build(status);
    await prisma.productVariant.update({
      where: { id: b.variantId }, data: { heroMediaId: b.mediaId },
    });
    const p = await load(b.slug);
    expect(p.packs[0]!.gallery.heroMediaId).toBeNull();
    expect(p.listing.heroUrl).toBeNull();
  });
});

describe('READY media', () => {
  it('reaches every customer-facing field', async () => {
    const b = await build(MediaStatus.READY);
    const p = await load(b.slug);

    expect(p.media).toHaveLength(1);
    expect(p.images).toHaveLength(1);
    expect(p.packs[0]!.gallery.items).toHaveLength(1);
    expect(p.packs[0]!.gallery.coverage).toBe('EXACT');
    expect(p.listing.heroUrl).toContain(b.slug);
  });
});

describe('a mixed gallery', () => {
  it('shows the finished assets and hides the rest', async () => {
    const b = await build(MediaStatus.READY);

    for (const [i, status] of [MediaStatus.PENDING, MediaStatus.FAILED, MediaStatus.ARCHIVED].entries()) {
      await prisma.productMedia.create({
        data: {
          familyId: b.familyId, type: MediaType.IMAGE, url: `${CDN}/${b.slug}-${status}.jpg`,
          alt: 'a', position: i + 1, publicId: `zz/${b.slug}-${status}`, status,
          variantId: b.variantId,
        },
      });
    }

    const p = await load(b.slug);
    expect(p.media).toHaveLength(1);
    expect(p.packs[0]!.gallery.items).toHaveLength(1);
    expect(p.packs[0]!.gallery.items[0]!.url).toBe(`${CDN}/${b.slug}.jpg`);
  });

  it('a PENDING video does not become the card’s hover film', async () => {
    const b = await build(MediaStatus.READY);
    await prisma.productMedia.create({
      data: {
        familyId: b.familyId, type: MediaType.VIDEO, url: `${CDN}/${b.slug}.mp4`,
        posterUrl: `${CDN}/${b.slug}-poster.jpg`, alt: 'film', position: 1,
        publicId: `zz/${b.slug}-vid`, status: MediaStatus.PENDING,
      },
    });

    const p = await load(b.slug);
    expect(p.listing.videoUrl).toBeNull();
    expect(p.packs[0]!.gallery.presentation.videoId).toBeNull();
  });

  it('the same video appears once it is READY', async () => {
    const b = await build(MediaStatus.READY);
    const vid = await prisma.productMedia.create({
      data: {
        familyId: b.familyId, type: MediaType.VIDEO, url: `${CDN}/${b.slug}.mp4`,
        posterUrl: `${CDN}/${b.slug}-poster.jpg`, alt: 'film', position: 1,
        publicId: `zz/${b.slug}-vid2`, status: MediaStatus.PENDING,
      },
      select: { id: true },
    });

    await prisma.productMedia.update({ where: { id: vid.id }, data: { status: MediaStatus.READY } });

    const p = await load(b.slug);
    expect(p.listing.videoUrl).toContain(b.slug);
    expect(p.packs[0]!.gallery.presentation.videoId).toBe(vid.id);
  });
});
