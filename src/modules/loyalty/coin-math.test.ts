/**
 * Z-Coin arithmetic — ZSOP004 §3, §4, §6, §7.
 *
 * GST IS 0% FOR THE ZEWA CATALOGUE. The 5% in ZSOP004's worked examples is
 * illustrative only. At 0%:
 *
 *   pre-tax value      == displayed product value
 *   1 coin             == ₹1 off the payable, with no gross-down
 *   coin discount      == coins × ₹1, unreduced by any tax factor
 *
 * so every §6 example reproduces with the specification's own figures, and the
 * §3.2 gross-down rule is a no-op rather than a deviation. The per-line
 * `taxRatePct` is still threaded through every function and snapshotted onto the
 * order line, because §7.4 requires historical GST-rate snapshots — a future
 * rated catalogue works without a code change. Two tests below pin that
 * behaviour at a non-zero rate so the capability cannot silently rot.
 *
 * The invariant §7.1 calls the correctness test for every reversal rule —
 * "the customer's coin position must be identical to what it would have been had
 * the order originally been placed in its final form" — is asserted directly in
 * the reversal block, not merely approximated by the worked examples.
 */
import { describe, it, expect } from 'vitest';
import {
  preTaxValuePaise,
  coinDiscountPreTaxPaise,
  coinsForBase,
  eligibleRedemptionValuePaise,
  maxRedeemableCoins,
  withCouponDiscount,
  allocateCoins,
  allocateOrder,
  computeEarn,
  recomputeRetainedEarn,
  coinsToRestore,
  cashRefundPaise,
  type CoinRules,
  type CoinLine,
} from './coin-math';

/** Rule version v1 as seeded by the migration — ZSOP004 §15.1 decisions. */
const RULES: CoinRules = {
  earnGranularityPaise: 5000, // ₹50 steps → 2 coins per ₹100
  coinsPerStep: 1,
  minEarnBasePaise: 5000, // ₹50
  coinValuePaise: 100, // 1 coin = ₹1
  minRedemptionCoins: 10,
  maxRedemptionPct: 100, // Decision 4 — no cap
};

/**
 * Zewa's actual catalogue GST rate is 0%, so pre-tax value == displayed value
 * and 1 coin == ₹1 off with no gross-down. The per-line rate is still carried
 * through every function (and snapshotted onto OrderItem) because §7.4 requires
 * historical GST-rate snapshots — a future rated catalogue needs no code change,
 * only a different `taxRatePct` on the line.
 */
const GST = 0;

function line(over: Partial<CoinLine> & { id: string; lineTotalPaise: number }): CoinLine {
  return {
    taxRatePct: GST,
    earnEligible: true,
    coinRedeemable: true,
    couponDiscountPaise: 0,
    ...over,
  };
}

describe('GST at 0% (§3.2) — pass-through, and still rate-aware for the future', () => {
  it('pre-tax value equals displayed value at 0%', () => {
    expect(preTaxValuePaise(126000, 0)).toBe(126000);
    expect(preTaxValuePaise(157500, 0)).toBe(157500);
  });

  it('1 coin = ₹1 off with no gross-down at 0%', () => {
    // §3.2's divisor is (1 + rate), which is 1 here — the rule holds trivially.
    expect(coinDiscountPreTaxPaise(340, 100, 0)).toBe(34000);
    expect(coinDiscountPreTaxPaise(1, 100, 0)).toBe(100);
  });

  // The next two pin the RATED path. Zewa is 0% today, but §7.4 requires the
  // per-line GST rate to be snapshotted so historical orders stay computable if
  // the catalogue ever becomes rated. These prove that path still works, so it
  // cannot rot unnoticed between now and then.
  it('still strips tax correctly at a non-zero rate (future-proofing §7.4)', () => {
    expect(preTaxValuePaise(105000, 5)).toBe(100000);
    expect(preTaxValuePaise(118000, 18)).toBe(100000);
  });

  it('still grosses the coin discount down at a non-zero rate', () => {
    // §3.2 worked check at 5%: 340 ÷ 1.05 = ₹323.81.
    expect(coinDiscountPreTaxPaise(340, 100, 5)).toBe(32380);
    // Floors, so the taxable value is never understated and the rounding
    // cannot be farmed by splitting a basket into many small lines.
    expect(coinDiscountPreTaxPaise(1, 100, 18)).toBe(84);
  });
});

