/**
 * Loyalty rule versions — ZSOP004 §9, §8.4 #35.
 *
 * "Every order stores rule_version_id. All later recomputation uses the stored
 * version. Config is never retroactive."
 *
 * That sentence is the whole design. Changing a rule writes a NEW row and flips
 * `isActive`; it never edits the row orders are pointing at. A partial unique
 * index (see the migration) guarantees exactly one active version, so "which
 * rules applied?" always has one answer.
 */
import type { LoyaltyRuleVersion } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { env } from '@/config/env';
import { AppError, ErrorCode } from '@/lib/errors';
import type { Tx } from './ledger.service';
import type { CoinRules } from './coin-math';

/** Cache the active version — it is read on every cart price. */
let cached: { row: LoyaltyRuleVersion; at: number } | null = null;
/*
 * §9.3: a kill switch must take effect within 60 seconds without a deployment.
 *
 * Disabled entirely under test. The cache is module-level state and the suites
 * share one process, so a file that flips `redemptionEnabled` leaves its
 * neighbours reading a stale row — the symptom is a spurious
 * ACCOUNT_CANNOT_REDEEM in whichever test happens to run next, moving between
 * files on every run. Reading through in tests is also strictly truer to the
 * rule: the switch takes effect immediately rather than within a minute.
 */
const TTL_MS = env.isTest ? 0 : 60_000;

/**
 * The currently active rule version.
 *
 * Cached for 60s, which is exactly the window §9.3 allows a kill switch. Longer
 * would break the "takes effect without a deployment" promise; shorter would put
 * a query on every cart render for no benefit.
 */
export async function active(client: Tx | typeof prisma = prisma): Promise<LoyaltyRuleVersion> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.row;

  const row = await client.loyaltyRuleVersion.findFirst({ where: { isActive: true } });
  if (!row) {
    throw new AppError(
      500,
      ErrorCode.INTERNAL,
      'No active loyalty rule version. The programme cannot price without one.',
    );
  }
  cached = { row, at: now };
  return row;
}

/** Drop the cache — called after a CMS rule change so the switch bites at once. */
export function invalidate(): void {
  cached = null;
}

/**
 * Load a SPECIFIC version by id — what every recomputation must use.
 *
 * Never falls back to the active version: an order priced under v1 that is
 * returned after v2 ships must unwind under v1, or the customer's final position
 * depends on when they happened to return rather than on what they bought.
 */
export async function byId(
  id: string,
  client: Tx | typeof prisma = prisma,
): Promise<LoyaltyRuleVersion> {
  const row = await client.loyaltyRuleVersion.findUnique({ where: { id } });
  if (!row) {
    throw new AppError(500, ErrorCode.INTERNAL, `Loyalty rule version ${id} no longer exists.`);
  }
  return row;
}

/** Narrow a full rule row to the arithmetic subset the pure math layer takes. */
export function toCoinRules(v: LoyaltyRuleVersion): CoinRules {
  return {
    earnGranularityPaise: v.earnGranularityPaise,
    coinsPerStep: v.coinsPerStep,
    minEarnBasePaise: v.minEarnBasePaise,
    coinValuePaise: v.coinValuePaise,
    minRedemptionCoins: v.minRedemptionCoins,
    maxRedemptionPct: v.maxRedemptionPct,
  };
}

/**
 * Is this customer inside the rollout? (§13.5)
 *
 * Deterministic on customer id, with the HOLDOUT IN THE BOTTOM BUCKETS so a
 * rising `rolloutPct` can never sweep it in. That ordering is the whole reason
 * the holdout survives a ramp: buckets 0–4 are the 5% holdout and are excluded
 * regardless of rollout, while exposure grows downward from 99.
 *
 * Uses a stable hash of the id rather than `Math.random`, so a customer's bucket
 * never changes between requests.
 */
export function bucketFor(customerId: string): number {
  let h = 0;
  for (let i = 0; i < customerId.length; i++) {
    h = (h * 31 + customerId.charCodeAt(i)) >>> 0;
  }
  return h % 100;
}

/** Holdout occupies the bottom 5 buckets (§13.5). */
export const HOLDOUT_BUCKETS = 5;

export function isHoldout(customerId: string): boolean {
  return bucketFor(customerId) < HOLDOUT_BUCKETS;
}

/**
 * Is the programme live for this customer?
 *
 * Holdout customers are never exposed, whatever the rollout percentage — they
 * see no coin surface at all, which is what makes them a valid control group.
 */
export function isExposed(customerId: string, rolloutPct: number): boolean {
  if (isHoldout(customerId)) return false;
  return bucketFor(customerId) < rolloutPct;
}
