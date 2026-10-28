/**
 * Product categories — CMS management (Products → Categories).
 *
 * A category is created with a label; its `code` is derived once from that
 * label and never changes, because products and coupon targets store the code.
 * Renaming changes only the label. Hiding (isActive = false) takes it off the
 * storefront and the product form without touching the products already in it.
 * Deleting is allowed only while nothing references it.
 */
import { AuditModule, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { conflict, notFound, unprocessable } from '@/lib/errors';
import { type AuditContext, buildDiff, writeAudit } from '@/modules/audit/audit.service';
import { reloadCategories } from './categories.registry';

/** "Freeze-Dried Treats" → "FREEZE_DRIED_TREATS". */
export const codeFromLabel = (label: string) =>
  label
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);

const SELECT = {
  code: true,
  label: true,
  position: true,
  isActive: true,
  _count: { select: { families: { where: { deletedAt: null } } } },
} satisfies Prisma.ProductCategorySelect;

type Row = Prisma.ProductCategoryGetPayload<{ select: typeof SELECT }>;

const serialize = (r: Row) => ({
  code: r.code,
  label: r.label,
  position: r.position,
  isActive: r.isActive,
  productCount: r._count.families,
});

export async function list() {
  const rows = await prisma.productCategory.findMany({
    select: SELECT,
    orderBy: [{ position: 'asc' }, { label: 'asc' }],
  });
  return rows.map(serialize);
}

async function assertLabelFree(label: string, exceptCode?: string) {
  const clash = await prisma.productCategory.findFirst({
    where: { label: { equals: label, mode: 'insensitive' }, NOT: exceptCode ? { code: exceptCode } : undefined },
    select: { code: true },
  });
  if (clash) throw unprocessable('A category with that name already exists.', { label: 'Already in use.' });
}

export async function create(body: { label: string; isActive?: boolean }, ctx: AuditContext) {
  const code = codeFromLabel(body.label);
  if (!code) throw unprocessable('Use at least one letter or number.', { label: 'Enter a name.' });
  await assertLabelFree(body.label);
  if (await prisma.productCategory.findUnique({ where: { code }, select: { code: true } })) {
    throw unprocessable('A category with a very similar name already exists.', { label: 'Too similar to an existing category.' });
  }

  // New categories go to the end of the visible list.
  const last = await prisma.productCategory.aggregate({ where: { isActive: true }, _max: { position: true } });
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.productCategory.create({
      data: {
        code,
        label: body.label,
        isActive: body.isActive ?? true,
        position: (last._max.position ?? 0) + 10,
      },
      select: SELECT,
    });
    await writeAudit(
      ctx,
      { module: AuditModule.PRODUCTS, action: `Created category "${body.label}"`, recordId: code },
      tx,
    );
    return created;
  });
  await reloadCategories();
  return serialize(row);
}

export async function update(
  code: string,
  body: { label?: string; isActive?: boolean },
  ctx: AuditContext,
) {
  const existing = await prisma.productCategory.findUnique({ where: { code }, select: SELECT });
  if (!existing) throw notFound('Category');
  if (body.label !== undefined) await assertLabelFree(body.label, code);

  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.productCategory.update({ where: { code }, data: body, select: SELECT });
    await writeAudit(
      ctx,
      {
        module: AuditModule.PRODUCTS,
        action: `Updated category "${updated.label}"`,
        recordId: code,
        diff: buildDiff(
          { label: existing.label, isActive: existing.isActive },
          { label: updated.label, isActive: updated.isActive },
        ),
      },
      tx,
    );
    return updated;
  });
  await reloadCategories();
  return serialize(row);
}

/** Sets display order to the sequence given. Codes not listed keep their place after it. */
export async function reorder(codes: string[], ctx: AuditContext) {
  const known = new Set((await prisma.productCategory.findMany({ select: { code: true } })).map((r) => r.code));
  const unknown = codes.filter((c) => !known.has(c));
  if (unknown.length) throw unprocessable(`Unknown category: ${unknown.join(', ')}`);

  await prisma.$transaction(async (tx) => {
    for (const [i, code] of codes.entries()) {
      await tx.productCategory.update({ where: { code }, data: { position: (i + 1) * 10 } });
    }
    await writeAudit(ctx, { module: AuditModule.PRODUCTS, action: 'Reordered categories' }, tx);
  });
  await reloadCategories();
  return list();
}

export async function remove(code: string, ctx: AuditContext) {
  const existing = await prisma.productCategory.findUnique({
    where: { code },
    select: { label: true, _count: { select: { families: true, couponCategories: true } } },
  });
  if (!existing) throw notFound('Category');
  // Counts soft-deleted products too: their rows still hold the foreign key.
  if (existing._count.families || existing._count.couponCategories) {
    throw conflict('This category is still used by products or coupons. Hide it instead.');
  }

  await prisma.$transaction(async (tx) => {
    await tx.productCategory.delete({ where: { code } });
    await writeAudit(
      ctx,
      { module: AuditModule.PRODUCTS, action: `Deleted category "${existing.label}"`, recordId: code },
      tx,
    );
  });
  await reloadCategories();
}
