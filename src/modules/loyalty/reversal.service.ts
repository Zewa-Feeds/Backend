/**
 * Cancellation, return and refund logic — ZSOP004 §7.
 *
 * THE GOVERNING PRINCIPLE (§7.1), which every rule here follows from:
 *
 *   "After any modification to an order, the customer's coin position must be
 *    identical to what it would have been had the order originally been placed in
 *    its final form."
 *
 * Any new edge case should be resolved by applying that test, not by inventing a
 * rule. It is asserted directly in reversal.test.ts.
 *
 * TWO INDEPENDENT MOVEMENTS (§7.2). Restore answers "how many of the coins they
 * spent relate to the part being returned?"; clawback answers "how many of the
 * coins they earned are no longer justified?". They are computed independently
 * and posted as SEPARATE ledger entries. Netting them into one number destroys
 * the audit trail and leaves support unable to explain a balance — "which is a
 * support cost, not an engineering aesthetic".
 *
 * RECOMPUTE, NEVER DELTA-CHAIN (§7.7). Reversal events arrive out of order — a
 * refund webhook before the return approval, for instance. Every reversal is
 * idempotent on the source event id and recomputes from the order's CURRENT
 * retained state. "Recomputation converges regardless of arrival order;
 * delta-chaining accumulates error."
 */
import {
  CoinLotState,
  CoinReason,
  CoinSourceType,
  ReturnKind,
  ReturnStatus,
} from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AppError, ErrorCode } from '@/lib/errors';
import { logger } from '@/lib/logger';
import * as ledger from './ledger.service';
import type { Tx } from './ledger.service';
import * as account from './account.service';
import * as lifecycle from './lifecycle.service';
import * as rulesService from './rules.service';
import {
  coinsForBase,
  coinsToRestore,
  cashRefundPaise,
  type LineAllocation,
} from './coin-math';

const log = logger.child({ module: 'loyalty.reversal' });

export interface ReturnedLine {
  orderItemId: string;
  qty: number;
}

/**
 * Restore coins to the lots they came from (§7.6).
 *
 * | Original lot at restore time      | Action                                    |
 * |-----------------------------------|-------------------------------------------|
 * | Active and unexpired              | Increment remaining, original expiry kept |
 * | Expired since redemption          | Grace lot, 30 days, references original   |
 * | Belongs to an order since reversed| Void — restore nothing, post a note       |
 *
 * The grace lot exists because "it would be unreasonable for a customer to lose
 * value because our returns process took three weeks. A small, bounded generosity
 * that removes an entire class of support ticket."
 */
export async function restoreToLots(
  tx: Tx,
  input: {
    accountId: string;
    orderId: string;
    coins: number;
    lotMap: { lotId: string; coins: number }[];
    sourceEventId: string;
  },
): Promise<number> {
  if (input.coins <= 0) return 0;

  const rv = await rulesService.active(tx);
  const now = new Date();
  let restored = 0;
  let left = input.coins;

  for (const step of input.lotMap) {
    if (left <= 0) break;
    const give = Math.min(step.coins, left);
    const lot = await tx.coinLot.findUnique({ where: { id: step.lotId } });

    if (!lot) continue;

    // A lot whose own order was reversed is dead value — restoring it would
    // create coins from nothing (§7.6, row 3).
    if (lot.state === CoinLotState.VOID || lot.state === CoinLotState.REVERSED) {
      await ledger.post(tx, {
        accountId: input.accountId,
        coinsDelta: 0,
        reason: CoinReason.RESTORE,
        idempotencyKey: `restore-void:${input.sourceEventId}:${step.lotId}`,
        lotId: lot.id,
        orderId: input.orderId,
        note: 'Coins not restored: the lot they came from belongs to a reversed order.',
      });
      left -= give;
      continue;
    }

    const expired = lot.state === CoinLotState.EXPIRED || lot.expiresAt <= now;

    if (expired) {
      // Grace lot — 30 days, referencing the original (§7.6).
      const graceExpiry = new Date(now);
      graceExpiry.setDate(graceExpiry.getDate() + rv.graceLotDays);
      const grace = await tx.coinLot.create({
        data: {
          accountId: input.accountId,
          coinsGranted: give,
          coinsRemaining: give,
          state: CoinLotState.AVAILABLE,
          sourceType: CoinSourceType.ORDER,
          orderId: input.orderId,
          earnedAt: lot.earnedAt,
          expiresAt: graceExpiry,
          parentLotId: lot.id,
          ruleVersionId: lot.ruleVersionId,
          claimedAt: now,
        },
      });
      await ledger.post(
        tx,
        {
          accountId: input.accountId,
          coinsDelta: give,
          reason: CoinReason.RESTORE,
          idempotencyKey: `restore:${input.sourceEventId}:${step.lotId}`,
          lotId: grace.id,
          orderId: input.orderId,
          note: `Returned coins restored to a 30-day grace lot — the original expired on ${lot.expiresAt.toISOString().slice(0, 10)}.`,
        },
        { coinValuePaise: rv.coinValuePaise },
      );
    } else {
      // Original expiry preserved — the customer is put back exactly where they
      // were, which is what §7.1 demands.
      await tx.coinLot.update({
        where: { id: lot.id },
        data: {
          coinsRemaining: { increment: give },
          state: CoinLotState.AVAILABLE,
        },
      });
      await ledger.post(
        tx,
        {
          accountId: input.accountId,
          coinsDelta: give,
          reason: CoinReason.RESTORE,
          idempotencyKey: `restore:${input.sourceEventId}:${step.lotId}`,
          lotId: lot.id,
          orderId: input.orderId,
        },
        { coinValuePaise: rv.coinValuePaise },
      );
    }

    restored += give;
    left -= give;
  }

  return restored;
}

