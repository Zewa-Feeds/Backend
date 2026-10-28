/**
 * Product categories, held in process.
 *
 * Categories used to be a Prisma enum with a hard-coded label map, and every
 * serializer reads that label synchronously (`CATEGORY_LABELS[family.category]`).
 * Now the CMS manages them in the ProductCategory table, so this keeps a copy
 * in memory that the same synchronous lookups read.
 *
 * Freshness: `categoriesFresh` runs ahead of every API request and reloads the
 * copy when it is older than MAX_AGE_MS, and every write in categories.service
 * reloads it immediately. Another instance therefore sees a rename within
 * MAX_AGE_MS. A code the copy has never seen still renders — as a humanised code
 * — rather than breaking a page; the foreign key keeps the data itself valid.
 */
import type { NextFunction, Request, Response } from 'express';
import { prisma } from '@/lib/prisma';

export interface CategoryRecord {
  code: string;
  label: string;
  position: number;
  isActive: boolean;
}

const MAX_AGE_MS = 30_000;

let byCode = new Map<string, CategoryRecord>();
let loadedAt = 0;
let inflight: Promise<void> | null = null;

export async function reloadCategories(): Promise<void> {
  const rows = await prisma.productCategory.findMany({
    select: { code: true, label: true, position: true, isActive: true },
    orderBy: [{ position: 'asc' }, { label: 'asc' }],
  });
  byCode = new Map(rows.map((r) => [r.code, r]));
  loadedAt = Date.now();
}

/** Reloads if stale. Concurrent callers share one query. */
export async function ensureCategoriesFresh(): Promise<void> {
  if (Date.now() - loadedAt < MAX_AGE_MS) return;
  inflight ??= reloadCategories().finally(() => {
    inflight = null;
  });
  await inflight;
}

/**
 * Express middleware form. A failed reload is not fatal while an older copy
 * exists — the request proceeds with that copy rather than 500-ing over a label.
 */
export function categoriesFresh(_req: Request, _res: Response, next: NextFunction) {
  ensureCategoriesFresh().then(
    () => next(),
    (err) => (loadedAt > 0 ? next() : next(err)),
  );
}

/** "NEW_LINE" → "New Line", for a code this process has not loaded yet. */
const humanise = (code: string) =>
  code
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');

export function categoryLabel(code: string): string {
  return byCode.get(code)?.label ?? humanise(code);
}

/** Every category, active and hidden, in display order. */
export function allCategories(): CategoryRecord[] {
  return [...byCode.values()];
}

/** The categories offered on the storefront and for new products. */
export function activeCategories(): CategoryRecord[] {
  return allCategories().filter((c) => c.isActive);
}

/**
 * Resolve the code, the label, or the CMS's normalised label
 * ("DRIED_BSF_LARVAE", "Dried BSF Larvae") to a code. Case- and
 * punctuation-insensitive, so "Slow Sinking Granules" still matches.
 */
const loose = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]+/g, '');

/** Older names a stored filter or URL may still carry. */
const ALIASES: Record<string, string> = {
  SLOWSINKINGPELLETS: 'SLOW_SINKING_PELLETS',
};

export function parseCategory(v: string): string | undefined {
  if (byCode.has(v)) return v;
  const key = loose(v);
  if (!key) return undefined;
  for (const c of byCode.values()) {
    if (loose(c.code) === key || loose(c.label) === key) return c.code;
  }
  return ALIASES[key] && byCode.has(ALIASES[key]!) ? ALIASES[key] : undefined;
}
