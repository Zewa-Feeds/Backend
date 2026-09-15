/**
 * Earning engine — ZSOP004 §3.
 *
 * Creates PENDING coins when an order is paid (prepaid) or placed (COD), and
 * writes the per-line allocation snapshot every later reversal depends on.
 *
 * FAILS OPEN (§8.1 #11). "Loyalty service unavailable at checkout → fail open on
 * earning (queue the event for replay), fail closed on redemption." An earning
 * failure must never cost the customer their order, so `earnForOrder` is called
 * outside the checkout transaction and its errors are swallowed into the event
 * inbox for a worker to replay. Redemption is the opposite and is handled in
 * redemption.service.
 */
import {
  CoinReason,
  CoinSourceType,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import type { Tx } from './ledger.service';
import * as account from './account.service';
import * as rulesService from './rules.service';
import * as earnCap from './earn-cap.service';
import { computeEarn, type CoinLine } from './coin-math';

const log = logger.child({ module: 'loyalty.earn' });

/**
 * Should this order earn at all? (§3.3)
 *
 * Every gate the specification lists, in the order it lists them. Returns a
 * reason string when blocked so the decision is loggable and explicable in the
 * CMS rather than a silent zero.
 */
export function earnGate(order: {
  customerId: string | null;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentMethod;
}): { ok: true } | { ok: false; reason: string } {
  // "logged-in customer" — a guest order earns nothing at order time, but is
  // claimable for 30 days on the same verified phone (§3.4).
  if (!order.customerId) return { ok: false, reason: 'GUEST_ORDER' };

  // "order reached paid (prepaid) or placed (COD)" (§3.3).
  if (order.paymentMethod === PaymentMethod.RAZORPAY && order.paymentStatus !== PaymentStatus.PAID) {
    return { ok: false, reason: 'PREPAID_NOT_PAID' };
  }
  if (order.status === OrderStatus.CANCELLED) return { ok: false, reason: 'CANCELLED' };

  return { ok: true };
}

/** Turn order lines into the shape the pure math layer consumes. */
export function linesFromOrderItems(
  items: {
    id: string;
    lineTotalPaise: number;
    taxRatePct: unknown;
    earnEligible: boolean;
    coinRedeemable: boolean;
    allocatedCouponDiscountPaise: number;
  }[],
): CoinLine[] {
  return items.map((i) => ({
    id: i.id,
    lineTotalPaise: i.lineTotalPaise,
    // Prisma returns Decimal; the catalogue is 0% today but the column is kept
    // so a future rated catalogue needs no migration (§7.4).
    taxRatePct: Number(i.taxRatePct),
    earnEligible: i.earnEligible,
    coinRedeemable: i.coinRedeemable,
    couponDiscountPaise: i.allocatedCouponDiscountPaise,
  }));
}

/**
 * Grant PENDING coins for an order (§3.5).
 *
 * Idempotent on the order: the ledger key is derived from the order id, so a
 * duplicate payment webhook (§8.1 #4) grants once. "Coins must not be granted or
 * redeemed twice."
 *
 * `maturesAt` is deliberately left null here. Coins are created PENDING at
 * payment and the unlock job fills the maturity date in from `deliveredAt` —
 * because at payment time we do not yet know when, or whether, the order will be
 * delivered.
 */
export async function earnForOrder(
  tx: Tx,
  orderId: string,
): Promise<{ coins: number; skipped?: string }> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      customerId: true,
      status: true,
      paymentStatus: true,
      paymentMethod: true,
      items: {
        select: {
          id: true,
          lineTotalPaise: true,
          taxRatePct: true,
          earnEligible: true,
          coinRedeemable: true,
          allocatedCouponDiscountPaise: true,
          allocatedCoins: true,
          preTaxNetPaidPaise: true,
        },
      },
      loyalty: true,
    },
  });
  if (!order) return { coins: 0, skipped: 'ORDER_NOT_FOUND' };

  const gate = earnGate(order);
  if (!gate.ok) return { coins: 0, skipped: gate.reason };

  const rv = await rulesService.active(tx);
  if (!rv.earningEnabled) return { coins: 0, skipped: 'EARNING_KILL_SWITCH' };

  const acc = await account.ensureAccount(tx, order.customerId!);
  if (!account.canEarn(acc)) return { coins: 0, skipped: 'ACCOUNT_NOT_EARNING' };

  /*
   * "Internal / test / staff accounts excluded by flag" (§3.3).
   *
   * There is no staff flag on `Customer`, but a CMS operator placing an order is
   * exactly who §3.3 means — so the existing `CmsUser` list is the
   * classification, matched on email. Staff can still be GIFTED coins by an
   * admin; this gate governs automatic earning only.
   */
  if (await earnCap.isInternalUser(tx, order.customerId!)) {
    return { coins: 0, skipped: 'INTERNAL_USER' };
  }

  // The earn base is computed from the SNAPSHOT already written at order
  // creation, never recomputed from the live catalogue (§7.4). `coinsRedeemed`
  // is what the order actually spent, so coins cannot earn on themselves (§3.1).
  const coinsRedeemed = order.loyalty?.coinsRedeemed ?? 0;
  const lines = linesFromOrderItems(order.items);
  const { allocations, earnBasePaise, coins } = computeEarn(
    lines,
    coinsRedeemed,
    rulesService.toCoinRules(rv),
  );

  // Persist the allocation onto the lines. This is the prerequisite §7.4 calls
  // out: "must be persisted at order creation and never recomputed at return
  // time — catalogue prices and active promotions will have changed by then."
  for (const a of allocations) {
    await tx.orderItem.update({
      where: { id: a.id },
      data: {
        allocatedCoins: a.allocatedCoins,
        allocatedCoinDiscountPaise: a.allocatedCoinDiscountPaise,
        preTaxNetPaidPaise: a.preTaxNetPaidPaise,
      },
    });
  }

  /*
   * Monthly earning cap (§3.3).
   *
   * Applied AFTER the arithmetic and BEFORE the grant, so the cap truncates the
   * grant rather than refusing the order: a customer 10 coins below their cap
   * earns those 10, not zero. Everything written below — the lot, the ledger,
   * and `coinsGrantedCurrent` on the order — uses the capped figure, or the
   * order's own record would disagree with the ledger.
   *
   * Read inside this transaction, which already holds the account lock via
   * `grantLot`'s ledger post, so two concurrent orders cannot both see the same
   * headroom and both spend it.
   */
  const capDecision = await earnCap.capGrant(tx, {
    accountId: acc.id,
    customerId: order.customerId!,
    proposedCoins: coins,
    defaultCapCoins: rv.monthlyEarnCapCoins,
  });
  const grantedCoins = capDecision.granted;

  const { lot } = await account.grantLot(tx, {
    accountId: acc.id,
    coins: grantedCoins,
    ruleVersion: rv,
    sourceType: CoinSourceType.ORDER,
    reason: CoinReason.EARN,
    idempotencyKey: `earn:${order.id}`,
    orderId: order.id,
    maturesAt: null, // set by the unlock job once delivery is known (§3.5)
  });

  await tx.orderLoyalty.upsert({
    where: { orderId: order.id },
    create: {
      orderId: order.id,
      accountId: acc.id,
      ruleVersionId: rv.id,
      preTaxEarnBasePaise: earnBasePaise,
      coinsGrantedCurrent: grantedCoins,
      coinsRedeemed,
      coinDiscountPaise: allocations.reduce((s, a) => s + a.allocatedCoinDiscountPaise, 0),
    },
    update: {
      preTaxEarnBasePaise: earnBasePaise,
      coinsGrantedCurrent: grantedCoins,
    },
  });

  log.info(
    {
      orderId: order.id,
      coins: grantedCoins,
      proposed: coins,
      withheldByCap: capDecision.withheld,
      earnBasePaise,
      lotId: lot?.id,
    },
    'coins earned (pending)',
  );
  return { coins: grantedCoins };
}

/**
 * Fire-and-forget wrapper used by the checkout path (§8.1 #11).
 *
 * Earning must never block or fail a checkout. A failure here is queued in the
 * event inbox and replayed by the worker, so the customer's coins arrive late
 * rather than never.
 */
export async function earnForOrderSafe(orderId: string): Promise<void> {
  try {
    await prisma.$transaction((tx) => earnForOrder(tx, orderId));
  } catch (err) {
    log.error({ err, orderId }, 'earning failed — queueing for replay');
    await prisma.loyaltyEventInbox
      .create({
        data: {
          eventId: `earn:${orderId}`,
          kind: 'EARN_ORDER',
          payload: { orderId },
          status: 'PENDING',
          lastError: err instanceof Error ? err.message : String(err),
        },
      })
      .catch(() => {
        // Already queued — the unique index on eventId did its job.
      });
  }
}
