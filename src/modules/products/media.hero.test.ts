/**
 * Hero, removal impact and ordering.
 *
 * These cover what the CMS media manager does when an operator acts: choosing a
 * main image, being told what a removal costs, and dragging a gallery into
 * order. All three are decided on the server, so these are the tests that prove
 * the CMS is not quietly making its own rules.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MediaStatus, MediaType, PrismaClient } from '@prisma/client';
import { sweepFixtures } from '@/test/fixtures';
import { mediaRemovalImpact, previewMedia } from './products.service';
import { checkHero, loadResolvable, reconcileMedia } from './media.integrity';
import { resolveGallery } from './media.resolver';

const prisma = new PrismaClient();

/* Clear anything an earlier crashed run left behind. */
beforeAll(async () => {
  await sweepFixtures(prisma);
});
afterAll(async () => prisma.$disconnect());

const TAG = `zz-hero-${Date.now()}`;

interface Seed {
  slug: string;
  familyId: string;
  base: { id: string; sku: string };
  twin: { id: string; sku: string };
  kilo: { id: string; sku: string };
}

/**
 * A committed product, deleted afterwards.
 *
 * previewMedia and mediaRemovalImpact read through the module-level client, so a
 * rolled-back transaction is invisible to them; committing is the only way to
 * exercise the real functions rather than a copy.
 */
