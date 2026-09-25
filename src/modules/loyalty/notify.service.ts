/**
 * Coin notifications — ZSOP004 §10.4.
 *
 * Reuses the existing account-mail path (`sendAccountEmail`) rather than the
 * order-scoped BullMQ queue: `CustomerEmailJob` carries an `orderNo` and an
 * `EmailLog` order row, and a coin expiry reminder has neither. That is the
 * same reasoning `account.mailer.ts` already documents for password mail.
 *
 * IDEMPOTENCY IS THE ADDITION.
 *
 * Account mail is one-per-human-request, so fire-and-forget is safe there. Coin
 * mail is driven by ORDER AND PAYMENT EVENTS, and §9.1 is blunt about those:
 * "Assume every event arrives at least twice." A duplicate payment webhook must
 * not send a second "your coins are ready" message, and a replayed return event
 * must not tell a customer twice that their balance was adjusted.
 *
 * So every send is claimed first, against the coin ledger's own unique
 * idempotency key. The claim row IS the dedupe — no second table, no Redis
 * dependency, and the audit of what was sent lives beside the movement that
 * caused it.
 */
import { CoinReason } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';
import { sendAccountEmail } from '@/modules/customers/account.mailer';

const log = logger.child({ module: 'loyalty.notify' });

/** Deep-link target. §10.4: "never the home page". */
function coinsUrl(): string {
  return `${env.STOREFRONT_ORIGIN.replace(/\/$/, '')}/account/coins`;
}

/**
 * Claim the right to send one notification, exactly once.
 *
 * Writes a zero-delta ledger row whose `idempotencyKey` is unique in the
 * database. The second caller's insert violates that index, so it returns false
 * and sends nothing — the same mechanism every financial movement uses, applied
 * to the message about the movement.
 *
 * A zero delta is deliberate: this row records that a message was sent, not that
 * coins moved, so it must never change a balance. `post()` skips zero-delta rows
 * in the customer-facing history for the same reason.
 */
async function claim(
  accountId: string,
  key: string,
  note: string,
  orderId?: string | null,
): Promise<boolean> {
  try {
    await prisma.coinLedger.create({
      data: {
        accountId,
        coinsDelta: 0,
        balanceAfter: 0,
        monetaryValuePaise: 0,
        reason: CoinReason.RECONCILE,
        note: `Notification sent: ${note}`,
        orderId: orderId ?? null,
        idempotencyKey: key,
      },
      select: { id: true },
    });
    return true;
  } catch (err) {
    /*
     * A unique violation (P2002) means another delivery of this event already
     * sent the message — the expected, healthy path.
     *
     * Anything else is a real failure and must be LOUD. Swallowing every error
     * here would make a broken notification pipeline look exactly like a
     * well-behaved duplicate, which is the failure mode this claim exists to
     * prevent.
     */
    const code = (err as { code?: string })?.code;
    if (code === 'P2002') {
      log.info({ key }, 'coin notification already sent — skipping duplicate');
      return false;
    }
    log.error({ err, key }, 'could not claim coin notification — not sending');
    return false;
  }
}

/** Who to write to, and what to call them. */
async function recipient(accountId: string) {
  const account = await prisma.loyaltyAccount.findUnique({
    where: { id: accountId },
    select: {
      // `id` so the EmailLog row can be attributed to the customer, which is what
      // lets the CMS show a coin email on the person it was sent to.
      customer: { select: { id: true, email: true, firstName: true } },
    },
  });
  if (!account?.customer?.email) return null;
  return {
    id: account.customer.id,
    email: account.customer.email,
    firstName: account.customer.firstName || 'there',
  };
}

/**
 * "You earned N Zewa Coins" — the ONE earning email.
 *
 * Sent when DELIVERY IS CONFIRMED, not when the coins later unlock. There is
 * deliberately no second "your coins are ready" message: two emails about one
 * grant read as two rewards, and a customer told twice about the same coins
 * reasonably expects twice the coins.
 *
 * That makes this message carry the whole story at once — what was earned, what
 * is spendable today, and when the new coins join it.
 *
 * TIMING IS COMPUTED, NOT HARDCODED. §3.5 adds a further hold above the
 * large-order threshold, so the unlock date comes from the lot's own
 * `maturesAt` (already set by `onDelivered` from the order's FROZEN rule
 * version). A ₹25,000 order therefore says 21 days where an ordinary one says 7,
 * without this function knowing either number.
 *
 * Keyed on the ORDER, so a repeated delivery webhook — §9.1: "assume every event
 * arrives at least twice" — sends once.
 */
