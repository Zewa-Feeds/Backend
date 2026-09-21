/**
 * The public rating for a product: imported baseline + this site's reviews.
 *
 * A catalogue that is new here is not a product that is new to the world. These
 * products sold on Amazon first, and discarding those ratings would show "no
 * reviews yet" for a feed with hundreds of them.
 *
 * The baseline is stored as COUNTS PER STAR, not an average, because an average
 * carries no weight: combining 4.54 with one new 5★ review needs to know
 * whether the 4.54 came from 3 ratings or 300. With counts it is one sum.
 *
 * Only reviews that had text were imported as rows — the rest exist as counts
 * alone. So `count` here (every rating) is deliberately larger than the number
 * of reviews the page can list, and the two must never be conflated.
 */

/** Star counts, index 0 = 5★ … index 4 = 1★. The shape stored on the family. */
export type StarCounts = readonly number[];

export interface RatingSummary {
  /** Mean across every rating, to one decimal. Null when there are none. */
  average: number | null;
  /** How many ratings that mean is over — imported plus approved. */
  count: number;
  /** Where the imported ratings came from, e.g. "Amazon". Null if none. */
  externalSource: string | null;
  /** How many of `count` came from the import, for "x of y" copy if wanted. */
  externalCount: number;
}

/**
 * Combines an imported baseline with the ratings of approved site reviews.
 *
 * `approvedRatings` must be the ratings of reviews left ON THIS SITE only —
 * every APPROVED row whose `externalSource` is null. Pass them all, not a page
 * of them: averaging a `take: 20` slice silently reports the mean of the most
 * recent twenty as if it were the mean of all.
 *
 * Imported rows are deliberately EXCLUDED, because the baseline counts already
 * contain them. The 5 Guppy Bites reviews that came with text are 5 of that
 * product's 133 Amazon ratings, not 5 more — counting both gave 138.
 */
export function reviewSummary(
  externalRatingCounts: StarCounts | null | undefined,
  externalSource: string | null | undefined,
  approvedRatings: readonly number[],
): RatingSummary {
  const counts = externalRatingCounts ?? [];

  let sum = 0;
  let count = 0;

  // Index 0 is 5★, so the star value is 5 - i.
  for (let i = 0; i < counts.length; i += 1) {
    const n = counts[i] ?? 0;
    if (n <= 0) continue;
    sum += n * (5 - i);
    count += n;
  }
  const externalCount = count;

  for (const rating of approvedRatings) {
    sum += rating;
    count += 1;
  }

  return {
    average: count > 0 ? Math.round((sum / count) * 10) / 10 : null,
    count,
    externalSource: externalCount > 0 ? (externalSource ?? null) : null,
    externalCount,
  };
}
