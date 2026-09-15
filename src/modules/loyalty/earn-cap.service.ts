/**
 * Monthly earning cap and internal-user exclusion — ZSOP004 §3.3.
 *
 * §3.3 lists two earning gates this file owns:
 *
 *   "monthly earn cap not exceeded"  — named, but given no figure. The value is
 *   a business decision, so it lives on the rule version (changeable from the
 *   CMS without a deployment) and may be overridden per customer.
 *
 *   "internal / test / staff accounts excluded by flag" — this application has
 *   no staff flag on `Customer`, but it does have `CmsUser`, and a CMS operator
 *   placing an order is exactly the person §3.3 means. That is the existing
 *   classification, reused rather than reinvented.
 *
 * TRUNCATE, DO NOT REFUSE. A customer who has earned 990 of a 1,000 cap and
 * places an order worth 40 coins earns 10, not zero. Refusing the whole grant
 * would make the cap a cliff that punishes the order that happens to cross it,
 * and would be indistinguishable to the customer from the programme being
 * broken.
 *
 * THE CAP NEVER TOUCHES SPENT OR EARNED COINS. It gates issuance only: lowering
 * a cap cannot claw back what last month granted, and it has no bearing on the
 * redemption engine.
 */
import { CoinReason } from '@prisma/client';
// Type-only: `prisma` appears here solely in `typeof prisma` positions, which
// are type queries and need no runtime binding. The union with `Tx` is
// load-bearing — these helpers are called both inside a transaction and, from
// tests, with the bare client.
import type { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import type { Tx } from './ledger.service';

const log = logger.child({ module: 'loyalty.earn-cap' });

/**
 * Is this customer an internal/staff user? (§3.3)
 *
 * Answered by matching the customer's email against an active `CmsUser`, which
 * is this application's only existing staff classification — there is no flag on
 * `Customer` to read, and inventing one would mean inventing a concept the rest
 * of the app does not have.
 *
 * Deliberately NOT a domain check. A `@zewafeeds.com` address is neither
 * necessary nor sufficient: staff use personal addresses, and the founder's
 * spouse on the same domain is not staff. The CMS user list is the record of who
 * actually works here.
 *
 * DEACTIVATED operators are excluded — someone who has left is an ordinary
 * customer again, and should earn on their own orders.
 */
export async function isInternalUser(
  tx: Tx | typeof prisma,
  customerId: string,
): Promise<boolean> {
  const customer = await tx.customer.findUnique({
    where: { id: customerId },
    select: { email: true },
  });
  if (!customer?.email) return false;

  const staff = await tx.cmsUser.findFirst({
    where: { email: customer.email, status: 'ACTIVE' },
    select: { id: true },
  });
  return Boolean(staff);
}

/** Start of the current calendar month, in server time. */
export function monthStart(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
}

/**
 * The cap in force for one customer right now.
 *
 * An override wins over the rule version's default, including when it is LOWER —
 * a cap of zero is a legitimate setting for an account under review, and is why
 * this returns the override's value rather than the maximum of the two.
 *
 * Expired and revoked overrides are ignored, so a one-off grant lapses on its
 * own rather than being forgotten.
 */
export async function effectiveCap(
  tx: Tx | typeof prisma,
  customerId: string,
  defaultCapCoins: number,
  now = new Date(),
): Promise<{ cap: number; overrideId: string | null }> {
  const override = await tx.customerEarnCapOverride.findFirst({
    where: {
      customerId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    // Newest wins when several are live — the most recent decision is the
    // operative one, and older rows stay as history.
    orderBy: { createdAt: 'desc' },
    select: { id: true, monthlyCapCoins: true },
  });

  if (override) return { cap: override.monthlyCapCoins, overrideId: override.id };
  return { cap: defaultCapCoins, overrideId: null };
}

/**
 * Coins already EARNED this calendar month.
 *
 * Counts `EARN` rows only. Deliberately not the account's lifetime total and
 * deliberately not net of clawbacks:
 *
 *   - `lifetimeEarned` never resets, so it cannot answer a monthly question.
 *   - A clawback reverses a grant that should not have been made; letting it
 *     refund headroom would let a customer earn, return, and earn again against
 *     the same cap indefinitely.
 *
 * Reads the ledger rather than the lots, because the ledger is the source of
 * truth and a lot can be voided out from under the question.
 */
export async function earnedThisMonth(
  tx: Tx | typeof prisma,
  accountId: string,
  now = new Date(),
): Promise<number> {
  const agg = await tx.coinLedger.aggregate({
    where: {
      accountId,
      reason: CoinReason.EARN,
      createdAt: { gte: monthStart(now) },
      coinsDelta: { gt: 0 },
    },
    _sum: { coinsDelta: true },
  });
  return agg._sum.coinsDelta ?? 0;
}

export interface CapDecision {
  /** Coins that may actually be granted — may be fewer than requested. */
  granted: number;
  /** Coins withheld because the cap was reached. */
  withheld: number;
  cap: number;
  earnedSoFar: number;
  /** True when the cap bit at all, so the caller can log it. */
  capped: boolean;
}

/**
 * Apply the monthly cap to a proposed grant (§3.3).
 *
 * `cap <= 0` from an OVERRIDE means "this customer earns nothing"; the same
 * value on the rule version means the cap is disabled entirely. The two are
 * distinguished by the caller passing `hasOverride`, because a business that
 * has not configured a cap should not accidentally stop all earning.
 */
export function applyCap(
  proposed: number,
  cap: number,
  earnedSoFar: number,
  hasOverride: boolean,
): CapDecision {
  // No cap configured at the programme level — earning is uncapped.
  if (cap <= 0 && !hasOverride) {
    return { granted: proposed, withheld: 0, cap: 0, earnedSoFar, capped: false };
  }

  const headroom = Math.max(0, cap - earnedSoFar);
  const granted = Math.min(proposed, headroom);
  return {
    granted,
    withheld: proposed - granted,
    cap,
    earnedSoFar,
    capped: granted < proposed,
  };
}

/**
 * Resolve the cap and truncate a proposed grant, in one call.
 *
 * MUST run inside the same transaction that writes the grant, and after the
 * account row is locked: the month's total is read here and written immediately
 * after, so two concurrent orders would otherwise both see the same headroom and
 * both spend it.
 */
export async function capGrant(
  tx: Tx,
  input: {
    accountId: string;
    customerId: string;
    proposedCoins: number;
    defaultCapCoins: number;
    now?: Date;
  },
): Promise<CapDecision> {
  const now = input.now ?? new Date();
  const { cap, overrideId } = await effectiveCap(
    tx,
    input.customerId,
    input.defaultCapCoins,
    now,
  );
  const earnedSoFar = await earnedThisMonth(tx, input.accountId, now);
  const decision = applyCap(input.proposedCoins, cap, earnedSoFar, overrideId !== null);

  if (decision.capped) {
    log.info(
      {
        customerId: input.customerId,
        cap,
        earnedSoFar,
        proposed: input.proposedCoins,
        granted: decision.granted,
        overrideId,
      },
      'monthly earn cap applied',
    );
  }

  return decision;
}
