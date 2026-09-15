-- ============================================================================
-- Monthly earning cap and per-customer overrides — ZSOP004 §3.3.
--
-- §3.3 lists "monthly earn cap not exceeded" among the earning gates but names
-- no figure; the value is a business decision. It lives on the rule version so
-- it is changeable from the CMS without a deployment, and so historical orders
-- keep the cap they were earned under (§8.4 #35).
--
-- `CustomerEarnCapOverride` is deliberately GENERIC — a cap, a reason, an
-- optional expiry — rather than a "wholesale" flag. The exception that needs a
-- higher cap today is a wholesale buyer; the next will be something else.
--
-- Additive and non-destructive: the new column carries a DEFAULT so existing
-- rule versions need no backfill, and the new table starts empty.
-- ============================================================================

-- AlterTable
ALTER TABLE "LoyaltyRuleVersion" ADD COLUMN     "monthlyEarnCapCoins" INTEGER NOT NULL DEFAULT 1000;

-- CreateTable
CREATE TABLE "CustomerEarnCapOverride" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "monthlyCapCoins" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerEarnCapOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerEarnCapOverride_customerId_revokedAt_expiresAt_idx" ON "CustomerEarnCapOverride"("customerId", "revokedAt", "expiresAt");

-- AddForeignKey
ALTER TABLE "CustomerEarnCapOverride" ADD CONSTRAINT "CustomerEarnCapOverride_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerEarnCapOverride" ADD CONSTRAINT "CustomerEarnCapOverride_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "CmsUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

