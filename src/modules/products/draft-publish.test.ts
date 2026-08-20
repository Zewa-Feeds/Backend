/**
 * Save never publishes; publish does.
 *
 * The editor says "Nothing goes live on save alone" directly above the button.
 * It was untrue for any product that had never been published — nine of the
 * thirteen in the catalogue — because saveDraft treated those as "safe to write
 * through" and applied the whole payload to the live rows, stamping publishedAt
 * on the way. These pin the promise the UI makes.
 *
 * Also covers applyRepresentative, which is the one write path guarding a
 * cross-product boundary the database cannot express.
 */
import { afterAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { MediaType, PrismaClient, ProductStatus } from '@prisma/client';
import { saveDraft, publish, setStatus } from './products.service';
import { productBodySchema } from './products.schemas';
import * as revalidate from '@/integrations/storefront/revalidate';
import type { Role } from '@prisma/client';

const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());

const ADMIN = 'ADMIN' as Role;
const CDN = 'https://res.cloudinary.com/test';

let actorId: string;
const actor = async () => (actorId ??= (await prisma.cmsUser.findFirstOrThrow({ select: { id: true } })).id);
const ctxFor = (id: string) => ({
  actorId: id, actorName: 'vitest', actorRole: 'Admin', ip: '127.0.0.1', userAgent: 'vitest',
}) as never;

interface Built { slug: string; familyId: string; base: string; kilo: string }

