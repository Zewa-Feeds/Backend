-- Pack-specific product photography.
--
-- One product sells the same feed as a 45g bottle, a 200g pouch and a 1kg pouch,
-- each shot separately. Media hung off the FAMILY only, so choosing "45g Bottle"
-- on the PDP still showed 1kg pouch photos.
--
-- NULL variantId = SHARED asset (fish photos, nutrition panels, feature
-- graphics) and shows for every pack. That is the majority, hence nullable.
--
-- ON DELETE SET NULL, not CASCADE: retiring a pack size must not destroy its
-- photography, which remains useful as a shared asset.

ALTER TABLE "ProductMedia" ADD COLUMN IF NOT EXISTS "variantId" TEXT;

ALTER TABLE "ProductMedia"
  ADD CONSTRAINT "ProductMedia_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "ProductMedia_variantId_idx" ON "ProductMedia"("variantId");
