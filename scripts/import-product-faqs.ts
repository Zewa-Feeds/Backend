/**
 * Load product FAQs from the PDP master document (scripts/catalogue.json) into
 * ProductFamily.faq, using parseCatalogueFaq (src/modules/products/faq-import.ts).
 *
 * Safe by construction:
 *   - Dry run unless --confirm.
 *   - Fills a product only while its FAQ list is still EMPTY, so anything already
 *     entered or edited in the CMS is never overwritten. Re-running is a no-op.
 *   - Skips a product with a pending CMS draft (its publish would carry the
 *     editor's own FAQ list); add those through the CMS instead.
 *   - Every product written gets an audit entry attributed to --actor.
 *
 *   npx tsx scripts/import-product-faqs.ts
 *   npx tsx scripts/import-product-faqs.ts --confirm --actor <cms email>
 *
 * Writes live rows directly, like the other one-off content imports. The
 * storefront picks the change up within its product-page cache window (60 s).
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { AuditModule, Prisma, PrismaClient } from '@prisma/client';
import { faqsBySlug } from '../src/modules/products/faq-import';

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const confirm = args.includes('--confirm');
const actorEmail = args.includes('--actor') ? args[args.indexOf('--actor') + 1] : undefined;

async function main() {
  const catalogue = JSON.parse(readFileSync('scripts/catalogue.json', 'utf8'));
  const meta = JSON.parse(readFileSync('scripts/derived-meta.json', 'utf8'));
  const bySlug = faqsBySlug(catalogue, meta);

  let actor: { id: string; name: string; role: string } | null = null;
  if (confirm) {
    if (!actorEmail) throw new Error('--confirm needs --actor <cms email>, so every change is attributed.');
    actor = await prisma.cmsUser.findFirst({
      where: { email: actorEmail.toLowerCase() },
      select: { id: true, name: true, role: true },
    });
    if (!actor) throw new Error(`No CMS user ${actorEmail}`);
  }

  console.log(confirm ? `▸ APPLYING as ${actor!.name}\n` : '▸ DRY RUN (add --confirm --actor <email> to apply)\n');
  let total = 0;
  let written = 0;
  for (const [slug, faq] of bySlug) {
    total += faq.length;
    const fam = await prisma.productFamily.findUnique({
      where: { slug },
      select: { id: true, name: true, faq: true, draft: { select: { id: true } } },
    });
    if (!fam) { console.log(`  ? ${slug}: no such product, skipped`); continue; }
    if (Array.isArray(fam.faq) && fam.faq.length > 0) { console.log(`  = ${slug}: already has ${fam.faq.length} FAQs, left alone`); continue; }
    if (fam.draft) { console.log(`  ! ${slug}: pending CMS draft, skipped (add via the CMS)`); continue; }
    console.log(`  + ${slug}: ${faq.length} FAQs`);
    if (!confirm) continue;
    await prisma.$transaction([
      prisma.productFamily.update({ where: { id: fam.id }, data: { faq: faq as unknown as Prisma.InputJsonValue } }),
      prisma.auditLog.create({
        data: {
          actorId: actor!.id, actorName: actor!.name, actorRole: actor!.role, ip: 'script',
          module: AuditModule.PRODUCTS, recordId: slug,
          action: `Imported ${faq.length} FAQs for "${fam.name}" from the PDP master document`,
        },
      }),
    ]);
    written++;
  }
  console.log(`\n${bySlug.size} products, ${total} FAQs in the catalogue${confirm ? `; ${written} products written` : ''}.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
