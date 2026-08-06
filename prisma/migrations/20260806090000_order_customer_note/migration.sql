-- Separate the customer's checkout note from the staff-only internal note.
--
-- checkout.service.ts was writing the CUSTOMER's note into `internalNote`, so a
-- shopper's delivery instruction appeared in the staff field — and the first
-- staff note saved over it, destroying the customer's words.
--
-- Existing rows: every non-null internalNote on an order was, in practice, a
-- customer note (staff had no other way to reach the field until the CMS note
-- editor shipped). Copy them across rather than lose them, then clear the
-- internal field so it starts empty for staff use.

ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "customerNote" TEXT;

UPDATE "Order"
SET "customerNote" = "internalNote", "internalNote" = NULL
WHERE "internalNote" IS NOT NULL AND "customerNote" IS NULL;
