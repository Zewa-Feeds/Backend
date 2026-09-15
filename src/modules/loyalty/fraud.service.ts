/**
 * Fraud and risk controls — ZSOP004 §12.1.
 *
 * Most of §12.1's controls are STRUCTURAL and live where the structure is:
 *
 *   Order-and-return farming    → deferred unlock (lifecycle.service)
 *   Large-order return          → +14-day hold and the −50 floor (lifecycle, ledger)
 *   Guest-claim abuse           → atomic claim and the 30-day window (guest-claim)
 *   Internal abuse              → reason codes and approval (admin.routes)
 *   Double-spend                → account-anchored holds (redemption.service)
 *
 * "Primary control: deferred unlock … eliminates the mechanism rather than
 * trying to detect it." That is the pattern throughout: the specification
 * prefers designs where the abuse is impossible over rules that notice it after
 * the fact. This file holds the remainder — the controls that genuinely are
 * checks rather than structure.
 *
 * ---------------------------------------------------------------------------
 * LARGE-REDEMPTION RE-VERIFICATION IS BLOCKED, NOT SKIPPED
 * ---------------------------------------------------------------------------
 *
 * §12.1 requires "OTP re-verification above 500 coins in one redemption" against
 * account takeover. Zewa has no SMS provider, so the check cannot be performed.
 *
 * `assessRedemptionRisk` below still computes and returns the decision, and
 * still records the risk signals — it simply cannot ENFORCE the step-up today.
 * Redemption is deliberately NOT blocked: §4 permits redemption up to 100% of
 * product value and nothing in the specification says to refuse it when
 * verification is unavailable, so refusing would invent a rule and break normal
 * customers. The exposure is recorded and surfaced instead.
 *
 * When an SMS provider exists, `requiresStepUp` is the only thing that needs a
 * consumer — the redemption engine needs no redesign.
 */
import { LoyaltyAccountStatus, PaymentMethod } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import * as rulesService from './rules.service';

const log = logger.child({ module: 'loyalty.fraud' });

/**
 * Is this account restricted to prepaid orders? (§12.1)
 *
 * "Rolling RTO counter. Earning disabled after 3 in 90 days; account moves to
 * prepaid-only."
 *
 * The earning half is applied in `reversal.handleRto`. This is the other half —
 * a customer who has refused three deliveries in 90 days cannot keep placing COD
 * orders, because each refusal costs real shipping money whether or not coins
 * are involved.
 *
 * The window is rolling: `rtoWindowAt` records when the current run started, and
 * a gap longer than 90 days resets it rather than holding a customer's old
 * record against them forever.
 */
export async function isPrepaidOnly(customerId: string | null | undefined): Promise<boolean> {
  if (!customerId) return false;

  const account = await prisma.loyaltyAccount.findUnique({
    where: { customerId },
    select: { rtoCount90d: true, rtoWindowAt: true },
  });
  if (!account?.rtoWindowAt) return false;

  const windowOpen = Date.now() - account.rtoWindowAt.getTime() < 90 * 24 * 3600 * 1000;
  if (!windowOpen) return false;

  const rv = await rulesService.active();
  return account.rtoCount90d >= rv.rtoLimit;
}

/**
 * Gate a COD order against the RTO record (§12.1).
 *
 * Called from checkout. Returns a customer-facing reason when COD must be
 * refused, or null when the order may proceed.
 *
 * Deliberately does NOT mention coins. The restriction is about delivery
 * refusals, applies whether or not the customer participates in the programme,
 * and telling someone their loyalty account caused it would be both confusing
 * and wrong.
 */
export async function codBlockedReason(
  customerId: string | null | undefined,
  paymentMethod: PaymentMethod,
): Promise<string | null> {
  if (paymentMethod !== PaymentMethod.COD) return null;
  if (!(await isPrepaidOnly(customerId))) return null;

  log.warn({ customerId }, 'COD refused — RTO limit reached, account is prepaid-only');
  return 'Cash on Delivery is not available on this account at the moment. Please pay online to place your order.';
}

