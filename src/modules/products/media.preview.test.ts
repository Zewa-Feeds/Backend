/**
 * Preview endpoint tests.
 *
 * The CMS media manager renders coverage, inheritance and hero from this, so the
 * contract these pin is: the preview must agree with the storefront, for the
 * gallery as the operator currently has it — including edits not yet saved.
 *
 * Each test builds and rolls back its own product, so the live catalogue is
 * untouched.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { MediaType, PrismaClient } from '@prisma/client';
import { previewMedia } from './products.service';
import { loadResolvable } from './media.integrity';
import { resolveGallery } from './media.resolver';

const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());

const TAG = `zz-preview-${Date.now()}`;
/**
 * previewMedia reads through the module-level prisma client, so a product built
 * inside a rolled-back transaction is invisible to it. These tests therefore
 * commit a namespaced product and delete it afterwards, which is the only way to
 * exercise the real function rather than a copy of it.
 */
interface SeedIds {
  familyId: string;
  base: string;
  twin: string;
  kilo: string;
}

async function withProduct<T>(fn: (slug: string, ids: SeedIds) => Promise<T>): Promise<T> {
  const ns = `${TAG}-${Math.random().toString(36).slice(2, 8)}`;
  const family = await prisma.productFamily.create({
    data: { slug: ns, name: 'Preview Test', shortDesc: 'x', category: 'BETTA', status: 'DRAFT' },
    select: { id: true },
  });
  try {
    const base = await prisma.productVariant.create({
      data: { familyId: family.id, sku: `${ns}-45G`, pack: '45g Bottle', mrpPaise: 1, pricePaise: 1, stock: 1, position: 0 },
      select: { id: true, sku: true },
    });
    const twin = await prisma.productVariant.create({
      data: {
        familyId: family.id, sku: `${ns}-45GX2`, pack: '45g x 2', mrpPaise: 1, pricePaise: 1,
        stock: 1, position: 1, baseVariantId: base.id, packMultiplier: 2,
      },
      select: { id: true, sku: true },
    });
    const kilo = await prisma.productVariant.create({
      data: { familyId: family.id, sku: `${ns}-1KG`, pack: '1kg Pouch', mrpPaise: 1, pricePaise: 1, stock: 1, position: 2 },
      select: { id: true, sku: true },
    });
    return await fn(ns, { familyId: family.id, base: base.sku, twin: twin.sku, kilo: kilo.sku });
  } finally {
    // Cascades to variants, media and assignments.
    await prisma.productFamily.delete({ where: { id: family.id } }).catch(() => {});
  }
}

const img = (url: string, skus: string[] = []) => ({
  type: MediaType.IMAGE, url, alt: `alt ${url}`, skus, sku: skus[0] ?? null,
});

const byPack = (r: Awaited<ReturnType<typeof previewMedia>>, sku: string) =>
  r.packs.find((p) => p.sku === sku)!;

