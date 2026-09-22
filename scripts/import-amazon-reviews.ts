/**
 * Imports the Amazon rating baseline and the reviews that carried text.
 *
 *   npx tsx -r dotenv/config scripts/import-amazon-reviews.ts [--dry]
 *
 * Source: scripts/amazon-reviews.json, derived from Zewa_Amazon_Reviews.xlsx.
 *
 * TWO DIFFERENT THINGS are imported, and conflating them would be a lie:
 *
 *   - the star COUNTS, onto ProductFamily. These drive the headline figure
 *     beside the price.
 *   - the reviews that actually had text, as Review rows. These are what the
 *     page can list.
 *
 * Most ratings have no text and are NOT written as rows: today that is 81
 * texts behind 468 ratings. Generating a row per rating would put hundreds of
 * invented reviews in the table, each indistinguishable from one a real
 * customer left here.
 *
 * Every review slot the sheet carries is read, however many there are — the
 * parser that builds amazon-reviews.json discovers them rather than assuming a
 * fixed five, which silently dropped 39 reviews when the sheet grew to 15.
 *
 * IDEMPOTENT. Re-running replaces this source's baseline and its imported
 * reviews, and never touches a review written on this site.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReviewState } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';

const SOURCE = 'Amazon';

interface ImportedReview {
  rating: number | null;
  author: string | null;
  title: string | null;
  body: string;
}

interface ImportedProduct {
  product: string;
  slug: string;
  stated_average: number;
  /** [5★, 4★, 3★, 2★, 1★] */
  stars: number[];
  total: number;
  reviews: ImportedReview[];
}

async function main() {
  const dryRun = process.argv.includes('--dry');
  const rows: ImportedProduct[] = JSON.parse(
    readFileSync(join(__dirname, 'amazon-reviews.json'), 'utf8'),
  );

  let families = 0;
  let reviewsWritten = 0;
  const missing: string[] = [];

  for (const row of rows) {
    const family = await prisma.productFamily.findUnique({
      where: { slug: row.slug },
      select: { id: true, name: true },
    });
    if (!family) {
      missing.push(row.slug);
      continue;
    }

    /*
     * The sheet states an average as well as the counts. They agree for every
     * row today, but a silent disagreement would mean the scrape is wrong and
     * the figure on the site would not be the one on Amazon — so check rather
     * than trust.
     */
    const sum = row.stars.reduce((acc, n, i) => acc + n * (5 - i), 0);
    const derived = row.total > 0 ? sum / row.total : 0;
    if (Math.abs(derived - row.stated_average) > 0.01) {
      throw new Error(
        `${row.slug}: star counts average ${derived.toFixed(2)} but the sheet ` +
          `states ${row.stated_average}. Refusing to import a baseline that ` +
          `does not match its own source.`,
      );
    }

    /*
     * The baseline must never claim FEWER ratings than the reviews we import.
     *
     * Koi Bites arrived with 3 written reviews against a 2-rating baseline —
     * the star breakdown and the review list were scraped at different times.
     * Left alone the page would list three reviews under "2 ratings", and the
     * third would not be counted in the average at all. Widening the baseline
     * to the number of real reviews is the conservative repair: it adds only
     * ratings we can actually see the text of.
     */
    if (row.reviews.length > row.total) {
      const extra = row.reviews.length - row.total;
      const byStar = [0, 0, 0, 0, 0];
      for (const r of row.reviews) {
        const star = r.rating ?? 5;
        byStar[5 - star] = (byStar[5 - star] ?? 0) + 1;
      }
      logger.warn(
        { module: 'import-reviews', slug: row.slug, ratings: row.total, texts: row.reviews.length },
        `${row.slug}: ${extra} more review(s) than the baseline counts — ` +
          `widening the baseline to match the reviews themselves`,
      );
      row.stars = byStar;
      row.total = row.reviews.length;
    }

    if (dryRun) {
      logger.info(
        { module: 'import-reviews', slug: row.slug, ratings: row.total, texts: row.reviews.length },
        `would import ${family.name}`,
      );
      families += 1;
      reviewsWritten += row.reviews.length;
      continue;
    }

    await prisma.$transaction(async (tx) => {
      await tx.productFamily.update({
        where: { id: family.id },
        data: {
          externalReviewSource: SOURCE,
          externalRatingCounts: row.stars,
        },
      });

      // Replace only THIS source's reviews. A review left on this site has a
      // null externalSource and is never touched.
      await tx.review.deleteMany({
        where: { familyId: family.id, externalSource: SOURCE },
      });

      for (const r of row.reviews) {
        await tx.review.create({
          data: {
            familyId: family.id,
            guestName: r.author,
            // No email: the source does not publish one, and a placeholder
            // would be a fake contact for a real person.
            email: null,
            rating: r.rating ?? 5,
            title: r.title,
            body: r.body,
            externalSource: SOURCE,
            // Already public on the other platform, so they are live here
            // rather than sitting in the moderation queue.
            state: ReviewState.APPROVED,
            // Never claim a purchase we cannot see an order for.
            isVerifiedPurchase: false,
          },
        });
      }
    });

    families += 1;
    reviewsWritten += row.reviews.length;
    logger.info(
      { module: 'import-reviews', slug: row.slug, ratings: row.total, texts: row.reviews.length },
      `imported ${family.name}`,
    );
  }

  if (missing.length > 0) {
    logger.warn(
      { module: 'import-reviews', missing },
      'no product family matched these slugs — their ratings were NOT imported',
    );
  }

  logger.info(
    {
      module: 'import-reviews',
      families,
      reviewsWritten,
      ratings: rows.reduce((s, r) => s + r.total, 0),
      dryRun,
    },
    dryRun ? 'dry run complete — nothing written' : 'import complete',
  );
}

main()
  .catch((err) => {
    logger.error({ module: 'import-reviews', err }, 'import failed');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
