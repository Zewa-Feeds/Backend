/**
 * One-time catalogue importer.
 *
 *   npx tsx scripts/import-catalogue.ts --dry      inspect, change nothing
 *   npx tsx scripts/import-catalogue.ts --confirm  write to the database
 *
 * Reads the JSON produced by the three dry-run scripts:
 *   parse-pdp-doc.py   -> catalogue.json     product copy + 44 SKUs
 *   derive-meta.py     -> derived-meta.json  category + species tags
 *   map-images.py      -> image-map.json     which image belongs where
 *
 * IDEMPOTENT: keyed on slug. Re-running updates rather than duplicating, and
 * skips any image already uploaded (recorded in uploaded.json), so a failed run
 * can be resumed without re-paying for uploads.
 *
 * Everything imports as DRAFT — nothing reaches customers until you publish it.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Category, ProductStatus, MediaType } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import { env } from '../src/config/env';
import { buildMediaAlt } from '../src/lib/media-alt';

const DIR = __dirname;
const IMAGES_ROOT = join(DIR, '..', 'Listing Images');
const LEDGER = join(DIR, 'uploaded.json');

const DRY = !process.argv.includes('--confirm');

type Sku = { sku: string; variant: string; mrp: number; price: number; hsn: string };
type Product = {
  code: string; slug: string; name: string; optimisedTitle: string;
  metaDescription: string; shortDescription: string; longParagraphs: string[];
  suitableFor: Record<string, string>; feeding: string;
  nutrition: Record<string, string>; keyFeatures: string[]; skus: Sku[];
};
type Meta = { code: string; slug: string; category: string; tags: string[] };
type ImageRow = { file: string; slug: string; position: number; include: boolean; pack: string | null };

const read = <T,>(f: string): T => JSON.parse(readFileSync(join(DIR, f), 'utf8'));

const products = read<Product[]>('catalogue.json');
const meta = read<Meta[]>('derived-meta.json');
const imageMap = read<{ images: ImageRow[] }>('image-map.json').images;

/** Cloudinary public_ids already uploaded, so a re-run does not duplicate work. */
const ledger: Record<string, { url: string; publicId: string; width: number; height: number }> =
  existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : {};

// ---------------------------------------------------------------- Cloudinary

function sign(params: Record<string, string | number>): string {
  const toSign = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  return createHash('sha1').update(`${toSign}${env.CLOUDINARY_API_SECRET}`).digest('hex');
}

/**
 * Upload one image straight to Cloudinary.
 *
 * Uses the same signed-params contract as the CMS's signature endpoint, so
 * imported assets are indistinguishable from hand-uploaded ones: same folder,
 * same ingest transformation, same allowed formats.
 */
async function upload(relPath: string) {
  if (ledger[relPath]) return ledger[relPath];

  const timestamp = Math.floor(Date.now() / 1000);
  const params = {
    folder: 'zewa/products',
    timestamp,
    transformation: 'q_auto,f_auto,w_2000,c_limit',
    allowed_formats: 'jpg,jpeg,png,webp,avif',
  };

  const form = new FormData();
  const bytes = readFileSync(join(IMAGES_ROOT, relPath));
  form.append('file', new Blob([bytes]), basename(relPath));
  form.append('api_key', env.CLOUDINARY_API_KEY as string);
  form.append('timestamp', String(timestamp));
  form.append('signature', sign(params));
  form.append('folder', params.folder);
  form.append('transformation', params.transformation);
  form.append('allowed_formats', params.allowed_formats);

  /*
   * Retry with backoff. A single dropped connection used to abort the whole run
   * ("fetch failed" at image 57 of 165) — which is unacceptable when the run has
   * already deleted the old catalogue. 165 sequential uploads over a home
   * connection WILL see transient failures; they are not a reason to stop.
   */
  let b: { secure_url: string; public_id: string; width: number; height: number } | null = null;
  let lastErr = '';
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const res = await fetch(
        `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`,
        { method: 'POST', body: form },
      );
      if (!res.ok) {
        lastErr = `${res.status} ${(await res.text()).slice(0, 160)}`;
        // 4xx is a bad request (wrong format, too large) — retrying cannot help.
        if (res.status >= 400 && res.status < 500) break;
      } else {
        b = (await res.json()) as typeof b;
        break;
      }
    } catch (e) {
      lastErr = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, attempt * 2000));
    console.log(`    retry ${attempt}/5 — ${basename(relPath)} (${lastErr})`);
  }
  if (!b) throw new Error(`upload ${relPath} failed after retries: ${lastErr}`);

  const entry = { url: b.secure_url, publicId: b.public_id, width: b.width, height: b.height };
  ledger[relPath] = entry;
  // Persist after EVERY upload: a crash at image 150 must not orphan the first
  // 149 in Cloudinary with no record of them.
  writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
  return entry;
}

