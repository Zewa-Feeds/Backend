/**
 * Weekly data export: every table as a sheet in one Excel workbook, emailed
 * to DATA_EXPORT_EMAIL (it@zewafeeds.com) every Monday at 06:00 IST.
 *
 * Why: production runs on Supabase Free, which has no automatic backups.
 * This is the business's own weekly copy of its data (asked for in Nov 2026).
 *
 * WHAT IS LEFT OUT, deliberately. The workbook sits in a mailbox, so nothing
 * in it may let someone sign in as anyone:
 *   - whole tables that hold only credentials (sessions, sign-in tokens,
 *     one-time codes, backup codes, invitations, reset/verification links);
 *   - password hashes, password history and the encrypted 2FA secret.
 * Very long cells (published website snapshots, drafts) are cut at Excel's
 * 32,767-character cell limit. The workbook is a readable copy, not a
 * byte-for-byte database restore.
 *
 * NEW TABLE WITH SECRETS? Add it to SKIP_TABLES or SKIP_COLUMNS, or it will
 * be emailed. weekly-export.test.ts fails on any column named like a secret
 * that is not listed here.
 */
import ExcelJS from 'exceljs';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';
import { sendEmail } from '@/integrations/zeptomail/zeptomail.client';

const log = logger.child({ module: 'weekly-export' });

export const SKIP_TABLES = new Set([
  'CustomerEmailVerification',
  'CustomerPasswordReset',
  'CmsInvitation',
  'CmsSession',
  'CmsSessionToken',
  'BackupCode',
  'CmsEmailOtp',
]);

export const SKIP_COLUMNS: Record<string, string[]> = {
  Customer: ['passwordHash'],
  CmsUser: ['passwordHash', 'passwordHistory', 'twofaSecret', 'tokenVersion'],
};

const CELL_LIMIT = 32_000;
/** ZeptoMail's per-message limit is 15 MB including encoding; base64 adds a third. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const PAGE = 2000;

function cellValue(v: unknown): string | number | boolean | Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Prisma.Decimal) return Number(v);
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > CELL_LIMIT ? `${s.slice(0, CELL_LIMIT)}… [cut: ${s.length} characters]` : s;
}

export async function buildWorkbook(): Promise<{ buffer: Buffer; sheets: { table: string; rows: number }[] }> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Zewa Feeds API';
  wb.created = new Date();
  const sheets: { table: string; rows: number }[] = [];

  for (const model of Prisma.dmmf.datamodel.models) {
    if (SKIP_TABLES.has(model.name)) continue;
    const skip = new Set(SKIP_COLUMNS[model.name] ?? []);
    const cols = model.fields.filter((f) => f.kind === 'scalar' || f.kind === 'enum').map((f) => f.name).filter((n) => !skip.has(n));
    const idField = model.fields.find((f) => f.isId)?.name ?? model.primaryKey?.fields?.[0] ?? cols[0]!;
    const delegate = (prisma as unknown as Record<string, { findMany: (a: object) => Promise<Record<string, unknown>[]> }>)[
      model.name.charAt(0).toLowerCase() + model.name.slice(1)
    ];
    if (!delegate) continue;

    const ws = wb.addWorksheet(model.name.slice(0, 31));
    ws.addRow(cols).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    const select = Object.fromEntries(cols.map((c) => [c, true]));
    let rows = 0;
    for (let skipN = 0; ; skipN += PAGE) {
      const batch = await delegate.findMany({ select, orderBy: { [idField]: 'asc' }, skip: skipN, take: PAGE });
      for (const r of batch) ws.addRow(cols.map((c) => cellValue(r[c])));
      rows += batch.length;
      if (batch.length < PAGE) break;
    }
    sheets.push({ table: model.name, rows });
  }

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, sheets };
}

export async function sendWeeklyExport(now = new Date()): Promise<{ sent: boolean; bytes: number; tables: number }> {
  const { buffer, sheets } = await buildWorkbook();
  const date = now.toISOString().slice(0, 10);
  const total = sheets.reduce((n, s) => n + s.rows, 0);
  const summary = sheets.map((s) => `<tr><td style="padding:2px 12px 2px 0">${s.table}</td><td style="text-align:right">${s.rows}</td></tr>`).join('');

  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    log.error({ bytes: buffer.length }, 'weekly export too large to email');
    await sendEmail({
      to: [{ email: env.DATA_EXPORT_EMAIL }],
      subject: `Zewa Feeds weekly data export ${date}: TOO LARGE, NOT ATTACHED`,
      htmlBody: `<p>This week's export is ${(buffer.length / 1048576).toFixed(1)} MB, over the email limit, so it was not attached. A developer needs to move the export to file storage (Backend modules/exports/weekly-export.ts).</p>`,
      reference: `weekly-export-${date}`,
    });
    return { sent: false, bytes: buffer.length, tables: sheets.length };
  }

  const res = await sendEmail({
    to: [{ email: env.DATA_EXPORT_EMAIL }],
    subject: `Zewa Feeds weekly data export ${date}`,
    htmlBody:
      `<p>Attached: every table in the Zewa Feeds database as of ${now.toUTCString()}, one sheet per table (${sheets.length} sheets, ${total.toLocaleString('en-IN')} rows).</p>` +
      `<p>Passwords, sign-in tokens and 2FA secrets are left out. It still holds customers' names, addresses and phone numbers: keep this mailbox protected and don't forward it.</p>` +
      `<table style="font-family:monospace;font-size:12px">${summary}</table>`,
    attachments: [{
      name: `zewa-feeds-export-${date}.xlsx`,
      content: buffer.toString('base64'),
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }],
    reference: `weekly-export-${date}`,
  });
  log.info({ bytes: buffer.length, tables: sheets.length, rows: total, sent: res.sent }, 'weekly data export');
  return { sent: res.sent, bytes: buffer.length, tables: sheets.length };
}
