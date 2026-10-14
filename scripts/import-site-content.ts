/**
 * Import the storefront's formerly hardcoded content into the CMS.
 *
 *   npx tsx -r dotenv/config scripts/import-site-content.ts <seed.json>            # dry run
 *   npx tsx -r dotenv/config scripts/import-site-content.ts <seed.json> --confirm  # writes
 *       [--write-snapshot <path>]   also dump the resulting live snapshot (the
 *                                   storefront's committed dev fallback)
 *
 * The seed comes from Frontend/scripts/export-site-content.ts, which measured
 * every file. This script:
 *
 *   1. registers each file as a MediaAsset (STATIC for Frontend/public, EXTERNAL
 *      for third-party URLs) — upsert by URL, nothing uploaded or duplicated
 *   2. creates each article as PUBLISHED with its original date — an article
 *      that already exists (same slug) is LEFT ALONE, never overwritten
 *   3. writes the website draft — only if no draft exists yet, unless --force
 *   4. on the FIRST import only, moves published articles the storefront never
 *      displayed back to Draft (they were invisible while the blog was
 *      hardcoded; v1 must look exactly like today's site)
 *   5. publishes v1 if nothing has been published yet — WITHOUT queueing a
 *      storefront regeneration (deploy the storefront next; it builds from v1;
 *      then press Retry on v1 in CMS → Publishing to confirm it LIVE)
 *
 * Needs the migration applied for --confirm. A dry run works before it.
 *
 * Safe to re-run: every step is idempotent, and the dry run reports what it
 * would do without writing anything.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { Prisma } from '@prisma/client';
import { AuditModule, ContentStatus, MediaStorage, MediaType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { type AuditContext, writeAudit } from '@/modules/audit/audit.service';
import { mimeFor } from '@/modules/site/media.service';
import { blocksSchema, siteSectionsSchema } from '@/modules/site/site.schemas';
import { DEFAULT_SECTIONS, exportCurrentSnapshot, publishFromScript, stableStringify } from '@/modules/site/site.service';
import { closeQueues } from '@/jobs/queues';
import { disconnectRedis } from '@/lib/redis';

interface SeedAsset {
  key: string;
  storage: 'STATIC' | 'EXTERNAL';
  type: 'IMAGE' | 'VIDEO';
  url: string;
  format: string | null;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  bytes: number | null;
  title: string;
  altText: string;
}

interface Seed {
  assets: SeedAsset[];
  sections: unknown;
  articles: Array<Record<string, unknown> & { slug: string; title: string; blocks: unknown[] }>;
}

const args = process.argv.slice(2);
const seedPath = args.find((a) => !a.startsWith('--'));
const confirm = args.includes('--confirm');
const force = args.includes('--force');
const snapshotOut = args.includes('--write-snapshot') ? args[args.indexOf('--write-snapshot') + 1] : null;

const CTX: AuditContext = { actorId: null, actorName: 'Content import', actorRole: 'System', ip: 'internal' };

/** Replace every { assetKey } with { assetId } — the shape the API stores. */
function remap(value: unknown, ids: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((v) => remap(v, ids));
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.assetKey === 'string') {
      const id = ids.get(obj.assetKey);
      if (!id) throw new Error(`Seed references unknown asset ${obj.assetKey}`);
      return { assetId: id };
    }
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, remap(v, ids)]));
  }
  return value;
}