/**
 * The reversal algorithm — §7.3, implemented step for step.
 *
 * Runs inside one transaction holding the account lock, so a concurrent
 * redemption cannot interleave with a clawback.
 */
export async function reverseOrder(input: {
  orderId: string;
  returnedLines: ReturnedLine[];
  sourceEventId: string;
  kind: ReturnKind;
  reason?: string;
  processedById?: string | null;
}): Promise<{
  restored: number;
  clawedBack: number;
  cashRefundPaise: number;
  duplicate: boolean;
  notify?: { accountId: string; orderNo: string; orderId: string };
}> {
  return prisma.$transaction(async (tx) => {
    // ---- 0. Idempotent on the source event (§7.3 line 1) -------------------
    const seen = await tx.orderReturn.findUnique({
      where: { sourceEventId: input.sourceEventId },
      select: { id: true, cashRefundPaise: true },
    });
    if (seen) {
      log.info({ sourceEventId: input.sourceEventId }, 'reversal already applied — no-op');
      return {
        restored: 0,
        clawedBack: 0,
        cashRefundPaise: seen.cashRefundPaise,
        duplicate: true,
      };
    }

    const order = await tx.order.findUnique({
      where: { id: input.orderId },
      select: {
        id: true,
        orderNo: true,
        items: {
          select: {
            id: true,
            qty: true,
            returnedQty: true,
            allocatedCoins: true,
            allocatedCouponDiscountPaise: true,
            allocatedCoinDiscountPaise: true,
            preTaxNetPaidPaise: true,
            earnEligible: true,
            coinRedeemable: true,
            taxRatePct: true,
          },
        },
        loyalty: true,
      },
    });
    if (!order) throw new AppError(404, ErrorCode.NOT_FOUND, 'Order not found.');

    const loyalty = order.loyalty;
    if (!loyalty) {
      // Order never participated in the programme — record the return for the
      // money side and stop.
      await tx.orderReturn.create({
        data: {
          orderId: input.orderId,
          kind: input.kind,
          status: ReturnStatus.COMPLETED,
          reason: input.reason ?? null,
          sourceEventId: input.sourceEventId,
          processedById: input.processedById ?? null,
          processedAt: new Date(),
          lines: {
            create: input.returnedLines.map((l) => ({
              orderItemId: l.orderItemId,
              qty: l.qty,
            })),
          },
        },
      });
      return { restored: 0, clawedBack: 0, cashRefundPaise: 0, duplicate: false };
    }

    // ---- 1. Load the FROZEN rule version, never current config (§7.3) ------
    const rv = await rulesService.byId(loyalty.ruleVersionId, tx);
    const accountId = loyalty.accountId!;
    await ledger.lockAccount(tx, accountId);

    // Rebuild the persisted allocation from the order lines. This is the
    // snapshot written at creation — catalogue prices have moved since.
    const allocations: LineAllocation[] = order.items.map((i) => ({
      id: i.id,
      allocatedCoins: i.allocatedCoins,
      allocatedCoinDiscountPaise: i.allocatedCoinDiscountPaise,
      allocatedCouponDiscountPaise: i.allocatedCouponDiscountPaise,
      preTaxNetPaidPaise: i.preTaxNetPaidPaise,
      earnEligible: i.earnEligible,
      coinRedeemable: i.coinRedeemable,
      taxRatePct: Number(i.taxRatePct),
    }));

    const byId = new Map(order.items.map((i) => [i.id, i]));

    // ---- 2. RESTORE spent coins to their original lots (§7.3 step 1) -------
    const returnedNow = new Map<string, { returned: number; ordered: number }>();
    for (const line of input.returnedLines) {
      const item = byId.get(line.orderItemId);
      if (!item) {
        throw new AppError(400, ErrorCode.VALIDATION_FAILED, 'Returned line is not on this order.');
      }
      const remaining = item.qty - item.returnedQty;
      if (line.qty > remaining) {
        // §8.2 #26: only possible via a bug or duplicate event; allowing it
        // creates value from nothing.
        throw new AppError(
          409,
          ErrorCode.CONFLICT,
          'This return would exceed the quantity still outstanding on the order.',
        );
      }
      returnedNow.set(line.orderItemId, { returned: line.qty, ordered: item.qty });
    }

    const restoreWanted = coinsToRestore(allocations, returnedNow);
    const restorable = loyalty.coinsRedeemed - loyalty.coinsAlreadyRestored;
    if (restoreWanted > restorable) {
      // §7.3's assertion, and §8.2 #26 — reject and alert.
      log.error(
        { orderId: input.orderId, restoreWanted, restorable },
        'reversal would restore more coins than were redeemed — rejected',
      );
      throw new AppError(
        409,
        ErrorCode.CONFLICT,
        'This return would restore more coins than were used on the order.',
      );
    }

    const lotMap = (loyalty.redemptionLotMap ?? []) as { lotId: string; coins: number }[];
    const restored = await restoreToLots(tx, {
      accountId,
      orderId: input.orderId,
      coins: restoreWanted,
      lotMap,
      sourceEventId: input.sourceEventId,
    });

    // ---- 3. Persist the new returned quantities BEFORE recomputing ---------
    // The recomputation reads CUMULATIVE retained state, so the quantities must
    // already include this event. This is what makes repeated partial returns
    // converge rather than compound (§7.3 step 2, §8.2 #19).
    for (const line of input.returnedLines) {
      await tx.orderItem.update({
        where: { id: line.orderItemId },
        data: { returnedQty: { increment: line.qty } },
      });
    }

    const refreshed = await tx.orderItem.findMany({
      where: { orderId: input.orderId },
      select: { id: true, qty: true, returnedQty: true, preTaxNetPaidPaise: true, earnEligible: true },
    });

    // ---- 4. RECOMPUTE the grant from CURRENT retained state (§7.3 step 2) --
    let newEarnBase = 0;
    for (const item of refreshed) {
      if (!item.earnEligible) continue;
      const retained = item.qty - item.returnedQty;
      if (retained <= 0 || item.qty <= 0) continue;
      newEarnBase += Math.floor((item.preTaxNetPaidPaise * retained) / item.qty);
    }
    const newCoins = coinsForBase(newEarnBase, rulesService.toCoinRules(rv));
    const delta = newCoins - loyalty.coinsGrantedCurrent;

    // ---- 5. POST the grant movement (§7.3 step 3) --------------------------
    let clawedBack = 0;
    if (delta < 0) {
      const lots = await tx.coinLot.findMany({
        where: { orderId: input.orderId, sourceType: CoinSourceType.ORDER },
      });
      const stillPending = lots.find((l) => l.state === CoinLotState.PENDING);

      if (stillPending) {
        // Grant never unlocked — reduce the pending lot rather than clawing back
        // coins the customer could not have spent.
        const reduceBy = Math.min(Math.abs(delta), stillPending.coinsRemaining);
        await tx.coinLot.update({
          where: { id: stillPending.id },
          data: {
            coinsRemaining: { decrement: reduceBy },
            coinsGranted: stillPending.coinsGranted - reduceBy,
            state: stillPending.coinsRemaining - reduceBy === 0 ? CoinLotState.VOID : CoinLotState.PENDING,
          },
        });
        await ledger.post(
          tx,
          {
            accountId,
            coinsDelta: -reduceBy,
            reason: CoinReason.VOID,
            idempotencyKey: `clawback-pending:${input.sourceEventId}`,
            lotId: stillPending.id,
            orderId: input.orderId,
            note: 'Pending grant reduced — retained order value fell after a return.',
          },
          { coinValuePaise: rv.coinValuePaise },
        );
        clawedBack = reduceBy;
      } else {
        // Coins have unlocked and may be spent. Claw back against the balance,
        // flooring at −50 and flagging any excess (§6.7, §8.2 #20, #23).
        const result = await ledger.postFlooredDebit(
          tx,
          {
            accountId,
            coinsDelta: delta,
            reason: CoinReason.CLAWBACK,
            idempotencyKey: `clawback:${input.sourceEventId}`,
            orderId: input.orderId,
            note: 'Grant reduced following a return.',
          },
          rv.maxNegativeBalance,
          { coinValuePaise: rv.coinValuePaise },
        );
        clawedBack = Math.abs(delta);

        // Consume the order's own unlocked lots so the lot remainders stay
        // consistent with the balance the ledger now reports.
        let toRemove = Math.abs(delta);
        for (const lot of lots.filter((l) => l.state === CoinLotState.AVAILABLE)) {
          if (toRemove <= 0) break;
          const take = Math.min(lot.coinsRemaining, toRemove);
          await tx.coinLot.update({
            where: { id: lot.id },
            data: {
              coinsRemaining: { decrement: take },
              state: lot.coinsRemaining - take === 0 ? CoinLotState.REVERSED : lot.state,
            },
          });
          toRemove -= take;
        }
        if (result.excess > 0) {
          log.warn(
            { orderId: input.orderId, excess: result.excess },
            'clawback exceeded the floor — full deficit recorded, account flagged',
          );
        }
      }
    } else if (delta > 0) {
      // An exchange at a higher price can increase the grant (§8.2 #22).
      await account.grantLot(tx, {
        accountId,
        coins: delta,
        ruleVersion: rv,
        sourceType: CoinSourceType.ORDER,
        reason: CoinReason.EARN,
        idempotencyKey: `regrant:${input.sourceEventId}`,
        orderId: input.orderId,
        maturesAt: null,
      });
    }

    // ---- 6. CASH (§7.3 step 4, §7.5) ---------------------------------------
    // net_paid is already net of that line's coin discount, so this refunds the
    // money actually paid and nothing more. Coins are never refunded as cash.
    const cash = cashRefundPaise(allocations, returnedNow);

    // ---- 7. Persist the return and the new order state ---------------------
    await tx.orderReturn.create({
      data: {
        orderId: input.orderId,
        kind: input.kind,
        status: ReturnStatus.COMPLETED,
        reason: input.reason ?? null,
        sourceEventId: input.sourceEventId,
        cashRefundPaise: cash,
        processedById: input.processedById ?? null,
        processedAt: new Date(),
        lines: {
          create: input.returnedLines.map((l) => ({
            orderItemId: l.orderItemId,
            qty: l.qty,
            coinsRestored: Math.floor(
              (byId.get(l.orderItemId)!.allocatedCoins * l.qty) /
                Math.max(1, byId.get(l.orderItemId)!.qty),
            ),
          })),
        },
      },
    });

    await tx.orderLoyalty.update({
      where: { orderId: input.orderId },
      data: {
        coinsGrantedCurrent: newCoins,
        coinsAlreadyRestored: { increment: restored },
        preTaxEarnBasePaise: newEarnBase,
      },
    });

    log.info(
      {
        orderId: input.orderId,
        restored,
        clawedBack,
        newCoins,
        cash,
        sourceEventId: input.sourceEventId,
      },
      'reversal applied',
    );

    return {
      restored,
      clawedBack,
      cashRefundPaise: cash,
      duplicate: false,
      // Carried out of the transaction so the caller can notify AFTER commit —
      // an email cannot be rolled back (§10.4).
      notify: { accountId, orderNo: order.orderNo, orderId: input.orderId },
    };
  });
}