describe('media preview', () => {
  it('reports EXACT for a pack with its own photography', async () => {
    await withProduct(async (slug, id) => {
      const r = await previewMedia(slug, { media: [img('a.jpg', [id.base])] as never });
      expect(byPack(r, id.base).coverage).toBe('EXACT');
      expect(byPack(r, id.base).items).toHaveLength(1);
    });
  });

  it('reports INHERITED and names the source pack', async () => {
    await withProduct(async (slug, id) => {
      const r = await previewMedia(slug, { media: [img('a.jpg', [id.base])] as never });
      const twin = byPack(r, id.twin);
      expect(twin.coverage).toBe('INHERITED');
      expect(twin.inheritedFromSku).toBe(id.base);
      expect(twin.items[0]!.source).toBe('INHERITED');
    });
  });

  it('reports SHARED_ONLY when only shared assets exist', async () => {
    await withProduct(async (slug, id) => {
      const r = await previewMedia(slug, { media: [img('fish.jpg')] as never });
      expect(byPack(r, id.kilo).coverage).toBe('SHARED_ONLY');
    });
  });

  it('reports EMPTY, and never another pack’s photography', async () => {
    await withProduct(async (slug, id) => {
      const r = await previewMedia(slug, { media: [img('kilo.jpg', [id.kilo])] as never });
      const base = byPack(r, id.base);
      expect(base.coverage).toBe('EMPTY');
      expect(base.items).toHaveLength(0);
    });
  });

  it('shows one asset across several packs without duplicating it', async () => {
    await withProduct(async (slug, id) => {
      const r = await previewMedia(slug, {
        media: [img('shot.jpg', [id.base, id.twin, id.kilo])] as never,
      });
      for (const sku of [id.base, id.twin, id.kilo]) {
        expect(byPack(r, sku).items).toHaveLength(1);
        expect(byPack(r, sku).coverage).toBe('EXACT');
      }
    });
  });

  it('lets a multipack override what it inherits', async () => {
    await withProduct(async (slug, id) => {
      const r = await previewMedia(slug, {
        media: [img('base.jpg', [id.base]), img('own.jpg', [id.twin])] as never,
      });
      const twin = byPack(r, id.twin);
      expect(twin.coverage).toBe('EXACT');
      expect(twin.items.map((m) => m.url)).toEqual(['own.jpg']);
    });
  });

  it('keeps the operator’s ordering', async () => {
    await withProduct(async (slug, id) => {
      const r = await previewMedia(slug, {
        media: [img('c.jpg'), img('a.jpg', [id.base]), img('b.jpg')] as never,
      });
      expect(byPack(r, id.base).items.map((m) => m.url)).toEqual(['c.jpg', 'a.jpg', 'b.jpg']);
    });
  });

  it('marks exactly one item as the main image', async () => {
    await withProduct(async (slug, id) => {
      const r = await previewMedia(slug, {
        media: [img('fish.jpg'), img('a.jpg', [id.base]), img('b.jpg', [id.base])] as never,
      });
      const base = byPack(r, id.base);
      expect(base.items.filter((m) => m.isPrimary)).toHaveLength(1);
      expect(base.heroMediaId).toBeTruthy();
    });
  });

  it('previews UNSAVED work — nothing needs to be saved first', async () => {
    await withProduct(async (slug, id) => {
      // Nothing has been written to ProductMedia at all.
      const r = await previewMedia(slug, { media: [img('draft.jpg', [id.base])] as never });
      expect(byPack(r, id.base).items.map((m) => m.url)).toEqual(['draft.jpg']);
      expect(await prisma.productMedia.count({ where: { familyId: id.familyId } })).toBe(0);
    });
  });

  it('honours inheritance staged in the editor but not yet saved', async () => {
    await withProduct(async (slug, id) => {
      const r = await previewMedia(slug, {
        media: [img('kilo.jpg', [id.kilo])] as never,
        // Operator has just pointed the twin at the 1kg pack.
        variants: [{ sku: id.twin, baseSku: id.kilo }],
      });
      const twin = byPack(r, id.twin);
      expect(twin.coverage).toBe('INHERITED');
      expect(twin.inheritedFromSku).toBe(id.kilo);
    });
  });

  it('returns the listing card, defaulting to the first pack', async () => {
    await withProduct(async (slug, id) => {
      const r = await previewMedia(slug, {
        media: [img('bottle.jpg', [id.base]), img('pouch.jpg', [id.kilo])] as never,
      });
      expect(r.listing.sku).toBe(id.base);
      expect(r.listing.heroUrl).toBe('bottle.jpg');
      expect(r.listing.isExplicit).toBe(false);
      expect(r.listing.coverage).toBe('EXACT');
    });
  });

  it('follows a representative staged in the editor but not yet saved', async () => {
    await withProduct(async (slug, id) => {
      const r = await previewMedia(slug, {
        media: [img('bottle.jpg', [id.base]), img('pouch.jpg', [id.kilo])] as never,
        representativeSku: id.kilo,
      });
      expect(r.listing.sku).toBe(id.kilo);
      expect(r.listing.heroUrl).toBe('pouch.jpg');
      expect(r.listing.isExplicit).toBe(true);
    });
  });

  it('shows no listing image rather than another pack’s', async () => {
    await withProduct(async (slug, id) => {
      // Only the 1kg is photographed; the card represents the 45g.
      const r = await previewMedia(slug, { media: [img('pouch.jpg', [id.kilo])] as never });
      expect(r.listing.sku).toBe(id.base);
      expect(r.listing.heroUrl).toBeNull();
      expect(r.listing.coverage).toBe('EMPTY');
    });
  });

  it('counts the further images the card can step through', async () => {
    await withProduct(async (slug, id) => {
      const r = await previewMedia(slug, {
        media: [img('a.jpg', [id.base]), img('b.jpg', [id.base]), img('c.jpg')] as never,
      });
      // Three images resolve for the pack; one of them is the hero.
      expect(r.listing.extraImageCount).toBe(2);
    });
  });

  it('agrees with the storefront for the same saved gallery', async () => {
    await withProduct(async (slug, id) => {
      const variants = await prisma.productVariant.findMany({
        where: { family: { slug } },
        select: { id: true, sku: true, baseVariantId: true },
      });
      const base = variants.find((v) => v.sku === id.base)!;

      await prisma.productMedia.create({
        data: {
          familyId: id.familyId, type: MediaType.IMAGE, url: 'saved.jpg',
          alt: 'a', position: 0, variantId: base.id,
        },
      });

      const storefront = resolveGallery(await loadResolvable(prisma, id.familyId), base);
      const preview = await previewMedia(slug, {
        media: [{ ...img('saved.jpg', [id.base]) }] as never,
      });

      const cms = byPack(preview, id.base);
      expect(cms.coverage).toBe(storefront.coverage);
      expect(cms.items.map((m) => m.url)).toEqual(storefront.items.map((m) => m.url));
    });
  });
});
