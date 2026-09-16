-- Coupons are no longer deletable: a coupon is the record of a promotion that
-- ran, and its redemptions and revenue hang off the row. Disabling replaces
-- deleting, so previously "deleted" coupons come back as disabled rather than
-- staying invisible.
--
-- Restore only where the code is free. `code` is UNIQUE, and create() allowed a
-- soft-deleted code to be reused, so a clashing row must stay hidden or the
-- statement would fail. Those keep deletedAt and remain out of the CMS.
UPDATE "Coupon" AS c
SET "deletedAt" = NULL,
    "isActive"  = false
WHERE c."deletedAt" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "Coupon" AS live
    WHERE live."code" = c."code"
      AND live."deletedAt" IS NULL
  );
