/**
 * Z-Coin arithmetic — ZSOP004 §3, §4.1, §7.4.
 *
 * Pure functions, no database, no clock. Everything the earning and redemption
 * engines compute lands here so it can be unit-tested against the specification's
 * worked examples without a fixture in sight.
 *
 * THREE RULES HOLD THROUGHOUT
 *
 *   1. Integers only. Coins are whole; money is paise. There is no float in this
 *      file and there must never be one — §9.2 forbids it in the loyalty path,
 *      and the drift is untraceable in aggregate.
 *
 *   2. Round DOWN when granting, round UP when charging. Every rounding decision
 *      below resolves against the house on issuance and toward the customer on
 *      what they pay, so no rounding rule can be farmed for value.
 *
 *   3. Nothing here reads configuration. Rules arrive as an argument — the caller
 *      passes the order's FROZEN rule version, never today's. That is what makes
 *      §8.4 #35 ("config is never retroactive") structurally true.
 *
 * ---------------------------------------------------------------------------
 * THE GST MAPPING — READ THIS BEFORE CHANGING ANY NUMBER
 * ---------------------------------------------------------------------------
 *
 * ZSOP004's worked examples assume a tax-EXCLUSIVE catalogue at 5% GST: §6.1
 * lists "₹1,200 pre-tax, ₹1,260 displayed". Zewa's catalogue is the other way
 * round and at a different rate — `gstInclusive: true` at 18% (settings, seeded
 * in prisma/seed.ts) — so a listed ₹1,260 already CONTAINS its tax.
 *
 * The specification's RULES are preserved exactly; only the arithmetic that maps
 * them onto an inclusive catalogue differs, exactly as instructed. Concretely:
 *
 *   §3.1  "earn base = pre-tax value of eligible product lines"
 *         → inclusive line total MINUS the tax already inside it, via the
 *           existing computeLineTax(). We do NOT divide by 1.05; we reverse the
 *           real rate on the real line, which is what tax.ts already does for
 *           the invoice.
 *
 *   §3.2  "the coin discount is shown as a pre-tax discount of
 *          coins × ₹1 ÷ (1 + GST rate), so the tax-inclusive total falls by
 *          exactly coins × ₹1"
 *         → identical intent, but the divisor is the LINE's own rate, not a
 *           global 1.05. The customer-facing promise — 1 coin = ₹1 off what you
 *           pay — is what the rule protects, and it holds unchanged.
 *
 *   §6.x  The worked numbers are therefore NOT reproducible verbatim. They are
 *         recomputed for an inclusive 18% catalogue in coin-math.test.ts, with
 *         each spec example shown beside its Zewa equivalent. The business rule
 *         is preserved; only the arithmetic is remapped.
 *
 * Existing production tax behaviour is untouched. This module calls
 * computeLineTax() rather than reimplementing it, so there is exactly one GST
 * implementation in the codebase and the invoice cannot drift from the earn base.
 */
import { computeLineTax, type TaxConfig } from '@/modules/orders/tax';

/**
 * The subset of a rule version this module needs.
 *
 * Structural rather than the Prisma type so the pure layer does not depend on
 * the client, and so tests can pass a literal.
 */
export interface CoinRules {
  earnGranularityPaise: number;
  coinsPerStep: number;
  minEarnBasePaise: number;
  coinValuePaise: number;
  minRedemptionCoins: number;
  maxRedemptionPct: number;
}

/** One order line, as the coin engine sees it. */
export interface CoinLine {
  /** Stable identifier — the OrderItem id, or the SKU pre-order. */
  id: string;
  /** What the customer is charged for this line, tax-INCLUSIVE, in paise. */
  lineTotalPaise: number;
  /** This line's own GST rate. Mixed-rate baskets are allocated per line (§3.2). */
  taxRatePct: number;
  /** Snapshot flags (§3.3, §6.4). */
  earnEligible: boolean;
  coinRedeemable: boolean;
  /** Coupon/promotion discount already attributed to this line, in paise. */
  couponDiscountPaise: number;
}

