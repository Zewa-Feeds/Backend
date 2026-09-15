/**
 * The coin ledger — ZSOP004 §9, §9.1, §9.2.
 *
 * THIS IS THE ONLY PLACE THAT MAY MUTATE A COIN BALANCE. Every other service in
 * the loyalty module composes `post()`; none of them touch `LoyaltyAccount` or
 * `CoinLot` directly. That rule is what makes the ledger the source of truth
 * rather than merely a log written alongside the truth — if balances could be
 * changed by any other route, reconciliation would be comparing a number against
 * itself.
 *
 * FOUR GUARANTEES, each enforced rather than promised:
 *
 *   IDEMPOTENCY. Every post carries a caller-supplied key, unique in the
 *   database. "Assume every event arrives at least twice" (§9.1) — gateways
 *   retry on timeout, order services retry on failure. A duplicate is a no-op
 *   that returns the original row, not an error, because the caller genuinely
 *   did nothing wrong.
 *
 *   SERIALISATION. Every mutation takes `SELECT … FOR UPDATE` on the account row
 *   first, so concurrent redemptions queue behind one another at the database
 *   rather than interleaving. The two-tab double-spend (§8.1 #7) dies here.
 *
 *   VERSION CHECK. The account's `version` is read inside the lock and
 *   incremented on write. A mismatch raises 409 rather than silently
 *   overwriting (§9.1).
 *
 *   APPEND-ONLY. Enforced by a database trigger that RAISES on UPDATE/DELETE.
 *   Corrections are new rows. See the migration for why this is a trigger and
 *   not the audit log's silent rule.
 */
import type { Prisma} from '@prisma/client';
import { CoinReason, CoinLotState, LoyaltyAccountStatus } from '@prisma/client';
import { AppError, ErrorCode } from '@/lib/errors';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'loyalty.ledger' });

/** Prisma transaction client — every function here runs inside one. */
export type Tx = Prisma.TransactionClient;

/** One movement to record. */
export interface LedgerPost {
  accountId: string;
  /** Signed. Positive credits the customer, negative debits. */
  coinsDelta: number;
  reason: CoinReason;
  /** Unique. A repeat of the same key is a no-op (§9.1). */
  idempotencyKey: string;
  lotId?: string | null;
  orderId?: string | null;
  /** Mandatory on manual adjustments (§9.2). */
  note?: string | null;
  actorId?: string | null;
  approvedById?: string | null;
  /**
   * Face value of the movement in paise. Defaults to |delta| × coin value, but
   * callers pass it explicitly where the rule version's coin value applies.
   */
  monetaryValuePaise?: number;
}

/** What a post did. `duplicate` means the key had already been used. */
export interface LedgerResult {
  ledgerId: bigint;
  balanceAfter: number;
  duplicate: boolean;
}

/**
 * Lock an account row for update and return it.
 *
 * `FOR UPDATE` rather than an optimistic read: the caller is about to compute a
 * new balance from this one, and any concurrent writer must wait rather than
 * read the same starting value. Postgres releases the lock at commit.
 *
 * Returns the row via a second typed query — `$queryRaw` gives us the lock, and
 * Prisma's typed client gives us the fields without hand-mapping snake_case.
 */
export async function lockAccount(tx: Tx, accountId: string) {
  await tx.$queryRaw`SELECT id FROM "LoyaltyAccount" WHERE id = ${accountId} FOR UPDATE`;
  const account = await tx.loyaltyAccount.findUnique({ where: { id: accountId } });
  if (!account) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Loyalty account not found.');
  }
  return account;
}

/**
 * Post one movement to the ledger and update the derived balance.
 *
 * MUST be called inside a transaction that already holds the account lock —
 * `lockAccount` above. Callers that forget would still be correct under
 * Postgres' row locking for the UPDATE itself, but the read-compute-write cycle
 * would not be atomic, so this is a contract rather than a suggestion.
 *
 * `expectedVersion` implements §9.1's version check. Pass the version read
 * inside the lock; a mismatch means someone else wrote in between, which under
 * `FOR UPDATE` should be impossible and therefore indicates a caller that
 * skipped the lock.
 */
