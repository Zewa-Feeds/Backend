/**
 * PRODUCT display order — the sequence products appear in on the storefront.
 *
 * Not variant order (`ProductVariant.position`, the packs inside one product)
 * and not gallery order (`ProductMedia.position`). Those are separate systems;
 * the last test here exists to prove this feature leaves them alone.
 *
 * Against the real database, because what is being tested IS the persistence:
 * that a reorder lands as a dense 0..n-1 sequence, that it is atomic, and that
 * it survives a reload. A mock would only prove the mock was called.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Category, PrismaClient, ProductStatus } from '@prisma/client';
import { ns, sweepFixtures, testActor, testCtx } from '@/test/fixtures';
import { listDisplayOrder, reorder } from './products.service';

const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());

let actorId: string;
const ctx = async () => testCtx(actorId ?? (actorId = await testActor(prisma)));

/** Slugs this file creates, so assertions ignore whatever else the DB holds. */
let mine: string[] = [];

/** Our products, in stored order, with the rest of the catalogue filtered out. */
async function ourOrder(): Promise<string[]> {
  const all = await listDisplayOrder();
  return all.filter((r) => mine.includes(r.slug)).map((r) => r.slug);
}

/** The full catalogue's slugs in order — needed because reorder takes all of them. */
const fullOrder = async () => (await listDisplayOrder()).map((r) => r.slug);

/** Move `slug` to `to` within the full catalogue list, keeping everything else. */
function moved(list: string[], slug: string, to: number): string[] {
  const rest = list.filter((s) => s !== slug);
  return [...rest.slice(0, to), slug, ...rest.slice(to)];
}

async function makeProduct(label: string, status: ProductStatus, order: number) {
  const slug = ns(label);
  await prisma.productFamily.create({
    data: {
      slug,
      name: `ZZ ${label}`,
      category: Category.SLOW_SINKING_PELLETS,
      status,
      shortDesc: 'fixture',
      displayOrder: order,
    },
  });
  return slug;
}

beforeAll(async () => {
  await sweepFixtures(prisma);
});

/*
 * Rebuilt per test. Reorder rewrites EVERY row in the catalogue, so a test that
 * mutated the sequence would otherwise hand its leftovers to the next one.
 */
beforeEach(async () => {
  await prisma.productFamily.deleteMany({ where: { slug: { in: mine } } });
  mine = [
    await makeProduct('ordA', ProductStatus.ACTIVE, 1001),
    await makeProduct('ordB', ProductStatus.ACTIVE, 1002),
    await makeProduct('ordC', ProductStatus.COMING_SOON, 1003),
    await makeProduct('ordD', ProductStatus.DISCONTINUED, 1004),
  ];
});

afterAll(async () => {
  await prisma.productFamily.deleteMany({ where: { slug: { in: mine } } });
});

describe('reading the order', () => {
  it('returns products in stored displayOrder', async () => {
    expect(await ourOrder()).toEqual(mine);
  });

  it('renumbers positions densely from zero, whatever is stored', async () => {
    const rows = await listDisplayOrder();
    expect(rows.map((r) => r.position)).toEqual(rows.map((_, i) => i));
  });

  it('includes products that are not ACTIVE — sequencing is not publishing', async () => {
    const rows = await listDisplayOrder();
    const statuses = rows.filter((r) => mine.includes(r.slug)).map((r) => r.status);
    expect(statuses).toContain(ProductStatus.COMING_SOON);
    expect(statuses).toContain(ProductStatus.DISCONTINUED);
  });

  it('excludes soft-deleted products', async () => {
    await prisma.productFamily.update({
      where: { slug: mine[1]! },
      data: { deletedAt: new Date() },
    });
    expect(await ourOrder()).not.toContain(mine[1]);
    await prisma.productFamily.update({ where: { slug: mine[1]! }, data: { deletedAt: null } });
  });
});

