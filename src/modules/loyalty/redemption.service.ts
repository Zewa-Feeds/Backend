/**
 * Redemption and reservations — ZSOP004 §4, §4.1, §4.3, §8.1.
 *
 * FAILS CLOSED (§8.1 #11). The mirror of earning: if anything here is uncertain,
 * no coins are spent. A customer who cannot redeem is inconvenienced; a customer
 * who redeems the same coins twice costs real money and is unrecoverable once the
 * goods ship.
 *
 * THE DOUBLE-SPEND DEFENCE, in the order it applies (§4.3, §8.1 #7):
 *
 *   1. Coins are reserved at APPLY time, not payment time — "the gap between
 *      applying and paying is exactly where double-spend happens".
 *   2. Reservations are held against the ACCOUNT, not the session, so they
 *      survive a device switch and cannot be duplicated in a second tab.
 *   3. Every mutation takes SELECT … FOR UPDATE on the account row first, so
 *      concurrent requests serialise at the database rather than interleaving.
 *   4. A unique index on (accountId, cartKey) and on orderId means a second
 *      reservation for the same cart collides rather than stacking.
 *   5. The lot-level CHECK (coinsRemaining >= 0) is the backstop: if all of the
 *      above were wrong, the write still fails loudly.
 */
import { CoinLotState, CoinReason, LoyaltyAccountStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AppError, ErrorCode } from '@/lib/errors';
import { logger } from '@/lib/logger';
import * as ledger from './ledger.service';
import type { Tx } from './ledger.service';
import * as account from './account.service';
import * as rulesService from './rules.service';
import { maxRedeemableCoins, type CoinLine } from './coin-math';

const log = logger.child({ module: 'loyalty.redemption' });

export interface ReserveInput {
  customerId: string;
  coins: number;
  lines: CoinLine[];
  /** Stable per-cart key so a re-apply replaces rather than stacks. */
  cartKey: string;
  /**
   * Coupon codes applied to this cart (ZSOP004 §4).
   *
   * "Coupon stacking: allowed — coupon first, coins second. With a per-coupon
   * block flag for aggressive promotions." Any code carrying `blocksCoins`
   * refuses the hold outright, because a promotion thin enough to need the flag
   * cannot absorb a coin discount on top of it.
   */
  couponCodes?: string[];
}

/**
 * Validate and hold coins for a cart (§4.1 step 5, §4.3).
 *
 * Returns the coins actually held, which may be LOWER than requested when the
 * cart has shrunk since the customer typed a number — §4.1: "If the eligible
 * value falls below the coins already applied, silently reduce and show a
 * non-blocking notice. A stale applied value surviving a cart mutation is how
 * negative order totals get created."
 */