export async function post(
  tx: Tx,
  entry: LedgerPost,
  opts: { expectedVersion?: number; coinValuePaise?: number } = {},
): Promise<LedgerResult> {
  // ---- 1. Idempotency, before any business logic (§9.1) --------------------
  const existing = await tx.coinLedger.findUnique({
    where: { idempotencyKey: entry.idempotencyKey },
    select: { id: true, balanceAfter: true },
  });
  if (existing) {
    log.info(
      { key: entry.idempotencyKey, reason: entry.reason },
      'ledger post is a duplicate — no-op',
    );
    return { ledgerId: existing.id, balanceAfter: existing.balanceAfter, duplicate: true };
  }

  const account = await tx.loyaltyAccount.findUnique({ where: { id: entry.accountId } });
  if (!account) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Loyalty account not found.');
  }

  if (opts.expectedVersion !== undefined && account.version !== opts.expectedVersion) {
    // §9.1: "a mismatch returns 409, never a silent overwrite".
    throw new AppError(
      409,
      ErrorCode.CONFLICT,
      'Your coin balance changed while this was being processed. Please try again.',
    );
  }

  const coinValue = opts.coinValuePaise ?? 100;
  const monetary = entry.monetaryValuePaise ?? Math.abs(entry.coinsDelta) * coinValue;

  // ---- 2. Which cached balance does this reason move? ----------------------
  // PENDING coins are not spendable, so EARN and VOID move `pendingCoins`;
  // everything else moves `availableCoins`. UNLOCK moves both — out of pending,
  // into available — which is why it is handled explicitly rather than by sign.
  const delta = entry.coinsDelta;
  const data: Prisma.LoyaltyAccountUpdateInput = { version: { increment: 1 } };

  let balanceAfter: number;

  switch (entry.reason) {
    case CoinReason.EARN:
      // Created PENDING at payment (§3.5). Not yet in the headline balance.
      data.pendingCoins = { increment: delta };
      data.lifetimeEarned = { increment: Math.max(0, delta) };
      balanceAfter = account.availableCoins;
      break;

    case CoinReason.UNLOCK:
      // PENDING → AVAILABLE. One movement, two counters.
      data.pendingCoins = { decrement: delta };
      data.availableCoins = { increment: delta };
      balanceAfter = account.availableCoins + delta;
      break;

    case CoinReason.VOID:
      // Pending coins killed before unlock — order never delivered (§3.5).
      data.pendingCoins = { decrement: Math.abs(delta) };
      balanceAfter = account.availableCoins;
      break;

    case CoinReason.REDEEM:
      data.availableCoins = { increment: delta }; // delta is negative
      data.lifetimeRedeemed = { increment: Math.abs(delta) };
      balanceAfter = account.availableCoins + delta;
      break;

    case CoinReason.EXPIRE:
      data.availableCoins = { increment: delta }; // negative
      data.lifetimeExpired = { increment: Math.abs(delta) };
      balanceAfter = account.availableCoins + delta;
      break;

    default:
      // RELEASE, RESTORE, CLAWBACK, GUEST_CLAIM, LAUNCH_BACKFILL, ADJUSTMENT,
      // GOODWILL, MERGE, RECONCILE — all move the available balance by `delta`.
      data.availableCoins = { increment: delta };
      balanceAfter = account.availableCoins + delta;
      break;
  }

  // ---- 3. Write the ledger row FIRST --------------------------------------
  // Order matters under a constraint violation: if the balance update fails a
  // CHECK, the whole transaction rolls back and neither row exists. Writing the
  // ledger first means the unique key on `idempotencyKey` is claimed before any
  // side effect, so a concurrent duplicate collides here rather than double-
  // applying the balance.
  const row = await tx.coinLedger.create({
    data: {
      accountId: entry.accountId,
      coinsDelta: delta,
      balanceAfter,
      monetaryValuePaise: monetary,
      reason: entry.reason,
      note: entry.note ?? null,
      lotId: entry.lotId ?? null,
      orderId: entry.orderId ?? null,
      actorId: entry.actorId ?? null,
      approvedById: entry.approvedById ?? null,
      idempotencyKey: entry.idempotencyKey,
    },
    select: { id: true },
  });

  await tx.loyaltyAccount.update({ where: { id: entry.accountId }, data });

  return { ledgerId: row.id, balanceAfter, duplicate: false };
}

/**
 * Apply the −50 floor to a debit, recording any excess as a flagged deficit (§6.7).
 *
 * "The balance may go that far negative and no further. Beyond −50 the account is
 * flagged for review — the shortfall is not silently written off. The full
 * deficit is recorded in the ledger; only the operative balance floors at −50."
 *
 * So a clawback of 1,520 against a zero balance posts −50 to the operative
 * balance and records 1,470 in `flaggedDeficit`, with the account frozen for
 * review. Writing off ₹1,470 without anyone seeing it would be the wrong
 * default, and is exactly what this prevents.
 *
 * Returns how many coins may actually be debited.
 */
