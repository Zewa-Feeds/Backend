-- Influencer affiliate programme.
--
-- Entirely ADDITIVE: a new enum value, a new table, and nullable columns. No
-- existing row changes meaning, and the currently-deployed code ignores all of
-- it, so this can be applied before the code that reads it ships.

-- A coupon that rides alongside any stack but never beside another of its kind.
ALTER TYPE "CouponStacking" ADD VALUE IF NOT EXISTS 'GLOBALLY_STACKABLE';

CREATE TYPE "InfluencerStatus" AS ENUM ('ACTIVE', 'INACTIVE');

CREATE TABLE "Influencer" (
    "id"            TEXT NOT NULL,
    "name"          TEXT NOT NULL,
    "email"         TEXT,
    "phone"         TEXT,
    "socialHandle"  TEXT,
    "notes"         TEXT,
    "status"        "InfluencerStatus" NOT NULL DEFAULT 'ACTIVE',
    "deactivatedAt" TIMESTAMP(3),
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Influencer_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Influencer_status_createdAt_idx" ON "Influencer"("status", "createdAt");
CREATE INDEX "Influencer_name_idx" ON "Influencer"("name");

-- Coupon: the affiliate link, and whether the code may be advertised publicly.
-- showAtCheckout defaults to FALSE so no existing code starts being published.
ALTER TABLE "Coupon"
  ADD COLUMN "influencerId"   TEXT,
  ADD COLUMN "showAtCheckout" BOOLEAN NOT NULL DEFAULT false;

-- Restrict, not Cascade: deleting an affiliate must never silently delete the
-- coupon that historical orders were attributed through.
ALTER TABLE "Coupon"
  ADD CONSTRAINT "Coupon_influencerId_fkey" FOREIGN KEY ("influencerId")
  REFERENCES "Influencer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "Coupon_influencerId_idx" ON "Coupon"("influencerId");
CREATE INDEX "Coupon_showAtCheckout_isActive_startsAt_endsAt_idx"
  ON "Coupon"("showAtCheckout", "isActive", "startsAt", "endsAt");

-- Order: the immutable attribution snapshot. Deliberately NOT a foreign key —
-- these columns are the record of what was true at purchase, and must survive
-- the influencer being renamed, re-rated or deactivated afterwards.
ALTER TABLE "Order"
  ADD COLUMN "influencerId"            TEXT,
  ADD COLUMN "influencerName"          TEXT,
  ADD COLUMN "influencerCouponCode"    TEXT,
  ADD COLUMN "influencerDiscountPct"   INTEGER,
  ADD COLUMN "influencerDiscountPaise" INTEGER,
  ADD COLUMN "influencerAppliedAt"     TIMESTAMP(3);

CREATE INDEX "Order_influencerId_placedAt_idx" ON "Order"("influencerId", "placedAt");
