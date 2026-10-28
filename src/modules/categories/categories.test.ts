/**
 * Product categories against the real test database: a category added in the
 * CMS is immediately usable on a product, renames keep the stored code, hiding
 * takes it off the storefront list, and one in use cannot be deleted.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';

vi.mock('@/modules/audit/audit.service', () => ({
  writeAudit: vi.fn().mockResolvedValue(undefined),
  buildDiff: vi.fn(() => ({})),
  auditContext: vi.fn(),
}));

import * as service from './categories.service';
import { activeCategories, categoryLabel, parseCategory } from './categories.registry';
import { productBodySchema } from '@/modules/products/products.schemas';

const db = new PrismaClient();
const ctx = {} as never;
const LABEL = `Test Line ${Date.now()}`;
const CODE = service.codeFromLabel(LABEL);
const SLUG = `cat-test-${Date.now()}`;

afterAll(async () => {
  await db.productFamily.deleteMany({ where: { slug: SLUG } });
  await db.productCategory.deleteMany({ where: { code: CODE } });
  await db.$disconnect();
});

describe('product categories', () => {
  it('derives a stable code from the label', () => {
    expect(service.codeFromLabel('Freeze-Dried Treats')).toBe('FREEZE_DRIED_TREATS');
  });

  it('creates a category that is offered and parseable at once', async () => {
    const created = await service.create({ label: LABEL }, ctx);
    expect(created).toMatchObject({ code: CODE, label: LABEL, isActive: true, productCount: 0 });
    expect(activeCategories().map((c) => c.code)).toContain(CODE);
    expect(parseCategory(LABEL)).toBe(CODE);
    // Placed after the existing visible categories.
    expect(activeCategories().at(-1)?.code).toBe(CODE);
  });

  it('accepts the new category on a product payload by its label', () => {
    // Only the category field is under test; other fields may fail validation.
    const categoryIssues = (category: string) => {
      const r = productBodySchema.safeParse({ name: 'Category Test', slug: SLUG, category });
      return r.success ? [] : r.error.issues.filter((i) => i.path[0] === 'category');
    };
    expect(categoryIssues(LABEL)).toEqual([]);
    expect(categoryIssues('Not A Real Category')).toHaveLength(1);
  });

  it('rejects duplicate names, ignoring case', async () => {
    await expect(service.create({ label: LABEL.toUpperCase() }, ctx)).rejects.toThrow(/already exists/);
  });

  it('renames without changing the code', async () => {
    const renamed = await service.update(CODE, { label: `${LABEL} Renamed` }, ctx);
    expect(renamed.code).toBe(CODE);
    expect(categoryLabel(CODE)).toBe(`${LABEL} Renamed`);
  });

  it('refuses to delete a category a product uses, and hiding removes it from the shop', async () => {
    await db.productFamily.create({
      data: { slug: SLUG, name: 'Category Test', category: CODE, shortDesc: 'x', proteinPct: 40 },
    });
    await expect(service.remove(CODE, ctx)).rejects.toThrow(/still used/);

    await service.update(CODE, { isActive: false }, ctx);
    expect(activeCategories().map((c) => c.code)).not.toContain(CODE);
    // Still valid on the product that holds it.
    expect(parseCategory(CODE)).toBe(CODE);
  });

  it('deletes once nothing references it', async () => {
    await db.productFamily.deleteMany({ where: { slug: SLUG } });
    await service.remove(CODE, ctx);
    expect(parseCategory(CODE)).toBeUndefined();
  });
});
