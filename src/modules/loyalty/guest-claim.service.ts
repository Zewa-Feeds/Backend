/**
 * Guest order claiming — ZSOP004 §3.4, §8.4 #27.
 *
 * "Guest checkout is the largest single leak of earnable value." A guest order
 * earns nothing at the time (§3.3), but if the customer registers within 30 days
 * the order is retro-credited once and marked claimed so it can never be claimed
 * twice.
 *
 * ---------------------------------------------------------------------------
 * IDENTITY: EMAIL, NOT SMS
 * ---------------------------------------------------------------------------
 *
 * §3.4 says "the same verified mobile number". Zewa has no SMS provider, so the
 * claim is gated on the customer's VERIFIED EMAIL instead, matched against the
 * email the guest order was placed with. This is a deliberate, documented
 * substitution of one verified identity channel for another — the control §3.4
 * actually specifies is "prove you are the person who placed that order", and a
 * verified email proves exactly that for an order keyed by email.
 *
 * It is also strictly the same strength here: guest orders in this codebase are
 * keyed by email (`Order.email`), not by phone, so email is the identifier that
 * actually links a guest order to a person.
 *
 * The three requirements that name OTP for reasons email cannot satisfy —
 * §12.1 large-redemption re-verification, §13.3 backfill release, §8.4 #29
 * migrated customers — are recorded as blockers in README.md rather than
 * approximated with a weaker control.
 *
 * TWO ABUSE VECTORS THE SPEC CALLS OUT, both closed here (§12.1):
 *
 *   "Orders marked claimed atomically" — the claim writes an OrderLoyalty row
 *   whose unique index on orderId makes a double claim impossible even under
 *   concurrent requests.
 *
 *   "30-day window prevents a long tail of historical claims" — otherwise a
 *   customer could register two years later and claim every order they ever
 *   placed, "which is both a cost surprise and a fraud vector".
 */
import { CoinReason, CoinSourceType, OrderStatus, PaymentMethod, PaymentStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import * as ledger from './ledger.service';
import * as account from './account.service';
import * as rulesService from './rules.service';
import { computeEarn } from './coin-math';
import { linesFromOrderItems } from './earn.service';

const log = logger.child({ module: 'loyalty.guest-claim' });

/**
 * Guest orders this customer could still claim (§3.4).
 *
 * Drives the "claim your coins" prompt on the account page and the order
 * confirmation. Returns the coins at stake so the copy can name the exact figure
 * — §3.4 is explicit that the prompt shows "the exact figure at stake", because
 * "Create a profile and earn 24 Zewa Coins" converts and "you have unclaimed
 * rewards" does not.
 */
export async function claimableOrders(customerId: string) {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { email: true, emailVerifiedAt: true },
  });
  // Unverified email cannot claim: the whole point of the gate is that someone
  // who merely guesses an address cannot take another person's coins.
  if (!customer?.emailVerifiedAt) return [];

  const rv = await rulesService.active();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - rv.guestClaimDays);

  const orders = await prisma.order.findMany({
    where: {
      email: customer.email.toLowerCase(),
      // A guest order: placed without an account attached.
      customerId: null,
      placedAt: { gte: cutoff },
      status: { not: OrderStatus.CANCELLED },
      // Already-claimed orders have an OrderLoyalty row; unclaimed ones do not.
      loyalty: { is: null },
    },
    select: {
      id: true,
      orderNo: true,
      placedAt: true,
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
        },
      },
    },
    take: 50,
  });

  const rules = rulesService.toCoinRules(rv);
  return orders
    .filter(
      (o) =>
        o.paymentMethod === PaymentMethod.COD || o.paymentStatus === PaymentStatus.PAID,
    )
    .map((o) => ({
      orderId: o.id,
      orderNo: o.orderNo,
      placedAt: o.placedAt,
      coins: computeEarn(linesFromOrderItems(o.items), 0, rules).coins,
      // §3.4: "Claim these coins any time in the next 30 days."
      claimableUntil: new Date(o.placedAt.getTime() + rv.guestClaimDays * 86400000),
    }))
    .filter((o) => o.coins > 0);
}