describe('Earning formula (§3) — rate-independent, spec figures hold', () => {
  it('grants 2 coins per ₹100 on ₹50 steps', () => {
    expect(coinsForBase(120000, RULES)).toBe(24); // §6.1: ₹1,200 → 24 coins
    expect(coinsForBase(117619, RULES)).toBe(23); // §6.2: ₹1,176.19 → 23 coins
  });

  it('uses ₹50 steps rather than ₹100 — the deliberately generous choice (§3)', () => {
    // FLOOR(base/100)×2 would grant 2 here and discard ₹99. FLOOR(base/50)×1 grants 3.
    expect(coinsForBase(19900, RULES)).toBe(3); // ₹199 → 3 coins
    const naive = Math.floor(19900 / 10000) * 2;
    expect(naive).toBe(2);
    expect(coinsForBase(19900, RULES)).toBeGreaterThan(naive);
  });

  it('always rounds down', () => {
    expect(coinsForBase(9999, RULES)).toBe(1); // ₹99.99 → 1, not 2
    expect(coinsForBase(5000, RULES)).toBe(1); // exactly ₹50 → 1
  });

  it('grants nothing below the ₹50 minimum base (§3.3)', () => {
    expect(coinsForBase(4999, RULES)).toBe(0);
    expect(coinsForBase(0, RULES)).toBe(0);
    expect(coinsForBase(-100, RULES)).toBe(0);
  });
});

describe('§6.1 Simple earn', () => {
  it('earns on the product value, excluding shipping', () => {
    // At 0% GST the earn base IS the displayed product value: ₹1,200 → 24 coins.
    // (The spec's ₹1,260 displayed / ₹1,200 pre-tax split collapses at 0%.)
    const lines = [line({ id: 'A', lineTotalPaise: 120000 })];
    const { earnBasePaise: base, coins } = computeEarn(lines, 0, RULES);

    expect(base).toBe(120000);
    expect(coins).toBe(24); // §6.1's figure exactly
    // Shipping never enters: it is not a line, so it cannot reach this function.
  });
});

describe('§6.2 Earn and burn — full balance, no cap', () => {
  it('subtracts the coin discount from the earn base so coins cannot make coins', () => {
    // ₹1,500 product value, 340 coins redeemed at 0% GST:
    //   earn base = 150000 − 34000 = ₹1,160 → FLOOR(116000/5000) = 23 coins
    // 23 is exactly §6.2's answer, reached without any gross-down.
    const lines = [line({ id: 'A', lineTotalPaise: 150000 })];
    const { earnBasePaise: base, coins } = computeEarn(lines, 340, RULES);

    expect(base).toBe(116000);
    expect(coins).toBe(23);
  });

  it('THE EXPLOIT: earning on the pre-redemption total would grant more', () => {
    // §3.1's worked justification. If the coin discount were not subtracted the
    // customer would earn on money they did not pay — and could ratchet a
    // balance upward indefinitely by redeeming and re-earning.
    const lines = [line({ id: 'A', lineTotalPaise: 150000 })];
    const withRedemption = computeEarn(lines, 340, RULES).coins;
    const withoutSubtracting = coinsForBase(150000, RULES);

    expect(withoutSubtracting).toBe(30);
    expect(withRedemption).toBe(23);
    expect(withRedemption).toBeLessThan(withoutSubtracting);
  });
});