// ---------------------------------------------------------------- transforms

/** Long description paragraphs -> the sanitised HTML the PDP renders. */
const toHtml = (paras: string[]) =>
  paras.filter((p) => p.trim()).map((p) => `<p>${p.trim()}</p>`).join('\n');

/** "•  46% insect protein" -> "46% insect protein" */
const cleanBullet = (s: string) => s.replace(/^[•\-•]\s*/, '').trim();

/** "46%" -> 46, for the proteinPct column. */
function proteinOf(nutrition: Record<string, string>) {
  const v = Object.entries(nutrition).find(([k]) => /crude protein/i.test(k))?.[1] ?? '0';
  return Math.round(parseFloat(v.replace(/[^\d.]/g, '')) || 0);
}

/**
 * Pack weight in grams, for shipping bands.
 *
 * Multiplies out combos: "45g × 2 Combo" is 90g shipped, not 45g. Reading only
 * the first number under-reports every multi-pack and would under-charge
 * shipping on 15 of the 44 SKUs.
 */
function gramsOf(variant: string) {
  const kg = /([\d.]+)\s*kg/i.exec(variant);
  const base = kg
    ? parseFloat(kg[1]) * 1000
    : (() => {
        const g = /([\d.]+)\s*g/i.exec(variant);
        return g ? parseFloat(g[1]) : null;
      })();
  if (base == null) return null;
  // "× 2" / "x 3" — the pack count.
  const mult = /[×x]\s*(\d+)/i.exec(variant);
  return Math.round(base * (mult ? parseInt(mult[1], 10) : 1));
}

/**
 * Pack selector label. "Betta Bites · 45g Bottle" -> "45g Bottle".
 *
 * Also rewrites the doc's marketplace wording into retail language: "45g × 2
 * Combo" reads like a spec sheet, so it becomes "45g — Pack of 2". The SKU code
 * (G2-45GX2) is unchanged, so marketplace feeds and invoices still match.
 */
function packLabel(variant: string) {
  const raw = (variant.split('·').pop() ?? variant).trim();
  const combo = /^([\d.]+\s*(?:g|kg))\s*[×x]\s*(\d+)\s*combo$/i.exec(raw);
  return combo ? `${combo[1]} — Pack of ${combo[2]}` : raw;
}

