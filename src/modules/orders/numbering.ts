/**
 * Document numbering for orders and invoices.
 *
 *   Orders    27ZFO001, 27ZFO002, …
 *   Invoices  27ZFI001, 27ZFI002, …
 *
 * `27` is the Indian financial year the document belongs to (FY 2026-27 → "27"),
 * which rolls over on 1 April. `ZFO`/`ZFI` identify the series. The running
 * number does NOT reset daily — an invoice series must be continuous and gapless
 * for GST purposes, so a per-day reset would be wrong.
 *
 * Both sequences come from OrderCounter via an atomic upsert-and-increment, so
 * concurrent checkouts can never collide on a number.
 */
import type { Prisma } from '@prisma/client';

/**
 * Two-digit Indian financial year. FY runs 1 April – 31 March, so anything
 * before April belongs to the year that started the previous calendar year:
 * March 2027 is still FY 2026-27 → "27".
 */
export function financialYearSuffix(now = new Date()): string {
  const year = now.getFullYear();
  // getMonth() is 0-based: 3 === April.
  const fyEndYear = now.getMonth() >= 3 ? year + 1 : year;
  return String(fyEndYear % 100).padStart(2, '0');
}

/** Minimum digits in the running number. Grows naturally past 999. */
const PAD = 3;

async function nextInSeries(
  tx: Prisma.TransactionClient,
  series: 'ZFO' | 'ZFI',
  now = new Date(),
): Promise<string> {
  const prefix = `${financialYearSuffix(now)}${series}`;

  const counter = await tx.orderCounter.upsert({
    where: { dateKey: prefix },
    create: { dateKey: prefix, seq: 1 },
    update: { seq: { increment: 1 } },
    select: { seq: true },
  });

  return `${prefix}${String(counter.seq).padStart(PAD, '0')}`;
}

/** e.g. 27ZFO001 */
export const nextOrderNo = (tx: Prisma.TransactionClient, now?: Date) =>
  nextInSeries(tx, 'ZFO', now);

/** e.g. 27ZFI001 */
export const nextInvoiceNo = (tx: Prisma.TransactionClient, now?: Date) =>
  nextInSeries(tx, 'ZFI', now);

/** Shared by every route that accepts an order number in a path or query. */
export const ORDER_NO_PATTERN = /^\d{2}ZFO\d{3,}$/;