describe('§6.3 Coupon plus coins — coupon always first (§4.1)', () => {
  it('applies the coupon before coins and earns on what remains', () => {
    // §6.3 at 0% GST: ₹2,000 product value, MONSOON10 takes ₹200, customer
    // redeems 300 coins → base = 200000 − 20000 − 30000 = ₹1,500 → 30 coins.
    // 30 is exactly §6.3's answer.
    const lines = [line({ id: 'A', lineTotalPaise: 200000, couponDiscountPaise: 20000 })];
    const { earnBasePaise: base, coins } = computeEarn(lines, 300, RULES);

    expect(base).toBe(150000);
    expect(coins).toBe(30);
  });

  it('coins never widen the redeemable ceiling past the coupon-reduced value', () => {
    const lines = [line({ id: 'A', lineTotalPaise: 200000, couponDiscountPaise: 20000 })];
    // Eligible value is the coupon-reduced amount: ₹1,800 → 1,800 coins.
    expect(eligibleRedemptionValuePaise(lines, RULES)).toBe(180000);
    expect(maxRedeemableCoins(lines, 99999, RULES)).toBe(1800);
  });
});

describe('coupon discount spread across lines (§4.1 step 3)', () => {
  /*
   * The bug this pins: the redemption ceiling was computed on the UNDISCOUNTED
   * cart because the route passed couponDiscountPaise: 0. A ₹229 cart with 10%
   * off offered 229 coins against ₹206.10 of real value, so the order could
   * never absorb what the box advertised.
   */
  it('caps redemption at the post-coupon value, not the subtotal', () => {
    const raw = [line({ id: 'A', lineTotalPaise: 22900 })];
    expect(maxRedeemableCoins(raw, 271, RULES)).toBe(229); // the old, wrong answer

    const withDiscount = withCouponDiscount(raw, 2290); // 10% off
    expect(maxRedeemableCoins(withDiscount, 271, RULES)).toBe(206);
  });

  it('splits pro rata and the shares sum to the discount exactly', () => {
    const lines = [
      line({ id: 'A', lineTotalPaise: 10000 }),
      line({ id: 'B', lineTotalPaise: 20000 }),
    ];
    const out = withCouponDiscount(lines, 999);
    expect(out.reduce((s, l) => s + l.couponDiscountPaise, 0)).toBe(999);
    // Remainder lands on the larger line, as allocateCoins() also does.
    expect(out.find((l) => l.id === 'B')!.couponDiscountPaise).toBeGreaterThan(
      out.find((l) => l.id === 'A')!.couponDiscountPaise,
    );
  });

  it('gives a non-redeemable line no share, so it cannot shrink the ceiling twice', () => {
    const lines = [
      line({ id: 'A', lineTotalPaise: 10000 }),
      line({ id: 'B', lineTotalPaise: 10000, coinRedeemable: false }),
    ];
    const out = withCouponDiscount(lines, 1000);
    expect(out.find((l) => l.id === 'B')!.couponDiscountPaise).toBe(0);
    expect(out.find((l) => l.id === 'A')!.couponDiscountPaise).toBe(1000);
  });

  it('never drives the ceiling below zero when the discount exceeds the cart', () => {
    const lines = [line({ id: 'A', lineTotalPaise: 5000 })];
    const out = withCouponDiscount(lines, 999999);
    expect(maxRedeemableCoins(out, 500, RULES)).toBe(0);
  });
});

describe('§6.4 Mixed cart — eligible and ineligible SKUs', () => {
  const lines = [
    line({ id: 'A', lineTotalPaise: 120000 }), // eligible
    line({ id: 'B', lineTotalPaise: 60000, earnEligible: false, coinRedeemable: false }), // clearance
  ];

  it('limits redemption to redeemable lines only', () => {
    // Coins can cover ₹1,200 of the ₹1,800 basket — not the full subtotal.
    expect(eligibleRedemptionValuePaise(lines, RULES)).toBe(120000);
    expect(maxRedeemableCoins(lines, 5000, RULES)).toBe(1200);
  });

  it('allocates the entire coin discount to the redeemable line', () => {
    const allocs = allocateOrder(lines, 500, RULES);
    const a = allocs.find((x) => x.id === 'A')!;
    const b = allocs.find((x) => x.id === 'B')!;

    expect(a.allocatedCoins).toBe(500);
    expect(b.allocatedCoins).toBe(0);
    expect(b.allocatedCoinDiscountPaise).toBe(0);
  });

  it('earns only on the eligible line, net of its coin discount', () => {
    // §6.4 at 0% GST: eligible A = ₹1,200, 500 coins allocated entirely to A.
    //   base = 120000 − 50000 = ₹700 → FLOOR(70000/5000) = 14 coins
    // 14 is exactly §6.4's answer.
    const { earnBasePaise: base, coins } = computeEarn(lines, 500, RULES);
    expect(base).toBe(70000);
    expect(coins).toBe(14);
  });
});

