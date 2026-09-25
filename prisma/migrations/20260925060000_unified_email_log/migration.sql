-- Unify OrderEmail into EmailLog.
--
-- Hand-written on purpose. `prisma migrate dev` renders a rename as DROP + CREATE,
-- which would discard every existing order-email row — the sent/failed history the
-- CMS already displays. ALTER ... RENAME preserves the table, its rows, its primary
-- key and its indexes.
--
-- Same approach as the ProductMedia rename.

-- 1. A skipped send is not a failed one. "The provider rejected this" and "there
--    was no provider configured" are different problems; conflating them is what
--    made the Sep 2026 ZeptoMail outage slow to diagnose.
ALTER TYPE "EmailStatus" ADD VALUE IF NOT EXISTS 'SKIPPED';

-- 2. Rename the table, keeping its data.
ALTER TABLE "OrderEmail" RENAME TO "EmailLog";

-- 3. orderId becomes optional: an OTP or password reset belongs to no order, which
--    is precisely why those emails could not be logged before.
ALTER TABLE "EmailLog" ALTER COLUMN "orderId" DROP NOT NULL;

-- 4. New columns. All nullable or defaulted, so existing rows stay valid.
ALTER TABLE "EmailLog" ADD COLUMN IF NOT EXISTS "customerId" TEXT;
ALTER TABLE "EmailLog" ADD COLUMN IF NOT EXISTS "resentFromId" TEXT;
ALTER TABLE "EmailLog" ADD COLUMN IF NOT EXISTS "lastAttemptAt" TIMESTAMP(3);

-- Phase 2 (open tracking). Added now so switching it on later needs no migration
-- against a live table. Nothing writes these yet.
ALTER TABLE "EmailLog" ADD COLUMN IF NOT EXISTS "trackOpens" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "EmailLog" ADD COLUMN IF NOT EXISTS "openedAt" TIMESTAMP(3);
ALTER TABLE "EmailLog" ADD COLUMN IF NOT EXISTS "openCount" INTEGER NOT NULL DEFAULT 0;

-- 5. Replace the CASCADE on orderId with SET NULL.
--
--    Under CASCADE, deleting an order also deleted the proof that its confirmation
--    email had been sent. Mail records what we told someone and when, so it has to
--    outlive the thing it refers to.
ALTER TABLE "EmailLog" DROP CONSTRAINT IF EXISTS "OrderEmail_orderId_fkey";
ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "EmailLog" DROP CONSTRAINT IF EXISTS "EmailLog_customerId_fkey";
ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 6. Indexes. Rename the inherited one, then add what the CMS list and Phase 2's
--    webhook lookup need.
ALTER INDEX IF EXISTS "OrderEmail_orderId_idx" RENAME TO "EmailLog_orderId_idx";
CREATE INDEX IF NOT EXISTS "EmailLog_customerId_idx" ON "EmailLog"("customerId");
CREATE INDEX IF NOT EXISTS "EmailLog_status_queuedAt_idx" ON "EmailLog"("status", "queuedAt");
CREATE INDEX IF NOT EXISTS "EmailLog_toEmail_idx" ON "EmailLog"("toEmail");
CREATE INDEX IF NOT EXISTS "EmailLog_template_idx" ON "EmailLog"("template");
-- The opens webhook arrives carrying only the provider's message id.
CREATE INDEX IF NOT EXISTS "EmailLog_providerMessageId_idx" ON "EmailLog"("providerMessageId");

-- 7. Backfill customerId where the order already tells us who the customer is, so
--    the CMS customer page can show mail history for past orders too.
UPDATE "EmailLog" e
SET "customerId" = o."customerId"
FROM "Order" o
WHERE e."orderId" = o."id"
  AND e."customerId" IS NULL
  AND o."customerId" IS NOT NULL;

-- 8. Keep customerId populated for order mail created outside the email service.
--
-- Order emails are created in four places (status change, refund, placement,
-- manual send), most of which select only the columns they need and do not carry
-- the customer id. A trigger fills it from the order so attribution cannot be
-- forgotten at a new call site — the CMS shows a person's mail history from this
-- column, so a missed one reads as missing history rather than as a bug.
--
-- Only ever FILLS IN a null; an explicit value always wins. Guest orders have no
-- customer, so the result stays null.
CREATE OR REPLACE FUNCTION "emaillog_fill_customer"() RETURNS trigger AS $$
BEGIN
  IF NEW."customerId" IS NULL AND NEW."orderId" IS NOT NULL THEN
    SELECT o."customerId" INTO NEW."customerId" FROM "Order" o WHERE o."id" = NEW."orderId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "emaillog_fill_customer" ON "EmailLog";
CREATE TRIGGER "emaillog_fill_customer"
  BEFORE INSERT ON "EmailLog"
  FOR EACH ROW EXECUTE FUNCTION "emaillog_fill_customer"();