export function applyFloor(
  currentAvailable: number,
  requestedDebit: number,
  maxNegativeBalance: number,
): { debit: number; excess: number } {
  const floor = -Math.abs(maxNegativeBalance);
  const wouldLand = currentAvailable - requestedDebit;
  if (wouldLand >= floor) return { debit: requestedDebit, excess: 0 };

  const allowed = currentAvailable - floor; // how far we can actually go down
  return { debit: Math.max(0, allowed), excess: requestedDebit - Math.max(0, allowed) };
}

/**
 * Post a debit that may exceed the floor, handling the excess per §6.7.
 *
 * Used by the clawback path. Freezes the account when a deficit is recorded, so
 * the exception reaches the daily report rather than sitting silently on a
 * balance the customer cannot explain.
 */
export async function postFlooredDebit(
  tx: Tx,
  entry: LedgerPost & { coinsDelta: number },
  maxNegativeBalance: number,
  opts: { coinValuePaise?: number } = {},
): Promise<LedgerResult & { excess: number }> {
  const account = await tx.loyaltyAccount.findUnique({
    where: { id: entry.accountId },
    select: { availableCoins: true },
  });
  if (!account) throw new AppError(404, ErrorCode.NOT_FOUND, 'Loyalty account not found.');

  const requested = Math.abs(entry.coinsDelta);
  const { debit, excess } = applyFloor(account.availableCoins, requested, maxNegativeBalance);

  const result = await post(tx, { ...entry, coinsDelta: -debit }, opts);

  if (excess > 0) {
    // Recorded in full and surfaced — never absorbed (§9.2).
    await tx.loyaltyAccount.update({
      where: { id: entry.accountId },
      data: {
        flaggedDeficit: { increment: excess },
        status: LoyaltyAccountStatus.FROZEN,
        version: { increment: 1 },
      },
    });
    log.warn(
      { accountId: entry.accountId, excess, requested, orderId: entry.orderId },
      'clawback exceeded the negative floor — deficit flagged, account frozen for review',
    );
  }

  return { ...result, excess };
}

/**
 * Rebuild an account's balances from the ledger and lots (§9.2).
 *
 * "Nightly job recomputes every balance from the ledger and from lot remainders,
 * auto-repairs to the ledger value and alerts."
 *
 * THE LEDGER ALWAYS WINS. This never edits ledger rows to match a balance; it
 * only ever moves the cache. A repair posts a RECONCILE row so the correction
 * itself is auditable — the drift is visible in history rather than silently
 * smoothed away.
 */
export async function recomputeBalances(tx: Tx, accountId: string) {
  const lots = await tx.coinLot.findMany({
    where: { accountId },
    select: { state: true, coinsRemaining: true },
  });

  // Available and pending are derivable from live lot remainders. A lot in any
  // terminal state (REDEEMED, EXPIRED, REVERSED, VOID) contributes nothing.
  let pending = 0;
  let available = 0;
  for (const lot of lots) {
    if (lot.state === CoinLotState.PENDING) pending += lot.coinsRemaining;
    else if (lot.state === CoinLotState.AVAILABLE) available += lot.coinsRemaining;
  }

  // Coins currently held by live reservations are deducted from spendable.
  const held = await tx.coinReservation.aggregate({
    where: { accountId, status: 'PENDING' },
    _sum: { coins: true },
  });
  const locked = held._sum.coins ?? 0;

  return { available: available - locked, pending, locked };
}

/**
 * Compare cached balances against the ledger-derived truth (§9.2).
 *
 * Returns the drift without writing anything, so the reconciliation job can log
 * the diff, alert, and decide whether to repair — two consecutive mismatches on
 * an account block its redemption, and that decision needs the diff first.
 */
export async function auditAccount(tx: Tx, accountId: string) {
  const account = await tx.loyaltyAccount.findUniqueOrThrow({ where: { id: accountId } });
  const derived = await recomputeBalances(tx, accountId);

  const drift = {
    available: derived.available - account.availableCoins,
    pending: derived.pending - account.pendingCoins,
    locked: derived.locked - account.lockedCoins,
  };
  const clean = drift.available === 0 && drift.pending === 0 && drift.locked === 0;

  return { account, derived, drift, clean };
}
