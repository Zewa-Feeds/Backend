/**
 * Explicit per-variant media assignment.
 *
 * The capability was always in the schema — ProductMediaVariant is a real
 * many-to-many — but nothing had ever used it: zero multi-variant assets in the
 * catalogue. These pin the behaviour now that the CMS exposes it, and above all
 * they pin the distinction the resolver has always drawn and the UI must not
 * blur:
 *
 *   SHARED   zero rows  — available to every pack, including ones added later
 *   SPECIFIC N rows     — exactly the packs the operator chose
 *
 * Those are different states with different coverage, and collapsing them would
 * quietly turn SHARED_ONLY into EXACT across the catalogue.
 *
 * Local Postgres via `npm run test:setup`. The real catalogue is never touched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MediaStatus, MediaType, PrismaClient } from '@prisma/client';
import { ns, sweepFixtures } from '@/test/fixtures';
import { reconcileMedia, toResolvable } from './media.integrity';
import { resolveGallery } from './media.resolver';

const prisma = new PrismaClient();
const CDN = 'https://res.cloudinary.com/test';

beforeAll(async () => { await sweepFixtures(prisma); });
afterAll(async () => { await sweepFixtures(prisma); await prisma.$disconnect(); });

interface Built {
  familyId: string;
  slug: string;
  /** A 45g, B 100g, C 200g, D 1kg — the four packs from the QA plan. */
  A: string; B: string; C: string; D: string;
  ids: Record<'A' | 'B' | 'C' | 'D', string>;
}

async function withProduct<T>(fn: (b: Built) => Promise<T>, opts: { inherit?: boolean } = {}) {
  const slug = ns('assign');
  const family = await prisma.productFamily.create({
    data: { slug, name: 'Assignment Test', shortDesc: 'x', category: 'BETTA', status: 'ACTIVE' },
    select: { id: true },
  });
  try {
    const mk = (suffix: string, pack: string, position: number, baseVariantId?: string) =>
      prisma.productVariant.create({
        data: {
          familyId: family.id, sku: `${slug.toUpperCase()}-${suffix}`, pack, position,
          mrpPaise: 100, pricePaise: 100, stock: 5, baseVariantId,
        },
        select: { id: true, sku: true },
      });
    const A = await mk('45G', '45g Bottle', 0);
    // D optionally inherits from A, so INHERITED can be exercised.
    const B = await mk('100G', '100g Bottle', 1);
    const C = await mk('200G', '200g Pouch', 2);
    const D = await mk('1KG', '1kg Pouch', 3, opts.inherit ? A.id : undefined);

    return await fn({
      familyId: family.id, slug,
      A: A.sku, B: B.sku, C: C.sku, D: D.sku,
      ids: { A: A.id, B: B.id, C: C.id, D: D.id },
    });
  } finally {
    await prisma.productFamily.delete({ where: { id: family.id } }).catch(() => undefined);
  }
}

/** Save a gallery the way the CMS does: whole array, `skus` per item. */
async function save(b: Built, items: { id?: string; url: string; skus: string[]; type?: MediaType }[]) {
  const variants = await prisma.productVariant.findMany({
    where: { familyId: b.familyId }, select: { id: true, sku: true },
  });
  const bySku = new Map(variants.map((v) => [v.sku.toUpperCase(), v.id]));

  return prisma.$transaction((tx) =>
    reconcileMedia(
      tx,
      b.familyId,
      items.map((m) => ({
        ...(m.id ? { id: m.id } : {}),
        type: m.type ?? MediaType.IMAGE,
        url: m.url,
        alt: 'a',
        publicId: `zz/${m.url.split('/').pop()}`,
        sku: m.skus[0] ?? null,
        skus: m.skus,
      })) as never,
      bySku,
    ),
  );
}

const load = (familyId: string) =>
  prisma.productMedia.findMany({
    where: { familyId },
    select: {
      id: true, url: true, publicId: true, position: true, status: true, variantId: true,
      type: true, alt: true, width: true, height: true, posterUrl: true,
      variantLinks: { select: { variantId: true } },
    },
    orderBy: { position: 'asc' },
  });

const coverageFor = async (b: Built, sku: keyof Built['ids']) => {
  const media = await load(b.familyId);
  const variant = await prisma.productVariant.findFirstOrThrow({
    where: { id: b.ids[sku] },
    select: { id: true, sku: true, baseVariantId: true },
  });
  return resolveGallery(toResolvable(media.filter((m) => m.status !== MediaStatus.ARCHIVED) as never), variant);
};

// ---------------------------------------------------------------------------

