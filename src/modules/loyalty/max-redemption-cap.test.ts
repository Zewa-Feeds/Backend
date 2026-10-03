/**
 * The 90% cap on Zewa Coin redemption (§2.3).
 *
 * `maxRedemptionPct` was built as a lever precisely so this could be a CONFIG
 * change rather than a code change — see the note in `eligibleRedemptionValuePaise`.
 * These tests pin the arithmetic so setting it to 90 does what it says, and so
 * the two constraints that already existed are not quietly broken by it.
 *
 * The cap is applied to the ELIGIBLE PRODUCT VALUE — line totals, less coupon
 * discounts, redeemable SKUs only. Shipping and fees are never coin-payable
 * (§4), so they sit outside it. "90% of net order value" therefore means 90% of
 * what coins are allowed to touch, which is the figure the customer sees as the
 * redeemable subtotal.
 */
import { describe, expect, it } from 'vitest';
import { maxRedeemableCoins, eligibleRedemptionValuePaise, MIN_GATEWAY_PAYABLE_PAISE } from './coin-math';

/** ₹1 = 100 paise = 1 coin, which is the live configuration. */
const rules = (maxRedemptionPct: number) => ({
  earnGranularityPaise: 5000,
  coinsPerStep: 1,
  minEarnBasePaise: 5000,
  coinValuePaise: 100,
  minRedemptionCoins: 10,
  maxRedemptionPct,
});

const line = (lineTotalPaise: number, couponDiscountPaise = 0) => ({
  id: 'l1',
  lineTotalPaise,
  couponDiscountPaise,
  coinRedeemable: true,
  earnEligible: true,
  taxRatePct: 0,
});

describe('maxRedemptionPct = 90', () => {
  it('caps redemption at 90% of the eligible value', () => {
    // ₹1000 eligible -> ₹900 may be paid in coins.
    expect(eligibleRedemptionValuePaise([line(100000)], rules(90))).toBe(90000);
  });

  it('leaves exactly the remaining 10% payable', () => {
    /*
     * ₹1000 eligible -> ₹900 in coins, ₹100 payable. The gateway floor does NOT
     * come off on top: it is a lower bound on what stays payable, and the cap
     * already leaves ₹100, far above the ₹1 minimum. Stacking them cost the
     * customer a coin (899) for a constraint that was not binding.
     */
    expect(maxRedeemableCoins([line(100000)], 100000, rules(90))).toBe(900);
  });

  it('gives the whole 90% on an everyday cart', () => {
    // The reported case: ₹100 of product -> 90 coins, ₹10 out of pocket.
    expect(maxRedeemableCoins([line(10000)], 100000, rules(90))).toBe(90);
  });

  it('subtracts coupon discounts before applying the cap', () => {
    // §4.1: coupon first, then coins. ₹1000 - ₹200 = ₹800 net; 90% = ₹720.
    expect(eligibleRedemptionValuePaise([line(100000, 20000)], rules(90))).toBe(72000);
  });

  it('still reserves the gateway floor on a cart too small for 10% to cover it', () => {
    /*
     * Below about ₹10 the percentage cap cannot keep the order payable on its
     * own: 10% of ₹2 is 20 paise and Razorpay refuses anything under ₹1. The
     * floor binds here and is what stops an unpayable order being priced.
     */
    expect(maxRedeemableCoins([line(200)], 1000, rules(90))).toBe(1);
  });

  it('leaves at least the gateway minimum payable at every cart size', () => {
    /*
     * The property that actually matters, swept rather than sampled: whatever
     * the two constraints do between them, a cart that can redeem at all must
     * still be chargeable.
     */
    for (let paise = 100; paise <= 200000; paise += 97) {
      const coins = maxRedeemableCoins([line(paise)], 10_000_000, rules(90));
      if (coins === 0) continue;
      expect(paise - coins * 100).toBeGreaterThanOrEqual(MIN_GATEWAY_PAYABLE_PAISE);
    }
  });

  it('never exceeds the customer balance', () => {
    // 90% of ₹1000 is ₹900, but they only hold 50 coins.
    expect(maxRedeemableCoins([line(100000)], 50, rules(90))).toBe(50);
  });

  it('ignores lines that are not coin-redeemable', () => {
    const lines = [line(100000), { ...line(50000), id: 'l2', coinRedeemable: false }];
    // Only the ₹1000 line counts; the ₹500 one does not widen the ceiling.
    expect(eligibleRedemptionValuePaise(lines, rules(90))).toBe(90000);
  });

  it('is a real change from the uncapped default', () => {
    const uncapped = maxRedeemableCoins([line(100000)], 100000, rules(100));
    const capped = maxRedeemableCoins([line(100000)], 100000, rules(90));
    expect(uncapped).toBe(999); // uncapped: ₹1000 less the ₹1 the gateway needs
    expect(capped).toBe(900);   // capped: 90% of ₹1000, floor not binding
    expect(capped).toBeLessThan(uncapped);
  });
});