/**
 * Cancel an order before dispatch (§7.5, §8.1 #9).
 *
 * "Cancellation before dispatch, prepaid → full amount paid in cash, all coins
 * redeemed restored." Pending coins are voided rather than clawed back, because
 * they never became spendable.
 */
export async function cancelOrder(input: {
  orderId: string;
  sourceEventId: string;
  reason?: string;
}): Promise<{ restored: number; voided: number; duplicate: boolean }> {
  return prisma.$transaction(async (tx) => {
    const seen = await tx.orderReturn.findUnique({
      where: { sourceEventId: input.sourceEventId },
      select: { id: true },
    });
    if (seen) return { restored: 0, voided: 0, duplicate: true };

    const order = await tx.order.findUnique({
      where: { id: input.orderId },
      select: { id: true, loyalty: true, items: { select: { id: true, qty: true } } },
    });
    if (!order?.loyalty) return { restored: 0, voided: 0, duplicate: false };

    const accountId = order.loyalty.accountId!;
    await ledger.lockAccount(tx, accountId);

    // Release an unconfirmed hold; restore a confirmed redemption.
    const lotMap = (order.loyalty.redemptionLotMap ?? []) as { lotId: string; coins: number }[];
    const restorable = order.loyalty.coinsRedeemed - order.loyalty.coinsAlreadyRestored;
    const restored = await restoreToLots(tx, {
      accountId,
      orderId: input.orderId,
      coins: restorable,
      lotMap,
      sourceEventId: input.sourceEventId,
    });

    const voided = await lifecycle.voidPendingForOrder(tx, input.orderId, input.reason ?? 'Order cancelled');

    await tx.orderReturn.create({
      data: {
        orderId: input.orderId,
        kind: ReturnKind.CANCELLATION,
        status: ReturnStatus.COMPLETED,
        reason: input.reason ?? null,
        sourceEventId: input.sourceEventId,
        processedAt: new Date(),
      },
    });

    await tx.orderLoyalty.update({
      where: { orderId: input.orderId },
      data: {
        coinsGrantedCurrent: 0,
        coinsAlreadyRestored: { increment: restored },
      },
    });

    return { restored, voided, duplicate: false };
  });
}