export async function reserve(input: ReserveInput): Promise<{
  held: number;
  reservationId: string | null;
  reduced: boolean;
  reason?: string;
}> {
  const rv = await rulesService.active();

  // Kill switch: redemption off means the box disappears, checkout continues
  // at full price (§9.3, §10.1).
  if (!rv.redemptionEnabled) {
    return { held: 0, reservationId: null, reduced: false, reason: 'REDEMPTION_DISABLED' };
  }

  return prisma.$transaction(async (tx) => {
    const acc = await tx.loyaltyAccount.findUnique({ where: { customerId: input.customerId } });
    if (!acc) return { held: 0, reservationId: null, reduced: false, reason: 'NO_ACCOUNT' };

    // Serialise every concurrent attempt on this account (§9.1).
    await ledger.lockAccount(tx, acc.id);
    const fresh = await tx.loyaltyAccount.findUniqueOrThrow({ where: { id: acc.id } });

    if (!account.canRedeem(fresh)) {
      return { held: 0, reservationId: null, reduced: false, reason: 'ACCOUNT_CANNOT_REDEEM' };
    }

    /*
     * A coupon on this cart may forbid coins entirely (§4).
     *
     * Checked BEFORE any lot is walked: refusing after planning consumption
     * would leave a hold to unwind, and the answer does not depend on the
     * customer's balance.
     */
    if (input.couponCodes?.length) {
      const blocking = await tx.coupon.findFirst({
        where: {
          code: { in: input.couponCodes.map((c) => c.trim().toUpperCase()) },
          blocksCoins: true,
        },
        select: { code: true },
      });
      if (blocking) {
        log.info(
          { accountId: acc.id, code: blocking.code },
          'coins refused — coupon blocks them (§4)',
        );
        return { held: 0, reservationId: null, reduced: false, reason: 'COUPON_BLOCKS_COINS' };
      }
    }

    // Release any earlier hold for this cart FIRST, so re-applying a different
    // number replaces the hold rather than stacking a second one on top.
    await releaseByCartKey(tx, acc.id, input.cartKey);

    /*
     * Spendable = live lot remainders MINUS coins already held by other carts.
     *
     * Subtracting live holds is not optional bookkeeping — it is the double-spend
     * defence itself (§8.1 #7). A lot's `coinsRemaining` is only decremented when
     * a redemption is CONFIRMED at payment, so between apply and payment the lot
     * still reads full. Two tabs reading raw remainders would each be told the
     * whole balance is available and both would succeed.
     *
     * The account row is already locked FOR UPDATE above, so this read and the
     * write below are atomic with respect to any other reservation on this
     * account: a concurrent tab blocks here until this transaction commits, then
     * sees its hold.
     */
    const lots = await account.spendableLots(tx, acc.id);
    const lotTotal = lots.reduce((s, l) => s + l.coinsRemaining, 0);

    const otherHolds = await tx.coinReservation.aggregate({
      where: { accountId: acc.id, status: 'PENDING' },
      _sum: { coins: true },
    });
    const spendable = Math.max(0, lotTotal - (otherHolds._sum.coins ?? 0));

    const ceiling = maxRedeemableCoins(input.lines, spendable, rulesService.toCoinRules(rv));
    const coins = Math.min(input.coins, ceiling);
    const reduced = coins < input.coins;

    // §4: minimum redemption. Below it, hold nothing rather than a part-hold.
    if (coins < rv.minRedemptionCoins) {
      return {
        held: 0,
        reservationId: null,
        reduced,
        reason: coins <= 0 ? 'NOTHING_REDEEMABLE' : 'BELOW_MINIMUM',
      };
    }

    /*
     * Plan against lot capacity net of other carts' holds, so two carts cannot
     * both be promised coins from the same lot.
     */
    const heldPerLot = new Map<string, number>();
    const liveHolds = await tx.coinReservation.findMany({
      where: { accountId: acc.id, status: 'PENDING' },
      select: { lotMap: true },
    });
    for (const hold of liveHolds) {
      for (const step of (hold.lotMap ?? []) as { lotId: string; coins: number }[]) {
        heldPerLot.set(step.lotId, (heldPerLot.get(step.lotId) ?? 0) + step.coins);
      }
    }
    const availableLots = lots
      .map((l) => ({ id: l.id, coinsRemaining: l.coinsRemaining - (heldPerLot.get(l.id) ?? 0) }))
      .filter((l) => l.coinsRemaining > 0);

    const plan = account.planConsumption(availableLots, coins);
    const expiresAt = new Date(Date.now() + rv.reservationTtlMinutes * 60_000);

    /*
     * `cartKey` is cleared when a hold is released, so the unique index on
     * (accountId, cartKey) constrains only LIVE holds. Without that, a customer
     * who removed coins and re-applied them would collide with their own
     * released row — the index is there to stop two live holds on one cart, not
     * to make a cart key single-use for all time.
     */
    const reservation = await tx.coinReservation.create({
      data: {
        accountId: acc.id,
        coins,
        cartKey: input.cartKey,
        status: 'PENDING',
        lotMap: plan,
        expiresAt,
      },
      select: { id: true },
    });

    // Reflect the hold in the cached balance so a second tab reading the balance
    // sees the coins already committed.
    await tx.loyaltyAccount.update({
      where: { id: acc.id },
      data: { lockedCoins: { increment: coins }, version: { increment: 1 } },
    });

    log.info({ accountId: acc.id, coins, reservationId: reservation.id }, 'coins reserved');
    return { held: coins, reservationId: reservation.id, reduced };
  });
}

