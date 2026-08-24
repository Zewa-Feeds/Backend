-- New discount kinds: free shipping, and buy-X-get-Y.
--
-- ALONE IN ITS OWN MIGRATION, deliberately. Postgres refuses to use a new enum
-- value in the same transaction that added it, and Prisma wraps each migration
-- file in one transaction. The migration that adds the columns and tables
-- referencing these values is the next one; splitting them is what makes both
-- appliable.
--
-- Purely additive. FLAT and PERCENTAGE are untouched, so every existing coupon
-- keeps its type and its behaviour.

ALTER TYPE "DiscountType" ADD VALUE 'FREE_SHIPPING';
ALTER TYPE "DiscountType" ADD VALUE 'BUY_X_GET_Y';
