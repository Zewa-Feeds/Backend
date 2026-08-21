-- Backfill publishedAt for products that went live without ever being published.
--
-- WHY THESE ROWS HAVE NO DATE
--
-- The catalogue import wrote 10 products straight to status ACTIVE instead of
-- going through publish(), so no publication event was ever recorded. The audit
-- log confirms it: zero publish entries and zero status changes for all ten,
-- against three publish entries for the three products that do carry a date.
--
-- WHY createdAt IS THE RIGHT VALUE AND NOT AN INVENTED ONE
--
-- `publishedAt` means "the moment this product's content first became
-- customer-visible". The storefront decides visibility from `status` alone — it
-- has never consulted this column — so a product created ACTIVE was visible from
-- the instant its row existed. createdAt is therefore a reading of when that
-- happened, not a guess at it.
--
-- WHY IT MATTERS BEYOND TIDINESS
--
-- The slug lock ("editable only before first publish") reads this column, so
-- these ten public products currently have rewritable URLs.
--
-- SCOPE
--
-- Only rows that are customer-visible, have no date, and are not soft-deleted.
-- COMING_SOON counts: it is a listed, linkable, indexable page. DRAFT, INACTIVE
-- and DISCONTINUED are invisible and must keep their NULL — a product that has
-- never been seen has never been published.
--
-- Idempotent by construction: the WHERE clause excludes anything already
-- stamped, so re-running changes nothing.

UPDATE "ProductFamily"
SET "publishedAt" = "createdAt"
WHERE "publishedAt" IS NULL
  AND "deletedAt" IS NULL
  AND "status" IN ('ACTIVE', 'COMING_SOON');
