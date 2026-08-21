/**
 * The public storefront payload, against the real database.
 *
 * These use the actual FAMILY_SELECT query rather than a hand-built object,
 * because the things being pinned here ARE query behaviour: the archived filter
 * is a `where` clause, and multi-target expansion depends on the join rows the
 * select asks for. A fixture would prove nothing about either.
 *
 * Each test builds and deletes its own namespaced product, so the live
 * catalogue is untouched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MediaStatus, MediaType, PrismaClient } from '@prisma/client';
import { sweepFixtures } from '@/test/fixtures';
import { FAMILY_SELECT, serializePublic } from './products.serializer';
import { hoverVideoUrl } from '@/integrations/cloudinary/cloudinary.service';

const prisma = new PrismaClient();

/* Clear anything an earlier crashed run left behind. */
beforeAll(async () => {
  await sweepFixtures(prisma);
});
afterAll(async () => prisma.$disconnect());

const CDN = 'https://res.cloudinary.com/test';

interface Built {
  slug: string;
  familyId: string;
  v45: string;
  v45x2: string;
  v1kg: string;
}

async function withProduct<T>(fn: (b: Built) => Promise<T>): Promise<T> {
  const ns = `zz-public-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const family = await prisma.productFamily.create({
    data: { slug: ns, name: 'Public Test', shortDesc: 'x', category: 'BETTA', status: 'ACTIVE' },
    select: { id: true },
  });
  try {
    const mk = (sku: string, pack: string, position: number, baseVariantId?: string) =>
      prisma.productVariant.create({
        data: {
          familyId: family.id, sku: `${ns}-${sku}`, pack, position,
          mrpPaise: 100, pricePaise: 100, stock: 5, baseVariantId,
        },
        select: { id: true },
      });

    const v45 = await mk('45G', '45g Bottle', 0);
    const v45x2 = await mk('45GX2', '45g x 2', 1, v45.id);
    const v1kg = await mk('1KG', '1kg Pouch', 2);

    return await fn({ slug: ns, familyId: family.id, v45: v45.id, v45x2: v45x2.id, v1kg: v1kg.id });
  } finally {
    await prisma.productFamily.delete({ where: { id: family.id } }).catch(() => {});
  }
}

const addMedia = (familyId: string, data: Record<string, unknown>) =>
  prisma.productMedia.create({
    data: { familyId, type: MediaType.IMAGE, alt: 'a', position: 0, ...data } as never,
    select: { id: true },
  });

const load = async (slug: string) => {
  const row = await prisma.productFamily.findUniqueOrThrow({ where: { slug }, select: FAMILY_SELECT });
  return serializePublic(row);
};

const packOf = (p: Awaited<ReturnType<typeof load>>, sku: string) =>
  p.packs.find((k) => k.sku.endsWith(sku))!;

// ---- Archived ---------------------------------------------------------------

describe('archived media', () => {
  it('never reaches the public response', async () => {
    await withProduct(async (b) => {
      await addMedia(b.familyId, { url: `${CDN}/live.jpg`, position: 0, variantId: b.v45 });
      await addMedia(b.familyId, {
        url: `${CDN}/gone.jpg`, position: 1, variantId: b.v45,
        status: MediaStatus.ARCHIVED, archivedAt: new Date(),
      });

      const p = await load(b.slug);
      const urls = p.media.map((m) => m.url);
      expect(urls).toContain(`${CDN}/live.jpg`);
      expect(urls).not.toContain(`${CDN}/gone.jpg`);
      expect(p.images.map((i) => i.url)).not.toContain(`${CDN}/gone.jpg`);
      expect(packOf(p, '-45G').gallery.items.map((m) => m.url)).not.toContain(`${CDN}/gone.jpg`);
      expect(p.listing.heroUrl).toBe(`${CDN}/live.jpg`);
    });
  });

  it('does not let an archived asset stay the listing image', async () => {
    await withProduct(async (b) => {
      await addMedia(b.familyId, {
        url: `${CDN}/gone.jpg`, position: 0, variantId: b.v45,
        status: MediaStatus.ARCHIVED, archivedAt: new Date(),
      });
      const p = await load(b.slug);
      expect(p.listing.heroUrl).toBeNull();
      expect(p.listing.coverage).toBe('EMPTY');
    });
  });
});

// ---- Multi-target -----------------------------------------------------------

describe('multi-target assignment', () => {
  it('shows one asset for every pack it is assigned to', async () => {
    await withProduct(async (b) => {
      const m = await addMedia(b.familyId, { url: `${CDN}/shot.jpg`, position: 0, variantId: b.v45 });
      await prisma.productMediaVariant.createMany({
        data: [
          { productMediaId: m.id, variantId: b.v45 },
          { productMediaId: m.id, variantId: b.v1kg },
        ],
      });

      const p = await load(b.slug);
      for (const sku of ['-45G', '-1KG']) {
        const g = packOf(p, sku).gallery;
        expect(g.coverage).toBe('EXACT');
        expect(g.items.map((i) => i.url)).toEqual([`${CDN}/shot.jpg`]);
      }
    });
  });

  it('stays ONE asset — no duplicate gallery entries', async () => {
    await withProduct(async (b) => {
      const m = await addMedia(b.familyId, { url: `${CDN}/shot.jpg`, position: 0, variantId: b.v45 });
      await prisma.productMediaVariant.createMany({
        data: [
          { productMediaId: m.id, variantId: b.v45 },
          { productMediaId: m.id, variantId: b.v45x2 },
          { productMediaId: m.id, variantId: b.v1kg },
        ],
      });

      const p = await load(b.slug);
      expect(p.media.filter((x) => x.url === `${CDN}/shot.jpg`)).toHaveLength(1);
      for (const sku of ['-45G', '-45GX2', '-1KG']) {
        const g = packOf(p, sku).gallery;
        expect(g.items).toHaveLength(1);
        expect(g.presentation.orderedIds).toHaveLength(1);
      }
    });
  });

  it('honours the join table over the legacy column', async () => {
    await withProduct(async (b) => {
      // Legacy column says 45g; the join table — authoritative — says 1kg only.
      const m = await addMedia(b.familyId, { url: `${CDN}/moved.jpg`, position: 0, variantId: b.v45 });
      await prisma.productMediaVariant.create({
        data: { productMediaId: m.id, variantId: b.v1kg },
      });

      const p = await load(b.slug);
      expect(packOf(p, '-1KG').gallery.items).toHaveLength(1);
      expect(packOf(p, '-45G').gallery.coverage).toBe('EMPTY');
    });
  });
});

// ---- Hero reaches the storefront -------------------------------------------

describe('hero', () => {
  it('honours the operator’s choice in the public payload', async () => {
    await withProduct(async (b) => {
      await addMedia(b.familyId, { url: `${CDN}/first.jpg`, position: 0, variantId: b.v45 });
      const starred = await addMedia(b.familyId, {
        url: `${CDN}/starred.jpg`, position: 1, variantId: b.v45,
      });
      await prisma.productVariant.update({
        where: { id: b.v45 }, data: { heroMediaId: starred.id },
      });

      const p = await load(b.slug);
      const g = packOf(p, '-45G').gallery;
      expect(g.heroMediaId).toBe(starred.id);
      expect(g.items.find((i) => i.isPrimary)?.url).toBe(`${CDN}/starred.jpg`);
      expect(g.presentation.orderedIds[0]).toBe(starred.id);
      // And the card follows it too.
      expect(p.listing.heroUrl).toBe(`${CDN}/starred.jpg`);
    });
  });

  it('never makes a video the hero or the listing image', async () => {
    await withProduct(async (b) => {
      const film = await addMedia(b.familyId, {
        type: MediaType.VIDEO, url: `${CDN}/film.mp4`, posterUrl: `${CDN}/film.jpg`, position: 0,
      });

      const p = await load(b.slug);
      const g = packOf(p, '-45G').gallery;
      expect(g.heroMediaId).toBeNull();
      expect(g.items.some((i) => i.isPrimary)).toBe(false);
      expect(p.listing.heroUrl).toBeNull();
      expect(p.listing.posterUrl).toBe(`${CDN}/film.jpg`);
      expect(p.listing.videoUrl).toContain('film.mp4');
      expect(g.presentation.videoId).toBe(film.id);
    });
  });
});

// ---- Listing ----------------------------------------------------------------

describe('listing payload', () => {
  it('uses the explicit representative', async () => {
    await withProduct(async (b) => {
      await addMedia(b.familyId, { url: `${CDN}/bottle.jpg`, position: 0, variantId: b.v45 });
      await addMedia(b.familyId, { url: `${CDN}/pouch.jpg`, position: 1, variantId: b.v1kg });
      await prisma.productFamily.update({
        where: { id: b.familyId }, data: { representativeVariantId: b.v1kg },
      });

      const p = await load(b.slug);
      expect(p.listing.heroUrl).toBe(`${CDN}/pouch.jpg`);
      expect(p.listing.sku).toMatch(/-1KG$/);
    });
  });

  it('does not move when the representative pack sells out', async () => {
    await withProduct(async (b) => {
      await addMedia(b.familyId, { url: `${CDN}/bottle.jpg`, position: 0, variantId: b.v45 });
      await addMedia(b.familyId, { url: `${CDN}/pouch.jpg`, position: 1, variantId: b.v1kg });

      const before = await load(b.slug);
      await prisma.productVariant.update({ where: { id: b.v45 }, data: { stock: 0 } });
      const after = await load(b.slug);

      expect(after.listing.heroUrl).toBe(before.listing.heroUrl);
      expect(after.listing.heroUrl).toBe(`${CDN}/bottle.jpg`);
      // Price and availability still follow the first purchasable pack.
      expect(after.packs.find((k) => k.sku.endsWith('-45G'))?.inStock).toBe(false);
    });
  });

  it('never borrows another pack’s photograph', async () => {
    await withProduct(async (b) => {
      await addMedia(b.familyId, { url: `${CDN}/pouch.jpg`, position: 0, variantId: b.v1kg });
      const p = await load(b.slug);
      expect(p.listing.heroUrl).toBeNull();
      // The asset still exists on the product — it is simply not the card's.
      expect(p.images).toHaveLength(1);
    });
  });

  it('keeps every legacy field the storefront already reads', async () => {
    await withProduct(async (b) => {
      await addMedia(b.familyId, { url: `${CDN}/bottle.jpg`, position: 0, variantId: b.v45 });
      const p = await load(b.slug);
      expect(Array.isArray(p.media)).toBe(true);
      expect(Array.isArray(p.images)).toBe(true);
      expect(Array.isArray(p.packs)).toBe(true);
      expect(Array.isArray(packOf(p, '-45G').gallery.items)).toBe(true);
    });
  });
});

// ---- Hover derivative -------------------------------------------------------

describe('hover video derivative', () => {
  it('inserts the transform after the upload segment', () => {
    expect(hoverVideoUrl('https://res.cloudinary.com/c/video/upload/v123/zewa/a.mp4')).toBe(
      'https://res.cloudinary.com/c/video/upload/f_auto,q_auto,w_640,c_limit/v123/zewa/a.mp4',
    );
  });

  it('is idempotent', () => {
    const once = hoverVideoUrl('https://res.cloudinary.com/c/video/upload/v1/a.mp4')!;
    expect(hoverVideoUrl(once)).toBe(once);
  });

  it('leaves an already-transformed URL alone', () => {
    const url = 'https://res.cloudinary.com/c/video/upload/w_100,c_fill/v1/a.mp4';
    expect(hoverVideoUrl(url)).toBe(url);
  });

  it('leaves a non-Cloudinary URL alone', () => {
    expect(hoverVideoUrl('https://example.com/a.mp4')).toBe('https://example.com/a.mp4');
  });

  it('handles null', () => {
    expect(hoverVideoUrl(null)).toBeNull();
  });
});