/**
 * RTO / refused delivery (§8.2 #15, §12.1).
 *
 * "Void the grant, restore redeemed coins, increment the RTO counter. At 3 RTOs
 * in 90 days, disable earning and move to prepaid-only."
 */
export async function handleRto(input: {
  orderId: string;
  sourceEventId: string;
}): Promise<{ restored: number; voided: number; rtoCount: number }> {
  const result = await cancelOrder({
    orderId: input.orderId,
    sourceEventId: input.sourceEventId,
    reason: 'Returned to origin / refused at delivery',
  });

  // Rolling 90-day counter (§12.1).
  const out = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: input.orderId },
      select: { loyalty: { select: { accountId: true } } },
    });
    const accountId = order?.loyalty?.accountId;
    if (!accountId) return 0;

    const acc = await tx.loyaltyAccount.findUniqueOrThrow({ where: { id: accountId } });
    const rv = await rulesService.active(tx);
    const now = new Date();

    // Reset the window if the last RTO was more than 90 days ago.
    const windowOpen =
      acc.rtoWindowAt && now.getTime() - acc.rtoWindowAt.getTime() < 90 * 24 * 3600 * 1000;
    const count = windowOpen ? acc.rtoCount90d + 1 : 1;

    await tx.loyaltyAccount.update({
      where: { id: accountId },
      data: {
        rtoCount90d: count,
        rtoWindowAt: windowOpen ? acc.rtoWindowAt : now,
        // At the limit, earning is disabled and the account moves to prepaid-only.
        earnEnabled: count >= rv.rtoLimit ? false : acc.earnEnabled,
        version: { increment: 1 },
      },
    });

    if (count >= rv.rtoLimit) {
      log.warn({ accountId, count }, 'RTO limit reached — earning disabled, prepaid only');
    }
    return count;
  });

  return { ...result, rtoCount: out };
}
