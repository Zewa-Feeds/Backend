/**
 * Buy X Get Y.
 *
 * The only promotion type priced in UNITS rather than money, which is what
 * makes it its own file.
 *
 * The shape: every `buyQty` units of the qualifying set earns `getQty` reward
 * units, discounted by `rewardPercentOff` (100 = free). The offer repeats while
 * the cart can pay for it, up to `maxRepeats`.
 *
 * ---------------------------------------------------------------------------
 * Which units are given away
 * ---------------------------------------------------------------------------
 * The CHEAPEST discountable units, always. Two reasons, and they agree:
 *
 *   - It is what the customer is promised. "Buy 2 get 1 free" on a mixed cart
 *     means one free item, and the shop chooses which — every retailer chooses
 *     the cheapest, and a customer who expected otherwise was not told so.
 *   - It bounds the giveaway. Discounting the dearest units would let cart
 *     composition alone swing the cost of the same promotion enormously.
 *
 * ---------------------------------------------------------------------------
 * Overlap between the buy set and the get set
 * ---------------------------------------------------------------------------
 * When one product both qualifies and is rewarded ("buy 3 of X, get 1 X free"),
 * the reward units must not be counted as qualifying units as well — otherwise
 * a cart of 3 would pay for 2 and the promotion would eat itself. Reward units
 * are therefore drawn only from what remains after the qualifying units are set
 * aside, which is what `unitsAvailableForReward` computes.
 */
import type { PromoLine, PromotionRow } from './types';
import type { Targeting } from './targeting';

export interface BxgyResult {
  /** Money to take off, in paise. */
  discountPaise: number;
  /** Line indexes the reward landed on. */
  rewardedIdx: number[];
  /** How many units were rewarded. */
  rewardedUnits: number;
}

/** One discountable unit, flattened so units can be sorted by price. */
interface Unit {
  lineIdx: number;
  unitPricePaise: number;
}

/**
 * Price the reward side of a BXGY promotion.
 *
 * Returns a zero result when the cart cannot earn a single batch, which the
 * engine treats as "not eligible" rather than "applied for nothing".
 */
export function priceBxgy(
  coupon: PromotionRow,
  lines: readonly PromoLine[],
  targeting: Targeting,
): BxgyResult {
  const cfg = coupon.bxgy;
  const empty: BxgyResult = { discountPaise: 0, rewardedIdx: [], rewardedUnits: 0 };
  if (!cfg || cfg.buyQty <= 0 || cfg.getQty <= 0) return empty;

  const batches = Math.floor(targeting.qualifyingQty / cfg.buyQty);
  if (batches <= 0) return empty;

  const cappedBatches =
    cfg.maxRepeats !== null && cfg.maxRepeats > 0 ? Math.min(batches, cfg.maxRepeats) : batches;

  /*
   * Units the reward may come from.
   *
   * When the qualifying and discountable sets overlap, the units already
   * "spent" earning the batches are withheld — a cart of exactly 3 on a
   * buy-3-get-1 offer has nothing left to give away.
   */
  const units: Unit[] = [];
  for (const i of targeting.discountableIdx) {
    const line = lines[i]!;
    const withheld = targeting.qualifyingIdx.includes(i)
      ? Math.min(line.qty, cappedBatches * cfg.buyQty)
      : 0;
    for (let n = 0; n < line.qty - withheld; n += 1) {
      units.push({ lineIdx: i, unitPricePaise: line.unitPricePaise });
    }
  }
  if (units.length === 0) return empty;

  // Cheapest first — see the header.
  units.sort((a, b) => a.unitPricePaise - b.unitPricePaise || a.lineIdx - b.lineIdx);

  const wanted = cappedBatches * cfg.getQty;
  const rewarded = units.slice(0, Math.min(wanted, units.length));
  if (rewarded.length === 0) return empty;

  const pct = Math.max(0, Math.min(100, cfg.rewardPercentOff));
  const discountPaise = rewarded.reduce(
    (sum, u) => sum + Math.round((u.unitPricePaise * pct) / 100),
    0,
  );

  return {
    discountPaise,
    rewardedIdx: [...new Set(rewarded.map((u) => u.lineIdx))],
    rewardedUnits: rewarded.length,
  };
}
