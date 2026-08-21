/**
 * Media integrity tests.
 *
 * These run against the real database, because the rules being tested ARE
 * database behaviour: composite primary keys, cascade direction, and what
 * survives a save. A mocked Prisma would assert that the mock was called, not
 * that the invariant holds.
 *
 * Every test builds its own product in a transaction and rolls it back, so the
 * live catalogue is never touched and the suite can run repeatedly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MediaStatus, MediaType, PrismaClient, type Prisma } from '@prisma/client';
import { sweepFixtures } from '@/test/fixtures';
import {
  HeroRejection,
  MediaDisposition,
  assessVariantRemoval,
  checkHero,
  deactivateVariantWithMedia,
  loadResolvable,
  reconcileMedia,
  syncAssignments,
  type IncomingMedia,
} from './media.integrity';
import { Coverage, resolveGallery } from './media.resolver';

const prisma = new PrismaClient();

/* Clear anything an earlier crashed run left behind. */
beforeAll(async () => {
  await sweepFixtures(prisma);
});
afterAll(async () => prisma.$disconnect());

/** Marker so anything that ever escapes a rollback is obvious. */
const TAG = `zz-mediatest-${Date.now()}`;

class Rollback extends Error {}

/**
 * Run a test inside a transaction that is always rolled back.
 *
 * Throwing at the end is how Prisma is told to roll back; the sentinel is caught
 * so the test still reports its own assertions rather than the abort.
 */