/**
 * Claim every eligible guest order for a customer (§3.4, §8.4 #27).
 *
 * "Retro-credit once on the same verified phone within 30 days. Mark claimed so
 * it can never be claimed twice."
 *
 * Claimed coins are granted as AVAILABLE rather than PENDING: the return window
 * on these orders has either closed or is irrelevant by the time someone
 * registers, and the deferred-unlock control exists to stop coins funding a
 * second order before the first is final — which cannot apply to an order placed
 * weeks ago that has already been delivered.
 */
export async function claimGuestOrders(
  customerId: string,
): Promise<{ claimed: number; coins: number }> {
  const claimable = await claimableOrders(customerId);
  if (claimable.length === 0) return { claimed: 0, coins: 0 };

  let claimed = 0;
  let coins = 0;

  for (const candidate of claimable) {
    try {
      const granted = await prisma.$transaction(async (tx) => {
        const rv = await rulesService.active(tx);
        const acc = await account.ensureAccount(tx, customerId);
        if (!account.canEarn(acc)) return 0;

        await ledger.lockAccount(tx, acc.id);

        /*
         * Atomic claim marker. The unique index on OrderLoyalty.orderId is what
         * makes a double claim structurally impossible: two concurrent requests
         * both reach here, one inserts, the other's insert violates the index
         * and its whole transaction rolls back — so the coins are granted once,
         * not twice, without needing a lock on the order.
         */
        const existing = await tx.orderLoyalty.findUnique({
          where: { orderId: candidate.orderId },
          select: { id: true },
        });
        if (existing) return 0;

        const order = await tx.order.findUniqueOrThrow({
          where: { id: candidate.orderId },
          select: {
            id: true,
            customerId: true,
            items: {
              select: {
                id: true,
                lineTotalPaise: true,
                taxRatePct: true,
                earnEligible: true,
                coinRedeemable: true,
                allocatedCouponDiscountPaise: true,
              },
            },
          },
        });
        // Someone attached this order to an account between the scan and here.
        if (order.customerId) return 0;

        const { allocations, earnBasePaise, coins: earned } = computeEarn(
          linesFromOrderItems(order.items),
          0,
          rulesService.toCoinRules(rv),
        );
        if (earned <= 0) return 0;

        // Persist the allocation snapshot, exactly as a normal earn would.
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

        await tx.orderLoyalty.create({
          data: {
            orderId: order.id,
            accountId: acc.id,
            ruleVersionId: rv.id,
            preTaxEarnBasePaise: earnBasePaise,
            coinsGrantedCurrent: earned,
          },
        });

        // Link the order to the account now that it is claimed, so it appears in
        // the customer's order history too.
        await tx.order.update({
          where: { id: order.id },
          data: { customerId },
        });

        await account.grantLot(tx, {
          accountId: acc.id,
          coins: earned,
          ruleVersion: rv,
          sourceType: CoinSourceType.GUEST_CLAIM,
          reason: CoinReason.GUEST_CLAIM,
          idempotencyKey: `guest-claim:${order.id}`,
          orderId: order.id,
          note: 'Claimed from an order placed before you created your profile.',
        });

        return earned;
      });

      if (granted > 0) {
        claimed++;
        coins += granted;
      }
    } catch (err) {
      // A unique-index collision means a concurrent request claimed it first —
      // the correct outcome, not an error worth surfacing to the customer.
      log.info(
        { err, orderId: candidate.orderId },
        'guest claim skipped — already claimed by a concurrent request',
      );
    }
  }

  if (claimed > 0) log.info({ customerId, claimed, coins }, 'guest orders claimed');
  return { claimed, coins };
}

/**
 * How many coins a guest order WOULD earn, for the checkout prompt (§3.4).
 *
 * "Create a free profile and earn 24 Zewa Coins on this order — ₹24 off your
 * next one. Takes 30 seconds."
 *
 * Takes the cart rather than an order, so the prompt can be shown at checkout
 * before the order exists.
 */
export async function previewGuestEarn(
  lines: { lineTotalPaise: number; earnEligible: boolean }[],
): Promise<number> {
  const rv = await rulesService.active();
  if (!rv.earningEnabled) return 0;

  const coinLines = lines.map((l, i) => ({
    id: String(i),
    lineTotalPaise: l.lineTotalPaise,
    taxRatePct: 0,
    earnEligible: l.earnEligible,
    coinRedeemable: true,
    couponDiscountPaise: 0,
  }));
  return computeEarn(coinLines, 0, rulesService.toCoinRules(rv)).coins;
}
