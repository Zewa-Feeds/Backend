/**
 * Send the weekly data export now, outside its Monday 06:00 IST schedule.
 * Builds the workbook in memory and emails it; nothing is written to disk.
 *
 *   npx tsx scripts/send-data-export.ts
 */
import 'dotenv/config';
import { sendWeeklyExport } from '../src/modules/exports/weekly-export';
import { prisma } from '../src/lib/prisma';

sendWeeklyExport()
  .then((r) => console.log(r))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