describe('reordering', () => {
  it('moves the first product to last', async () => {
    const full = await fullOrder();
    const [first] = mine;
    await reorder(moved(full, first!, full.length - 1), await ctx());

    const after = await ourOrder();
    expect(after[after.length - 1]).toBe(first);
  });

  it('moves the last product to first', async () => {
    const full = await fullOrder();
    const last = mine[mine.length - 1]!;
    await reorder([last, ...full.filter((s) => s !== last)], await ctx());

    expect((await ourOrder())[0]).toBe(last);
  });

  it('moves a product in between two others', async () => {
    const full = await fullOrder();
    const target = mine[3]!;
    const anchor = full.indexOf(mine[0]!);
    await reorder(moved(full, target, anchor + 1), await ctx());

    const after = await ourOrder();
    expect(after.indexOf(target)).toBe(after.indexOf(mine[0]!) + 1);
  });

  it('writes a dense 0..n-1 sequence with no duplicates or gaps', async () => {
    await reorder(await fullOrder(), await ctx());

    const stored = await prisma.productFamily.findMany({
      where: { deletedAt: null },
      orderBy: { displayOrder: 'asc' },
      select: { displayOrder: true },
    });
    const values = stored.map((r) => r.displayOrder);
    expect(values).toEqual(values.map((_, i) => i));
    expect(new Set(values).size).toBe(values.length);
  });

  it('persists across a reload', async () => {
    const full = await fullOrder();
    const target = mine[2]!;
    await reorder([target, ...full.filter((s) => s !== target)], await ctx());

    // Fresh client, so nothing can be served from an in-process cache.
    const fresh = new PrismaClient();
    try {
      const row = await fresh.productFamily.findUniqueOrThrow({
        where: { slug: target },
        select: { displayOrder: true },
      });
      expect(row.displayOrder).toBe(0);
    } finally {
      await fresh.$disconnect();
    }
  });

  it('is idempotent — saving the same order twice changes nothing', async () => {
    const full = await fullOrder();
    await reorder(full, await ctx());
    const first = await fullOrder();
    await reorder(full, await ctx());
    expect(await fullOrder()).toEqual(first);
  });

  it('records the change in the audit log', async () => {
    const before = await prisma.auditLog.count();
    await reorder(await fullOrder(), await ctx());
    expect(await prisma.auditLog.count()).toBeGreaterThan(before);
  });
});

describe('rejected payloads', () => {
  it('rejects a duplicated slug rather than collapsing it', async () => {
    const full = await fullOrder();
    await expect(reorder([full[0]!, ...full], await ctx())).rejects.toMatchObject({ status: 422 });
  });

  it('rejects an unknown slug', async () => {
    await expect(reorder([...(await fullOrder()), 'zz-not-a-product'], await ctx())).rejects.toMatchObject(
      { status: 422 },
    );
  });

  it('rejects a partial list — a missing product would silently jump to the top', async () => {
    const full = await fullOrder();
    await expect(reorder(full.slice(1), await ctx())).rejects.toMatchObject({ status: 422 });
  });

  it('leaves the stored order untouched when it rejects', async () => {
    const before = await ourOrder();
    await expect(reorder((await fullOrder()).slice(1), await ctx())).rejects.toThrow();
    expect(await ourOrder()).toEqual(before);
  });
});

describe('the other ordering systems are untouched', () => {
  it('does not renumber variant positions', async () => {
    const family = await prisma.productFamily.findUniqueOrThrow({ where: { slug: mine[0]! } });
    await prisma.productVariant.createMany({
      data: [
        { familyId: family.id, sku: ns('SKA').toUpperCase(), pack: '45g', mrpPaise: 100, pricePaise: 100, position: 0 },
        { familyId: family.id, sku: ns('SKB').toUpperCase(), pack: '1kg', mrpPaise: 200, pricePaise: 200, position: 1 },
      ],
    });

    const before = await prisma.productVariant.findMany({
      where: { familyId: family.id },
      orderBy: { position: 'asc' },
      select: { sku: true, position: true },
    });

    const full = await fullOrder();
    await reorder([...full].reverse(), await ctx());

    const after = await prisma.productVariant.findMany({
      where: { familyId: family.id },
      orderBy: { position: 'asc' },
      select: { sku: true, position: true },
    });
    expect(after).toEqual(before);

    await prisma.productVariant.deleteMany({ where: { familyId: family.id } });
  });

  it('does not touch the representative variant', async () => {
    const before = await prisma.productFamily.findMany({
      where: { slug: { in: mine } },
      select: { slug: true, representativeVariantId: true, status: true, name: true },
      orderBy: { slug: 'asc' },
    });

    await reorder([...(await fullOrder())].reverse(), await ctx());

    const after = await prisma.productFamily.findMany({
      where: { slug: { in: mine } },
      select: { slug: true, representativeVariantId: true, status: true, name: true },
      orderBy: { slug: 'asc' },
    });
    expect(after).toEqual(before);
  });
});