describe('shared vs specific', () => {
  it('A. shared writes zero rows and resolves SHARED_ONLY', async () => {
    await withProduct(async (b) => {
      await save(b, [{ url: `${CDN}/fish.jpg`, skus: [] }]);

      const [asset] = await load(b.familyId);
      expect(asset!.variantLinks).toHaveLength(0);
      expect(asset!.variantId).toBeNull();
      for (const pack of ['A', 'B', 'C', 'D'] as const) {
        expect((await coverageFor(b, pack)).coverage).toBe('SHARED_ONLY');
      }
    });
  });

  it('D. every variant ticked writes N rows and resolves EXACT — NOT the same as shared', async () => {
    await withProduct(async (b) => {
      await save(b, [{ url: `${CDN}/all.jpg`, skus: [b.A, b.B, b.C, b.D] }]);

      const [asset] = await load(b.familyId);
      expect(asset!.variantLinks).toHaveLength(4);
      for (const pack of ['A', 'B', 'C', 'D'] as const) {
        expect((await coverageFor(b, pack)).coverage).toBe('EXACT');
      }
    });
  });

  it('E. specific with zero variants is the same absence of rows as shared', async () => {
    /*
     * The honest limit of this model. "No packs chosen" and "every pack" are one
     * state in the database, so the UI keeps them apart only for the length of
     * an edit and says so on screen.
     */
    await withProduct(async (b) => {
      await save(b, [{ url: `${CDN}/none.jpg`, skus: [] }]);
      const [asset] = await load(b.familyId);
      expect(asset!.variantLinks).toHaveLength(0);
      expect((await coverageFor(b, 'A')).coverage).toBe('SHARED_ONLY');
    });
  });
});

describe('choosing exactly which packs', () => {
  it('B. one variant — only that pack gets it', async () => {
    await withProduct(async (b) => {
      await save(b, [{ url: `${CDN}/a-only.jpg`, skus: [b.A] }]);

      expect((await coverageFor(b, 'A')).coverage).toBe('EXACT');
      for (const pack of ['B', 'C', 'D'] as const) {
        const g = await coverageFor(b, pack);
        expect(g.coverage).toBe('EMPTY');
        expect(g.items).toHaveLength(0);
      }
    });
  });

  it('C. A + B — and C and D get nothing', async () => {
    await withProduct(async (b) => {
      await save(b, [{ url: `${CDN}/ab.jpg`, skus: [b.A, b.B] }]);

      const [asset] = await load(b.familyId);
      expect(asset!.variantLinks).toHaveLength(2);
      expect((await coverageFor(b, 'A')).items).toHaveLength(1);
      expect((await coverageFor(b, 'B')).items).toHaveLength(1);
      expect((await coverageFor(b, 'C')).items).toHaveLength(0);
      expect((await coverageFor(b, 'D')).items).toHaveLength(0);
    });
  });

  it('the QA matrix resolves exactly as drawn', async () => {
    await withProduct(async (b) => {
      await save(b, [
        { url: `${CDN}/1.jpg`, skus: [b.A, b.B] },
        { url: `${CDN}/2.jpg`, skus: [b.A, b.C] },
        { url: `${CDN}/3.jpg`, skus: [b.B, b.C, b.D] },
        { url: `${CDN}/4.jpg`, skus: [b.D] },
      ]);

      const urls = async (pack: 'A' | 'B' | 'C' | 'D') =>
        (await coverageFor(b, pack)).items.map((m) => m.url.split('/').pop()).sort();

      expect(await urls('A')).toEqual(['1.jpg', '2.jpg']);
      expect(await urls('B')).toEqual(['1.jpg', '3.jpg']);
      expect(await urls('C')).toEqual(['2.jpg', '3.jpg']);
      expect(await urls('D')).toEqual(['3.jpg', '4.jpg']);
    });
  });
});

