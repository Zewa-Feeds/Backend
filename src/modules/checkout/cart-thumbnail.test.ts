/**
 * Cart line thumbnails.
 *
 * The listing card and the product page were made variant-aware; the cart was
 * still showing the family's first image, so a shopper could see a 45g bottle
 * throughout the shop and a 1kg pouch in their basket. These pin that all three
 * surfaces answer the same way.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MediaStatus, MediaType, PrismaClient } from '@prisma/client';
import { sweepFixtures } from '@/test/fixtures';
import { priceCart } from './pricing.service';
import * as settingsService from '@/modules/settings/settings.service';

const prisma = new PrismaClient();

/* Clear anything an earlier crashed run left behind. */
beforeAll(async () => {
  await sweepFixtures(prisma);
});

/*
 * Warm Redis before the timer starts.
 *
 * `priceCart` reads tax and shipping settings, which are cached in Redis — a
 * remote instance, ~260ms per round trip warm and ~3.9s on a cold connect. This
 * is the only test file that touches Redis at all, and it runs last, by which
 * point the client has been idle for the length of the suite. Paying the
 * connect here means a reconnect cannot land inside a test's 45s budget and be
 * reported as a failure of media resolution, which is what these tests actually
 * cover.
 *
 * Nothing is mocked: the tests still exercise the real priceCart path.
 */
beforeAll(async () => {
  await settingsService.getAll();
}, 60_000);

// Redis is closed by the shared vitest.setup.ts teardown, for every file.
afterAll(async () => prisma.$disconnect());

const CDN = 'https://res.cloudinary.com/test';

interface Built {
  familyId: string;
  sku45: string;
  sku45x2: string;
  sku1kg: string;
  v45: string;
  v45x2: string;
  v1kg: string;
}

async function withProduct<T>(fn: (b: Built) => Promise<T>): Promise<T> {
  const ns = `ZZCART${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const family = await prisma.productFamily.create({
    data: {
      slug: ns.toLowerCase(), name: 'Cart Test', shortDesc: 'x',
      category: 'BETTA', status: 'ACTIVE',
    },
    select: { id: true },
  });
  try {
    const mk = (suffix: string, pack: string, position: number, baseVariantId?: string) =>
      prisma.productVariant.create({
        data: {
          familyId: family.id, sku: `${ns}-${suffix}`, pack, position,
          mrpPaise: 10000, pricePaise: 10000, stock: 50, baseVariantId,
        },
        select: { id: true, sku: true },
      });

    const v45 = await mk('45G', '45g Bottle', 0);
    const v45x2 = await mk('45GX2', '45g x 2', 1, v45.id);
    const v1kg = await mk('1KG', '1kg Pouch', 2);

    return await fn({
      familyId: family.id,
      sku45: v45.sku, sku45x2: v45x2.sku, sku1kg: v1kg.sku,
      v45: v45.id, v45x2: v45x2.id, v1kg: v1kg.id,
    });
  } finally {
    await prisma.productFamily.delete({ where: { id: family.id } }).catch(() => {});
  }
}

const addMedia = (familyId: string, data: Record<string, unknown>) =>
  prisma.productMedia.create({
    data: { familyId, type: MediaType.IMAGE, alt: 'a', position: 0, ...data } as never,
    select: { id: true },
  });

const thumb = async (sku: string) => {
  const cart = await priceCart({ lines: [{ sku, qty: 1 }] });
  return cart.lines[0]?.imageUrl ?? null;
};

describe('cart thumbnail', () => {
  it('uses the SELECTED pack, not the product’s first image', async () => {
    await withProduct(async (b) => {
      // The 1kg photograph sorts first, exactly as Cichlid C4's does.
      await addMedia(b.familyId, { url: `${CDN}/pouch.jpg`, position: 0, variantId: b.v1kg });
      await addMedia(b.familyId, { url: `${CDN}/bottle.jpg`, position: 1, variantId: b.v45 });

      expect(await thumb(b.sku45)).toBe(`${CDN}/bottle.jpg`);
      expect(await thumb(b.sku1kg)).toBe(`${CDN}/pouch.jpg`);
    });
  });

  it('shows nothing rather than another pack’s photograph', async () => {
    await withProduct(async (b) => {
      await addMedia(b.familyId, { url: `${CDN}/pouch.jpg`, position: 0, variantId: b.v1kg });
      expect(await thumb(b.sku45)).toBeNull();
    });
  });

  it('lets a multipack inherit its base pack’s photograph', async () => {
    await withProduct(async (b) => {
      await addMedia(b.familyId, { url: `${CDN}/bottle.jpg`, position: 0, variantId: b.v45 });
      expect(await thumb(b.sku45x2)).toBe(`${CDN}/bottle.jpg`);
    });
  });

  it('honours the operator’s chosen main image', async () => {
    await withProduct(async (b) => {
      await addMedia(b.familyId, { url: `${CDN}/first.jpg`, position: 0, variantId: b.v45 });
      const starred = await addMedia(b.familyId, {
        url: `${CDN}/starred.jpg`, position: 1, variantId: b.v45,
      });
      await prisma.productVariant.update({
        where: { id: b.v45 }, data: { heroMediaId: starred.id },
      });
      expect(await thumb(b.sku45)).toBe(`${CDN}/starred.jpg`);
    });
  });

  it('never puts a video URL in the thumbnail', async () => {
    await withProduct(async (b) => {
      await addMedia(b.familyId, {
        type: MediaType.VIDEO, url: `${CDN}/film.mp4`, posterUrl: `${CDN}/film.jpg`, position: 0,
      });
      expect(await thumb(b.sku45)).toBeNull();
    });
  });

  it('falls back to a shared photograph when the pack has none', async () => {
    await withProduct(async (b) => {
      await addMedia(b.familyId, { url: `${CDN}/fish.jpg`, position: 0 });
      expect(await thumb(b.sku45)).toBe(`${CDN}/fish.jpg`);
    });
  });

  it('never uses an archived asset', async () => {
    await withProduct(async (b) => {
      await addMedia(b.familyId, {
        url: `${CDN}/gone.jpg`, position: 0, variantId: b.v45,
        status: MediaStatus.ARCHIVED, archivedAt: new Date(),
      });
      await addMedia(b.familyId, { url: `${CDN}/live.jpg`, position: 1, variantId: b.v45 });
      expect(await thumb(b.sku45)).toBe(`${CDN}/live.jpg`);
    });
  });

  it('honours a multi-target assignment', async () => {
    await withProduct(async (b) => {
      const m = await addMedia(b.familyId, {
        url: `${CDN}/shot.jpg`, position: 0, variantId: b.v45,
      });
      await prisma.productMediaVariant.createMany({
        data: [
          { productMediaId: m.id, variantId: b.v45 },
          { productMediaId: m.id, variantId: b.v1kg },
        ],
      });
      expect(await thumb(b.sku1kg)).toBe(`${CDN}/shot.jpg`);
    });
  });
});