async function main() {
  if (!seedPath) throw new Error('Usage: import-site-content.ts <seed.json> [--confirm] [--force] [--write-snapshot <path>]');
  const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as Seed;
  const host = new URL(process.env.DATABASE_URL ?? 'postgres://unknown').host;
  console.log(`${confirm ? 'IMPORTING into' : 'DRY RUN against'} ${host}`);

  /*
   * Has migration 20261014090000_site_content_publishing been applied?
   *
   * A dry run is useful BEFORE migrating (it is the check that tells you what
   * the import will do), so it must not crash on the missing tables: it reports
   * what it can from the tables that already exist. A real import refuses.
   */
  const [probe] = await prisma.$queryRaw<{ migrated: boolean }[]>`
    SELECT to_regclass('"SitePublication"') IS NOT NULL AS migrated`;
  const migrated = Boolean(probe?.migrated);
  if (!migrated) {
    if (confirm) throw new Error('Migration 20261014090000_site_content_publishing is not applied — run `npm run prisma:deploy` first.');
    console.log('NOTE: the site-content migration is not applied yet; reporting from existing tables only.');
  }

  // ---- 1. Assets ---------------------------------------------------------
  const ids = new Map<string, string>();
  let createdAssets = 0;
  for (const a of seed.assets) {
    const existing = migrated
      ? await prisma.mediaAsset.findUnique({ where: { url: a.url }, select: { id: true } })
      : null;
    if (existing) {
      ids.set(a.key, existing.id);
      continue;
    }
    createdAssets += 1;
    if (!confirm) {
      ids.set(a.key, `00000000-0000-4000-8000-${String(createdAssets).padStart(12, '0')}`);
      continue;
    }
    const row = await prisma.mediaAsset.create({
      data: {
        storage: a.storage === 'STATIC' ? MediaStorage.STATIC : MediaStorage.EXTERNAL,
        type: a.type === 'VIDEO' ? MediaType.VIDEO : MediaType.IMAGE,
        url: a.url,
        format: a.format,
        mimeType: mimeFor(a.format),
        width: a.width,
        height: a.height,
        bytes: a.bytes,
        durationSec: a.durationSec,
        title: a.title,
        altText: a.altText ?? '',
        tags: ['imported'],
      },
      select: { id: true },
    });
    ids.set(a.key, row.id);
  }
  console.log(`assets: ${createdAssets} new, ${seed.assets.length - createdAssets} already registered`);

  // ---- 2. Articles ---------------------------------------------------------
  let createdArticles = 0;
  for (const a of seed.articles) {
    const blocks = blocksSchema.parse(remap(a.blocks, ids)); // the seed must satisfy the editor's own rules
    const existing = await prisma.article.findUnique({ where: { slug: a.slug }, select: { id: true } });
    if (existing) {
      console.log(`  article ${a.slug}: exists — left unchanged`);
      continue;
    }
    createdArticles += 1;
    if (!confirm) continue;
    const cover = remap(a.cover, ids) as { assetId: string } | null;
    const coverMobile = remap(a.coverMobile, ids) as { assetId: string } | null;
    const coverUrl = seed.assets.find((x) => x.key === (a.cover as { assetKey?: string } | null)?.assetKey)?.url ?? null;
    await prisma.article.create({
      data: {
        slug: a.slug,
        title: a.title,
        shortTitle: (a.shortTitle as string) ?? null,
        tag: a.tag as string,
        tagColor: (a.tagColor as string) ?? null,
        readMinutes: a.readMinutes as number,
        excerpt: a.excerpt as string,
        contentBlocks: blocks as unknown as Prisma.InputJsonValue,
        coverAssetId: cover?.assetId ?? null,
        coverMobileAssetId: coverMobile?.assetId ?? null,
        coverImageUrl: coverUrl,
        coverAlt: (a.coverAlt as string) ?? null,
        stat: (a.stat as string) ?? null,
        statLabel: (a.statLabel as string) ?? null,
        seoTitle: (a.seoTitle as string) ?? null,
        seoDesc: (a.seoDesc as string) ?? null,
        focusKeyword: (a.focusKeyword as string) ?? null,
        seoKeywords: (a.seoKeywords as string[]) ?? [],
        ogTitle: (a.ogTitle as string) ?? null,
        ogDescription: (a.ogDescription as string) ?? null,
        authorName: a.authorName as string,
        status: ContentStatus.PUBLISHED,
        publishedAt: new Date(a.publishedAt as string),
      },
    });
  }
  console.log(`articles: ${createdArticles} new, ${seed.articles.length - createdArticles} existing`);

  // ---- 2b. Articles the storefront never showed ----------------------------
  // Until now the blog was hardcoded, so a PUBLISHED row here was invisible to
  // customers (e.g. prisma/seed.ts placeholders). v1 must reproduce the site as
  // it is, so those return to Draft for an editor to review rather than
  // appearing on the blog the moment the static pipeline goes live.
  const seedSlugs = new Set(seed.articles.map((a) => a.slug));
  const hidden = await prisma.article.findMany({
    where: { status: ContentStatus.PUBLISHED, deletedAt: null, slug: { notIn: [...seedSlugs] } },
    select: { id: true, slug: true, title: true },
  });
  const firstPublish = !migrated || !(await prisma.sitePublication.findFirst({ select: { id: true } }));
  if (!hidden.length) console.log('  no other published articles — nothing to hide');
  if (hidden.length && firstPublish) {
    for (const h of hidden) console.log(`  article ${h.slug}: published in the CMS but never shown on the site — ${confirm ? 'moved' : 'would move'} to Draft`);
    if (confirm) {
      await prisma.$transaction(async (tx) => {
        await tx.article.updateMany({ where: { id: { in: hidden.map((h) => h.id) } }, data: { status: ContentStatus.DRAFT } });
        await writeAudit(
          CTX,
          {
            module: AuditModule.CONTENT,
            action: `Moved ${hidden.length} never-displayed article(s) to Draft before the first website publication: ${hidden.map((h) => h.slug).join(', ')}`,
            recordId: 'site:import',
          },
          tx,
        );
      });
    }
  }

  // ---- 3. Draft ------------------------------------------------------------
  const sections = siteSectionsSchema.parse(remap(seed.sections, ids));
  const draft = migrated
    ? await prisma.siteContentDraft.findUnique({ where: { key: 'site' }, select: { revision: true, sections: true } })
    : null;
  // Opening Content → Website before this import creates a placeholder draft
  // from the built-in defaults. That is not editorial work and must not stop
  // the import — otherwise v1 would publish an empty homepage.
  const untouched =
    draft && draft.revision === 1 && stableStringify(draft.sections) === stableStringify(DEFAULT_SECTIONS);
  if (draft && !untouched && !force) {
    console.log('website draft: exists — left unchanged (pass --force to overwrite)');
  } else if (confirm) {
    await prisma.siteContentDraft.upsert({
      where: { key: 'site' },
      update: { sections: sections as unknown as Prisma.InputJsonValue, revision: { increment: 1 } },
      create: { key: 'site', sections: sections as unknown as Prisma.InputJsonValue },
    });
    console.log('website draft: written');
  } else {
    console.log('website draft: would be written');
  }

  // ---- 4. First publication ------------------------------------------------
  const current = migrated
    ? await prisma.sitePublication.findFirst({ where: { isCurrent: true }, select: { version: true } })
    : null;
  if (current) {
    console.log(`publication: v${current.version} is already the current version — not republishing`);
  } else if (confirm) {
    const pub = await publishFromScript('Initial import of the existing website content', CTX);
    console.log(`publication: created v${pub?.version} (QUEUED — not regenerated; the storefront deploy builds from it)`);
  } else {
    console.log('publication: would create v1');
  }

  if (snapshotOut && confirm) {
    writeFileSync(snapshotOut, `${JSON.stringify(await exportCurrentSnapshot(), null, 2)}\n`);
    console.log(`snapshot written to ${snapshotOut}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeQueues().catch(() => undefined);
    await disconnectRedis().catch(() => undefined);
    await prisma.$disconnect();
  });
