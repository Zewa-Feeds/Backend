/**
 * One-off content fixes from the Nov 2026 close-out review.
 *
 *   1. Product card text. Every product's shortDesc was the product brief's
 *      copy cut at 200 characters, mid-word ("…prebiotics for the st"). The
 *      column now holds 320 (migration 20261110110000_short_desc_320), so the
 *      full copy from scripts/catalogue.json goes back in.
 *   2. "paprica" -> "paprika" (Koi Bites K7: card, description, key benefits).
 *   3. The stale "Free shipping on orders over ₹999 · Monsoon sale live"
 *      announcement is switched off. Free shipping is only the FREESHIPPING coupon.
 *
 * Safe by construction:
 *   - Dry run unless --confirm.
 *   - A card text is replaced only while it is still exactly the truncated
 *     import, so anything edited in the CMS since is left alone.
 *   - Pending CMS drafts get the same fixes, so a later publish cannot bring
 *     the old text back.
 *   - Every change writes an audit entry attributed to --actor.
 *
 *   npx tsx scripts/fix-review-content-2026-11.ts
 *   npx tsx scripts/fix-review-content-2026-11.ts --confirm --actor parthk@zewafeeds.com
 *
 * Run it only after the deploy that applies the 320-character migration.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { AuditModule, Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const confirm = args.includes('--confirm');
const actorEmail = args.includes('--actor') ? args[args.indexOf('--actor') + 1] : undefined;

type Source = { code: string; shortDescription: string };
type Meta = { code: string; slug: string };

const fixSpelling = (s: string) => s.replace(/paprica/g, 'paprika').replace(/Paprica/g, 'Paprika');

function fixDeep<T>(v: T): T {
  if (typeof v === 'string') return fixSpelling(v) as T;
  if (Array.isArray(v)) return v.map(fixDeep) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fixDeep(x)])) as T;
  return v;
}

async function main() {
  const sources: Source[] = JSON.parse(readFileSync('scripts/catalogue.json', 'utf8'));
  const meta: Meta[] = JSON.parse(readFileSync('scripts/derived-meta.json', 'utf8'));
  const slugOf = new Map(meta.map((m) => [m.code, m.slug]));

  const col = await prisma.$queryRaw<{ len: number }[]>`
    SELECT character_maximum_length AS len FROM information_schema.columns
     WHERE table_name = 'ProductFamily' AND column_name = 'shortDesc'`;
  if (Number(col[0]?.len) < 320) {
    throw new Error(`shortDesc still holds ${col[0]?.len} characters. Deploy the 320-character migration first.`);
  }

  let actor: { id: string; name: string; role: string } | null = null;
  if (confirm) {
    if (!actorEmail) throw new Error('--confirm needs --actor <cms email>, so every change is attributed.');
    actor = await prisma.cmsUser.findFirst({ where: { email: actorEmail.toLowerCase() }, select: { id: true, name: true, role: true } });
    if (!actor) throw new Error(`No CMS user ${actorEmail}`);
  }
  const ctx = actor && { actorId: actor.id, actorName: actor.name, actorRole: actor.role, ip: 'script' };

  console.log(confirm ? '▸ APPLYING\n' : '▸ DRY RUN (add --confirm --actor <email> to apply)\n');

  for (const src of sources) {
    const slug = slugOf.get(src.code);
    const fam = slug
      ? await prisma.productFamily.findUnique({
          where: { slug },
          select: { id: true, name: true, shortDesc: true, fullDescHtml: true, benefits: true, draft: { select: { payload: true } } },
        })
      : null;
    if (!fam) {
      console.log(`  ? ${src.code}: no product with slug ${slug}, skipped`);
      continue;
    }

    const full = fixSpelling(src.shortDescription.trim());
    const stillTruncated = fam.shortDesc === src.shortDescription.trim().slice(0, 200);
    const nextShort = stillTruncated ? full : fixSpelling(fam.shortDesc);
    const nextFull = fixSpelling(fam.fullDescHtml);
    const nextBenefits = fam.benefits.map(fixSpelling);

    const changes: string[] = [];
    if (nextShort !== fam.shortDesc) changes.push(stillTruncated ? `card text restored (${fam.shortDesc.length} → ${nextShort.length} chars)` : 'card text spelling');
    if (nextFull !== fam.fullDescHtml) changes.push('description spelling');
    if (nextBenefits.join('\n') !== fam.benefits.join('\n')) changes.push('benefits spelling');
    if (!stillTruncated && fam.shortDesc.length >= 200) console.log(`  ! ${fam.name}: card text was edited since import, left as is`);
    if (changes.length === 0) {
      console.log(`  = ${fam.name}: nothing to change`);
      continue;
    }
    console.log(`  ✓ ${fam.name}: ${changes.join(', ')}`);
    if (!confirm || !ctx) continue;

    await prisma.$transaction(async (tx) => {
      await tx.productFamily.update({
        where: { id: fam.id },
        data: { shortDesc: nextShort, fullDescHtml: nextFull, benefits: nextBenefits },
      });
      if (fam.draft) {
        const payload = fixDeep(fam.draft.payload as Record<string, unknown>);
        if (stillTruncated && payload && typeof payload === 'object' && payload.shortDesc === fam.shortDesc) {
          payload.shortDesc = nextShort;
        }
        await tx.productDraft.update({ where: { familyId: fam.id }, data: { payload: payload as Prisma.InputJsonValue } });
      }
      await tx.auditLog.create({
        data: {
          actorId: ctx.actorId,
          actorName: ctx.actorName,
          actorRole: ctx.actorRole,
          module: AuditModule.PRODUCTS,
          action: `Review fixes on "${fam.name}": ${changes.join(', ')}`,
          recordId: slug,
          ip: ctx.ip,
        },
      });
    });
  }

  // ---- announcement ---------------------------------------------------------
  const row = await prisma.setting.findUnique({ where: { key: 'announcement' } });
  const ann = (row?.value ?? {}) as { active?: boolean; text?: string };
  if (ann.active) {
    console.log(`\n  ✓ announcement "${ann.text}": switch off`);
    if (confirm && ctx) {
      await prisma.$transaction([
        prisma.setting.update({ where: { key: 'announcement' }, data: { value: { ...ann, active: false }, updatedById: ctx.actorId } }),
        prisma.auditLog.create({
          data: {
            actorId: ctx.actorId,
            actorName: ctx.actorName,
            actorRole: ctx.actorRole,
            module: AuditModule.SETTINGS,
            action: `Switched off the stale announcement "${ann.text}" (free shipping over ₹999 is not offered)`,
            recordId: 'announcement',
            ip: ctx.ip,
          },
        }),
      ]);
    }
  } else {
    console.log('\n  = announcement already off');
  }

  console.log(confirm ? '\nDone. The settings cache expires within 60 s; product pages refresh on their next revalidation.' : '\nDry run only.');
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
