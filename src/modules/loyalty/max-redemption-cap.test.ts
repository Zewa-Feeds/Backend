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
  gstRateBp: 0,
});

describe('maxRedemptionPct = 90', () => {
  it('caps redemption at 90% of the eligible value', () => {
    // ₹1000 eligible -> ₹900 may be paid in coins.
    expect(eligibleRedemptionValuePaise([line(100000)], rules(90))).toBe(90000);
  });

  it('leaves the remaining 10% payable, less the gateway floor', () => {
    /*
     * BOTH constraints stack, in this order: the 90% cap narrows the eligible
     * value, then the ₹1 gateway reserve comes off what is left. ₹1000 -> ₹900
     * -> ₹899 redeemable, so ₹101 of the order stays payable in cash.
     */
    const cap = maxRedeemableCoins([line(100000)], 100000, rules(90));
    expect(cap).toBe(899);
  });

  it('subtracts coupon discounts before applying the cap', () => {
    // §4.1: coupon first, then coins. ₹1000 - ₹200 = ₹800 net; 90% = ₹720.
    expect(eligibleRedemptionValuePaise([line(100000, 20000)], rules(90))).toBe(72000);
  });

  it('still reserves the ₹1 gateway floor when that binds harder', () => {
    /*
     * On a small order the 90% cap can leave less than the gateway minimum, so
     * BOTH constraints have to hold. ₹2 eligible -> 90% = ₹1.80 -> less the ₹1
     * floor = 80 paise redeemable.
     */
    const cap = maxRedeemableCoins([line(200)], 1000, rules(90));
    const ninety = Math.floor((200 * 90) / 100);
    expect(cap).toBe(Math.floor((ninety - MIN_GATEWAY_PAYABLE_PAISE) / 100));
    expect(cap).toBeLessThanOrEqual(1);
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
    expect(uncapped).toBe(999); // ₹1000 less the ₹1 floor
    expect(capped).toBe(899);   // 90% of ₹1000, less the ₹1 floor
    expect(capped).toBeLessThan(uncapped);
  });
});
