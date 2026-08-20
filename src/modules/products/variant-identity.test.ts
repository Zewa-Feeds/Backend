/**
 * A pack keeps its identity when its SKU changes.
 *
 * Variants used to be reconciled by SKU alone, so renaming one created a second
 * variant and deactivated the first. Everything that referenced the pack — its
 * photography, its hero, the multipacks inheriting from it — stayed attached to
 * the deactivated row, and a whole gallery disappeared from the storefront and
 * from the editor with no warning.
 *
 * These run against the real database because what is being tested IS the
 * reconciliation: which rows are updated, which are created, which are
 * deactivated, and what survives on the join table. Each builds and deletes its
 * own namespaced product.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { MediaType, PrismaClient } from '@prisma/client';
import { saveDraft, publish } from './products.service';
import { productBodySchema } from './products.schemas';
import { resolveGallery } from './media.resolver';
import { toResolvable } from './media.integrity';
import type { Role } from '@prisma/client';

const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());

const ADMIN = 'ADMIN' as Role;
const CDN = 'https://res.cloudinary.com/test';
/** A real audit context: writeAudit stores actorName/actorRole, which are NOT NULL. */
const ctx = {
  actorId: null,
  actorName: 'vitest',
  actorRole: 'Admin',
  ip: '127.0.0.1',
  userAgent: 'vitest',
} as never;

let actorId: string;
async function actor(): Promise<string> {
  if (actorId) return actorId;
  const u = await prisma.cmsUser.findFirstOrThrow({ select: { id: true } });
  actorId = u.id;
  return actorId;
}

interface Built { slug: string; familyId: string; base: string; twin: string; kilo: string }