async function inRollback<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  let captured: T;
  try {
    await prisma.$transaction(async (tx) => {
      captured = await fn(tx);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return captured!;
}

/** A product with three packs: base, twin (inherits base), and a 1kg. */
async function seed(tx: Prisma.TransactionClient) {
  // SKUs are globally unique, and one test seeds two products, so each seed
  // needs its own namespace rather than sharing the run-level tag.
  const ns = `${TAG}-${Math.random().toString(36).slice(2, 8)}`;

  const family = await tx.productFamily.create({
    data: {
      slug: ns,
      name: 'Integrity Test Product',
      shortDesc: 'x',
      category: 'BETTA',
      status: 'DRAFT',
    },
    select: { id: true },
  });

  const mk = (sku: string, pack: string, position: number) =>
    tx.productVariant.create({
      data: {
        familyId: family.id,
        sku: `${ns}-${sku}`,
        pack,
        mrpPaise: 10000,
        pricePaise: 9000,
        stock: 5,
        position,
      },
      select: { id: true, sku: true, baseVariantId: true },
    });

  const base = await mk('45G', '45g', 0);
  const twin = await tx.productVariant.create({
    data: {
      familyId: family.id,
      sku: `${ns}-45GX2`,
      pack: '45g x 2',
      mrpPaise: 19000,
      pricePaise: 17000,
      stock: 5,
      position: 1,
      baseVariantId: base.id,
      packMultiplier: 2,
    },
    select: { id: true, sku: true, baseVariantId: true },
  });
  const kilo = await mk('1KG', '1kg', 2);

  const bySku = new Map([
    [base.sku.toUpperCase(), base.id],
    [twin.sku.toUpperCase(), twin.id],
    [kilo.sku.toUpperCase(), kilo.id],
  ]);

  return { familyId: family.id, base, twin, kilo, bySku };
}

const item = (over: Partial<IncomingMedia> & { url: string }): IncomingMedia => ({
  type: MediaType.IMAGE,
  publicId: `pid-${over.url}`,
  alt: 'alt text',
  ...over,
});

// ---------------------------------------------------------------------------

describe('stable media identity', () => {
  it('keeps the same ids across saves, and updates rather than recreates', async () => {
    await inRollback(async (tx) => {
      const { familyId, base, bySku } = await seed(tx);

      await reconcileMedia(tx, familyId, [
        item({ url: 'a.jpg', sku: base.sku }),
        item({ url: 'b.jpg' }),
      ], bySku);

      const first = await tx.productMedia.findMany({
        where: { familyId }, select: { id: true, url: true }, orderBy: { position: 'asc' },
      });
      expect(first).toHaveLength(2);

      // Second save: same assets, one with edited alt text.
      const r = await reconcileMedia(tx, familyId, [
        item({ id: first[0]!.id, url: 'a.jpg', sku: base.sku, alt: 'edited' }),
        item({ id: first[1]!.id, url: 'b.jpg' }),
      ], bySku);

      const second = await tx.productMedia.findMany({
        where: { familyId }, select: { id: true, alt: true }, orderBy: { position: 'asc' },
      });

      expect(second.map((m) => m.id)).toEqual(first.map((m) => m.id));
      expect(r.created).toBe(0);
      expect(r.updated).toBe(2);
      expect(second[0]!.alt).toBe('edited');
    });
  });

  it('matches on publicId when the payload carries no id', async () => {
    await inRollback(async (tx) => {
      const { familyId, bySku } = await seed(tx);
      await reconcileMedia(tx, familyId, [item({ url: 'a.jpg' })], bySku);
      const before = await tx.productMedia.findFirstOrThrow({ where: { familyId }, select: { id: true } });

      // No id — as an older CMS build would send.
      await reconcileMedia(tx, familyId, [item({ url: 'a.jpg' })], bySku);
      const after = await tx.productMedia.findFirstOrThrow({ where: { familyId }, select: { id: true } });

      expect(after.id).toBe(before.id);
    });
  });

  it('archives what leaves the gallery instead of deleting it', async () => {
    await inRollback(async (tx) => {
      const { familyId, bySku } = await seed(tx);
      await reconcileMedia(tx, familyId, [item({ url: 'a.jpg' }), item({ url: 'b.jpg' })], bySku);

      const r = await reconcileMedia(tx, familyId, [item({ url: 'a.jpg' })], bySku);

      expect(r.archived).toBe(1);
      expect(r.archivedPublicIds).toEqual(['pid-b.jpg']);
      // The row survives, so its publicId can be swept deliberately.
      const gone = await tx.productMedia.findFirstOrThrow({
        where: { familyId, url: 'b.jpg' }, select: { status: true, publicId: true },
      });
      expect(gone.status).toBe(MediaStatus.ARCHIVED);
      expect(gone.publicId).toBe('pid-b.jpg');
    });
  });

  it('preserves url, publicId, alt and position through a save', async () => {
    await inRollback(async (tx) => {
      const { familyId, base, bySku } = await seed(tx);
      await reconcileMedia(tx, familyId, [
        item({ url: 'x.jpg', sku: base.sku, alt: 'keep me' }),
      ], bySku);

      const row = await tx.productMedia.findFirstOrThrow({
        where: { familyId },
        select: { url: true, publicId: true, alt: true, position: true, variantId: true },
      });
      expect(row).toMatchObject({
        url: 'x.jpg', publicId: 'pid-x.jpg', alt: 'keep me', position: 0, variantId: base.id,
      });
    });
  });

  it('is safe to run twice — a retry changes nothing', async () => {
    await inRollback(async (tx) => {
      const { familyId, base, bySku } = await seed(tx);
      const payload = [item({ url: 'a.jpg', sku: base.sku })];

      await reconcileMedia(tx, familyId, payload, bySku);
      const once = await tx.productMedia.findMany({ where: { familyId }, select: { id: true } });
      await reconcileMedia(tx, familyId, payload, bySku);
      const twice = await tx.productMedia.findMany({ where: { familyId }, select: { id: true } });

      expect(twice.map((m) => m.id)).toEqual(once.map((m) => m.id));
      expect(await tx.productMediaVariant.count({ where: { productMediaId: once[0]!.id } })).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------

describe('many-to-many targeting', () => {
  it('assigns one asset to several packs without duplicating it', async () => {
    await inRollback(async (tx) => {
      const { familyId, base, twin, kilo, bySku } = await seed(tx);

      await reconcileMedia(tx, familyId, [
        item({ url: 'shot.jpg', skus: [base.sku, twin.sku, kilo.sku] }),
      ], bySku);

      expect(await tx.productMedia.count({ where: { familyId } })).toBe(1);
      const media = await tx.productMedia.findFirstOrThrow({ where: { familyId }, select: { id: true } });
      expect(await tx.productMediaVariant.count({ where: { productMediaId: media.id } })).toBe(3);
    });
  });

  it('refuses a duplicate assignment at the database level', async () => {
    await inRollback(async (tx) => {
      const { familyId, base, bySku } = await seed(tx);
      await reconcileMedia(tx, familyId, [item({ url: 'a.jpg', sku: base.sku })], bySku);
      const media = await tx.productMedia.findFirstOrThrow({ where: { familyId }, select: { id: true } });

      await expect(
        tx.productMediaVariant.create({ data: { productMediaId: media.id, variantId: base.id } }),
      ).rejects.toThrow();
    });
  });

  it('syncAssignments is idempotent', async () => {
    await inRollback(async (tx) => {
      const { familyId, base, twin, bySku } = await seed(tx);
      await reconcileMedia(tx, familyId, [item({ url: 'a.jpg' })], bySku);
      const media = await tx.productMedia.findFirstOrThrow({ where: { familyId }, select: { id: true } });

      await syncAssignments(tx, media.id, [base.id, twin.id]);
      await syncAssignments(tx, media.id, [base.id, twin.id]);

      expect(await tx.productMediaVariant.count({ where: { productMediaId: media.id } })).toBe(2);
    });
  });

  it('un-assigning removes the link but never the asset', async () => {
    await inRollback(async (tx) => {
      const { familyId, base, bySku } = await seed(tx);
      await reconcileMedia(tx, familyId, [item({ url: 'a.jpg', sku: base.sku })], bySku);
      const media = await tx.productMedia.findFirstOrThrow({ where: { familyId }, select: { id: true } });

      await syncAssignments(tx, media.id, []);

      expect(await tx.productMediaVariant.count({ where: { productMediaId: media.id } })).toBe(0);
      expect(await tx.productMedia.count({ where: { id: media.id } })).toBe(1);
    });
  });

  it('a multi-target asset appears once in a resolved gallery', async () => {
    await inRollback(async (tx) => {
      const { familyId, base, twin, bySku } = await seed(tx);
      await reconcileMedia(tx, familyId, [
        item({ url: 'shot.jpg', skus: [base.sku, twin.sku] }),
      ], bySku);

      const media = await loadResolvable(tx, familyId);
      const r = resolveGallery(media, { id: base.id, sku: base.sku });
      expect(r.items).toHaveLength(1);
      expect(r.coverage).toBe(Coverage.EXACT);
    });
  });
});

// ---------------------------------------------------------------------------

describe('hero integrity', () => {
  it('accepts an asset the pack actually shows', async () => {
    await inRollback(async (tx) => {
      const { familyId, base, bySku } = await seed(tx);
      await reconcileMedia(tx, familyId, [item({ url: 'a.jpg', sku: base.sku })], bySku);
      const media = await tx.productMedia.findFirstOrThrow({ where: { familyId }, select: { id: true } });

      expect((await checkHero(tx, base.id, media.id)).ok).toBe(true);
    });
  });

  it('rejects an asset belonging to another product', async () => {
    await inRollback(async (tx) => {
      const a = await seed(tx);
      const b = await seed(tx);
      await reconcileMedia(tx, b.familyId, [item({ url: 'other.jpg', sku: b.base.sku })], b.bySku);
      const foreign = await tx.productMedia.findFirstOrThrow({
        where: { familyId: b.familyId }, select: { id: true },
      });

      const r = await checkHero(tx, a.base.id, foreign.id);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe(HeroRejection.WRONG_PRODUCT);
    });
  });

  it('rejects an archived asset', async () => {
    await inRollback(async (tx) => {
      const { familyId, base, bySku } = await seed(tx);
      await reconcileMedia(tx, familyId, [item({ url: 'a.jpg', sku: base.sku })], bySku);
      const media = await tx.productMedia.findFirstOrThrow({ where: { familyId }, select: { id: true } });
      await tx.productMedia.update({
        where: { id: media.id },
        data: { status: MediaStatus.ARCHIVED, archivedAt: new Date() },
      });

      const r = await checkHero(tx, base.id, media.id);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe(HeroRejection.ARCHIVED);
    });
  });

  it("rejects an asset that is not in this pack's gallery", async () => {
    await inRollback(async (tx) => {
      const { familyId, base, kilo, bySku } = await seed(tx);
      await reconcileMedia(tx, familyId, [item({ url: 'kilo.jpg', sku: kilo.sku })], bySku);
      const kiloShot = await tx.productMedia.findFirstOrThrow({ where: { familyId }, select: { id: true } });

      const r = await checkHero(tx, base.id, kiloShot.id);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe(HeroRejection.NOT_IN_GALLERY);
    });
  });

  it('rejects a media id that does not exist', async () => {
    await inRollback(async (tx) => {
      const { base } = await seed(tx);
      const r = await checkHero(tx, base.id, '00000000-0000-0000-0000-000000000000');
      expect(r.ok).toBe(false);
      expect(r.reason).toBe(HeroRejection.NOT_FOUND);
    });
  });
});

// ---------------------------------------------------------------------------

describe('variant removal safety', () => {
  it('NEVER turns pack media into shared media', async () => {
    await inRollback(async (tx) => {
      const { familyId, kilo, bySku } = await seed(tx);
      await reconcileMedia(tx, familyId, [item({ url: 'kilo.jpg', sku: kilo.sku })], bySku);

      await deactivateVariantWithMedia(tx, kilo.id, MediaDisposition.KEEP_WITH_VARIANT);

      const row = await tx.productMedia.findFirstOrThrow({
        where: { familyId }, select: { variantId: true, status: true },
      });
      // The old SetNull behaviour would have made this null — i.e. shared.
      expect(row.variantId).toBe(kilo.id);
      expect(row.status).toBe(MediaStatus.READY);
      expect(await tx.productMediaVariant.count({ where: { variantId: kilo.id } })).toBe(1);
    });
  });

  it('does not leak the removed pack’s photography to other packs', async () => {
    await inRollback(async (tx) => {
      const { familyId, base, kilo, bySku } = await seed(tx);
      await reconcileMedia(tx, familyId, [item({ url: 'kilo.jpg', sku: kilo.sku })], bySku);
      await deactivateVariantWithMedia(tx, kilo.id, MediaDisposition.KEEP_WITH_VARIANT);

      const r = resolveGallery(await loadResolvable(tx, familyId), { id: base.id, sku: base.sku });
      expect(r.items).toHaveLength(0);
      expect(r.coverage).toBe(Coverage.EMPTY);
    });
  });

  it('reports what a removal would affect, before it happens', async () => {
    await inRollback(async (tx) => {
      const { familyId, base, twin, bySku } = await seed(tx);
      await reconcileMedia(tx, familyId, [item({ url: 'base.jpg', sku: base.sku })], bySku);
      const media = await tx.productMedia.findFirstOrThrow({ where: { familyId }, select: { id: true } });
      await tx.productVariant.update({ where: { id: base.id }, data: { heroMediaId: media.id } });

      const impact = await assessVariantRemoval(tx, base.id);
      expect(impact.ownMediaCount).toBe(1);
      expect(impact.heroOfSkus).toContain(base.sku);
      expect(impact.dependentSkus).toContain(twin.sku);
      expect(impact.needsDecision).toBe(true);
    });
  });

  it('makes media shared only when that is explicitly chosen', async () => {
    await inRollback(async (tx) => {
      const { familyId, kilo, bySku } = await seed(tx);
      await reconcileMedia(tx, familyId, [item({ url: 'kilo.jpg', sku: kilo.sku })], bySku);

      await deactivateVariantWithMedia(tx, kilo.id, MediaDisposition.MAKE_SHARED);

      const row = await tx.productMedia.findFirstOrThrow({ where: { familyId }, select: { variantId: true } });
      expect(row.variantId).toBeNull();
      expect(await tx.productMediaVariant.count({ where: { variantId: kilo.id } })).toBe(0);
    });
  });

  it('can move photography to another pack instead', async () => {
    await inRollback(async (tx) => {
      const { familyId, base, kilo, bySku } = await seed(tx);
      await reconcileMedia(tx, familyId, [item({ url: 'kilo.jpg', sku: kilo.sku })], bySku);

      await deactivateVariantWithMedia(tx, kilo.id, MediaDisposition.MOVE, base.id);

      const row = await tx.productMedia.findFirstOrThrow({ where: { familyId }, select: { variantId: true } });
      expect(row.variantId).toBe(base.id);
      expect(await tx.productMediaVariant.count({ where: { variantId: base.id } })).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------

describe('base variant removal', () => {
  it('detects the packs that inherit from it', async () => {
    await inRollback(async (tx) => {
      const { base, twin } = await seed(tx);
      const impact = await assessVariantRemoval(tx, base.id);
      expect(impact.dependentSkus).toEqual([twin.sku]);
    });
  });

  it('leaves inheritance resolving after the base is deactivated', async () => {
    await inRollback(async (tx) => {
      const { familyId, base, twin, bySku } = await seed(tx);
      await reconcileMedia(tx, familyId, [item({ url: 'base.jpg', sku: base.sku })], bySku);

      await deactivateVariantWithMedia(tx, base.id, MediaDisposition.KEEP_WITH_VARIANT);

      // The pointer stays valid — the pack is inactive, not gone — so the twin
      // still resolves rather than silently emptying.
      const r = resolveGallery(await loadResolvable(tx, familyId), {
        id: twin.id, sku: twin.sku, baseVariantId: base.id,
      });
      expect(r.coverage).toBe(Coverage.INHERITED);
      expect(r.items).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------

describe('SKU independence', () => {
  it('renaming a pack does not change its gallery', async () => {
    await inRollback(async (tx) => {
      const { familyId, base, bySku } = await seed(tx);
      await reconcileMedia(tx, familyId, [item({ url: 'a.jpg', sku: base.sku })], bySku);

      const before = resolveGallery(await loadResolvable(tx, familyId), { id: base.id, sku: base.sku });
      await tx.productVariant.update({ where: { id: base.id }, data: { sku: `${TAG}-RENAMED` } });
      const after = resolveGallery(await loadResolvable(tx, familyId), { id: base.id, sku: `${TAG}-RENAMED` });

      expect(after.items.map((m) => m.id)).toEqual(before.items.map((m) => m.id));
      expect(after.coverage).toBe(before.coverage);
    });
  });
});