async function main() {
  const bySlug = new Map(meta.map((m) => [m.code, m]));
  const actorId = (await prisma.cmsUser.findFirst({
    where: { role: 'ADMIN', deletedAt: null }, select: { id: true },
  }))?.id;

  const wanted = imageMap.filter((i) => i.include);
  console.log(`${DRY ? 'DRY RUN — nothing will be written' : 'LIVE RUN'}\n`);
  console.log(`  products : ${products.length}`);
  console.log(`  SKUs     : ${products.reduce((n, p) => n + p.skus.length, 0)}`);
  console.log(`  images   : ${wanted.length}  (${Object.keys(ledger).length} already uploaded)\n`);

  if (DRY) {
    for (const p of products) {
      const m = bySlug.get(p.code)!;
      const imgs = wanted.filter((i) => i.slug === m.slug).length;
      console.log(
        `  ${m.slug.padEnd(20)} ${m.category.padEnd(22)} ` +
        `${String(p.skus.length).padStart(2)} SKUs  ${String(imgs).padStart(2)} imgs  ` +
        `${proteinOf(p.nutrition)}% protein  ${m.tags.length} tags`,
      );
    }
    console.log('\n  re-run with --confirm to write.');
    return;
  }

  // ---- 1. remove the seed/test catalogue -----------------------------------
  const keep = new Set(meta.map((m) => m.slug));
  const stale = await prisma.productFamily.findMany({
    where: { slug: { notIn: [...keep] } }, select: { id: true, slug: true },
  });
  if (stale.length) {
    console.log(`  deleting ${stale.length} product(s) not in the master doc…`);
    const ids = stale.map((s) => s.id);
    // Order matters: children first, and orders reference variants.
    await prisma.orderItem.deleteMany({ where: { variant: { familyId: { in: ids } } } });
    await prisma.order.deleteMany({});
    await prisma.productMedia.deleteMany({ where: { familyId: { in: ids } } });
    await prisma.productDraft.deleteMany({ where: { familyId: { in: ids } } });
    await prisma.review.deleteMany({ where: { familyId: { in: ids } } });
    await prisma.spotlight.deleteMany({ where: { familyId: { in: ids } } });
    await prisma.couponProduct.deleteMany({ where: { familyId: { in: ids } } });
    await prisma.productVariant.deleteMany({ where: { familyId: { in: ids } } });
    await prisma.productFamily.deleteMany({ where: { id: { in: ids } } });
    console.log(`  removed ${stale.length} seed product(s): ${stale.map((s) => s.slug).join(', ')}\n`);
  }

  // ---- 2. upload images ----------------------------------------------------
  let done = 0;
  for (const img of wanted) {
    await upload(img.file);
    done += 1;
    if (done % 20 === 0) console.log(`  uploaded ${done}/${wanted.length}`);
  }
  console.log(`  uploaded ${done}/${wanted.length} images\n`);

  // ---- 3. products + variants + galleries ---------------------------------
  for (const p of products) {
    const m = bySlug.get(p.code)!;
    const gallery = wanted
      .filter((i) => i.slug === m.slug)
      .sort((a, b) => a.position - b.position);

    const data = {
      name: p.name,
      category: m.category as Category,
      status: ProductStatus.DRAFT,
      shortDesc: p.shortDescription.slice(0, 200),
      fullDescHtml: toHtml(p.longParagraphs),
      proteinPct: proteinOf(p.nutrition),
      benefits: p.keyFeatures.map(cleanBullet).filter(Boolean).slice(0, 8),
      tags: m.tags,
      feedFreq: null,
      feedPortion: null,
      feedNotesHtml: p.feeding ? `<p>${p.feeding}</p>` : null,
      nutrition: p.nutrition,
      seoTitle: p.optimisedTitle.slice(0, 70),
      seoDesc: p.metaDescription.slice(0, 180),
      updatedById: actorId ?? null,
    };

    const family = await prisma.productFamily.upsert({
      where: { slug: m.slug },
      create: { ...data, slug: m.slug },
      update: data,
      select: { id: true },
    });

    // Variants: upsert by SKU so re-runs update prices instead of failing on the
    // unique constraint.
    for (const [i, s] of p.skus.entries()) {
      const v = {
        familyId: family.id,
        pack: packLabel(s.variant),
        mrpPaise: s.mrp * 100,
        pricePaise: s.price * 100,
        hsn: s.hsn,
        weightGrams: gramsOf(s.variant),
        position: i,
        isActive: true,
      };
      await prisma.productVariant.upsert({
        where: { sku: s.sku },
        create: { ...v, sku: s.sku, stock: 0 },
        update: v,   // stock is NOT overwritten — it is operational data
      });
    }

    /*
     * Resolve each image's detected pack ("200g", "1kg", "bottle") to a real
     * variant, so the PDP can show only the selected pack's photography.
     * Unresolved -> null -> shared asset, shown for every pack.
     */
    const variants = await prisma.productVariant.findMany({
      where: { familyId: family.id }, select: { id: true, sku: true, pack: true },
    });
    const variantFor = (pack: string | null): string | null => {
      if (!pack) return null;
      const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');
      // "bottle" is only unambiguous when the product has exactly one bottle SKU.
      if (pack === 'bottle') {
        const bottles = variants.filter((v) => /bottle/i.test(v.pack));
        return bottles.length === 1 ? bottles[0].id : null;
      }
      // Never attach to a multi-pack: a "Pack of 2" photo does not exist, and the
      // single-pack shot is the right image for it anyway.
      const hit = variants.find(
        (v) => norm(v.pack).startsWith(norm(pack)) && !/pack of/i.test(v.pack),
      );
      return hit?.id ?? null;
    };

    // Gallery: replace wholesale, so re-running reflects a corrected map.
    await prisma.productMedia.deleteMany({ where: { familyId: family.id } });
    if (gallery.length) {
      await prisma.productMedia.createMany({
        data: gallery.map((g, i) => {
          const up = ledger[g.file];
          return {
            familyId: family.id,
            variantId: variantFor((g as { pack?: string | null }).pack ?? null),
            type: MediaType.IMAGE,
            url: up.url,
            publicId: up.publicId,
            // Only stripped .png, so every JPEG kept its extension in the
            // alt text. See buildMediaAlt for the full reasoning.
            alt: buildMediaAlt(p.name, basename(g.file), i),
            position: i,
            width: up.width,
            height: up.height,
          };
        }),
      });
    }

    console.log(`  ✓ ${m.slug.padEnd(20)} ${p.skus.length} SKUs, ${gallery.length} images`);
  }

  console.log('\n  done — all products are DRAFT. Review and publish each in the CMS.');
}

main()
  .catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
