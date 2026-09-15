-- ============================================================================
-- Z-COIN LOYALTY PROGRAMME — ZSOP004 v3.3
--
-- Adds the seven loyalty models, line-level returns, customer phone OTP, and
-- the per-line allocation snapshots the reversal engine depends on.
--
-- The generated DDL is followed by hand-written integrity guards (search for
-- "INTEGRITY GUARDS" below). Those are the part that matters: they make the
-- ledger's append-only promise and the non-negative-lot invariant structurally
-- true rather than a convention the application is trusted to honour.
-- ============================================================================

-- CreateEnum
CREATE TYPE "CoinLotState" AS ENUM ('PENDING', 'AVAILABLE', 'REDEEMED', 'EXPIRED', 'REVERSED', 'VOID');

-- CreateEnum
CREATE TYPE "CoinReason" AS ENUM ('EARN', 'UNLOCK', 'REDEEM', 'RELEASE', 'EXPIRE', 'RESTORE', 'CLAWBACK', 'VOID', 'GUEST_CLAIM', 'LAUNCH_BACKFILL', 'ADJUSTMENT', 'GOODWILL', 'MERGE', 'RECONCILE');

-- CreateEnum
CREATE TYPE "LoyaltyAccountStatus" AS ENUM ('ACTIVE', 'FROZEN', 'MERGED');

-- CreateEnum
CREATE TYPE "CoinSourceType" AS ENUM ('ORDER', 'LAUNCH_BACKFILL', 'GUEST_CLAIM', 'MANUAL', 'MERGE');

-- CreateEnum
CREATE TYPE "ReturnKind" AS ENUM ('CANCELLATION', 'RETURN', 'RTO', 'EXCHANGE');

-- CreateEnum
CREATE TYPE "ReturnStatus" AS ENUM ('REQUESTED', 'APPROVED', 'COMPLETED', 'REJECTED');

-- AlterEnum
-- Guarded: production already carries this label (added outside migration
-- history via `db push`), so an unguarded ADD VALUE fails with 42710. The guard
-- makes this a no-op there and still creates the label on a fresh database.
ALTER TYPE "CmsUserStatus" ADD VALUE IF NOT EXISTS 'INVITED';