/** Release a cart's hold, returning the coins to the spendable balance. */
export async function releaseByCartKey(
  tx: Tx,
  accountId: string,
  cartKey: string,
): Promise<number> {
  const existing = await tx.coinReservation.findFirst({
    where: { accountId, cartKey, status: 'PENDING' },
  });
  if (!existing) return 0;

  await tx.coinReservation.update({
    where: { id: existing.id },
    // cartKey is cleared so the (accountId, cartKey) unique index constrains
    // only LIVE holds — a customer re-applying coins to the same cart must not
    // collide with their own released row.
    data: { status: 'RELEASED', releasedAt: new Date(), cartKey: null },
  });
  await tx.loyaltyAccount.update({
    where: { id: accountId },
    data: { lockedCoins: { decrement: existing.coins }, version: { increment: 1 } },
  });
  return existing.coins;
}

/**
 * Bind a reservation to an order at checkout.
 *
 * Called inside the checkout transaction. The unique index on
 * `CoinReservation.orderId` is what stops one hold backing two orders.
 */
export async function attachToOrder(
  tx: Tx,
  reservationId: string,
  orderId: string,
): Promise<void> {
  await tx.coinReservation.update({
    where: { id: reservationId },
    data: { orderId },
  });
}

/**
 * Confirm a redemption once payment succeeds (§5, §8.1 #5).
 *
 * This is where coins actually leave the customer: lots are decremented, the
 * ledger records the spend, and the hold is closed. Idempotent on the order, so
 * a duplicate payment webhook (§8.1 #4) confirms once.
 *
 * For COD the caller invokes this at placement — "coins redeemed at placement;
 * the amount collected at the door is already net of the discount" (§8.1 #5).
 */
export async function confirmForOrder(tx: Tx, orderId: string): Promise<number> {
  const reservation = await tx.coinReservation.findUnique({ where: { orderId } });
  if (!reservation || reservation.status !== 'PENDING') return 0;

  await ledger.lockAccount(tx, reservation.accountId);

  const plan = (reservation.lotMap ?? []) as { lotId: string; coins: number }[];

  // Re-validate the plan against current lot state. A lot may have expired or
  // been reversed between apply and payment; §8.1 #3 requires we never silently
  // change a total the customer agreed to, so this raises rather than adjusts.
  for (const step of plan) {
    const lot = await tx.coinLot.findUnique({ where: { id: step.lotId } });
    if (!lot || lot.coinsRemaining < step.coins || lot.state !== CoinLotState.AVAILABLE) {
      log.error(
        { orderId, lotId: step.lotId },
        'reserved lot is no longer spendable — holding the order for ops',
      );
      throw new AppError(
        409,
        ErrorCode.CONFLICT,
        'Your coins could not be applied to this order. Our team has been notified.',
      );
    }
  }

  await account.applyConsumption(tx, plan);

  const rv = await rulesService.active(tx);
  await ledger.post(
    tx,
    {
      accountId: reservation.accountId,
      coinsDelta: -reservation.coins,
      reason: CoinReason.REDEEM,
      idempotencyKey: `redeem:${orderId}`,
      orderId,
    },
    { coinValuePaise: rv.coinValuePaise },
  );

  await tx.coinReservation.update({
    where: { id: reservation.id },
    data: { status: 'CONFIRMED', confirmedAt: new Date(), cartKey: null },
  });
  await tx.loyaltyAccount.update({
    where: { id: reservation.accountId },
    data: { lockedCoins: { decrement: reservation.coins }, version: { increment: 1 } },
  });

  // Persist the lot map on the order — this is what a later restoration reads to
  // know which expiry dates to give coins back to (§4.2).
  await tx.orderLoyalty.upsert({
    where: { orderId },
    create: {
      orderId,
      accountId: reservation.accountId,
      ruleVersionId: rv.id,
      coinsRedeemed: reservation.coins,
      redemptionLotMap: plan,
    },
    update: {
      coinsRedeemed: reservation.coins,
      redemptionLotMap: plan,
    },
  });

  log.info({ orderId, coins: reservation.coins }, 'redemption confirmed');
  return reservation.coins;
}

