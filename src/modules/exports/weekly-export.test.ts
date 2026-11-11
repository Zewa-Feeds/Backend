/**
 * The weekly export must never email a credential.
 */
import { describe, it, expect, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { Prisma } from '@prisma/client';

vi.mock('@/integrations/zeptomail/zeptomail.client', () => ({ sendEmail: vi.fn(async () => ({ sent: true })) }));

import { buildWorkbook, SKIP_COLUMNS, SKIP_TABLES, sendWeeklyExport } from './weekly-export';
import { sendEmail } from '@/integrations/zeptomail/zeptomail.client';

/** Columns named like secrets that are known not to be one. */
const NOT_SECRET = new Set(['SitePublication.contentHash', 'LoyaltyRuleVersion.otpThresholdCoins']);

describe('weekly data export', () => {
  it('leaves out every column named like a credential (add new ones to SKIP_COLUMNS)', () => {
    const leaks: string[] = [];
    for (const m of Prisma.dmmf.datamodel.models) {
      if (SKIP_TABLES.has(m.name)) continue;
      for (const f of m.fields) {
        const name = `${m.name}.${f.name}`;
        if (f.kind === 'scalar' && /hash|token|secret|otp|password/i.test(f.name) && !SKIP_COLUMNS[m.name]?.includes(f.name) && !NOT_SECRET.has(name)) {
          leaks.push(name);
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it('builds one sheet per table, without the skipped tables or password hashes', async () => {
    const { buffer, sheets } = await buildWorkbook();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toContain('Order');
    expect(names).toContain('Customer');
    for (const t of SKIP_TABLES) expect(names).not.toContain(t);
    const header = (wb.getWorksheet('Customer')!.getRow(1).values as unknown[]).filter(Boolean);
    expect(header).toContain('email');
    expect(header).not.toContain('passwordHash');
    const cms = (wb.getWorksheet('CmsUser')!.getRow(1).values as unknown[]).filter(Boolean);
    expect(cms).not.toContain('twofaSecret');
    expect(sheets.length).toBe(names.length);
  }, 60_000);

  it('emails it as an xlsx attachment', async () => {
    const res = await sendWeeklyExport(new Date('2026-11-16T00:30:00Z'));
    expect(res.sent).toBe(true);
    const call = vi.mocked(sendEmail).mock.calls.at(-1)![0];
    expect(call.subject).toBe('Zewa Feeds weekly data export 2026-11-16');
    expect(call.attachments?.[0]?.name).toBe('zewa-feeds-export-2026-11-16.xlsx');
  }, 60_000);
});