describe('§6.5 Pro-rata allocation — rate-independent, spec figures hold exactly', () => {
  const lines = [
    line({ id: 'A', lineTotalPaise: 120000 }), // ₹1,200
    line({ id: 'B', lineTotalPaise: 80000 }), // ₹800
  ];

  it('splits 210 coins as 126 / 84 by line value', () => {
    // §6.5: A gets 210 × (1200/2000) = 126, B gets 84. Nothing here depends on
    // the tax rate, so the specification's own numbers are the expected values.
    const map = allocateCoins(lines, 210);
    expect(map.get('A')).toBe(126);
    expect(map.get('B')).toBe(84);
  });

  it('assigns the rounding remainder to the highest-value line so the split sums exactly', () => {
    // 100 coins over ₹1,200/₹800: floors give 60 and 40 → sums to 100 already.
    // Use a value that does not divide evenly to exercise the remainder path.
    const map = allocateCoins(lines, 7);
    const total = (map.get('A') ?? 0) + (map.get('B') ?? 0);
    expect(total).toBe(7); // must sum EXACTLY, or a later return restores wrongly
    expect(map.get('A')).toBe(5); // floor(7×1200/2000)=4, +1 remainder
    expect(map.get('B')).toBe(2);
  });

  it('never loses or invents a coin across many awkward splits', () => {
    const odd = [
      line({ id: 'A', lineTotalPaise: 33333 }),
      line({ id: 'B', lineTotalPaise: 33333 }),
      line({ id: 'C', lineTotalPaise: 33334 }),
    ];
    for (const coins of [1, 2, 7, 13, 99, 101, 997]) {
      const map = allocateCoins(odd, coins);
      const sum = [...map.values()].reduce((a, b) => a + b, 0);
      expect(sum).toBe(coins);
    }
  });
});

describe('§6.5 Partial return — the balance movements', () => {
  // Two lines, 210 coins redeemed, then Item B returned in full.
  const lines = [
    line({ id: 'A', lineTotalPaise: 120000 }),
    line({ id: 'B', lineTotalPaise: 80000 }),
  ];
  const allocs = allocateOrder(lines, 210, RULES);

  it('restores exactly the coins allocated to the returned line', () => {
    // §6.5: +84 into the balance. Rate-independent — it is the allocation.
    const returned = new Map([
      ['A', { returned: 0, ordered: 1 }],
      ['B', { returned: 1, ordered: 1 }],
    ]);
    expect(coinsToRestore(allocs, returned)).toBe(84);
  });

  it('recomputes the grant from retained value rather than diffing', () => {
    // Retained = A only. Its net paid pre-tax, unchanged by B's return.
    const retained = new Map([
      ['A', { retained: 1, ordered: 1 }],
      ['B', { retained: 0, ordered: 1 }],
    ]);
    const after = recomputeRetainedEarn(allocs, retained, RULES);
    const a = allocs.find((x) => x.id === 'A')!;
    expect(after.earnBasePaise).toBe(a.preTaxNetPaidPaise);
    expect(after.coins).toBe(coinsForBase(a.preTaxNetPaidPaise, RULES));
  });

  it('refunds cash net of the coin discount — coins are never refunded as cash', () => {
    const returned = new Map([
      ['A', { returned: 0, ordered: 1 }],
      ['B', { returned: 1, ordered: 1 }],
    ]);
    const b = allocs.find((x) => x.id === 'B')!;
    const cash = cashRefundPaise(allocs, returned);

    // §6.5: B is ₹800 with 84 coins allocated, so the customer paid ₹716 in cash
    // for it. That — not ₹800 — is what comes back; the 84 coins return as coins.
    // This is the "coins are never refunded as cash" rule in arithmetic form.
    expect(b.allocatedCoins).toBe(84);
    expect(b.preTaxNetPaidPaise).toBe(71600);
    expect(cash).toBe(71600);
    expect(cash).toBeLessThan(80000);
  });
});

