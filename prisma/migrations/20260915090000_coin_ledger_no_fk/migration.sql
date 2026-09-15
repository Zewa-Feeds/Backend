-- ============================================================================
-- Coin ledger: drop the foreign keys that made orders undeletable.
--
-- The ledger's order/lot/actor columns were created with `onDelete: SET NULL`.
-- SET NULL is implemented as an UPDATE on the referencing row, so deleting an
-- order made Postgres attempt to rewrite that order's ledger entries — and the
-- append-only trigger correctly refused, with:
--
--   ERROR: CoinLedger is append-only: UPDATE rejected.
--
-- The result was that any order with coin history could never be deleted. The
-- trigger was right; the foreign keys were wrong.
--
-- A financial record must outlive what it refers to. ZSOP004 §9.2 retains the
-- ledger for 8 years "even after PII is anonymised on account deletion", so an
-- entry has to remain readable once its order is purged or the staff member who
-- made an adjustment has left the company. These columns therefore become plain
-- ids, resolved by lookup rather than join; a missing target renders as
-- "no longer available" instead of silently rewriting history.
--
-- `accountId` KEEPS its cascade: a ledger entry belonging to no account is not a
-- historical record, it is an orphan.
-- ============================================================================

-- DropForeignKey
ALTER TABLE "CoinLedger" DROP CONSTRAINT "CoinLedger_actorId_fkey";

-- DropForeignKey
ALTER TABLE "CoinLedger" DROP CONSTRAINT "CoinLedger_approvedById_fkey";

-- DropForeignKey
ALTER TABLE "CoinLedger" DROP CONSTRAINT "CoinLedger_lotId_fkey";

-- DropForeignKey
ALTER TABLE "CoinLedger" DROP CONSTRAINT "CoinLedger_orderId_fkey";

