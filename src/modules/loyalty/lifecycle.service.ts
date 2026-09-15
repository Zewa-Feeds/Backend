/**
 * Pending → available → expired — ZSOP004 §3.5, §4.3.
 *
 * Deferred unlock is the programme's PRIMARY FRAUD CONTROL, not a nicety (§12.1):
 * "Coins usable the instant an order is placed can be spent on a second order and
 * the first then returned. Holding them until the return window closes eliminates
 * the mechanism rather than trying to detect it."
 *
 * Everything in this file therefore errs toward holding coins back, with one
 * deliberate exception — the 21-day failsafe, where the specification chooses the
 * customer over the control because "erring towards the customer on a handful of
 * orders is cheaper than the support load of the alternative".
 */
import { CoinLotState, CoinReason, LoyaltyAccountStatus, OrderStatus } from '@prisma/client';
import type { LoyaltyRuleVersion } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import * as ledger from './ledger.service';
import type { Tx } from './ledger.service';
import * as rulesService from './rules.service';

const log = logger.child({ module: 'loyalty.lifecycle' });

/**
 * What the caller needs to send the "coins earned" email after its transaction
 * commits. `maturesAt` already includes any §3.5 large-order hold.
 */
export interface EarnedNotice {
  accountId: string;
  orderId: string;
  coins: number;
  maturesAt: Date;
  deliveredAt: Date;
}

/**
 * When do this order's coins unlock? (§3.5)
 *
 *   matures_at = delivered_at + return_window_days
 *
 * plus an extended hold above the large-order threshold:
 *
 *   "For orders above ₹20,000 pre-tax, coins unlock at delivered_at +
 *    return_window + 14 days. Bulk orders now earn without a ceiling, so a single
 *    returned bulk order can generate a clawback of over 1,500 coins. The extended
 *    hold means those coins are far less likely to have been spent before the
 *    return window and the extended-return risk have passed. This is the control
 *    that makes the uncapped bulk decision safe."
 */
export function maturityFor(
  deliveredAt: Date,
  preTaxBasePaise: number,
  rv: Pick<
    LoyaltyRuleVersion,
    'returnWindowDays' | 'largeOrderThresholdPaise' | 'largeOrderHoldDays'
  >,
): Date {
  const out = new Date(deliveredAt);
  let days = rv.returnWindowDays;
  if (preTaxBasePaise > rv.largeOrderThresholdPaise) days += rv.largeOrderHoldDays;
  out.setDate(out.getDate() + days);
  return out;
}

/**
 * Record a delivery and schedule the unlock (§3.5, §8.2 #16).
 *
 * "Split shipments mature from the last delivered line" — this codebase marks
 * delivery at order level, so `deliveredAt` already IS the last-delivered moment
 * and no extra handling is needed. Documented rather than silently assumed.
 *
 * Idempotent: setting the same maturity twice is a no-op, so a repeated delivery
 * webhook cannot shorten or extend the clock.
 */
export async function onDelivered(
  tx: Tx,
  orderId: string,
  deliveredAt: Date,
): Promise<EarnedNotice | null> {
  const loyalty = await tx.orderLoyalty.findUnique({
    where: { orderId },
    select: {
      preTaxEarnBasePaise: true,
      ruleVersionId: true,
      accountId: true,
      coinsGrantedCurrent: true,
    },
  });
  if (!loyalty) return null;

  const rv = await rulesService.byId(loyalty.ruleVersionId, tx);
  const maturesAt = maturityFor(deliveredAt, loyalty.preTaxEarnBasePaise, rv);

  await tx.coinLot.updateMany({
    where: { orderId, state: CoinLotState.PENDING },
    data: { maturesAt },
  });

  log.info({ orderId, maturesAt }, 'delivery recorded — unlock scheduled');

  /*
   * Returned rather than sent here: this runs inside the order-status
   * transaction, and an email cannot be rolled back if that transaction fails.
   * The caller sends it after commit.
   */
  if (!loyalty.accountId || loyalty.coinsGrantedCurrent <= 0) return null;
  return {
    accountId: loyalty.accountId,
    orderId,
    coins: loyalty.coinsGrantedCurrent,
    maturesAt,
    deliveredAt,
  };
}

/**
 * Unlock every pending lot whose return window has closed (§3.5, §8.2 #12).
 *
 * Runs as a scheduled job. Frozen accounts are skipped: §8.4 #30 pauses their
 * clocks so our review time cannot cost a wrongly-flagged customer value.
 */
export async function unlockMatured(now = new Date()): Promise<{ unlocked: number; coins: number }> {
  const due = await prisma.coinLot.findMany({
    where: {
      state: CoinLotState.PENDING,
      maturesAt: { not: null, lte: now },
      account: { status: LoyaltyAccountStatus.ACTIVE },
    },
    select: { id: true, accountId: true, coinsRemaining: true, ruleVersionId: true },
    take: 500,
  });

  let coins = 0;
  for (const lot of due) {
    await prisma.$transaction(async (tx) => {
      await ledger.lockAccount(tx, lot.accountId);
      // Re-read inside the lock: a reversal may have voided this lot since the
      // scan above, and unlocking a voided lot would resurrect dead coins.
      const fresh = await tx.coinLot.findUnique({ where: { id: lot.id } });
      if (!fresh || fresh.state !== CoinLotState.PENDING) return;

      await tx.coinLot.update({
        where: { id: lot.id },
        data: { state: CoinLotState.AVAILABLE },
      });
      const rv = await rulesService.byId(fresh.ruleVersionId, tx);
      await ledger.post(
        tx,
        {
          accountId: fresh.accountId,
          coinsDelta: fresh.coinsRemaining,
          reason: CoinReason.UNLOCK,
          idempotencyKey: `unlock:${fresh.id}`,
          lotId: fresh.id,
          orderId: fresh.orderId,
        },
        { coinValuePaise: rv.coinValuePaise },
      );
      coins += fresh.coinsRemaining;
    });
  }

  /*
   * NO EMAIL HERE, deliberately.
   *
   * The customer was already told about these coins when the order was
   * delivered — the "coins earned" message names the unlock date up front. A
   * second message when they actually unlock would read as a second reward for
   * the same purchase.
   */
  if (due.length) log.info({ lots: due.length, coins }, 'coins unlocked');
  return { unlocked: due.length, coins };
}