export async function notifyEarned(input: {
  accountId: string;
  orderId: string;
  orderNo: string;
  coins: number;
  /** When the coins become spendable. From the lot, so §3.5 holds are included. */
  maturesAt: Date;
  deliveredAt: Date;
}): Promise<void> {
  if (input.coins <= 0) return;
  const to = await recipient(input.accountId);
  if (!to) return;

  /*
   * The balance EXCLUDING this grant.
   *
   * The coins just earned are still PENDING, so `availableCoins` is already
   * exactly "what you can spend today" — reading it after the grant is correct
   * precisely because a pending grant does not touch it. Summing the two would
   * tell the customer they can spend money they cannot.
   */
  const account = await prisma.loyaltyAccount.findUnique({
    where: { id: input.accountId },
    select: { availableCoins: true },
  });
  const availableCoins = Math.max(0, account?.availableCoins ?? 0);

  const unlockDays = Math.max(
    0,
    Math.round(
      (input.maturesAt.getTime() - input.deliveredAt.getTime()) / 86_400_000,
    ),
  );

  const claimed = await claim(
    input.accountId,
    `notify-earned:${input.orderId}`,
    `${input.coins} coins earned on ${input.orderNo}`,
    input.orderId,
  );
  if (!claimed) return;

  sendAccountEmail(to.email, 'coins-earned', {
    firstName: to.firstName,
    coins: input.coins,
    availableCoins,
    unlockDays,
    unlockOn: input.maturesAt.toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }),
    orderNo: input.orderNo,
    coinsUrl: coinsUrl(),
  }, to.id);
}

/**
 * The SINGLE expiry reminder, 7 days out (§4.3, §10.4).
 *
 * §4.3 removed the 30-day reminder and requires this to be sent "only if the lot
 * has coins remaining — reminding someone about coins they cannot use is worse
 * than silence". The caller filters on that; the key here makes the reminder
 * once-per-lot even if the job runs several times inside the window.
 */
export async function notifyExpiring(
  accountId: string,
  lotId: string,
  coins: number,
  expiresAt: Date,
): Promise<void> {
  if (coins <= 0) return;
  const to = await recipient(accountId);
  if (!to) return;

  if (!(await claim(accountId, `notify-expiring:${lotId}`, `${coins} coins expiring`))) return;

  sendAccountEmail(to.email, 'coins-expiring', {
    firstName: to.firstName,
    coins,
    expiresOn: expiresAt.toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }),
    coinsUrl: coinsUrl(),
  }, to.id);
}

/**
 * "Following your return, N coins have been returned and M adjusted" (§10.4).
 *
 * Keyed on the RETURN EVENT, not the order: multiple sequential partial returns
 * each deserve their own message, but a replayed webhook for one of them does
 * not (§7.7).
 *
 * Sends nothing when neither figure moved — a message saying nothing happened is
 * worse than no message.
 */
export async function notifyAdjusted(
  accountId: string,
  sourceEventId: string,
  input: { orderNo: string; orderId: string; restored: number; clawedBack: number },
): Promise<void> {
  if (input.restored <= 0 && input.clawedBack <= 0) return;
  const to = await recipient(accountId);
  if (!to) return;

  const claimed = await claim(
    accountId,
    `notify-adjusted:${sourceEventId}`,
    `return adjustment on ${input.orderNo}`,
    input.orderId,
  );
  if (!claimed) return;

  sendAccountEmail(to.email, 'coins-adjusted', {
    firstName: to.firstName,
    orderNo: input.orderNo,
    restored: input.restored,
    clawedBack: input.clawedBack,
    coinsUrl: coinsUrl(),
  }, to.id);
}

/**
 * Send the 7-day expiry reminders (§4.3).
 *
 * Run by the daily expiry job. Scoped to lots expiring in exactly the reminder
 * window and still holding coins, so a customer with nothing to lose hears
 * nothing.
 */
export async function sendExpiryReminders(now = new Date()): Promise<number> {
  /*
   * A whole CALENDAR DAY, not a 24-hour slice from the moment the job happens
   * to run.
   *
   * Anchoring to `now` exactly means a lot expiring seven days out to the
   * millisecond can fall on either side of the boundary depending on when the
   * job fires — so a customer either gets the reminder or silently does not,
   * decided by scheduler jitter. §4.3 allows exactly ONE reminder, which makes
   * a missed one unrecoverable.
   *
   * Normalising to midnight makes the window "lots expiring on the day that is
   * 7 days from today", which is both what the copy promises and stable under
   * any run time.
   */
  const windowStart = new Date(now);
  windowStart.setDate(windowStart.getDate() + 7);
  windowStart.setHours(0, 0, 0, 0);
  const windowEnd = new Date(windowStart);
  windowEnd.setDate(windowEnd.getDate() + 1);

  const due = await prisma.coinLot.findMany({
    where: {
      state: 'AVAILABLE',
      coinsRemaining: { gt: 0 },
      expiresAt: { gte: windowStart, lt: windowEnd },
      account: { status: 'ACTIVE' },
    },
    select: { id: true, accountId: true, coinsRemaining: true, expiresAt: true },
    take: 500,
  });

  for (const lot of due) {
    await notifyExpiring(lot.accountId, lot.id, lot.coinsRemaining, lot.expiresAt);
  }

  if (due.length) log.info({ reminders: due.length }, 'coin expiry reminders sent');
  return due.length;
}