/** What one line ended up carrying, once coins were allocated. */
export interface LineAllocation {
  id: string;
  /** Coins attributed to this line, pro rata by redeemable value. */
  allocatedCoins: number;
  /** Pre-tax value of that coin discount, grossed down at this line's rate. */
  allocatedCoinDiscountPaise: number;
  allocatedCouponDiscountPaise: number;
  /** Pre-tax value actually paid for this line, after both discounts. */
  preTaxNetPaidPaise: number;
  earnEligible: boolean;
  coinRedeemable: boolean;
  taxRatePct: number;
}

/**
 * Strip the tax out of a tax-inclusive amount at a given rate.
 *
 * Delegates to the production tax function so there is one implementation.
 * `sellerState` is passed as the customer state so the CGST/SGST split is
 * irrelevant here — only `taxableValuePaise` is read, and the split never
 * changes the total.
 */
export function preTaxValuePaise(inclusivePaise: number, taxRatePct: number): number {
  const config: TaxConfig = { gstRatePct: taxRatePct, gstInclusive: true, sellerState: 'X' };
  return computeLineTax({ lineTotalPaise: inclusivePaise, taxRatePct }, config, 'X')
    .taxableValuePaise;
}

/**
 * Gross a coin discount DOWN to its pre-tax equivalent (§3.2).
 *
 *   pre-tax discount = coins × coinValue ÷ (1 + rate)
 *
 * so that the tax-inclusive total falls by exactly the coin face value and the
 * headline promise — 1 coin = ₹1 off what you pay — survives.
 *
 * Rounds DOWN, which is the conservative direction: a smaller pre-tax discount
 * means a slightly larger taxable value, so the exchequer is never short and the
 * rounding can never be farmed by splitting a basket into many small lines.
 */
export function coinDiscountPreTaxPaise(
  coins: number,
  coinValuePaise: number,
  taxRatePct: number,
): number {
  const inclusive = coins * coinValuePaise;
  // Integer arithmetic throughout: multiply before dividing, never a float ratio.
  return Math.floor((inclusive * 100) / (100 + taxRatePct));
}

/**
 * Coins earned on a pre-tax base (§3).
 *
 *   coins = FLOOR(base / granularity) × coinsPerStep
 *
 * Computing on ₹50 steps rather than ₹100 is deliberate and slightly generous:
 * FLOOR(base/100)×2 grants only even numbers and silently discards up to ₹99 of
 * spend per order. The copy still says "2 coins per ₹100" — that is the legible
 * framing of the same rule.
 *
 * Returns 0 below the minimum base, and never returns a negative.
 */
export function coinsForBase(preTaxBasePaise: number, rules: CoinRules): number {
  if (preTaxBasePaise < rules.minEarnBasePaise) return 0;
  if (preTaxBasePaise <= 0) return 0;
  return Math.floor(preTaxBasePaise / rules.earnGranularityPaise) * rules.coinsPerStep;
}

/**
 * Value on which coins may be spent (§4, §6.4).
 *
 * Redeemable lines only — a clearance SKU flagged non-redeemable does not widen
 * the ceiling. Tax-inclusive, because redemption is "₹1 off the payable amount"
 * and the payable amount includes tax.
 *
 * Coupon discounts are already subtracted, because §4.1 fixes the order of
 * operations: coupon first (step 3), then coins (step 5).
 */
export function eligibleRedemptionValuePaise(lines: CoinLine[], rules: CoinRules): number {
  const gross = lines
    .filter((l) => l.coinRedeemable)
    .reduce((sum, l) => sum + l.lineTotalPaise - l.couponDiscountPaise, 0);
  if (gross <= 0) return 0;
  // maxRedemptionPct is 100 by default (Decision 4 — no cap), but the lever
  // exists so §2.3 can reintroduce a cap as a config change, not a code change.
  return Math.floor((gross * rules.maxRedemptionPct) / 100);
}

/**
 * The most coins this cart can absorb (§4.1 step 5).
 *
 * MIN(balance, eligible value expressed in coins). Floors, so a part-coin is
 * never granted.
 */