/**
 * Release a hold on payment failure (§8.1 #1).
 *
 * "Locked → Available immediately. No grant. Cart retains the coin entry so
 * retry needs no re-typing." The cart-side retention is the frontend's job; this
 * is the ledger half.
 */
export async function releaseForOrder(tx: Tx, orderId: string): Promise<number> {
  const reservation = await tx.coinReservation.findUnique({ where: { orderId } });
  if (!reservation || reservation.status !== 'PENDING') return 0;

  await tx.coinReservation.update({
    where: { id: reservation.id },
    data: { status: 'RELEASED', releasedAt: new Date(), cartKey: null },
  });
  await tx.loyaltyAccount.update({
    where: { id: reservation.accountId },
    data: { lockedCoins: { decrement: reservation.coins }, version: { increment: 1 } },
  });

  log.info({ orderId, coins: reservation.coins }, 'reservation released');
  return reservation.coins;
}

/**
 * Sweep expired holds (§8.1 #2).
 *
 * "Reservation expires after 30 min; a sweeper every 5 min handles dead
 * sessions." Nothing here touches the ledger — a hold that never became a
 * redemption never moved any coins, so releasing it is purely a cache correction.
 */
export async function sweepExpired(now = new Date()): Promise<number> {
  const dead = await prisma.coinReservation.findMany({
    where: { status: 'PENDING', expiresAt: { lte: now } },
    select: { id: true, accountId: true, coins: true },
    take: 500,
  });

  for (const r of dead) {
    await prisma.$transaction(async (tx) => {
      await ledger.lockAccount(tx, r.accountId);
      const fresh = await tx.coinReservation.findUnique({ where: { id: r.id } });
      if (!fresh || fresh.status !== 'PENDING') return;

      await tx.coinReservation.update({
        where: { id: r.id },
        data: { status: 'EXPIRED', releasedAt: now, cartKey: null },
      });
      await tx.loyaltyAccount.update({
        where: { id: r.accountId },
        data: { lockedCoins: { decrement: r.coins }, version: { increment: 1 } },
      });
    });
  }

  if (dead.length) log.info({ swept: dead.length }, 'expired reservations released');
  return dead.length;
}

/**
 * What the checkout should show for this cart (§10.1).
 *
 * Returns everything the coins box needs, or a null box when the programme is
 * off, the customer is in the holdout, or the balance is negative — §10.1:
 * "Never show a negative balance, and hide the box entirely for negative-balance
 * and holdout customers."
 */
export async function quote(
  customerId: string,
  lines: CoinLine[],
  couponCodes?: string[],
): Promise<{
  visible: boolean;
  available: number;
  maxRedeemable: number;
  minRedemption: number;
  coinValuePaise: number;
} | null> {
  const rv = await rulesService.active();
  if (!rv.redemptionEnabled) return null;

  // Hide the box entirely when a coupon on the cart forbids coins (§4) — an
  // input the customer can fill in but never submit is worse than no input.
  if (couponCodes?.length) {
    const blocking = await prisma.coupon.findFirst({
      where: { code: { in: couponCodes.map((c) => c.trim().toUpperCase()) }, blocksCoins: true },
      select: { id: true },
    });
    if (blocking) return null;
  }

  const acc = await prisma.loyaltyAccount.findUnique({ where: { customerId } });
  if (!acc) return null;
  if (acc.holdout || acc.availableCoins < 0 || acc.status !== LoyaltyAccountStatus.ACTIVE) {
    return null;
  }
  if (!account.canRedeem(acc)) return null;

  const spendable = Math.max(0, acc.availableCoins - acc.lockedCoins);
  return {
    visible: true,
    available: spendable,
    maxRedeemable: maxRedeemableCoins(lines, spendable, rulesService.toCoinRules(rv)),
    minRedemption: rv.minRedemptionCoins,
    coinValuePaise: rv.coinValuePaise,
  };
}