describe('editing assignments', () => {
  it('H. A+B+C -> A+C removes only B, and keeps the asset', async () => {
    await withProduct(async (b) => {
      await save(b, [{ url: `${CDN}/keep.jpg`, skus: [b.A, b.B, b.C] }]);
      const before = (await load(b.familyId))[0]!;

      await save(b, [{ id: before.id, url: `${CDN}/keep.jpg`, skus: [b.A, b.C] }]);

      const after = (await load(b.familyId))[0]!;
      expect(after.id).toBe(before.id);
      expect(after.publicId).toBe(before.publicId);
      expect(after.url).toBe(before.url);
      expect(after.status).not.toBe(MediaStatus.ARCHIVED);
      expect(after.variantLinks.map((l) => l.variantId).sort())
        .toEqual([b.ids.A, b.ids.C].sort());
      expect((await coverageFor(b, 'B')).items).toHaveLength(0);
    });
  });

  it('I. A -> A+B adds only B', async () => {
    await withProduct(async (b) => {
      await save(b, [{ url: `${CDN}/grow.jpg`, skus: [b.A] }]);
      const before = (await load(b.familyId))[0]!;

      await save(b, [{ id: before.id, url: `${CDN}/grow.jpg`, skus: [b.A, b.B] }]);

      const after = (await load(b.familyId))[0]!;
      expect(after.id).toBe(before.id);
      expect(after.variantLinks.map((l) => l.variantId).sort())
        .toEqual([b.ids.A, b.ids.B].sort());
    });
  });

  it('F. shared -> specific converts intentionally', async () => {
    await withProduct(async (b) => {
      await save(b, [{ url: `${CDN}/conv.jpg`, skus: [] }]);
      const before = (await load(b.familyId))[0]!;
      expect((await coverageFor(b, 'A')).coverage).toBe('SHARED_ONLY');

      await save(b, [{ id: before.id, url: `${CDN}/conv.jpg`, skus: [b.A, b.B] }]);

      const after = (await load(b.familyId))[0]!;
      expect(after.id).toBe(before.id);
      expect(after.variantLinks).toHaveLength(2);
      expect((await coverageFor(b, 'A')).coverage).toBe('EXACT');
      expect((await coverageFor(b, 'C')).coverage).toBe('EMPTY');
    });
  });

  it('G. specific -> shared removes the rows and keeps the asset', async () => {
    await withProduct(async (b) => {
      await save(b, [{ url: `${CDN}/back.jpg`, skus: [b.A, b.B] }]);
      const before = (await load(b.familyId))[0]!;

      await save(b, [{ id: before.id, url: `${CDN}/back.jpg`, skus: [] }]);

      const after = (await load(b.familyId))[0]!;
      expect(after.id).toBe(before.id);
      expect(after.publicId).toBe(before.publicId);
      expect(after.variantLinks).toHaveLength(0);
      expect((await coverageFor(b, 'C')).coverage).toBe('SHARED_ONLY');
    });
  });

  it('J/K. identity survives every reassignment', async () => {
    await withProduct(async (b) => {
      await save(b, [{ url: `${CDN}/stable.jpg`, skus: [b.A] }]);
      const first = (await load(b.familyId))[0]!;

      for (const skus of [[b.A, b.B], [b.B], [], [b.A, b.B, b.C, b.D], [b.C]]) {
        await save(b, [{ id: first.id, url: `${CDN}/stable.jpg`, skus }]);
        const now = (await load(b.familyId))[0]!;
        expect(now.id).toBe(first.id);
        expect(now.publicId).toBe(first.publicId);
        expect(now.url).toBe(first.url);
      }
      expect(await prisma.productMedia.count({ where: { familyId: b.familyId } })).toBe(1);
    });
  });

  it('never duplicates a row when the same set is saved twice', async () => {
    await withProduct(async (b) => {
      await save(b, [{ url: `${CDN}/idem.jpg`, skus: [b.A, b.B] }]);
      const first = (await load(b.familyId))[0]!;
      await save(b, [{ id: first.id, url: `${CDN}/idem.jpg`, skus: [b.A, b.B] }]);

      const after = (await load(b.familyId))[0]!;
      expect(after.variantLinks).toHaveLength(2);
      expect(await prisma.productMediaVariant.count({ where: { productMediaId: after.id } })).toBe(2);
    });
  });
});

describe('the other coverage states still work', () => {
  it('M. INHERITED survives — a multipack with no assignment of its own', async () => {
    await withProduct(async (b) => {
      await save(b, [{ url: `${CDN}/base.jpg`, skus: [b.A] }]);
      const g = await coverageFor(b, 'D');
      expect(g.coverage).toBe('INHERITED');
      expect(g.items.map((m) => m.url.split('/').pop())).toEqual(['base.jpg']);
    }, { inherit: true });
  });

  it('assigning the multipack explicitly overrides what it inherits', async () => {
    await withProduct(async (b) => {
      await save(b, [
        { url: `${CDN}/base.jpg`, skus: [b.A] },
        { url: `${CDN}/own.jpg`, skus: [b.D] },
      ]);
      const g = await coverageFor(b, 'D');
      expect(g.coverage).toBe('EXACT');
      expect(g.items.map((m) => m.url.split('/').pop())).toEqual(['own.jpg']);
    }, { inherit: true });
  });

  it('shared assets still join a specific pack’s gallery', async () => {
    await withProduct(async (b) => {
      await save(b, [
        { url: `${CDN}/panel.jpg`, skus: [] },
        { url: `${CDN}/a.jpg`, skus: [b.A] },
      ]);
      const g = await coverageFor(b, 'A');
      expect(g.coverage).toBe('EXACT');
      expect(g.items.map((m) => m.url.split('/').pop()).sort()).toEqual(['a.jpg', 'panel.jpg']);
    });
  });

  it('L. hero is unaffected by reassignment', async () => {
    await withProduct(async (b) => {
      await save(b, [{ url: `${CDN}/hero.jpg`, skus: [b.A, b.B] }]);
      const asset = (await load(b.familyId))[0]!;
      await prisma.productVariant.update({
        where: { id: b.ids.A }, data: { heroMediaId: asset.id },
      });

      await save(b, [{ id: asset.id, url: `${CDN}/hero.jpg`, skus: [b.A, b.B, b.C] }]);

      const variant = await prisma.productVariant.findUniqueOrThrow({
        where: { id: b.ids.A }, select: { heroMediaId: true },
      });
      expect(variant.heroMediaId).toBe(asset.id);
      // And assigning an asset never makes it a hero anywhere else.
      const other = await prisma.productVariant.findUniqueOrThrow({
        where: { id: b.ids.C }, select: { heroMediaId: true },
      });
      expect(other.heroMediaId).toBeNull();
    });
  });
});