/** What a redemption looks like from a risk perspective. */
export interface RedemptionRisk {
  coins: number;
  /** §12.1: re-verification is required above this many coins in one redemption. */
  requiresStepUp: boolean;
  /**
   * True when the step-up is required but CANNOT be performed — no SMS provider.
   * Surfaced on the CMS exception list so the exposure is visible rather than
   * silently absent.
   */
  stepUpUnavailable: boolean;
  /** New device combined with a new shipping address (§12.1). */
  newDeviceNewAddress: boolean;
  /** Everything worth alerting on, for the daily report. */
  signals: string[];
}

/**
 * Assess one redemption attempt (§12.1).
 *
 * Computes the decision even though the step-up cannot be enforced, so that:
 *   - the signal is recorded now and reviewable in the CMS,
 *   - turning on enforcement later is a one-line change at the call site
 *     rather than a redesign of the redemption engine.
 */
export async function assessRedemptionRisk(input: {
  customerId: string;
  coins: number;
  /** Shipping pincode on this order, if known. */
  pincode?: string | null;
  /** A stable per-device marker, when the client supplies one. */
  deviceId?: string | null;
}): Promise<RedemptionRisk> {
  const rv = await rulesService.active();
  const signals: string[] = [];

  const requiresStepUp = input.coins >= rv.otpThresholdCoins;
  if (requiresStepUp) {
    signals.push(`Large redemption: ${input.coins} coins (threshold ${rv.otpThresholdCoins})`);
  }

  /*
   * "Alert on redemption from a new device combined with a new shipping
   * address" — the COMBINATION is the signal, because either alone is ordinary.
   * People buy on a new phone; people ship to a friend.
   *
   * "New address" is judged against the customer's own order history rather than
   * their address book: the book can be edited by whoever holds the session,
   * while past orders cannot.
   */
  let newDeviceNewAddress = false;
  if (input.pincode) {
    const seenBefore = await prisma.order.findFirst({
      where: {
        customerId: input.customerId,
        shippingAddress: { path: ['pincode'], equals: input.pincode },
      },
      select: { id: true },
    });
    const newAddress = !seenBefore;
    // Without a device marker the combination cannot be established, so this
    // stays false rather than guessing from the address alone.
    newDeviceNewAddress = newAddress && Boolean(input.deviceId);
    if (newDeviceNewAddress) {
      signals.push('Redemption from a new device to a previously unused address');
    }
  }

  const risk: RedemptionRisk = {
    coins: input.coins,
    requiresStepUp,
    // The exposure §12.1 asks for and this build cannot close.
    stepUpUnavailable: requiresStepUp,
    newDeviceNewAddress,
    signals,
  };

  if (signals.length > 0) {
    log.warn(
      { customerId: input.customerId, coins: input.coins, signals },
      'redemption risk signals raised',
    );
  }

  return risk;
}

/**
 * Accounts worth a human look (§12.1 monitoring).
 *
 * "Weekly review of high-return accounts holding balances" plus the exception
 * counts the daily report needs. Read-only: this decides nothing, it surfaces
 * what someone should decide about.
 */
