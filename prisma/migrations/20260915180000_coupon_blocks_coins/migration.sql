-- ============================================================================
-- Per-coupon Zewa Coins block — ZSOP004 §4.
--
-- "Coupon stacking: allowed — coupon first, coins second. With a per-coupon
-- block flag for aggressive promotions."
--
-- Additive and non-destructive: NOT NULL with a DEFAULT false, so every
-- existing coupon keeps the programme's normal behaviour (§4 permits stacking)
-- and no backfill is needed. Opting a promotion out is a deliberate act.
--
-- Deliberately a separate column rather than a new `CouponStacking` value:
-- that enum governs which COUPONS may ride together, which is a different
-- question from whether COINS may be spent alongside one of them.
-- ============================================================================

-- AlterTable
ALTER TABLE "Coupon" ADD COLUMN     "blocksCoins" BOOLEAN NOT NULL DEFAULT false;

