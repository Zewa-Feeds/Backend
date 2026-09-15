/**
 * Nightly reconciliation — ZSOP004 §9.2, §8.4 #37.
 *
 * "Nightly job recomputes every balance from the ledger and from lot remainders,
 * auto-repairs to the ledger value and alerts. THE LEDGER ALWAYS WINS. Two
 * consecutive mismatches on an account blocks its redemption — a recurring drift
 * is a bug, and letting it keep spending compounds the loss."
 *
 * The repair posts a RECONCILE ledger row rather than quietly setting the cached
 * number, so the correction is itself auditable. A drift that was silently
 * smoothed away is indistinguishable from a drift that never happened, which is
 * exactly the situation this job exists to prevent.
 */
import { CoinReason } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import * as ledger from './ledger.service';

const log = logger.child({ module: 'loyalty.reconcile' });

export interface ReconcileReport {
  checked: number;
  repaired: number;
  blocked: number;
  drifts: { accountId: string; available: number; pending: number }[];
}

/**
 * Reconcile every account that has moved recently.
 *
 * Scoped to accounts with activity rather than the whole table: a dormant
 * account cannot drift, and scanning every row nightly would grow linearly with
 * the customer base for no benefit.
 */
export async function reconcileAll(opts: { since?: Date; limit?: number } = {}): Promise<ReconcileReport> {
  const since = opts.since ?? new Date(Date.now() - 36 * 3600 * 1000);
  const limit = opts.limit ?? 1000;

  const active = await prisma.loyaltyAccount.findMany({
    where: { updatedAt: { gte: since } },
    select: { id: true },
    take: limit,
  });

  const report: ReconcileReport = { checked: 0, repaired: 0, blocked: 0, drifts: [] };

  for (const row of active) {
    const outcome = await reconcileAccount(row.id);
    report.checked++;
    if (!outcome.clean) {
      report.repaired++;
      report.drifts.push({
        accountId: row.id,
        available: outcome.drift.available,
        pending: outcome.drift.pending,
      });
      if (outcome.blocked) report.blocked++;
    }
  }

  if (report.repaired > 0) {
    log.error(
      { checked: report.checked, repaired: report.repaired, blocked: report.blocked },
      'reconciliation found balance drift — repaired to the ledger and alerted',
    );
  } else {
    log.info({ checked: report.checked }, 'reconciliation clean');
  }

  return report;
}

/**
 * Reconcile one account, repairing the cache to the ledger-derived truth.
 *
 * Returns `blocked: true` when the account has now drifted twice in a row and
 * its redemption has been suspended pending investigation (§9.2).
 */
export async function reconcileAccount(accountId: string) {
  return prisma.$transaction(async (tx) => {
    await ledger.lockAccount(tx, accountId);
    const audit = await ledger.auditAccount(tx, accountId);

    if (audit.clean) {
      // A clean night resets the streak — only CONSECUTIVE mismatches block.
      if (audit.account.mismatchStreak > 0) {
        await tx.loyaltyAccount.update({
          where: { id: accountId },
          data: { mismatchStreak: 0, version: { increment: 1 } },
        });
      }
      return { clean: true, blocked: false, drift: audit.drift };
    }

    const streak = audit.account.mismatchStreak + 1;
    const blocked = streak >= 2;

    // Repair the CACHE to the derived truth. The ledger is never edited.
    await tx.loyaltyAccount.update({
      where: { id: accountId },
      data: {
        availableCoins: audit.derived.available,
        pendingCoins: audit.derived.pending,
        lockedCoins: audit.derived.locked,
        mismatchStreak: streak,
        // §9.2: two consecutive mismatches block redemption until investigated.
        redeemEnabled: blocked ? false : audit.account.redeemEnabled,
        version: { increment: 1 },
      },
    });

    // The correction is itself a ledger entry, so the drift is visible in
    // history rather than smoothed away.
    await ledger.post(tx, {
      accountId,
      coinsDelta: 0,
      reason: CoinReason.RECONCILE,
      idempotencyKey: `reconcile:${accountId}:${Date.now()}`,
      note:
        `Balance repaired to ledger. Drift: available ${audit.drift.available}, ` +
        `pending ${audit.drift.pending}, locked ${audit.drift.locked}.` +
        (blocked ? ' Redemption blocked after two consecutive mismatches.' : ''),
    });

    log.error(
      { accountId, drift: audit.drift, streak, blocked },
      'account balance drifted from the ledger',
    );

    return { clean: false, blocked, drift: audit.drift };
  });
}

/**
 * Replay queued earning events (§8.1 #11, §9).
 *
 * The inbox is what makes "fail open on earning" safe: a checkout that could not
 * reach the loyalty service queues the event and returns, and this drains the
 * queue afterwards. Attempts are capped so a permanently bad event surfaces as
 * an exception rather than retrying forever.
 */
export async function replayInbox(limit = 100): Promise<{ processed: number; failed: number }> {
  const pending = await prisma.loyaltyEventInbox.findMany({
    where: { status: 'PENDING', attempts: { lt: 5 } },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  let processed = 0;
  let failed = 0;

  for (const event of pending) {
    try {
      if (event.kind === 'EARN_ORDER') {
        const { orderId } = event.payload as { orderId: string };
        const earn = await import('./earn.service');
        await prisma.$transaction((tx) => earn.earnForOrder(tx, orderId));
      }
      await prisma.loyaltyEventInbox.update({
        where: { id: event.id },
        data: { status: 'DONE', processedAt: new Date() },
      });
      processed++;
    } catch (err) {
      failed++;
      await prisma.loyaltyEventInbox.update({
        where: { id: event.id },
        data: {
          attempts: { increment: 1 },
          lastError: err instanceof Error ? err.message : String(err),
          status: event.attempts + 1 >= 5 ? 'FAILED' : 'PENDING',
        },
      });
      log.error({ err, eventId: event.eventId }, 'inbox replay failed');
    }
  }

  return { processed, failed };
}