/** A published product, so saves land in the draft and publish applies them. */
async function withProduct<T>(fn: (b: Built) => Promise<T>): Promise<T> {
  const ns = `zzident${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const family = await prisma.productFamily.create({
    data: {
      slug: ns, name: 'Identity Test', shortDesc: 'x', category: 'BETTA',
      status: 'ACTIVE', publishedAt: new Date(),
    },
    select: { id: true },
  });
  try {
    const mk = (sku: string, pack: string, position: number, baseVariantId?: string) =>
      prisma.productVariant.create({
        data: {
          familyId: family.id, sku: `${ns.toUpperCase()}-${sku}`, pack, position,
          mrpPaise: 10000, pricePaise: 10000, stock: 5, baseVariantId,
        },
        select: { id: true, sku: true },
      });
    const base = await mk('45G', '45g Bottle', 0);
    const twin = await mk('45GX2', '45g x 2', 1, base.id);
    const kilo = await mk('1KG', '1kg Pouch', 2);
    return await fn({ slug: ns, familyId: family.id, base: base.sku, twin: twin.sku, kilo: kilo.sku });
  } finally {
    await prisma.productFamily.delete({ where: { id: family.id } }).catch(() => {});
  }
}

/**
 * The editor's payload, as ProductEditor builds it — and parsed by the SAME Zod
 * schema the route uses, so display strings become enums and the new optional
 * `id` field is exercised rather than smuggled past validation.
 */
const body = (b: Built, variants: { id?: string; sku: string; pack: string; heroMediaId?: string | null }[],
              media: { id?: string; url: string; skus: string[] }[]) => productBodySchema.parse({
  name: 'Identity Test', slug: b.slug, category: 'Betta', status: 'Active', badge: null,
  shortDesc: 'x', fullDesc: '', protein: 40, benefits: [], tags: [],
  feedFreq: null, feedPortion: null, feedNotes: null, nutrition: {}, seoTitle: null, seoDesc: null,
  media: media.map((m) => ({
    ...(m.id ? { id: m.id } : {}),
    type: MediaType.IMAGE, url: m.url, alt: 'a', publicId: null,
    sku: m.skus[0] ?? null, skus: m.skus,
  })),
  variants: variants.map((v) => ({
    ...(v.id ? { id: v.id } : {}),
    sku: v.sku, pack: v.pack, mrp: 100, price: 100, stock: 5, hsn: '23099090',
    isActive: true, heroMediaId: v.heroMediaId ?? null,
  })),
}) as never;

const live = (familyId: string) => prisma.productFamily.findUniqueOrThrow({
  where: { id: familyId },
  select: {
    variants: { select: { id: true, sku: true, isActive: true, baseVariantId: true, heroMediaId: true, position: true }, orderBy: { position: 'asc' } },
    media: { select: { id: true, type: true, url: true, alt: true, position: true, variantId: true,
      variantLinks: { select: { variantId: true } } }, orderBy: { position: 'asc' } },
  },
});

/**
 * Attach a photograph to a pack directly.
 *
 * Setup only. These tests are about what a RENAME does to existing
 * relationships, so getting a photograph in place does not need to go through
 * saveDraft + publish — two multi-query transactions against a remote database,
 * per test, to arrange a state Prisma can write in two statements. The rename
 * itself still goes through the real service path, which is the thing under
 * test. `media.integrity.test.ts` covers the assignment machinery.
 */
async function seedMedia(familyId: string, url: string, variantId: string | null, position = 0) {
  const row = await prisma.productMedia.create({
    data: {
      familyId, type: MediaType.IMAGE, url, alt: 'a', position,
      // Both mechanisms, exactly as reconcileMedia writes them during dual-read.
      variantId,
      ...(variantId ? { variantLinks: { create: { variantId } } } : {}),
    },
    select: { id: true },
  });
  return row.id;
}

/** Save then publish, so the payload reaches the live rows. */
async function saveAndPublish(slug: string, payload: never) {
  const id = await actor();
  const withActor = { ...(ctx as object), actorId: id } as never;
  await saveDraft(slug, payload, id, withActor, ADMIN);
  await publish(slug, id, withActor, ADMIN);
}

describe('renaming a SKU', () => {
  it('keeps the SAME ProductVariant id', async () => {
    await withProduct(async (b) => {
      const before = await live(b.familyId);
      const baseRow = before.variants.find((v) => v.sku === b.base)!;

      await saveAndPublish(b.slug, body(b,
        [{ id: baseRow.id, sku: `${b.base}NEW`, pack: '45g Bottle' },
         { sku: b.twin, pack: '45g x 2' }, { sku: b.kilo, pack: '1kg Pouch' }],
        [{ url: `${CDN}/bottle.jpg`, skus: [b.base] }]));

      const after = await live(b.familyId);
      const renamed = after.variants.find((v) => v.sku === `${b.base}NEW`)!;
      expect(renamed.id).toBe(baseRow.id);
    });
  });

  it('does not create a duplicate variant', async () => {
    await withProduct(async (b) => {
      const baseRow = (await live(b.familyId)).variants.find((v) => v.sku === b.base)!;
      await saveAndPublish(b.slug, body(b,
        [{ id: baseRow.id, sku: `${b.base}NEW`, pack: '45g Bottle' },
         { sku: b.twin, pack: '45g x 2' }, { sku: b.kilo, pack: '1kg Pouch' }],
        [{ url: `${CDN}/bottle.jpg`, skus: [b.base] }]));

      const after = await live(b.familyId);
      expect(after.variants).toHaveLength(3);
      expect(after.variants.some((v) => v.sku === b.base)).toBe(false);
    });
  });

  it('does not deactivate the renamed pack', async () => {
    await withProduct(async (b) => {
      const baseRow = (await live(b.familyId)).variants.find((v) => v.sku === b.base)!;
      await saveAndPublish(b.slug, body(b,
        [{ id: baseRow.id, sku: `${b.base}NEW`, pack: '45g Bottle' },
         { sku: b.twin, pack: '45g x 2' }, { sku: b.kilo, pack: '1kg Pouch' }],
        [{ url: `${CDN}/bottle.jpg`, skus: [b.base] }]));

      const after = await live(b.familyId);
      expect(after.variants.every((v) => v.isActive)).toBe(true);
    });
  });

  it('keeps the ProductMediaVariant assignments', async () => {
    await withProduct(async (b) => {
      const before = await live(b.familyId);
      const baseRow = before.variants.find((v) => v.sku === b.base)!;
      await seedMedia(b.familyId, `${CDN}/bottle.jpg`, baseRow.id);

      const mid = await live(b.familyId);
      const asset = mid.media[0]!;
      expect(asset.variantLinks.map((l) => l.variantId)).toEqual([baseRow.id]);

      // Rename. The gallery still refers to the pack by its OLD sku, exactly as
      // an editor payload built before the rename would.
      await saveAndPublish(b.slug, body(b,
        [{ id: baseRow.id, sku: `${b.base}NEW`, pack: '45g Bottle' },
         { sku: b.twin, pack: '45g x 2' }, { sku: b.kilo, pack: '1kg Pouch' }],
        [{ id: asset.id, url: `${CDN}/bottle.jpg`, skus: [b.base] }]));

      const after = await live(b.familyId);
      const still = after.media.find((m) => m.id === asset.id)!;
      expect(still.variantLinks.map((l) => l.variantId)).toEqual([baseRow.id]);
    });
  });

  it('keeps the legacy variantId in step', async () => {
    await withProduct(async (b) => {
      const before = await live(b.familyId);
      const baseRow = before.variants.find((v) => v.sku === b.base)!;
      await seedMedia(b.familyId, `${CDN}/bottle.jpg`, baseRow.id);
      const asset = (await live(b.familyId)).media[0]!;

      await saveAndPublish(b.slug, body(b,
        [{ id: baseRow.id, sku: `${b.base}NEW`, pack: '45g Bottle' },
         { sku: b.twin, pack: '45g x 2' }, { sku: b.kilo, pack: '1kg Pouch' }],
        [{ id: asset.id, url: `${CDN}/bottle.jpg`, skus: [b.base] }]));

      const after = await live(b.familyId);
      expect(after.media.find((m) => m.id === asset.id)!.variantId).toBe(baseRow.id);
    });
  });

  it('keeps the chosen main image', async () => {
    await withProduct(async (b) => {
      const baseRow = (await live(b.familyId)).variants.find((v) => v.sku === b.base)!;
      await seedMedia(b.familyId, `${CDN}/a.jpg`, baseRow.id, 0);
      await seedMedia(b.familyId, `${CDN}/b.jpg`, baseRow.id, 1);

      const mid = await live(b.familyId);
      const starred = mid.media.find((m) => m.url.endsWith('b.jpg'))!;

      await saveAndPublish(b.slug, body(b,
        [{ id: baseRow.id, sku: `${b.base}NEW`, pack: '45g Bottle', heroMediaId: starred.id },
         { sku: b.twin, pack: '45g x 2' }, { sku: b.kilo, pack: '1kg Pouch' }],
        mid.media.map((m) => ({ id: m.id, url: m.url, skus: [b.base] }))));

      const after = await live(b.familyId);
      expect(after.variants.find((v) => v.id === baseRow.id)!.heroMediaId).toBe(starred.id);
    });
  });

  it('keeps multipack inheritance pointing at the same pack', async () => {
    await withProduct(async (b) => {
      const before = await live(b.familyId);
      const baseRow = before.variants.find((v) => v.sku === b.base)!;
      const twinRow = before.variants.find((v) => v.sku === b.twin)!;
      expect(twinRow.baseVariantId).toBe(baseRow.id);

      await saveAndPublish(b.slug, body(b,
        [{ id: baseRow.id, sku: `${b.base}NEW`, pack: '45g Bottle' },
         { id: twinRow.id, sku: b.twin, pack: '45g x 2' }, { sku: b.kilo, pack: '1kg Pouch' }],
        [{ url: `${CDN}/bottle.jpg`, skus: [b.base] }]));

      const after = await live(b.familyId);
      expect(after.variants.find((v) => v.id === twinRow.id)!.baseVariantId).toBe(baseRow.id);
    });
  });

  it('leaves the resolved gallery identical — the whole point', async () => {
    await withProduct(async (b) => {
      const seed = await live(b.familyId);
      const baseRow0 = seed.variants.find((v) => v.sku === b.base)!;
      await seedMedia(b.familyId, `${CDN}/bottle.jpg`, baseRow0.id, 0);
      await seedMedia(b.familyId, `${CDN}/fish.jpg`, null, 1);

      const mid = await live(b.familyId);
      const baseRow = mid.variants.find((v) => v.sku === b.base)!;
      const twinRow = mid.variants.find((v) => v.sku === b.twin)!;
      const beforeBase = resolveGallery(toResolvable(mid.media as never), baseRow);
      const beforeTwin = resolveGallery(toResolvable(mid.media as never), twinRow);
      expect(beforeBase.coverage).toBe('EXACT');
      expect(beforeTwin.coverage).toBe('INHERITED');

      await saveAndPublish(b.slug, body(b,
        [{ id: baseRow.id, sku: `${b.base}NEW`, pack: '45g Bottle' },
         { id: twinRow.id, sku: b.twin, pack: '45g x 2' }, { sku: b.kilo, pack: '1kg Pouch' }],
        mid.media.map((m) => ({ id: m.id, url: m.url, skus: m.variantId === baseRow.id ? [b.base] : [] }))));

      const after = await live(b.familyId);
      const res = toResolvable(after.media as never);
      const afterBase = resolveGallery(res, after.variants.find((v) => v.id === baseRow.id)!);
      const afterTwin = resolveGallery(res, after.variants.find((v) => v.id === twinRow.id)!);

      expect(afterBase.coverage).toBe(beforeBase.coverage);
      expect(afterBase.items.map((m) => m.url)).toEqual(beforeBase.items.map((m) => m.url));
      expect(afterTwin.coverage).toBe(beforeTwin.coverage);
      expect(afterTwin.items.map((m) => m.url)).toEqual(beforeTwin.items.map((m) => m.url));
    });
  });

  it('handles a rename AND a new pack reusing the freed SKU in one save', async () => {
    /*
     * The collision case. A -> B, and a brand-new pack takes over the name A.
     *
     * Both payload entries used to resolve to the SAME existing row, because the
     * SKU map was built before the loop and nothing stopped a second claim: the
     * rename was either undone or its identity — and all of its photography —
     * was handed to what should have been a new pack. The outcome even depended
     * on payload order.
     */
    await withProduct(async (b) => {
      const before = await live(b.familyId);
      const baseRow = before.variants.find((v) => v.sku === b.base)!;

      // Photograph the pack first, so we can prove the photo follows identity.
      await seedMedia(b.familyId, `${CDN}/original.jpg`, baseRow.id);

      const withPhoto = await live(b.familyId);
      const asset = withPhoto.media.find((m) => m.url.endsWith('original.jpg'))!;
      expect(asset.variantLinks.map((l) => l.variantId)).toEqual([baseRow.id]);

      // Rename A -> B, and introduce a NEW pack that reuses A.
      await saveAndPublish(b.slug, body(b,
        [{ id: baseRow.id, sku: `${b.base}B`, pack: '45g Bottle' },
         { sku: b.base, pack: 'New pack reusing the old name' },
         { sku: b.twin, pack: '45g x 2' }, { sku: b.kilo, pack: '1kg Pouch' }],
        [{ id: asset.id, url: `${CDN}/original.jpg`, skus: [`${b.base}B`] }]));

      const after = await live(b.familyId);
      const renamed = after.variants.find((v) => v.sku === `${b.base}B`)!;
      const reused = after.variants.find((v) => v.sku === b.base)!;

      // The original row IS the renamed pack.
      expect(renamed.id).toBe(baseRow.id);
      // The reused name belongs to a genuinely new row.
      expect(reused.id).not.toBe(baseRow.id);
      // Four packs, four distinct identities.
      expect(after.variants).toHaveLength(4);
      expect(new Set(after.variants.map((v) => v.id)).size).toBe(4);
      // Neither was deactivated.
      expect(renamed.isActive).toBe(true);
      expect(reused.isActive).toBe(true);
      // The photograph followed identity, not the name.
      const still = after.media.find((m) => m.id === asset.id)!;
      expect(still.variantLinks.map((l) => l.variantId)).toEqual([baseRow.id]);
      expect(still.variantId).toBe(baseRow.id);
    });
  });

  it('gives the same answer whichever order the two entries arrive in', async () => {
    await withProduct(async (b) => {
      const baseRow = (await live(b.familyId)).variants.find((v) => v.sku === b.base)!;

      // New pack listed FIRST, rename second — the order that used to lose.
      await saveAndPublish(b.slug, body(b,
        [{ sku: b.base, pack: 'New pack reusing the old name' },
         { id: baseRow.id, sku: `${b.base}B`, pack: '45g Bottle' },
         { sku: b.twin, pack: '45g x 2' }, { sku: b.kilo, pack: '1kg Pouch' }],
        []));

      const after = await live(b.familyId);
      expect(after.variants.find((v) => v.sku === `${b.base}B`)!.id).toBe(baseRow.id);
      expect(after.variants.find((v) => v.sku === b.base)!.id).not.toBe(baseRow.id);
      expect(after.variants).toHaveLength(4);
      expect(after.variants.every((v) => v.isActive)).toBe(true);
    });
  });

  it('still deactivates a pack genuinely removed from the editor', async () => {
    await withProduct(async (b) => {
      const before = await live(b.familyId);
      const kiloRow = before.variants.find((v) => v.sku === b.kilo)!;

      await saveAndPublish(b.slug, body(b,
        [{ sku: b.base, pack: '45g Bottle' }, { sku: b.twin, pack: '45g x 2' }], []));

      const after = await live(b.familyId);
      expect(after.variants.find((v) => v.id === kiloRow.id)!.isActive).toBe(false);
    });
  });

  it('ignores an id belonging to another product', async () => {
    await withProduct(async (b) => {
      const foreign = await prisma.productVariant.findFirstOrThrow({
        where: { family: { slug: 'guppy-bites' } }, select: { id: true },
      });
      await saveAndPublish(b.slug, body(b,
        [{ id: foreign.id, sku: b.base, pack: '45g Bottle' },
         { sku: b.twin, pack: '45g x 2' }, { sku: b.kilo, pack: '1kg Pouch' }],
        []));

      // Matched by SKU instead; the other product is untouched.
      const after = await live(b.familyId);
      expect(after.variants.map((v) => v.id)).not.toContain(foreign.id);
      const stillTheirs = await prisma.productVariant.findUniqueOrThrow({
        where: { id: foreign.id }, select: { family: { select: { slug: true } } },
      });
      expect(stillTheirs.family.slug).toBe('guppy-bites');
    });
  });
});