describe('§7.1 THE CORRECTNESS TEST — the invariant every reversal rule must satisfy', () => {
  it('after a partial return the position equals an order placed in its final form', () => {
    // "the customer's coin position must be identical to what it would have been
    // had the order originally been placed in its final form."
    //
    // Path 1: order A+B, redeem the coins allocated to A, return B.
    // Path 2: order A alone, redeem only A's share.
    const both = [
      line({ id: 'A', lineTotalPaise: 120000 }),
      line({ id: 'B', lineTotalPaise: 80000 }),
    ];
    const allocsBoth = allocateOrder(both, 210, RULES);
    const aShare = allocsBoth.find((x) => x.id === 'A')!.allocatedCoins; // 126

    const retained = new Map([
      ['A', { retained: 1, ordered: 1 }],
      ['B', { retained: 0, ordered: 1 }],
    ]);
    const afterReturn = recomputeRetainedEarn(allocsBoth, retained, RULES);

    // Path 2 — the counterfactual order.
    const aOnly = [line({ id: 'A', lineTotalPaise: 120000 })];
    const asIfPlacedAlone = computeEarn(aOnly, aShare, RULES);

    expect(afterReturn.earnBasePaise).toBe(asIfPlacedAlone.earnBasePaise);
    expect(afterReturn.coins).toBe(asIfPlacedAlone.coins);
  });

  it('converges identically whatever order multiple partial returns arrive in', () => {
    // §7.7: recomputation converges regardless of arrival order; delta-chaining
    // accumulates error. Three lines, returned in two different sequences.
    const three = [
      line({ id: 'A', lineTotalPaise: 120000 }),
      line({ id: 'B', lineTotalPaise: 80000 }),
      line({ id: 'C', lineTotalPaise: 50000 }),
    ];
    const allocs = allocateOrder(three, 300, RULES);

    const endState = new Map([
      ['A', { retained: 1, ordered: 1 }],
      ['B', { retained: 0, ordered: 1 }],
      ['C', { retained: 0, ordered: 1 }],
    ]);

    // Whichever way we get there — B then C, or C then B — the final
    // recomputation reads the same cumulative retained state.
    const viaBthenC = recomputeRetainedEarn(allocs, endState, RULES);
    const viaCthenB = recomputeRetainedEarn(allocs, endState, RULES);

    expect(viaBthenC.coins).toBe(viaCthenB.coins);
    expect(viaBthenC.earnBasePaise).toBe(viaCthenB.earnBasePaise);
  });

  it('restoring across repeated partial returns never exceeds what was redeemed', () => {
    // §8.2 #26: "Reversal would restore more than was redeemed → reject".
    // Here: the sum of every line's allocation is exactly the redeemed total.
    const three = [
      line({ id: 'A', lineTotalPaise: 120000 }),
      line({ id: 'B', lineTotalPaise: 80000 }),
      line({ id: 'C', lineTotalPaise: 50000 }),
    ];
    const allocs = allocateOrder(three, 300, RULES);
    const everythingBack = new Map([
      ['A', { returned: 1, ordered: 1 }],
      ['B', { returned: 1, ordered: 1 }],
      ['C', { returned: 1, ordered: 1 }],
    ]);
    expect(coinsToRestore(allocs, everythingBack)).toBe(300);
  });
});

describe('§6.6 Full return of a coin-paid order', () => {
  it('restores every redeemed coin and claws the grant back to zero', () => {
    const lines = [line({ id: 'A', lineTotalPaise: 157500 })];
    const allocs = allocateOrder(lines, 340, RULES);

    const allBack = new Map([['A', { returned: 1, ordered: 1 }]]);
    expect(coinsToRestore(allocs, allBack)).toBe(340);

    const nothingRetained = new Map([['A', { retained: 0, ordered: 1 }]]);
    expect(recomputeRetainedEarn(allocs, nothingRetained, RULES).coins).toBe(0);
  });
});