async function withProduct<T>(fn: (s: Seed) => Promise<T>): Promise<T> {
  const ns = `${TAG}-${Math.random().toString(36).slice(2, 8)}`;
  const family = await prisma.productFamily.create({
    data: { slug: ns, name: 'Hero Test', shortDesc: 'x', category: 'BETTA', status: 'DRAFT' },
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
    return await fn({ slug: ns, familyId: family.id, base, twin, kilo });
  } finally {
    await prisma.productFamily.delete({ where: { id: family.id } }).catch(() => {});
  }
}

/** Save a gallery the way the product save does, returning ids by url. */
async function saveGallery(
  s: Seed,
  items: { url: string; skus?: string[] }[],
): Promise<Record<string, string>> {
  const bySku = new Map([
    [s.base.sku.toUpperCase(), s.base.id],
    [s.twin.sku.toUpperCase(), s.twin.id],
    [s.kilo.sku.toUpperCase(), s.kilo.id],
  ]);
  await reconcileMedia(
    prisma,
    s.familyId,
    items.map((i) => ({
      type: MediaType.IMAGE, url: i.url, alt: i.url, publicId: `p-${i.url}`,
      skus: i.skus ?? [], sku: i.skus?.[0] ?? null,
    })),
    bySku,
  );
  const rows = await prisma.productMedia.findMany({
    where: { familyId: s.familyId }, select: { id: true, url: true },
  });
  return Object.fromEntries(rows.map((r) => [r.url, r.id]));
}

const stage = (items: { url: string; skus?: string[]; id?: string }[]) =>
  items.map((i) => ({
    ...(i.id ? { id: i.id } : {}),
    type: MediaType.IMAGE, url: i.url, alt: i.url,
    skus: i.skus ?? [], sku: i.skus?.[0] ?? null,
  })) as never;

// ---------------------------------------------------------------------------

describe('hero selection', () => {
  it('accepts an image the pack shows', async () => {
    await withProduct(async (s) => {
      const ids = await saveGallery(s, [{ url: 'a.jpg', skus: [s.base.sku] }]);
      expect((await checkHero(prisma, s.base.id, ids['a.jpg']!)).ok).toBe(true);
    });
  });

  it('rejects an image from another product', async () => {
    await withProduct(async (a) => {
      await withProduct(async (b) => {
        const ids = await saveGallery(b, [{ url: 'other.jpg', skus: [b.base.sku] }]);
        const r = await checkHero(prisma, a.base.id, ids['other.jpg']!);
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('WRONG_PRODUCT');
      });
    });
  });

  it('rejects an archived image', async () => {
    await withProduct(async (s) => {
      const ids = await saveGallery(s, [{ url: 'a.jpg', skus: [s.base.sku] }]);
      await prisma.productMedia.update({
        where: { id: ids['a.jpg']! },
        data: { status: MediaStatus.ARCHIVED, archivedAt: new Date() },
      });
      const r = await checkHero(prisma, s.base.id, ids['a.jpg']!);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('ARCHIVED');
    });
  });

  it("rejects an image that pack does not show", async () => {
    await withProduct(async (s) => {
      const ids = await saveGallery(s, [{ url: 'kilo.jpg', skus: [s.kilo.sku] }]);
      const r = await checkHero(prisma, s.base.id, ids['kilo.jpg']!);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('NOT_IN_GALLERY');
    });
  });

  it('persists, and the preview leads with it', async () => {
    await withProduct(async (s) => {
      const ids = await saveGallery(s, [
        { url: 'a.jpg', skus: [s.base.sku] },
        { url: 'b.jpg', skus: [s.base.sku] },
      ]);
      // Second image chosen, so this is not just the default first pick.
      await prisma.productVariant.update({
        where: { id: s.base.id }, data: { heroMediaId: ids['b.jpg']! },
      });

      const r = await previewMedia(s.slug, {
        media: stage([{ url: 'a.jpg', id: ids['a.jpg'], skus: [s.base.sku] },
                      { url: 'b.jpg', id: ids['b.jpg'], skus: [s.base.sku] }]),
      });
      const pack = r.packs.find((p) => p.sku === s.base.sku)!;
      expect(pack.heroMediaId).toBe(ids['b.jpg']);
      expect(pack.heroIsExplicit).toBe(true);
      expect(pack.items.find((m) => m.isPrimary)?.id).toBe(ids['b.jpg']);
    });
  });

  it('falls back when the chosen image is archived', async () => {
    await withProduct(async (s) => {
      const ids = await saveGallery(s, [
        { url: 'a.jpg', skus: [s.base.sku] },
        { url: 'b.jpg', skus: [s.base.sku] },
      ]);
      await prisma.productVariant.update({
        where: { id: s.base.id }, data: { heroMediaId: ids['b.jpg']! },
      });
      await prisma.productMedia.update({
        where: { id: ids['b.jpg']! },
        data: { status: MediaStatus.ARCHIVED, archivedAt: new Date() },
      });

      const media = await loadResolvable(prisma, s.familyId);
      const resolved = resolveGallery(media, { id: s.base.id, sku: s.base.sku });
      // The archived asset is gone from the gallery, so it cannot lead it.
      expect(resolved.items.map((m) => m.id)).not.toContain(ids['b.jpg']);
      expect(resolved.heroMediaId).toBe(ids['a.jpg']);
    });
  });

  it('honours a hero staged in the editor but not saved', async () => {
    await withProduct(async (s) => {
      const ids = await saveGallery(s, [
        { url: 'a.jpg', skus: [s.base.sku] },
        { url: 'b.jpg', skus: [s.base.sku] },
      ]);
      const r = await previewMedia(s.slug, {
        media: stage([{ url: 'a.jpg', id: ids['a.jpg'], skus: [s.base.sku] },
                      { url: 'b.jpg', id: ids['b.jpg'], skus: [s.base.sku] }]),
        variants: [{ sku: s.base.sku, heroMediaId: ids['b.jpg']! }],
      });
      expect(r.packs.find((p) => p.sku === s.base.sku)!.heroMediaId).toBe(ids['b.jpg']);
    });
  });
});

// ---------------------------------------------------------------------------

describe('removal impact', () => {
  it('flags a shared asset as affecting every pack', async () => {
    await withProduct(async (s) => {
      const ids = await saveGallery(s, [{ url: 'fish.jpg' }]);
      const r = await mediaRemovalImpact(s.slug, {
        media: stage([{ url: 'fish.jpg', id: ids['fish.jpg'] }]),
        mediaId: ids['fish.jpg']!,
      });
      expect(r.isShared).toBe(true);
      expect(r.usedBy.length).toBe(3);
    });
  });

  it('lists every pack that displays a multi-target asset, inherited included', async () => {
    await withProduct(async (s) => {
      const ids = await saveGallery(s, [{ url: 'shot.jpg', skus: [s.base.sku, s.kilo.sku] }]);
      const r = await mediaRemovalImpact(s.slug, {
        media: stage([{ url: 'shot.jpg', id: ids['shot.jpg'], skus: [s.base.sku, s.kilo.sku] }]),
        mediaId: ids['shot.jpg']!,
      });

      // Assigned to two packs directly.
      const direct = r.usedBy.filter((u) => u.source === 'VARIANT').map((u) => u.sku);
      expect(direct.sort()).toEqual([s.base.sku, s.kilo.sku].sort());

      /*
       * The twin borrows the base pack's photography, so it shows this asset too
       * and loses it on removal. Reporting only the direct assignments would
       * understate the damage, which is the opposite of what this warning is for.
       */
      const inherited = r.usedBy.find((u) => u.sku === s.twin.sku);
      expect(inherited?.source).toBe('INHERITED');
    });
  });

  it('says when the asset is a pack’s main image', async () => {
    await withProduct(async (s) => {
      const ids = await saveGallery(s, [{ url: 'a.jpg', skus: [s.base.sku] }]);
      await prisma.productVariant.update({
        where: { id: s.base.id }, data: { heroMediaId: ids['a.jpg']! },
      });
      const r = await mediaRemovalImpact(s.slug, {
        media: stage([{ url: 'a.jpg', id: ids['a.jpg'], skus: [s.base.sku] }]),
        mediaId: ids['a.jpg']!,
      });
      expect(r.primaryFor.length).toBeGreaterThan(0);
    });
  });

  it('warns that a borrowing pack loses it too', async () => {
    await withProduct(async (s) => {
      const ids = await saveGallery(s, [{ url: 'base.jpg', skus: [s.base.sku] }]);
      const r = await mediaRemovalImpact(s.slug, {
        media: stage([{ url: 'base.jpg', id: ids['base.jpg'], skus: [s.base.sku] }]),
        mediaId: ids['base.jpg']!,
      });
      // The twin inherits it, so it appears in usedBy and loses coverage.
      expect(r.usedBy.some((u) => u.sku === s.twin.sku)).toBe(true);
      expect(r.leavesEmpty.length).toBeGreaterThan(0);
    });
  });

  it('names the packs left with nothing', async () => {
    await withProduct(async (s) => {
      const ids = await saveGallery(s, [{ url: 'only.jpg', skus: [s.base.sku] }]);
      const r = await mediaRemovalImpact(s.slug, {
        media: stage([{ url: 'only.jpg', id: ids['only.jpg'], skus: [s.base.sku] }]),
        mediaId: ids['only.jpg']!,
      });
      expect(r.coverageChanges.some((c) => c.to === 'EMPTY')).toBe(true);
    });
  });

  it('reports the shared fallback rather than empty when one exists', async () => {
    await withProduct(async (s) => {
      const ids = await saveGallery(s, [
        { url: 'a.jpg', skus: [s.base.sku] },
        { url: 'fish.jpg' },
      ]);
      const r = await mediaRemovalImpact(s.slug, {
        media: stage([{ url: 'a.jpg', id: ids['a.jpg'], skus: [s.base.sku] },
                      { url: 'fish.jpg', id: ids['fish.jpg'] }]),
        mediaId: ids['a.jpg']!,
      });
      const base = r.coverageChanges.find((c) => c.sku === s.base.sku);
      expect(base?.to).toBe('SHARED_ONLY');
      expect(r.leavesEmpty).toHaveLength(0);
    });
  });

  it('reports no coverage change when other assets remain', async () => {
    await withProduct(async (s) => {
      const ids = await saveGallery(s, [
        { url: 'a.jpg', skus: [s.base.sku] },
        { url: 'b.jpg', skus: [s.base.sku] },
      ]);
      const r = await mediaRemovalImpact(s.slug, {
        media: stage([{ url: 'a.jpg', id: ids['a.jpg'], skus: [s.base.sku] },
                      { url: 'b.jpg', id: ids['b.jpg'], skus: [s.base.sku] }]),
        mediaId: ids['a.jpg']!,
      });
      expect(r.coverageChanges).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------

describe('ordering', () => {
  it('persists a reorder as position', async () => {
    await withProduct(async (s) => {
      const ids = await saveGallery(s, [{ url: 'a.jpg' }, { url: 'b.jpg' }]);
      // Dragged: b before a.
      await saveGallery(s, [{ url: 'b.jpg' }, { url: 'a.jpg' }]);

      const rows = await prisma.productMedia.findMany({
        where: { familyId: s.familyId }, select: { id: true, url: true, position: true },
        orderBy: { position: 'asc' },
      });
      expect(rows.map((r) => r.url)).toEqual(['b.jpg', 'a.jpg']);
      // Same assets — a reorder is not a replacement.
      expect(rows.map((r) => r.id).sort()).toEqual(Object.values(ids).sort());
    });
  });

  it('does not change which packs an asset serves', async () => {
    await withProduct(async (s) => {
      await saveGallery(s, [
        { url: 'a.jpg', skus: [s.base.sku, s.kilo.sku] },
        { url: 'b.jpg' },
      ]);
      await saveGallery(s, [
        { url: 'b.jpg' },
        { url: 'a.jpg', skus: [s.base.sku, s.kilo.sku] },
      ]);

      const a = await prisma.productMedia.findFirstOrThrow({
        where: { familyId: s.familyId, url: 'a.jpg' },
        select: { id: true, variantLinks: { select: { variantId: true } } },
      });
      expect(a.variantLinks.map((l) => l.variantId).sort()).toEqual(
        [s.base.id, s.kilo.id].sort(),
      );
    });
  });

  it('does not change the main image', async () => {
    await withProduct(async (s) => {
      const ids = await saveGallery(s, [
        { url: 'a.jpg', skus: [s.base.sku] },
        { url: 'b.jpg', skus: [s.base.sku] },
      ]);
      await prisma.productVariant.update({
        where: { id: s.base.id }, data: { heroMediaId: ids['b.jpg']! },
      });

      await saveGallery(s, [
        { url: 'b.jpg', skus: [s.base.sku] },
        { url: 'a.jpg', skus: [s.base.sku] },
      ]);

      const v = await prisma.productVariant.findUniqueOrThrow({
        where: { id: s.base.id }, select: { heroMediaId: true },
      });
      expect(v.heroMediaId).toBe(ids['b.jpg']);
    });
  });

  it('keeps a multi-target asset as one asset', async () => {
    await withProduct(async (s) => {
      await saveGallery(s, [{ url: 'shot.jpg', skus: [s.base.sku, s.twin.sku, s.kilo.sku] }]);
      await saveGallery(s, [{ url: 'shot.jpg', skus: [s.base.sku, s.twin.sku, s.kilo.sku] }]);
      expect(await prisma.productMedia.count({ where: { familyId: s.familyId } })).toBe(1);
    });
  });
});