export function maxRedeemableCoins(
  lines: CoinLine[],
  availableCoins: number,
  rules: CoinRules,
): number {
  const valuePaise = eligibleRedemptionValuePaise(lines, rules);
  const byValue = Math.floor(valuePaise / rules.coinValuePaise);
  return Math.max(0, Math.min(availableCoins, byValue));
}

/**
 * Split a coin redemption across lines, pro rata by redeemable value (§6.5, §7.4).
 *
 * Allocating COINS rather than rupees is what keeps mixed-rate baskets exact:
 * each line's pre-tax discount is then derived by grossing its own coin share
 * down at its own GST rate, so no rounding crosses a rate boundary.
 *
 * The remainder from integer division goes to the HIGHEST-VALUE line, so the
 * allocations sum to the redeemed total exactly — §6.5 specifies this, and it
 * matters: an allocation that does not sum makes a later partial return restore
 * the wrong number of coins.
 */
export function allocateCoins(lines: CoinLine[], coins: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) out.set(l.id, 0);
  if (coins <= 0) return out;

  const redeemable = lines.filter((l) => l.coinRedeemable);
  const totalPaise = redeemable.reduce(
    (s, l) => s + l.lineTotalPaise - l.couponDiscountPaise,
    0,
  );
  if (totalPaise <= 0) return out;

  let assigned = 0;
  for (const l of redeemable) {
    const lineValue = l.lineTotalPaise - l.couponDiscountPaise;
    // Integer floor of the exact share. Multiply first — never (coins * (v/t)).
    const share = Math.floor((coins * lineValue) / totalPaise);
    out.set(l.id, share);
    assigned += share;
  }

  // Hand the rounding remainder to the highest-value redeemable line (§6.5).
  const remainder = coins - assigned;
  if (remainder > 0 && redeemable.length > 0) {
    const biggest = redeemable.reduce((a, b) =>
      b.lineTotalPaise - b.couponDiscountPaise > a.lineTotalPaise - a.couponDiscountPaise ? b : a,
    );
    out.set(biggest.id, (out.get(biggest.id) ?? 0) + remainder);
  }

  return out;
}

/**
 * Full per-line allocation for an order (§4.1 step 11, §7.4).
 *
 * This is the structure persisted onto OrderItem at creation and never
 * recomputed. Everything a later reversal needs is derivable from it.
 */
export function allocateOrder(lines: CoinLine[], coins: number, rules: CoinRules): LineAllocation[] {
  const coinMap = allocateCoins(lines, coins);

  return lines.map((l) => {
    const allocatedCoins = coinMap.get(l.id) ?? 0;
    const coinDiscountPreTax = coinDiscountPreTaxPaise(
      allocatedCoins,
      rules.coinValuePaise,
      l.taxRatePct,
    );
    // Pre-tax value of what was charged, less the coupon's pre-tax share, less
    // the coin discount's pre-tax share.
    const linePreTax = preTaxValuePaise(l.lineTotalPaise, l.taxRatePct);
    const couponPreTax = preTaxValuePaise(l.couponDiscountPaise, l.taxRatePct);
    const netPaid = Math.max(0, linePreTax - couponPreTax - coinDiscountPreTax);

    return {
      id: l.id,
      allocatedCoins,
      allocatedCoinDiscountPaise: coinDiscountPreTax,
      allocatedCouponDiscountPaise: l.couponDiscountPaise,
      preTaxNetPaidPaise: netPaid,
      earnEligible: l.earnEligible,
      coinRedeemable: l.coinRedeemable,
      taxRatePct: l.taxRatePct,
    };
  });
}

