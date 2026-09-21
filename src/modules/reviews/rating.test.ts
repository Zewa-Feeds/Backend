/**
 * The combined rating. Pure arithmetic, so it is tested directly.
 *
 * The figures below are the real Amazon baseline for Guppy Bites — 91×5, 23×4,
 * 19×3 — which the source spreadsheet states as 4.54 across 133 ratings. If the
 * combination is wrong, this is where it shows.
 */
import { describe, expect, it } from 'vitest';
import { reviewSummary } from './rating';

/** Guppy Bites, as scraped: [5★, 4★, 3★, 2★, 1★]. */
const GUPPY = [91, 23, 19, 0, 0];

describe('reviewSummary', () => {
  it('reports nothing for a product with no ratings at all', () => {
    expect(reviewSummary([], null, [])).toEqual({
      average: null,
      count: 0,
      externalSource: null,
      externalCount: 0,
    });
  });

  it('reproduces the source average from the imported counts alone', () => {
    const s = reviewSummary(GUPPY, 'Amazon', []);
    // (91*5 + 23*4 + 19*3) / 133 = 4.54 — the sheet's own figure.
    expect(s.average).toBe(4.5);
    expect(s.count).toBe(133);
    expect(s.externalSource).toBe('Amazon');
  });

  it('counts every rating, not just the reviews that had text', () => {
    // 5 of the 133 Guppy ratings came with a written review.
    const s = reviewSummary(GUPPY, 'Amazon', []);
    expect(s.count).toBe(133);
    expect(s.externalCount).toBe(133);
  });

  it('moves the average when an approved review lands', () => {
    const before = reviewSummary(GUPPY, 'Amazon', []);
    const after = reviewSummary(GUPPY, 'Amazon', [1]);

    expect(after.count).toBe(before.count + 1);
    // 604 + 1 = 605 over 134 ratings = 4.515, still displaying as 4.5.
    expect(after.average).toBeLessThan(5);
    expect(after.count).toBe(134);
  });

  it('weights the baseline by its size, which an average could not', () => {
    /*
     * The point of storing counts: one 5★ against 133 ratings shifts the mean
     * from 4.5414 to 4.5448 — not enough to change the displayed figure, which
     * is exactly right. A stored AVERAGE would have jumped to 4.77.
     */
    const big = reviewSummary(GUPPY, 'Amazon', [5]);
    expect(big.average).toBe(4.5);

    // ...but dominates a baseline of three.
    const small = reviewSummary([2, 1, 0, 0, 0], 'Amazon', [5, 5, 5]);
    expect(small.count).toBe(6);
    expect(small.average).toBe(4.8);
  });

  it('works with no baseline, for a product that only ever sold here', () => {
    const s = reviewSummary([], null, [5, 4]);
    expect(s.average).toBe(4.5);
    expect(s.count).toBe(2);
    // Nothing was imported, so there is no other platform to credit.
    expect(s.externalSource).toBeNull();
    expect(s.externalCount).toBe(0);
  });

  it('ignores a source name when nothing was actually imported', () => {
    const s = reviewSummary([0, 0, 0, 0, 0], 'Amazon', [5]);
    expect(s.externalSource).toBeNull();
    expect(s.count).toBe(1);
  });

  it('handles a partial counts array without treating gaps as ratings', () => {
    // Only 5★ and 4★ recorded; 2★/1★ absent rather than zero.
    const s = reviewSummary([2, 2], 'Amazon', []);
    expect(s.count).toBe(4);
    expect(s.average).toBe(4.5);
  });

  /*
   * The imported reviews that had TEXT are a subset of the baseline counts,
   * not additions to them. Guppy Bites' 5 written reviews are 5 of its 133
   * Amazon ratings — passing them in as site reviews reported 138.
   */
  it('does not re-count the imported reviews that came with text', () => {
    // What the caller must pass: site reviews only, so an untouched product
    // reports exactly its baseline however many texts were imported.
    const s = reviewSummary(GUPPY, 'Amazon', []);
    expect(s.count).toBe(133);
    expect(s.average).toBe(4.5);
  });
});