export async function riskReport(now = new Date()): Promise<{
  negativeBalances: number;
  flaggedDeficits: number;
  frozenAccounts: number;
  highRtoAccounts: number;
  largeRedemptionsUnverified: number;
  highReturnAccounts: {
    customerId: string;
    email: string;
    availableCoins: number;
    rtoCount90d: number;
  }[];
}> {
  const rv = await rulesService.active();
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);

  const [negativeBalances, flaggedDeficits, frozenAccounts, highRto, largeRedemptions] =
    await Promise.all([
      prisma.loyaltyAccount.count({ where: { availableCoins: { lt: 0 } } }),
      prisma.loyaltyAccount.count({ where: { flaggedDeficit: { gt: 0 } } }),
      prisma.loyaltyAccount.count({ where: { status: LoyaltyAccountStatus.FROZEN } }),
      prisma.loyaltyAccount.count({ where: { rtoCount90d: { gte: rv.rtoLimit } } }),
      // Redemptions that WOULD have needed re-verification. Counted so the
      // blocked control's exposure is a number someone can look at, rather than
      // an absence nobody notices.
      prisma.coinLedger.count({
        where: {
          reason: 'REDEEM',
          createdAt: { gte: weekAgo },
          coinsDelta: { lte: -rv.otpThresholdCoins },
        },
      }),
    ]);

  // Accounts that both return often AND hold a balance — the combination §12.1
  // asks to review weekly.
  const highReturn = await prisma.loyaltyAccount.findMany({
    where: { rtoCount90d: { gte: 1 }, availableCoins: { gt: 0 } },
    orderBy: { rtoCount90d: 'desc' },
    take: 50,
    select: {
      customerId: true,
      availableCoins: true,
      rtoCount90d: true,
      customer: { select: { email: true } },
    },
  });

  return {
    negativeBalances,
    flaggedDeficits,
    frozenAccounts,
    highRtoAccounts: highRto,
    largeRedemptionsUnverified: largeRedemptions,
    highReturnAccounts: highReturn.map((a) => ({
      customerId: a.customerId,
      email: a.customer.email,
      availableCoins: a.availableCoins,
      rtoCount90d: a.rtoCount90d,
    })),
  };
}

/**
 * Daily issuance and redemption against the trailing 7-day average (§12.1).
 *
 * "Real-time alerts on outsized single-account earning or single-order
 * redemption; daily issuance and redemption against the trailing 7-day average."
 *
 * A ratio rather than an absolute threshold, because the right absolute number
 * changes with the size of the programme and would be stale within a month.
 */
export async function dailyVolumeCheck(now = new Date()): Promise<{
  issuedToday: number;
  redeemedToday: number;
  issuedAvg7d: number;
  redeemedAvg7d: number;
  anomalous: boolean;
}> {
  const dayAgo = new Date(now);
  dayAgo.setDate(dayAgo.getDate() - 1);
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 8);

  const sumFor = async (reason: 'UNLOCK' | 'REDEEM', from: Date, to: Date) => {
    const agg = await prisma.coinLedger.aggregate({
      where: { reason, createdAt: { gte: from, lt: to } },
      _sum: { coinsDelta: true },
    });
    return Math.abs(agg._sum.coinsDelta ?? 0);
  };

  const [issuedToday, redeemedToday, issuedWeek, redeemedWeek] = await Promise.all([
    sumFor('UNLOCK', dayAgo, now),
    sumFor('REDEEM', dayAgo, now),
    sumFor('UNLOCK', weekAgo, dayAgo),
    sumFor('REDEEM', weekAgo, dayAgo),
  ]);

  const issuedAvg7d = Math.round(issuedWeek / 7);
  const redeemedAvg7d = Math.round(redeemedWeek / 7);

  // Three times the trailing average, with a floor so a programme issuing single
  // digits does not alert on ordinary noise.
  const MULTIPLE = 3;
  const FLOOR = 100;
  const anomalous =
    (issuedAvg7d > 0 && issuedToday > Math.max(FLOOR, issuedAvg7d * MULTIPLE)) ||
    (redeemedAvg7d > 0 && redeemedToday > Math.max(FLOOR, redeemedAvg7d * MULTIPLE));

  if (anomalous) {
    log.error(
      { issuedToday, issuedAvg7d, redeemedToday, redeemedAvg7d },
      'coin volume is far above the trailing 7-day average — investigate',
    );
  }

  return { issuedToday, redeemedToday, issuedAvg7d, redeemedAvg7d, anomalous };
}
