/**
 * Publishing product content never writes pack stock or active state.
 *
 * The editor's payload carries every pack's stock as it was when the page was
 * loaded, and publish() used to write it back. Any stock movement in between
 * (an order, a cancellation restock, a stock-tool count) was silently undone,
 * and a check afterwards could not tell, because a lost decrement looks exactly
 * like "stock unchanged". On 19 Nov 2026 M3-1KG ended a publish at 2 after the
 * stock tool had set it to 10 two minutes earlier.
 *
 * Stock is owned by checkout, the order paths and the stock tool. Active state
 * is never switched by publishing. Only packs CREATED by a publish take their
 * initial stock and active state from the payload.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaType, PrismaClient, ProductStatus } from '@prisma/client';
import { publish, saveDraft, updateStock } from './products.service';
import { productBodySchema } from './products.schemas';
import * as revalidate from '@/integrations/storefront/revalidate';
import { dropFamily, ns, sweepFixtures, testActor, testCtx } from '@/test/fixtures';
import type { Role } from '@prisma/client';

const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());

const ADMIN = 'ADMIN' as Role;
const CDN = 'https://res.cloudinary.com/test';

let actorId: string;
const actor = async () => (actorId ??= await testActor(prisma));

beforeAll(async () => {
  await sweepFixtures(prisma);
});
beforeEach(() => {
  vi.spyOn(revalidate, 'revalidateStorefront').mockResolvedValue(undefined);
});

interface Built { slug: string; familyId: string; base: string; kilo: string }

/** A live product with two packs, each holding 10 units. */
async function withProduct<T>(fn: (b: Built) => Promise<T>): Promise<T> {
  const slug = ns('stock');
  const family = await prisma.productFamily.create({
    data: {
      slug, name: 'Stock Test', shortDesc: 'original', category: 'BETTA',
      status: ProductStatus.ACTIVE, publishedAt: new Date(),
    },
    select: { id: true },
  });
  try {
    const mk = (sku: string, pack: string, position: number) =>
      prisma.productVariant.create({
        data: { familyId: family.id, sku: `${slug.toUpperCase()}-${sku}`, pack, position,
          mrpPaise: 10000, pricePaise: 10000, stock: 10 },
        select: { sku: true },
      });
    const base = await mk('45G', '45g Bottle', 0);
    const kilo = await mk('1KG', '1kg Pouch', 1);
    return await fn({ slug, familyId: family.id, base: base.sku, kilo: kilo.sku });
  } finally {
    await dropFamily(prisma, family.id);
  }
}

type Pack = { sku: string; pack: string; mrp?: number; price?: number; stock?: number; isActive?: boolean };

/** What the CMS editor sends: every pack with the stock it showed when loaded (10). */
const body = (b: Built, packs?: Pack[], shortDesc = 'edited in the draft') => productBodySchema.parse({
  name: 'Stock Test', slug: b.slug, category: 'Betta', status: 'Active', badge: null,
  shortDesc, fullDesc: '', protein: 40, benefits: [], tags: [],
  feedFreq: null, feedPortion: null, feedNotes: null, nutrition: {}, seoTitle: null, seoDesc: null,
  media: [{ type: MediaType.IMAGE, url: `${CDN}/bottle.jpg`, alt: 'a', publicId: null, sku: b.base, skus: [b.base] }],
  variants: (packs ?? [
    { sku: b.base, pack: '45g Bottle' },
    { sku: b.kilo, pack: '1kg Pouch' },
  ]).map((p) => ({
    sku: p.sku, pack: p.pack, mrp: p.mrp ?? 100, price: p.price ?? 100,
    stock: p.stock ?? 10, hsn: '23099090', isActive: p.isActive ?? true,
  })),
}) as never;

const packs = async (familyId: string) => {
  const rows = await prisma.productVariant.findMany({
    where: { familyId },
    select: { sku: true, pack: true, pricePaise: true, position: true, stock: true, isActive: true },
    orderBy: { position: 'asc' },
  });
  return new Map(rows.map((r) => [r.sku, r]));
};

/** Checkout's own stock guard (checkout.service.ts, step 5a), verbatim. */
const checkoutDecrement = (sku: string, qty: number) =>
  prisma.productVariant.updateMany({
    where: { sku, stock: { gte: qty } },
    data: { stock: { decrement: qty } },
  });

const saveAndPublish = async (b: Built, payload: never) => {
  const id = await actor();
  await saveDraft(b.slug, payload, id, testCtx(id), ADMIN);
  await publish(b.slug, id, testCtx(id), ADMIN);
};

