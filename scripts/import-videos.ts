/**
 * Attach one product video per product, at gallery position 1.
 *
 *   npx tsx scripts/import-videos.ts --dry
 *   npx tsx scripts/import-videos.ts --confirm
 *
 * Position 1 (second) is deliberate: position 0 must stay a still image so the
 * PDP hero, cart thumbnail and OG tag all have a real photo. The owner's stated
 * order was "photo, video, photo, photo…".
 *
 * Idempotent: keyed on slug, skips uploads already in video-uploaded.json, and
 * replaces any existing VIDEO row rather than adding a second one (the DB has a
 * partial unique index allowing only one video per product).
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { MediaType } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import { env } from '../src/config/env';

const DIR = __dirname;
const VIDEOS = join(DIR, 'video-web');
const LEDGER = join(DIR, 'video-uploaded.json');
const DRY = !process.argv.includes('--confirm');

type Up = { url: string; publicId: string; width: number; height: number; duration: number };
const ledger: Record<string, Up> = existsSync(LEDGER)
  ? JSON.parse(readFileSync(LEDGER, 'utf8'))
  : {};

function sign(params: Record<string, string | number>) {
  const s = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  return createHash('sha1').update(`${s}${env.CLOUDINARY_API_SECRET}`).digest('hex');
}

/**
 * Upload one video. Uses `eager` + `eager_async` rather than `transformation`:
 * a synchronous transform makes Cloudinary transcode BEFORE responding, which
 * measured 43s for an 11MB clip and times the request out on larger files.
 */
async function upload(slug: string): Promise<Up> {
  if (ledger[slug]) return ledger[slug];

  const file = join(VIDEOS, `${slug}.mp4`);
  const timestamp = Math.floor(Date.now() / 1000);
  const params = {
    folder: 'zewa/products',
    timestamp,
    eager: 'q_auto,w_1920,c_limit',
    eager_async: 'true',
    allowed_formats: 'mp4,webm,mov',
  };

  const form = new FormData();
  form.append('file', new Blob([readFileSync(file)]), basename(file));
  form.append('api_key', env.CLOUDINARY_API_KEY as string);
  form.append('timestamp', String(timestamp));
  form.append('signature', sign(params));
  form.append('folder', params.folder);
  form.append('eager', params.eager);
  form.append('eager_async', 'true');
  form.append('allowed_formats', params.allowed_formats);

  let last = '';
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const res = await fetch(
        `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/video/upload`,
        { method: 'POST', body: form },
      );
      if (res.ok) {
        const b = (await res.json()) as any;
        const entry: Up = {
          url: b.secure_url, publicId: b.public_id,
          width: b.width, height: b.height, duration: b.duration,
        };
        ledger[slug] = entry;
        writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
        return entry;
      }
      last = `${res.status} ${(await res.text()).slice(0, 140)}`;
      if (res.status >= 400 && res.status < 500) break;  // bad request — retry won't help
    } catch (e) { last = (e as Error).message; }
    await new Promise((r) => setTimeout(r, attempt * 3000));
    console.log(`    retry ${attempt}/5 — ${slug} (${last})`);
  }
  throw new Error(`upload ${slug}: ${last}`);
}

/** Cloudinary renders a poster frame on demand; so_0 pins it to the first frame. */
const posterFor = (publicId: string) =>
  `https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/video/upload/so_0,q_auto,f_jpg/${publicId}.jpg`;

async function main() {
  const slugs = readdirSync(VIDEOS).filter((f) => f.endsWith('.mp4')).map((f) => f.replace('.mp4', ''));
  console.log(`${DRY ? 'DRY RUN — nothing written' : 'LIVE RUN'}\n`);

  for (const slug of slugs) {
    const family = await prisma.productFamily.findFirst({
      where: { slug }, select: { id: true, name: true },
    });
    if (!family) { console.log(`  ✗ ${slug.padEnd(20)} no such product`); continue; }

    if (DRY) {
      const imgs = await prisma.productMedia.count({
        where: { familyId: family.id, type: MediaType.IMAGE },
      });
      console.log(`  ${slug.padEnd(20)} ${imgs} images → video goes to position 1`);
      continue;
    }

    const up = await upload(slug);

    // Rebuild the gallery so the video lands at index 1 and images keep order.
    const images = await prisma.productMedia.findMany({
      where: { familyId: family.id, type: MediaType.IMAGE },
      orderBy: { position: 'asc' },
    });

    const keep = images.slice(0, 19);

    await prisma.$transaction(async (tx) => {
      await tx.productMedia.deleteMany({ where: { familyId: family.id } });

      /*
       * The API caps a gallery at 20 items, and several products already have
       * exactly 20 images. Drop the LAST image to make room for the video rather
       * than exceeding the cap — the tail images are duplicate pack-size shots,
       * and a save from the CMS would be rejected at 21.
       */
      const rows = keep.map((m) => ({
        familyId: family.id, type: MediaType.IMAGE, url: m.url, publicId: m.publicId,
        // variantId MUST be carried over: rebuilding the gallery without it
        // silently un-linked every pack-specific photo (158 of 171 rows).
        variantId: m.variantId,
        alt: m.alt, width: m.width, height: m.height, position: 0,
      }));
      // photo, VIDEO, photo, photo…
      rows.splice(1, 0, {
        familyId: family.id, type: MediaType.VIDEO, url: up.url, publicId: up.publicId,
        // Shared: the film covers the product, not one pack size.
        variantId: null,
        alt: `${family.name} — product video`, width: up.width, height: up.height, position: 1,
      } as any);
      rows.forEach((r, i) => { r.position = i; });

      await tx.productMedia.createMany({ data: rows as any });
      await tx.productMedia.updateMany({
        where: { familyId: family.id, type: MediaType.VIDEO },
        data: { posterUrl: posterFor(up.publicId), durationSec: up.duration },
      });
    });

    console.log(`  ✓ ${slug.padEnd(20)} video at position 1, ${keep.length} images, ${up.duration?.toFixed(0)}s`);
  }

  if (DRY) console.log('\n  re-run with --confirm to upload.');
}

main()
  .catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
