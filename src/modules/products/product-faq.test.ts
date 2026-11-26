/**
 * Product FAQs: import parsing, validation, and the draft → publish → public path.
 *
 * The catalogue's FAQs must reach the storefront word for word (only the "Qn: "
 * numbering label is dropped), attached to the right product, and an editor's
 * save must never silently lose or rewrite them.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient, ProductStatus, MediaType } from '@prisma/client';
import { faqsBySlug, parseCatalogueFaq } from './faq-import';
import { productBodySchema } from './products.schemas';
import { publish, saveDraft } from './products.service';
import { FAMILY_SELECT, serializePublic, faqList } from './products.serializer';
import * as revalidate from '@/integrations/storefront/revalidate';
import { dropFamily, ns, sweepFixtures, testActor, testCtx } from '@/test/fixtures';
import type { Role } from '@prisma/client';

const catalogue = JSON.parse(readFileSync('scripts/catalogue.json', 'utf8')) as { code: string; faq?: string[] }[];
const meta = JSON.parse(readFileSync('scripts/derived-meta.json', 'utf8')) as { code: string; slug: string }[];

describe('parsing the catalogue FAQs', () => {
  const bySlug = faqsBySlug(catalogue, meta);

  it('finds 53 FAQs across all 13 products, attached to the right slugs', () => {
    const counts = Object.fromEntries([...bySlug].map(([slug, f]) => [slug, f.length]));
    expect(counts).toEqual({
      'dried-bsf-larvae': 4, 'guppy-bites': 4, 'tetra-pellets': 4, 'betta-bites': 4,
      'micro-pellets': 4, 'shrimp-grazers': 4, 'cichlid-bites-c4': 4, 'cichlid-bites-c5': 4,
      'pleco-bites': 4, 'goldfish-bites': 4, 'monster-sticks': 4, 'koi-bites': 4, 'hatchery-feeds': 5,
    });
    expect([...bySlug.values()].flat()).toHaveLength(53);
  });

  it('keeps every question and answer word for word (only the "Qn: " label removed)', () => {
    for (const product of catalogue) {
      const slug = meta.find((m) => m.code === product.code)!.slug;
      const parsed = bySlug.get(slug)!;
      parsed.forEach((f, i) => {
        expect(product.faq![i * 2]).toBe(`Q${i + 1}: ${f.q}`);
        expect(product.faq![i * 2 + 1]).toBe(f.a);
      });
    }
  });

  it("drops the source document's footer lines instead of treating them as an FAQ", () => {
    const hatch = bySlug.get('hatchery-feeds')!;
    expect(hatch.map((f) => f.q).join(' ')).not.toMatch(/End of PDP|zewafeeds\.com/);
    expect(hatch.map((f) => f.a).join(' ')).not.toMatch(/End of PDP|zewafeeds\.com/);
    expect(parseCatalogueFaq(['Q1: Real?', 'Yes.', '— End of PDP Content Master v5.0 —', 'footer'])).toEqual([{ q: 'Real?', a: 'Yes.' }]);
  });
});

describe('validation', () => {
  const base = {
    name: 'FAQ Test', category: 'Betta', status: 'Active', shortDesc: 'x', fullDesc: '', protein: 40,
    benefits: [], tags: [], nutrition: {}, media: [],
    variants: [{ sku: 'FAQ-1', pack: '45g', mrp: 100, price: 100, stock: 1, hsn: '23099090' }],
  };
  const parse = (faq: unknown) => productBodySchema.safeParse({ ...base, faq });

  it('accepts FAQs and keeps characters like "&" as typed', () => {
    const r = parse([{ q: 'Is it safe for fry & adults?', a: 'Yes — at 3–4 feeds a day.' }]);
    expect(r.success && r.data.faq).toEqual([{ q: 'Is it safe for fry & adults?', a: 'Yes — at 3–4 feeds a day.' }]);
  });

  it('strips markup', () => {
    const r = parse([{ q: '<b>Bold?</b>', a: '<script>alert(1)</script>Plain.' }]);
    expect(r.success && r.data.faq).toEqual([{ q: 'Bold?', a: 'Plain.' }]);
  });

  it('drops a fully blank row but rejects a half-filled one', () => {
    const blank = parse([{ q: 'Q?', a: 'A.' }, { q: '  ', a: '' }]);
    expect(blank.success && blank.data.faq).toEqual([{ q: 'Q?', a: 'A.' }]);
    expect(parse([{ q: 'Q without answer?', a: '' }]).success).toBe(false);
  });

  it('is optional, so a client that omits it is still valid', () => {
    const r = productBodySchema.safeParse(base);
    expect(r.success && r.data.faq).toBeUndefined();
  });
});

describe('faqList (serializer guard)', () => {
  it('serves only well-formed entries', () => {
    expect(faqList([{ q: 'a', a: 'b' }, { q: 1 }, null, 'x'])).toEqual([{ q: 'a', a: 'b' }]);
    expect(faqList(null)).toEqual([]);
  });
});

const prisma = new PrismaClient();
const ADMIN = 'ADMIN' as Role;
afterAll(async () => prisma.$disconnect());
beforeAll(async () => sweepFixtures(prisma));
beforeEach(() => { vi.spyOn(revalidate, 'revalidateStorefront').mockResolvedValue(undefined); });

describe('draft → publish → public', () => {
  const withProduct = async (fn: (slug: string, id: string) => Promise<void>) => {
    const slug = ns('faq');
    const fam = await prisma.productFamily.create({
      data: { slug, name: 'FAQ Test', shortDesc: 'x', category: 'BETTA', status: ProductStatus.ACTIVE, publishedAt: new Date(),
        faq: [{ q: 'Existing?', a: 'Kept.' }] },
      select: { id: true },
    });
    await prisma.productVariant.create({ data: { familyId: fam.id, sku: `${slug.toUpperCase()}-45G`, pack: '45g', position: 0, mrpPaise: 10000, pricePaise: 10000, stock: 5 } });
    try { await fn(slug, fam.id); } finally { await dropFamily(prisma, fam.id); }
  };
  const body = (slug: string, extra: Record<string, unknown> = {}) => productBodySchema.parse({
    name: 'FAQ Test', slug, category: 'Betta', status: 'Active', badge: null, shortDesc: 'x', fullDesc: '', protein: 40,
    benefits: [], tags: [], feedFreq: null, feedPortion: null, feedNotes: null, nutrition: {}, seoTitle: null, seoDesc: null,
    media: [{ type: MediaType.IMAGE, url: 'https://res.cloudinary.com/test/a.jpg', alt: 'a', publicId: null, sku: null, skus: [] }],
    variants: [{ sku: `${slug.toUpperCase()}-45G`, pack: '45g', mrp: 100, price: 100, stock: 5, hsn: '23099090' }],
    ...extra,
  }) as never;
  const publicFaq = async (id: string) =>
    serializePublic((await prisma.productFamily.findUniqueOrThrow({ where: { id }, select: FAMILY_SELECT })) as never).faq;

  it('keeps FAQs in the draft until publish, then serves them publicly in order', async () => {
    await withProduct(async (slug, famId) => {
      const id = await testActor(prisma);
      const faq = [{ q: 'First?', a: 'One.' }, { q: 'Second?', a: 'Two.' }];
      await saveDraft(slug, body(slug, { faq }), id, testCtx(id), ADMIN);
      expect(await publicFaq(famId)).toEqual([{ q: 'Existing?', a: 'Kept.' }]);
      await publish(slug, id, testCtx(id), ADMIN);
      expect(await publicFaq(famId)).toEqual(faq);
    });
  });

  it('never wipes FAQs when a save omits them (older client or older draft)', async () => {
    await withProduct(async (slug, famId) => {
      const id = await testActor(prisma);
      await saveDraft(slug, body(slug), id, testCtx(id), ADMIN);
      await publish(slug, id, testCtx(id), ADMIN);
      expect(await publicFaq(famId)).toEqual([{ q: 'Existing?', a: 'Kept.' }]);
    });
  });

  it('removes FAQs only when the editor sends an empty list', async () => {
    await withProduct(async (slug, famId) => {
      const id = await testActor(prisma);
      await saveDraft(slug, body(slug, { faq: [] }), id, testCtx(id), ADMIN);
      await publish(slug, id, testCtx(id), ADMIN);
      expect(await publicFaq(famId)).toEqual([]);
    });
  });
});