describe('publishing does not overwrite stock', () => {
  it('keeps an order placed between saving the draft and publishing', async () => {
    await withProduct(async (b) => {
      const id = await actor();
      // The editor was loaded at stock 10; the draft carries 10.
      await saveDraft(b.slug, body(b, [
        { sku: b.base, pack: '45g Bottle (new label)', mrp: 150, price: 120 },
        { sku: b.kilo, pack: '1kg Pouch' },
      ]), id, testCtx(id), ADMIN);

      // A customer buys 3 before the operator presses Publish.
      expect((await checkoutDecrement(b.base, 3)).count).toBe(1);

      await publish(b.slug, id, testCtx(id), ADMIN);

      const after = await packs(b.familyId);
      expect(after.get(b.base)!.stock).toBe(7);
      // The content in the same publish still went live.
      expect(after.get(b.base)!.pack).toBe('45g Bottle (new label)');
      expect(after.get(b.base)!.pricePaise).toBe(12000);
      const fam = await prisma.productFamily.findUniqueOrThrow({ where: { id: b.familyId }, select: { shortDesc: true } });
      expect(fam.shortDesc).toBe('edited in the draft');
    });
  });

  it('keeps a stock-tool count made while the draft was open', async () => {
    await withProduct(async (b) => {
      const id = await actor();
      await saveDraft(b.slug, body(b), id, testCtx(id), ADMIN);
      await updateStock(b.slug, [{ sku: b.kilo, stock: 25 }], id, testCtx(id), ADMIN);

      await publish(b.slug, id, testCtx(id), ADMIN);

      expect((await packs(b.familyId)).get(b.kilo)!.stock).toBe(25);
    });
  });

  it('ignores the stock value in the payload for an existing pack', async () => {
    await withProduct(async (b) => {
      await saveAndPublish(b, body(b, [
        { sku: b.base, pack: '45g Bottle', stock: 999 },
        { sku: b.kilo, pack: '1kg Pouch', stock: 0 },
      ]));

      const after = await packs(b.familyId);
      expect(after.get(b.base)!.stock).toBe(10);
      expect(after.get(b.kilo)!.stock).toBe(10);
    });
  });

  it('loses no unit when orders run concurrently with a publish', async () => {
    await withProduct(async (b) => {
      const id = await actor();
      for (let round = 0; round < 3; round++) {
        await prisma.productVariant.update({ where: { sku: b.base }, data: { stock: 40 } });
        await saveDraft(b.slug, body(b, undefined, `round ${round}`), id, testCtx(id), ADMIN);

        const orders = Array.from({ length: 20 }, () => checkoutDecrement(b.base, 1));
        const results = await Promise.all([publish(b.slug, id, testCtx(id), ADMIN), ...orders]);

        const sold = results.slice(1).reduce((n, r) => n + (r as { count: number }).count, 0);
        expect(sold).toBe(20);
        expect((await packs(b.familyId)).get(b.base)!.stock).toBe(40 - 20);
      }
    });
  });
});

describe('publishing does not change pack active state', () => {
  it('leaves an inactive pack inactive, whatever the payload says', async () => {
    await withProduct(async (b) => {
      await prisma.productVariant.update({ where: { sku: b.kilo }, data: { isActive: false } });

      await saveAndPublish(b, body(b, [
        { sku: b.base, pack: '45g Bottle', isActive: true },
        { sku: b.kilo, pack: '1kg Pouch', isActive: true },
      ]));

      const after = await packs(b.familyId);
      expect(after.get(b.kilo)!.isActive).toBe(false);
      expect(after.get(b.base)!.isActive).toBe(true);
    });
  });

  it('leaves an active pack active when the payload says false', async () => {
    await withProduct(async (b) => {
      await saveAndPublish(b, body(b, [
        { sku: b.base, pack: '45g Bottle', isActive: false },
        { sku: b.kilo, pack: '1kg Pouch', isActive: false },
      ]));

      const after = await packs(b.familyId);
      expect(after.get(b.base)!.isActive).toBe(true);
      expect(after.get(b.kilo)!.isActive).toBe(true);
    });
  });
});

describe('packs created by a publish', () => {
  it('take their initial stock from the payload and start active', async () => {
    await withProduct(async (b) => {
      const twin = `${b.slug.toUpperCase()}-45GX2`;
      await saveAndPublish(b, body(b, [
        { sku: b.base, pack: '45g Bottle' },
        { sku: twin, pack: '45g x 2', stock: 12, isActive: false },
        { sku: b.kilo, pack: '1kg Pouch' },
      ]));

      const after = await packs(b.familyId);
      expect(after.get(twin)).toMatchObject({ stock: 12, isActive: true, position: 1, pack: '45g x 2' });
      // The existing packs moved position but kept their stock.
      expect(after.get(b.kilo)).toMatchObject({ stock: 10, position: 2 });
    });
  });
});