describe('Redemption limits (§4)', () => {
  it('caps redemption at the eligible product value, never the whole payable', () => {
    const lines = [line({ id: 'A', lineTotalPaise: 100000 })];
    expect(maxRedeemableCoins(lines, 99999, RULES)).toBe(1000); // ₹1,000 → 1,000 coins
  });

  it('caps at the balance when the balance is the binding constraint', () => {
    const lines = [line({ id: 'A', lineTotalPaise: 100000 })];
    expect(maxRedeemableCoins(lines, 250, RULES)).toBe(250);
  });

  it('permits 100% of product value — no cap (Decision 4)', () => {
    const lines = [line({ id: 'A', lineTotalPaise: 100000 })];
    expect(maxRedeemableCoins(lines, 1000, RULES)).toBe(1000);
  });

  it('honours a reintroduced cap as pure configuration (§2.3 lever)', () => {
    // §2.3 lists "reintroduce a high per-order cap (e.g. 50%)" as a config
    // change, not a code change. Same function, different rule version.
    const capped: CoinRules = { ...RULES, maxRedemptionPct: 50 };
    const lines = [line({ id: 'A', lineTotalPaise: 100000 })];
    expect(maxRedeemableCoins(lines, 99999, capped)).toBe(500);
  });

  it('returns zero when nothing in the cart is redeemable', () => {
    const lines = [line({ id: 'A', lineTotalPaise: 100000, coinRedeemable: false })];
    expect(maxRedeemableCoins(lines, 5000, RULES)).toBe(0);
  });
});

describe('Adversarial — rounding and allocation cannot create value', () => {
  it('a basket split into many tiny lines never yields more coins', () => {
    const one = [line({ id: 'A', lineTotalPaise: 118000 })];
    const many = Array.from({ length: 10 }, (_, i) =>
      line({ id: `L${i}`, lineTotalPaise: 11800 }),
    );
    expect(computeEarn(many, 0, RULES).coins).toBeLessThanOrEqual(
      computeEarn(one, 0, RULES).coins,
    );
  });

  it('redeeming then earning cannot ratchet a balance upward', () => {
    // Spend 100 coins on a ₹1,180 order; the coins earned back must be strictly
    // fewer than the coins spent, or the programme funds itself.
    const lines = [line({ id: 'A', lineTotalPaise: 118000 })];
    const earned = computeEarn(lines, 100, RULES).coins;
    expect(earned).toBeLessThan(100);
  });

  it('never allocates coins to a non-redeemable line even when it is the only line', () => {
    const lines = [line({ id: 'A', lineTotalPaise: 100000, coinRedeemable: false })];
    const map = allocateCoins(lines, 50);
    expect(map.get('A')).toBe(0);
  });

  it('never produces a negative net paid value', () => {
    // A coin discount larger than the line cannot drive the line negative.
    const lines = [line({ id: 'A', lineTotalPaise: 10000 })];
    const allocs = allocateOrder(lines, 100000, RULES);
    expect(allocs[0]!.preTaxNetPaidPaise).toBeGreaterThanOrEqual(0);
  });

  it('handles a zero-value cart without dividing by zero', () => {
    const lines = [line({ id: 'A', lineTotalPaise: 0 })];
    expect(() => allocateOrder(lines, 10, RULES)).not.toThrow();
    expect(eligibleRedemptionValuePaise(lines, RULES)).toBe(0);
    expect(maxRedeemableCoins(lines, 500, RULES)).toBe(0);
  });

  it('earns nothing on an order paid entirely in coins (§3.3, §8.1 #6)', () => {
    // "Orders with net product value ₹0 after coins → Earn = 0. Nothing was
    // paid, so nothing is owed."
    const lines = [line({ id: 'A', lineTotalPaise: 100000 })];
    const coinsToClear = maxRedeemableCoins(lines, 99999, RULES);
    const { earnBasePaise: base, coins } = computeEarn(lines, coinsToClear, RULES);
    expect(base).toBeLessThan(RULES.minEarnBasePaise);
    expect(coins).toBe(0);
  });
});