async function withProduct<T>(
  opts: { published: boolean },
  fn: (b: Built) => Promise<T>,
): Promise<T> {
  const ns = `zzdraft${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const family = await prisma.productFamily.create({
    data: {
      slug: ns, name: 'Draft Test', shortDesc: 'original', category: 'BETTA',
      status: ProductStatus.ACTIVE,
      publishedAt: opts.published ? new Date() : null,
    },
    select: { id: true },
  });
  try {
    const mk = (sku: string, pack: string, position: number) =>
      prisma.productVariant.create({
        data: { familyId: family.id, sku: `${ns.toUpperCase()}-${sku}`, pack, position,
          mrpPaise: 10000, pricePaise: 10000, stock: 5 },
        select: { sku: true },
      });
    const base = await mk('45G', '45g Bottle', 0);
    const kilo = await mk('1KG', '1kg Pouch', 1);
    return await fn({ slug: ns, familyId: family.id, base: base.sku, kilo: kilo.sku });
  } finally {
    await prisma.productFamily.delete({ where: { id: family.id } }).catch(() => {});
  }
}

const body = (b: Built, over: Record<string, unknown> = {}) => productBodySchema.parse({
  name: 'Draft Test', slug: b.slug, category: 'Betta', status: 'Active', badge: null,
  shortDesc: 'edited in the draft', fullDesc: '', protein: 40, benefits: [], tags: [],
  feedFreq: null, feedPortion: null, feedNotes: null, nutrition: {}, seoTitle: null, seoDesc: null,
  media: [{ type: MediaType.IMAGE, url: `${CDN}/bottle.jpg`, alt: 'a', publicId: null, sku: b.base, skus: [b.base] }],
  variants: [
    { sku: b.base, pack: '45g Bottle', mrp: 100, price: 100, stock: 5, hsn: '23099090', isActive: true },
    { sku: b.kilo, pack: '1kg Pouch', mrp: 200, price: 200, stock: 5, hsn: '23099090', isActive: true },
  ],
  ...over,
}) as never;

const state = (id: string) => prisma.productFamily.findUniqueOrThrow({
  where: { id },
  select: {
    shortDesc: true, publishedAt: true, status: true, representativeVariantId: true,
    draft: { select: { id: true } },
    _count: { select: { media: true } },
    variants: { select: { sku: true, isActive: true } },
  },
});

/*
 * The cache purge is observed, not performed: whether it fires is part of the
 * contract being tested, and a real fetch to a storefront that may not be
 * running would make these tests depend on the environment.
 */
let purge: MockInstance<(slug?: string) => Promise<void>>;
beforeEach(() => {
  purge = vi.spyOn(revalidate, 'revalidateStorefront').mockResolvedValue(undefined);
});

describe('save draft', () => {
  it('leaves an UNPUBLISHED product unpublished', async () => {
    await withProduct({ published: false }, async (b) => {
      const id = await actor();
      await saveDraft(b.slug, body(b), id, ctxFor(id), ADMIN);

      const after = await state(b.familyId);
      expect(after.publishedAt).toBeNull();
      expect(after.draft).not.toBeNull();
    });
  });

  it('does not write live content for an unpublished product', async () => {
    await withProduct({ published: false }, async (b) => {
      const id = await actor();
      await saveDraft(b.slug, body(b), id, ctxFor(id), ADMIN);

      const after = await state(b.familyId);
      // The edited copy and the gallery stayed in the overlay.
      expect(after.shortDesc).toBe('original');
      expect(after._count.media).toBe(0);
    });
  });

  it('leaves a PUBLISHED product’s live version untouched', async () => {
    await withProduct({ published: true }, async (b) => {
      const id = await actor();
      const before = await state(b.familyId);
      await saveDraft(b.slug, body(b), id, ctxFor(id), ADMIN);

      const after = await state(b.familyId);
      expect(after.shortDesc).toBe('original');
      expect(after._count.media).toBe(0);
      expect(after.publishedAt).toEqual(before.publishedAt);
    });
  });

  it('does NOT purge the storefront cache', async () => {
    await withProduct({ published: true }, async (b) => {
      const id = await actor();
      await saveDraft(b.slug, body(b), id, ctxFor(id), ADMIN);
      expect(purge).not.toHaveBeenCalled();
    });
  });

  it('DOES purge when the status changes, because that is customer-visible', async () => {
    await withProduct({ published: true }, async (b) => {
      const id = await actor();
      await saveDraft(b.slug, body(b, { status: 'Inactive' }), id, ctxFor(id), ADMIN);
      expect(purge).toHaveBeenCalledWith(b.slug);
      expect((await state(b.familyId)).status).toBe(ProductStatus.INACTIVE);
    });
  });

  it('a rejected save leaves nothing behind', async () => {
    await withProduct({ published: false }, async (b) => {
      const id = await actor();
      // A SKU already owned by another product fails the uniqueness assertion.
      const clash = await prisma.productVariant.findFirstOrThrow({
        where: { family: { slug: 'guppy-bites' } }, select: { sku: true },
      });
      const bad = body(b, {
        variants: [{ sku: clash.sku, pack: 'x', mrp: 100, price: 100, stock: 1, hsn: '23099090', isActive: true }],
      });

      await expect(saveDraft(b.slug, bad, id, ctxFor(id), ADMIN)).rejects.toThrow();

      const after = await state(b.familyId);
      expect(after.draft).toBeNull();
      expect(after.publishedAt).toBeNull();
      expect(after._count.media).toBe(0);
      expect(purge).not.toHaveBeenCalled();
    });
  });
});

describe('publish', () => {
  it('applies the draft to live and stamps publishedAt', async () => {
    await withProduct({ published: false }, async (b) => {
      const id = await actor();
      await saveDraft(b.slug, body(b), id, ctxFor(id), ADMIN);
      await publish(b.slug, id, ctxFor(id), ADMIN);

      const after = await state(b.familyId);
      expect(after.shortDesc).toBe('edited in the draft');
      expect(after._count.media).toBe(1);
      expect(after.publishedAt).not.toBeNull();
      expect(after.draft).toBeNull();
    });
  });

  it('purges the storefront cache for that product', async () => {
    await withProduct({ published: false }, async (b) => {
      const id = await actor();
      await saveDraft(b.slug, body(b), id, ctxFor(id), ADMIN);
      purge.mockClear();
      await publish(b.slug, id, ctxFor(id), ADMIN);
      expect(purge).toHaveBeenCalledWith(b.slug);
    });
  });
});

describe('publishedAt has one meaning', () => {
  /*
   * "The moment this product's content first became customer-visible."
   *
   * Three paths used to disagree: setStatus() and applyToLive() stamped it when
   * a product went ACTIVE, and saveDraft()'s status branch stamped nothing — so
   * the same operator action left different rows behind depending on which
   * button was used, and a product could be on sale with publishedAt NULL while
   * its slug was still rewritable.
   */
  it('is stamped when Save Draft makes a product visible', async () => {
    await withProduct({ published: false }, async (b) => {
      const id = await actor();
      await prisma.productFamily.update({ where: { id: b.familyId }, data: { status: ProductStatus.DRAFT } });

      await saveDraft(b.slug, body(b, { status: 'Active' }), id, ctxFor(id), ADMIN);

      const after = await state(b.familyId);
      expect(after.status).toBe(ProductStatus.ACTIVE);
      expect(after.publishedAt).not.toBeNull();
    });
  });

  it('counts COMING_SOON as visible — it is a public, linkable page', async () => {
    await withProduct({ published: false }, async (b) => {
      const id = await actor();
      await prisma.productFamily.update({ where: { id: b.familyId }, data: { status: ProductStatus.DRAFT } });

      await saveDraft(b.slug, body(b, { status: 'Coming Soon' }), id, ctxFor(id), ADMIN);

      const after = await state(b.familyId);
      expect(after.status).toBe(ProductStatus.COMING_SOON);
      expect(after.publishedAt).not.toBeNull();
    });
  });

  it('is NOT stamped by a status that hides the product', async () => {
    await withProduct({ published: false }, async (b) => {
      const id = await actor();
      await prisma.productFamily.update({ where: { id: b.familyId }, data: { status: ProductStatus.DRAFT } });

      await saveDraft(b.slug, body(b, { status: 'Inactive' }), id, ctxFor(id), ADMIN);

      const after = await state(b.familyId);
      expect(after.status).toBe(ProductStatus.INACTIVE);
      expect(after.publishedAt).toBeNull();
    });
  });

  it('never moves once set — it is a first-publication timestamp', async () => {
    await withProduct({ published: true }, async (b) => {
      const id = await actor();
      const before = await state(b.familyId);

      await saveDraft(b.slug, body(b, { status: 'Inactive' }), id, ctxFor(id), ADMIN);
      await saveDraft(b.slug, body(b, { status: 'Active' }), id, ctxFor(id), ADMIN);
      await publish(b.slug, id, ctxFor(id), ADMIN);

      expect((await state(b.familyId)).publishedAt).toEqual(before.publishedAt);
    });
  });

  it('making a product visible publishes the PRODUCT, never the pending draft', async () => {
    await withProduct({ published: false }, async (b) => {
      const id = await actor();
      await prisma.productFamily.update({ where: { id: b.familyId }, data: { status: ProductStatus.DRAFT } });

      // Edited copy and a gallery sit in the overlay; the status flips to visible.
      await saveDraft(b.slug, body(b, { status: 'Active' }), id, ctxFor(id), ADMIN);

      const after = await state(b.familyId);
      expect(after.status).toBe(ProductStatus.ACTIVE);
      // Live content is untouched: the draft still has to be published.
      expect(after.shortDesc).toBe('original');
      expect(after._count.media).toBe(0);
      expect(after.draft).not.toBeNull();
    });
  });

  it('setStatus and Save Draft agree', async () => {
    const stamp = async (useSetStatus: boolean) =>
      withProduct({ published: false }, async (b) => {
        const id = await actor();
        await prisma.productFamily.update({ where: { id: b.familyId }, data: { status: ProductStatus.DRAFT } });
        if (useSetStatus) await setStatus(b.slug, ProductStatus.ACTIVE, id, ctxFor(id), ADMIN);
        else await saveDraft(b.slug, body(b, { status: 'Active' }), id, ctxFor(id), ADMIN);
        const after = await state(b.familyId);
        return { status: after.status, stamped: after.publishedAt !== null };
      });

    expect(await stamp(true)).toEqual(await stamp(false));
  });
});

describe('listing representative', () => {
  it('persists a valid active pack', async () => {
    await withProduct({ published: false }, async (b) => {
      const id = await actor();
      await saveDraft(b.slug, body(b, { representativeSku: b.kilo }), id, ctxFor(id), ADMIN);
      await publish(b.slug, id, ctxFor(id), ADMIN);

      const after = await state(b.familyId);
      const kilo = await prisma.productVariant.findUniqueOrThrow({ where: { sku: b.kilo }, select: { id: true } });
      expect(after.representativeVariantId).toBe(kilo.id);
    });
  });

  it('clears a SKU belonging to another product', async () => {
    await withProduct({ published: false }, async (b) => {
      const id = await actor();
      const foreign = await prisma.productVariant.findFirstOrThrow({
        where: { family: { slug: 'guppy-bites' } }, select: { sku: true, id: true },
      });
      await saveDraft(b.slug, body(b, { representativeSku: foreign.sku }), id, ctxFor(id), ADMIN);
      await publish(b.slug, id, ctxFor(id), ADMIN);

      const after = await state(b.familyId);
      expect(after.representativeVariantId).toBeNull();
      // And the other product is untouched.
      const theirs = await prisma.productFamily.findUniqueOrThrow({
        where: { slug: 'guppy-bites' }, select: { representativeVariantId: true },
      });
      expect(theirs.representativeVariantId).not.toBe(foreign.id);
    });
  });

  it('clears a pack that is no longer active', async () => {
    await withProduct({ published: false }, async (b) => {
      const id = await actor();
      // Drop the 1kg from the payload (deactivating it) while naming it representative.
      await saveDraft(b.slug, body(b, {
        representativeSku: b.kilo,
        variants: [{ sku: b.base, pack: '45g Bottle', mrp: 100, price: 100, stock: 5, hsn: '23099090', isActive: true }],
      }), id, ctxFor(id), ADMIN);
      await publish(b.slug, id, ctxFor(id), ADMIN);

      const after = await state(b.familyId);
      expect(after.variants.find((v) => v.sku === b.kilo)!.isActive).toBe(false);
      expect(after.representativeVariantId).toBeNull();
    });
  });

  it('survives deactivation of the pack it points at', async () => {
    await withProduct({ published: false }, async (b) => {
      const id = await actor();
      await saveDraft(b.slug, body(b, { representativeSku: b.kilo }), id, ctxFor(id), ADMIN);
      await publish(b.slug, id, ctxFor(id), ADMIN);
      expect((await state(b.familyId)).representativeVariantId).not.toBeNull();

      // Now retire that pack.
      await saveDraft(b.slug, body(b, {
        representativeSku: b.kilo,
        variants: [{ sku: b.base, pack: '45g Bottle', mrp: 100, price: 100, stock: 5, hsn: '23099090', isActive: true }],
      }), id, ctxFor(id), ADMIN);
      await publish(b.slug, id, ctxFor(id), ADMIN);

      // Cleared rather than left dangling; the resolver falls back to position.
      expect((await state(b.familyId)).representativeVariantId).toBeNull();
    });
  });
});
