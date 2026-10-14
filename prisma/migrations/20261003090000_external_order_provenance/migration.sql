-- Provenance for customers and orders migrated from another platform (the
-- Dukaan store that ran zewafeeds.com until Sep 2026). All nullable: every
-- existing row, and every row created by this site, leaves them NULL.
--
-- The (source, ref) pairs are unique so the import is idempotent. Postgres
-- treats NULLs as distinct, so native rows never collide with each other.
ALTER TABLE "Customer" ADD COLUMN "externalSource" TEXT;
ALTER TABLE "Customer" ADD COLUMN "externalRef" TEXT;
CREATE UNIQUE INDEX "Customer_externalSource_externalRef_key" ON "Customer"("externalSource", "externalRef");

ALTER TABLE "Order" ADD COLUMN "externalSource" TEXT;
ALTER TABLE "Order" ADD COLUMN "externalRef" TEXT;
-- Every exported column of every line item, verbatim, for audit.
ALTER TABLE "Order" ADD COLUMN "externalData" JSONB;
CREATE UNIQUE INDEX "Order_externalSource_externalRef_key" ON "Order"("externalSource", "externalRef");