/**
 * The earn base (§3.1).
 *
 *   pre-tax value of eligible product lines
 *     − coupon/promotional discount allocated to those lines
 *     − coin redemption discount allocated to those lines
 *     (shipping, COD fee, gift wrap, other charges excluded)
 *
 * SUBTRACTING THE COIN DISCOUNT IS THE POINT. If coins were earned on the
 * pre-redemption total, coins would generate coins: on a ₹1,000 pre-tax order
 * with 210 coins redeemed, earning on ₹1,000 grants coins on money the customer
 * did not pay. Earning on ₹800 grants strictly on value received. The second is
 * correct and closes an exploit available to anyone who notices it.
 *
 * Shipping and fees never appear here because they are not lines — they are
 * order-level charges the caller does not pass in.
 */
export function earnBasePaise(allocations: LineAllocation[]): number {
  return allocations
    .filter((a) => a.earnEligible)
    .reduce((sum, a) => sum + a.preTaxNetPaidPaise, 0);
}

/** Earn base and resulting coins in one step — the common case. */
export function computeEarn(
  lines: CoinLine[],
  coinsRedeemed: number,
  rules: CoinRules,
): { allocations: LineAllocation[]; earnBasePaise: number; coins: number } {
  const allocations = allocateOrder(lines, coinsRedeemed, rules);
  const base = earnBasePaise(allocations);
  return { allocations, earnBasePaise: base, coins: coinsForBase(base, rules) };
}

/**
 * Recompute an order's grant from the lines that are STILL RETAINED (§7.3 step 2).
 *
 * Deliberately not a delta. §7.7: "always recomputes from current order state
 * rather than as a delta on the previous event. Recomputation converges
 * regardless of arrival order; delta-chaining accumulates error."
 *
 * `retainedQty` carries the CUMULATIVE retained quantity per line, so multiple
 * sequential partial returns each recompute from scratch and land on the same
 * answer whatever order the events arrived in.
 */
export function recomputeRetainedEarn(
  allocations: LineAllocation[],
  retainedQty: Map<string, { retained: number; ordered: number }>,
  rules: CoinRules,
): { earnBasePaise: number; coins: number } {
  let base = 0;
  for (const a of allocations) {
    if (!a.earnEligible) continue;
    const q = retainedQty.get(a.id);
    if (!q || q.ordered <= 0 || q.retained <= 0) continue;
    // Pro-rate the line's net paid value by the fraction still retained.
    base += Math.floor((a.preTaxNetPaidPaise * q.retained) / q.ordered);
  }
  return { earnBasePaise: base, coins: coinsForBase(base, rules) };
}

/**
 * Coins to restore for a set of returned lines (§7.2).
 *
 * "How many of the coins they spent relate to the part being returned?" —
 * computed independently of the clawback, and posted as a separate ledger entry.
 * Netting the two into one number destroys the audit trail and leaves support
 * unable to explain a balance.
 */
export function coinsToRestore(
  allocations: LineAllocation[],
  returnedQty: Map<string, { returned: number; ordered: number }>,
): number {
  let coins = 0;
  for (const a of allocations) {
    const q = returnedQty.get(a.id);
    if (!q || q.ordered <= 0 || q.returned <= 0) continue;
    coins += Math.floor((a.allocatedCoins * q.returned) / q.ordered);
  }
  return coins;
}

/**
 * Cash refunded for returned lines (§7.5).
 *
 * "Returned line value minus its allocated coin discount, plus tax on that net."
 * Coins are never refunded as cash, so the coin discount stays deducted — the
 * customer gets back the money they actually paid, and the coins come back as
 * coins through `coinsToRestore`.
 */
export function cashRefundPaise(
  allocations: LineAllocation[],
  returnedQty: Map<string, { returned: number; ordered: number }>,
): number {
  let paise = 0;
  for (const a of allocations) {
    const q = returnedQty.get(a.id);
    if (!q || q.ordered <= 0 || q.returned <= 0) continue;
    // preTaxNetPaidPaise is already net of both discounts; add this line's tax
    // back on to refund the tax-inclusive amount actually charged.
    const netPreTax = Math.floor((a.preTaxNetPaidPaise * q.returned) / q.ordered);
    const tax = Math.round((netPreTax * a.taxRatePct) / 100);
    paise += netPreTax + tax;
  }
  return paise;
}
