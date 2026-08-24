/**
 * Which cart re-pricing requests spend coupon-attempt budget.
 *
 * `POST /cart/validate` accepts a coupon code and reports per-code rejection
 * reasons, so it answers the same question the coupon limiter exists to protect
 * — but it sat behind the 200/min public ceiling, ten times looser than the
 * endpoint that was actually guarded.
 *
 * It cannot simply wear the 20/min coupon budget: the storefront re-prices on
 * every cart mutation, and throttling a shopper who is only changing quantities
 * would cost a sale to protect nothing. The limiter therefore SKIPS requests
 * that carry no coupon code, and this predicate is what decides that.
 *
 * The limiter itself is deliberately inert under test (`base` sets
 * `skip: () => env.isTest`, so suites are not flaky), which is exactly why the
 * decision function is exported and tested directly.
 */
import { describe, expect, it } from 'vitest';
import { carriesCouponCode } from './rateLimit';

describe('carriesCouponCode', () => {
  it('counts a request carrying a coupon code', () => {
    expect(carriesCouponCode({ body: { lines: [], couponCode: 'MONSOON10' } })).toBe(true);
  });

  it('skips ordinary re-pricing with no coupon field', () => {
    expect(carriesCouponCode({ body: { lines: [{ sku: 'F3-45G', qty: 2 }] } })).toBe(false);
  });

  it('skips a cleared coupon sent as null', () => {
    // The storefront sends null when the shopper removes a coupon.
    expect(carriesCouponCode({ body: { couponCode: null } })).toBe(false);
  });

  it('skips an empty or whitespace-only code', () => {
    expect(carriesCouponCode({ body: { couponCode: '' } })).toBe(false);
    expect(carriesCouponCode({ body: { couponCode: '   ' } })).toBe(false);
  });

  it('skips a non-string code rather than throwing', () => {
    // Body is unvalidated at limiter time — the limiter runs before zod.
    expect(carriesCouponCode({ body: { couponCode: 12345 } })).toBe(false);
    expect(carriesCouponCode({ body: { couponCode: { code: 'X' } } })).toBe(false);
  });

  it('tolerates a missing or non-object body', () => {
    expect(carriesCouponCode({})).toBe(false);
    expect(carriesCouponCode({ body: undefined })).toBe(false);
  });
});