-- AlterTable
-- Guarded for the same reason as the enum above: both columns already exist in
-- production but in no migration.
ALTER TABLE "CmsUser" ADD COLUMN IF NOT EXISTS "activatedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "phone" TEXT;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "phoneVerifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "allocatedCoinDiscountPaise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "allocatedCoins" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "allocatedCouponDiscountPaise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "coinRedeemable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "earnEligible" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "preTaxNetPaidPaise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "returnedQty" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ProductVariant" ADD COLUMN     "coinRedeemable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "earnEligible" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
-- Guarded: this table already exists in production but in no migration.
CREATE TABLE IF NOT EXISTS "CmsInvitation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "invitedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CmsInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyAccount" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "phone" TEXT,
    "status" "LoyaltyAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "availableCoins" INTEGER NOT NULL DEFAULT 0,
    "pendingCoins" INTEGER NOT NULL DEFAULT 0,
    "lockedCoins" INTEGER NOT NULL DEFAULT 0,
    "lifetimeEarned" INTEGER NOT NULL DEFAULT 0,
    "lifetimeRedeemed" INTEGER NOT NULL DEFAULT 0,
    "lifetimeExpired" INTEGER NOT NULL DEFAULT 0,
    "flaggedDeficit" INTEGER NOT NULL DEFAULT 0,
    "earnEnabled" BOOLEAN NOT NULL DEFAULT true,
    "redeemEnabled" BOOLEAN NOT NULL DEFAULT true,
    "holdout" BOOLEAN NOT NULL DEFAULT false,
    "rtoCount90d" INTEGER NOT NULL DEFAULT 0,
    "rtoWindowAt" TIMESTAMP(3),
    "mismatchStreak" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoinLot" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "coinsGranted" INTEGER NOT NULL,
    "coinsRemaining" INTEGER NOT NULL,
    "state" "CoinLotState" NOT NULL DEFAULT 'PENDING',
    "sourceType" "CoinSourceType" NOT NULL DEFAULT 'ORDER',
    "orderId" TEXT,
    "earnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "maturesAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "parentLotId" TEXT,
    "ruleVersionId" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoinLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoinLedger" (
    "id" BIGSERIAL NOT NULL,
    "accountId" TEXT NOT NULL,
    "coinsDelta" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "monetaryValuePaise" INTEGER NOT NULL,
    "reason" "CoinReason" NOT NULL,
    "note" TEXT,
    "lotId" TEXT,
    "orderId" TEXT,
    "actorId" TEXT,
    "approvedById" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoinLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLoyalty" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "accountId" TEXT,
    "ruleVersionId" TEXT NOT NULL,
    "preTaxEarnBasePaise" INTEGER NOT NULL DEFAULT 0,
    "coinsGrantedCurrent" INTEGER NOT NULL DEFAULT 0,
    "grantState" "CoinLotState" NOT NULL DEFAULT 'PENDING',
    "coinsRedeemed" INTEGER NOT NULL DEFAULT 0,
    "coinsAlreadyRestored" INTEGER NOT NULL DEFAULT 0,
    "redemptionLotMap" JSONB,
    "coinDiscountPaise" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderLoyalty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyRuleVersion" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "earnGranularityPaise" INTEGER NOT NULL DEFAULT 5000,
    "coinsPerStep" INTEGER NOT NULL DEFAULT 1,
    "minEarnBasePaise" INTEGER NOT NULL DEFAULT 5000,
    "coinValuePaise" INTEGER NOT NULL DEFAULT 100,
    "minRedemptionCoins" INTEGER NOT NULL DEFAULT 10,
    "maxRedemptionPct" INTEGER NOT NULL DEFAULT 100,
    "returnWindowDays" INTEGER NOT NULL DEFAULT 7,
    "expiryDays" INTEGER NOT NULL DEFAULT 365,
    "largeOrderThresholdPaise" INTEGER NOT NULL DEFAULT 2000000,
    "largeOrderHoldDays" INTEGER NOT NULL DEFAULT 14,
    "stuckShipmentDays" INTEGER NOT NULL DEFAULT 21,
    "stuckGraceDays" INTEGER NOT NULL DEFAULT 7,
    "reservationTtlMinutes" INTEGER NOT NULL DEFAULT 30,
    "maxNegativeBalance" INTEGER NOT NULL DEFAULT 50,
    "graceLotDays" INTEGER NOT NULL DEFAULT 30,
    "guestClaimDays" INTEGER NOT NULL DEFAULT 30,
    "backfillExpiryDays" INTEGER NOT NULL DEFAULT 90,
    "otpThresholdCoins" INTEGER NOT NULL DEFAULT 500,
    "approvalThresholdCoins" INTEGER NOT NULL DEFAULT 500,
    "rtoLimit" INTEGER NOT NULL DEFAULT 3,
    "earningEnabled" BOOLEAN NOT NULL DEFAULT true,
    "redemptionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "rolloutPct" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyRuleVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyEventInbox" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyEventInbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoinReservation" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "coins" INTEGER NOT NULL,
    "orderId" TEXT,
    "cartKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "lotMap" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoinReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderReturn" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" "ReturnKind" NOT NULL,
    "status" "ReturnStatus" NOT NULL DEFAULT 'REQUESTED',
    "reason" TEXT,
    "sourceEventId" TEXT NOT NULL,
    "cashRefundPaise" INTEGER NOT NULL DEFAULT 0,
    "processedById" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderReturn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderReturnLine" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "coinsRestored" INTEGER NOT NULL DEFAULT 0,
    "cashRefundPaise" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "OrderReturnLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerPhoneOtp" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "otpHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'VERIFY_PHONE',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerPhoneOtp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Guarded: these four indexes already exist in production but in no migration.