/**
 * Void pending coins for an order that will never be delivered (§3.5, §8.2 #15).
 *
 * "Orders never delivered — cancelled, RTO, lost — have their pending coins
 * voided." Voiding is terminal: these coins never existed as spendable value, so
 * there is nothing to claw back and no customer-visible loss.
 */
export async function voidPendingForOrder(
  tx: Tx,
  orderId: string,
  reason: string,
): Promise<number> {
  const lots = await tx.coinLot.findMany({
    where: { orderId, state: CoinLotState.PENDING },
  });

  let voided = 0;
  for (const lot of lots) {
    await tx.coinLot.update({
      where: { id: lot.id },
      data: { state: CoinLotState.VOID, coinsRemaining: 0 },
    });
    await ledger.post(tx, {
      accountId: lot.accountId,
      coinsDelta: -lot.coinsRemaining,
      reason: CoinReason.VOID,
      idempotencyKey: `void:${lot.id}`,
      lotId: lot.id,
      orderId,
      note: reason,
    });
    voided += lot.coinsRemaining;
  }

  if (voided) log.info({ orderId, voided, reason }, 'pending coins voided');
  return voided;
}

/**
 * Expire lots past their date (§4.3).
 *
 * "Evaluated by a daily job and lazily on every balance read, so no customer ever
 * sees a balance including coins that expired overnight. Evaluates at 23:59:59
 * IST, so a coin is usable for the whole of its final day."
 *
 * Two protections the specification is explicit about:
 *   - Locked coins are protected from expiry until their order resolves: "a
 *     customer is never denied a checkout they had already committed to."
 *   - Frozen accounts are skipped, pausing their clocks (§8.4 #30).
 */
export async function expireLots(now = new Date()): Promise<{ expired: number; coins: number }> {
  const due = await prisma.coinLot.findMany({
    where: {
      state: CoinLotState.AVAILABLE,
      coinsRemaining: { gt: 0 },
      expiresAt: { lte: now },
      account: { status: LoyaltyAccountStatus.ACTIVE },
    },
    select: { id: true, accountId: true },
    take: 500,
  });

  let coins = 0;
  for (const row of due) {
    await prisma.$transaction(async (tx) => {
      await ledger.lockAccount(tx, row.accountId);
      const lot = await tx.coinLot.findUnique({ where: { id: row.id } });
      if (!lot || lot.state !== CoinLotState.AVAILABLE || lot.coinsRemaining <= 0) return;

      // Coins committed to a live checkout are protected (§4.3).
      const held = await tx.coinReservation.aggregate({
        where: { accountId: lot.accountId, status: 'PENDING' },
        _sum: { coins: true },
      });
      if ((held._sum.coins ?? 0) > 0) {
        log.info({ lotId: lot.id }, 'expiry deferred — coins are committed to a live checkout');
        return;
      }

      await tx.coinLot.update({
        where: { id: lot.id },
        data: { state: CoinLotState.EXPIRED, coinsRemaining: 0 },
      });
      await ledger.post(tx, {
        accountId: lot.accountId,
        coinsDelta: -lot.coinsRemaining,
        reason: CoinReason.EXPIRE,
        idempotencyKey: `expire:${lot.id}`,
        lotId: lot.id,
      });
      coins += lot.coinsRemaining;
    });
  }

  if (due.length) log.info({ lots: due.length, coins }, 'coins expired (breakage)');
  return { expired: due.length, coins };
}

/**
 * The stuck-shipment failsafe (§3.5, §8.2 #14).
 *
 * "Courier APIs miss delivery callbacks. If an order sits in shipped for more
 * than 21 days with no delivery or RTO event, it is flagged for ops; after a
 * further 7 days the coins unlock anyway and the reason is logged."
 *
 * A rising count here is a useful signal that the courier integration is
 * degrading, which is why the log line is deliberately loud.
 */
export async function releaseStuckShipments(now = new Date()): Promise<number> {
  const rv = await rulesService.active();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - (rv.stuckShipmentDays + rv.stuckGraceDays));

  const stuck = await prisma.order.findMany({
    where: {
      status: OrderStatus.SHIPPED,
      shippedAt: { lte: cutoff },
      loyalty: { isNot: null },
    },
    select: { id: true, orderNo: true },
    take: 200,
  });

  let released = 0;
  for (const order of stuck) {
    await prisma.$transaction(async (tx) => {
      // Unlock from NOW rather than from a delivery date we never received.
      await tx.coinLot.updateMany({
        where: { orderId: order.id, state: CoinLotState.PENDING },
        data: { maturesAt: now },
      });
    });
    released++;
    log.warn(
      { orderId: order.id, orderNo: order.orderNo },
      'no delivery event after the failsafe window — unlocking coins anyway (courier integration may be degrading)',
    );
  }

  return released;
}