CREATE UNIQUE INDEX IF NOT EXISTS "CmsInvitation_userId_key" ON "CmsInvitation"("userId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CmsInvitation_tokenHash_key" ON "CmsInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CmsInvitation_tokenHash_idx" ON "CmsInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CmsInvitation_userId_idx" ON "CmsInvitation"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyAccount_customerId_key" ON "LoyaltyAccount"("customerId");

-- CreateIndex
CREATE INDEX "LoyaltyAccount_status_idx" ON "LoyaltyAccount"("status");

-- CreateIndex
CREATE INDEX "LoyaltyAccount_holdout_idx" ON "LoyaltyAccount"("holdout");

-- CreateIndex
CREATE INDEX "LoyaltyAccount_availableCoins_idx" ON "LoyaltyAccount"("availableCoins");

-- CreateIndex
CREATE INDEX "CoinLot_accountId_state_expiresAt_idx" ON "CoinLot"("accountId", "state", "expiresAt");

-- CreateIndex
CREATE INDEX "CoinLot_state_maturesAt_idx" ON "CoinLot"("state", "maturesAt");

-- CreateIndex
CREATE INDEX "CoinLot_state_expiresAt_idx" ON "CoinLot"("state", "expiresAt");

-- CreateIndex
CREATE INDEX "CoinLot_orderId_idx" ON "CoinLot"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "CoinLedger_idempotencyKey_key" ON "CoinLedger"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CoinLedger_accountId_createdAt_idx" ON "CoinLedger"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "CoinLedger_orderId_idx" ON "CoinLedger"("orderId");

-- CreateIndex
CREATE INDEX "CoinLedger_reason_createdAt_idx" ON "CoinLedger"("reason", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLoyalty_orderId_key" ON "OrderLoyalty"("orderId");

-- CreateIndex
CREATE INDEX "OrderLoyalty_accountId_idx" ON "OrderLoyalty"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyRuleVersion_label_key" ON "LoyaltyRuleVersion"("label");

-- CreateIndex
CREATE INDEX "LoyaltyRuleVersion_isActive_idx" ON "LoyaltyRuleVersion"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyEventInbox_eventId_key" ON "LoyaltyEventInbox"("eventId");

-- CreateIndex
CREATE INDEX "LoyaltyEventInbox_status_createdAt_idx" ON "LoyaltyEventInbox"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CoinReservation_orderId_key" ON "CoinReservation"("orderId");

-- CreateIndex
CREATE INDEX "CoinReservation_status_expiresAt_idx" ON "CoinReservation"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "CoinReservation_accountId_status_idx" ON "CoinReservation"("accountId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CoinReservation_accountId_cartKey_key" ON "CoinReservation"("accountId", "cartKey");

-- CreateIndex
CREATE UNIQUE INDEX "OrderReturn_sourceEventId_key" ON "OrderReturn"("sourceEventId");

-- CreateIndex
CREATE INDEX "OrderReturn_orderId_status_idx" ON "OrderReturn"("orderId", "status");

-- CreateIndex
CREATE INDEX "OrderReturn_status_createdAt_idx" ON "OrderReturn"("status", "createdAt");

-- CreateIndex
CREATE INDEX "OrderReturnLine_orderItemId_idx" ON "OrderReturnLine"("orderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderReturnLine_returnId_orderItemId_key" ON "OrderReturnLine"("returnId", "orderItemId");

-- CreateIndex
CREATE INDEX "CustomerPhoneOtp_customerId_purpose_idx" ON "CustomerPhoneOtp"("customerId", "purpose");

-- CreateIndex
CREATE INDEX "CustomerPhoneOtp_expiresAt_idx" ON "CustomerPhoneOtp"("expiresAt");

-- AddForeignKey
-- Guarded: these two constraints already exist in production but in no
-- migration. PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS, so the existence
-- check is explicit.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CmsInvitation_userId_fkey') THEN
    ALTER TABLE "CmsInvitation" ADD CONSTRAINT "CmsInvitation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "CmsUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CmsInvitation_invitedById_fkey') THEN
    ALTER TABLE "CmsInvitation" ADD CONSTRAINT "CmsInvitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "CmsUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
ALTER TABLE "LoyaltyAccount" ADD CONSTRAINT "LoyaltyAccount_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoinLot" ADD CONSTRAINT "CoinLot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LoyaltyAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoinLot" ADD CONSTRAINT "CoinLot_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoinLot" ADD CONSTRAINT "CoinLot_parentLotId_fkey" FOREIGN KEY ("parentLotId") REFERENCES "CoinLot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoinLot" ADD CONSTRAINT "CoinLot_ruleVersionId_fkey" FOREIGN KEY ("ruleVersionId") REFERENCES "LoyaltyRuleVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoinLedger" ADD CONSTRAINT "CoinLedger_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LoyaltyAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoinLedger" ADD CONSTRAINT "CoinLedger_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "CoinLot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoinLedger" ADD CONSTRAINT "CoinLedger_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoinLedger" ADD CONSTRAINT "CoinLedger_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "CmsUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoinLedger" ADD CONSTRAINT "CoinLedger_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "CmsUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLoyalty" ADD CONSTRAINT "OrderLoyalty_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLoyalty" ADD CONSTRAINT "OrderLoyalty_ruleVersionId_fkey" FOREIGN KEY ("ruleVersionId") REFERENCES "LoyaltyRuleVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyRuleVersion" ADD CONSTRAINT "LoyaltyRuleVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "CmsUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoinReservation" ADD CONSTRAINT "CoinReservation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LoyaltyAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderReturn" ADD CONSTRAINT "OrderReturn_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderReturn" ADD CONSTRAINT "OrderReturn_processedById_fkey" FOREIGN KEY ("processedById") REFERENCES "CmsUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderReturnLine" ADD CONSTRAINT "OrderReturnLine_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "OrderReturn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderReturnLine" ADD CONSTRAINT "OrderReturnLine_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPhoneOtp" ADD CONSTRAINT "CustomerPhoneOtp_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================================
-- INTEGRITY GUARDS (§9.1, §9.2)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The coin ledger is append-only, and says so LOUDLY.
--
-- The existing AuditLog rule uses DO INSTEAD NOTHING, which silently discards
-- the write. That is the right call for an audit log: a stray ORM write should
-- not be able to take the API down, and a lost log line is an inconvenience.
--
-- It is the WRONG call here. This is a financial record. A silently discarded
-- ledger write leaves the cached balance disagreeing with history, with nothing
-- to show that it happened — exactly the class of bug reconciliation exists to
-- catch, arriving through the door reconciliation trusts. §9.2 is explicit that
-- a bad write must "fail loudly rather than quietly creating value".
--
-- A trigger is used rather than a RULE because RULEs can only rewrite a
-- statement, not raise. To legitimately prune under the 8-year retention policy
-- (§9.2), drop the trigger inside a transaction, delete, and recreate it — a
-- deliberate, reviewable act.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION coin_ledger_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'CoinLedger is append-only: % rejected. Post a correcting entry instead.',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER coin_ledger_no_update
  BEFORE UPDATE ON "CoinLedger"
  FOR EACH ROW EXECUTE FUNCTION coin_ledger_append_only();

CREATE TRIGGER coin_ledger_no_delete
  BEFORE DELETE ON "CoinLedger"
  FOR EACH ROW EXECUTE FUNCTION coin_ledger_append_only();

-- ---------------------------------------------------------------------------
-- 2. A lot can never hand out more than it holds (§9.1).
--
-- "If application logic is ever wrong, the write fails loudly rather than
-- quietly creating value." coinsRemaining is the only mutable quantity on a
-- lot; coinsGranted is immutable by convention and this keeps the pair coherent.
-- ---------------------------------------------------------------------------
ALTER TABLE "CoinLot"
  ADD CONSTRAINT "CoinLot_coinsRemaining_nonnegative"
  CHECK ("coinsRemaining" >= 0);

ALTER TABLE "CoinLot"
  ADD CONSTRAINT "CoinLot_coinsRemaining_within_granted"
  CHECK ("coinsRemaining" <= "coinsGranted");

ALTER TABLE "CoinLot"
  ADD CONSTRAINT "CoinLot_coinsGranted_positive"
  CHECK ("coinsGranted" > 0);

-- ---------------------------------------------------------------------------
-- 3. Pending and locked balances can never go negative.
--
-- `availableCoins` is deliberately NOT constrained: §6.7 requires it to reach
-- -50 after a clawback against spent coins. The floor itself is enforced in the
-- service layer against the rule version's maxNegativeBalance, because it is a
-- configurable business rule rather than a structural invariant.
-- ---------------------------------------------------------------------------
ALTER TABLE "LoyaltyAccount"
  ADD CONSTRAINT "LoyaltyAccount_pending_nonnegative"
  CHECK ("pendingCoins" >= 0);

ALTER TABLE "LoyaltyAccount"
  ADD CONSTRAINT "LoyaltyAccount_locked_nonnegative"
  CHECK ("lockedCoins" >= 0);

ALTER TABLE "LoyaltyAccount"
  ADD CONSTRAINT "LoyaltyAccount_deficit_nonnegative"
  CHECK ("flaggedDeficit" >= 0);

-- ---------------------------------------------------------------------------
-- 4. A reservation always holds a positive number of coins.
-- ---------------------------------------------------------------------------
ALTER TABLE "CoinReservation"
  ADD CONSTRAINT "CoinReservation_coins_positive"
  CHECK ("coins" > 0);

-- ---------------------------------------------------------------------------
-- 5. Exactly one active rule version at a time (§9, §8.4 #35).
--
-- A partial unique index rather than application logic: two concurrent CMS
-- saves must not be able to leave two versions active, which would make "which
-- rules applied?" unanswerable for orders priced in between.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "LoyaltyRuleVersion_one_active"
  ON "LoyaltyRuleVersion" ("isActive")
  WHERE "isActive" = true;

-- ---------------------------------------------------------------------------
-- 6. Returned quantity can never exceed what was ordered (§7.3).
--
-- The assertion that stops repeated partial returns from unwinding more than
-- the order ever contained.
-- ---------------------------------------------------------------------------
ALTER TABLE "OrderItem"
  ADD CONSTRAINT "OrderItem_returnedQty_nonnegative"
  CHECK ("returnedQty" >= 0 AND "returnedQty" <= "qty");

ALTER TABLE "OrderReturnLine"
  ADD CONSTRAINT "OrderReturnLine_qty_positive"
  CHECK ("qty" > 0);

-- ---------------------------------------------------------------------------
-- 7. Seed rule version v1 (§13.2 — earning on, redemption OFF).
--
-- The programme launches accruing silently: earning enabled, redemption behind
-- the kill switch, rollout at 0%. Every default here is the value ZSOP004 §15.1
-- decided, so the seeded row IS the specification's configuration.
-- ---------------------------------------------------------------------------
INSERT INTO "LoyaltyRuleVersion" (
  id, label, "isActive",
  "earnGranularityPaise", "coinsPerStep", "minEarnBasePaise",
  "coinValuePaise", "minRedemptionCoins", "maxRedemptionPct",
  "returnWindowDays", "expiryDays",
  "largeOrderThresholdPaise", "largeOrderHoldDays",
  "stuckShipmentDays", "stuckGraceDays",
  "reservationTtlMinutes", "maxNegativeBalance", "graceLotDays",
  "guestClaimDays", "backfillExpiryDays",
  "otpThresholdCoins", "approvalThresholdCoins", "rtoLimit",
  "earningEnabled", "redemptionEnabled", "rolloutPct",
  "createdAt"
) VALUES (
  gen_random_uuid(), 'v1', true,
  5000, 1, 5000,
  100, 10, 100,
  7, 365,
  2000000, 14,
  21, 7,
  30, 50, 30,
  30, 90,
  500, 500, 3,
  true, false, 0,
  NOW()
);
