-- Listing representative variant.
--
-- The pack whose photography represents a product on listing surfaces (shop
-- grid card, homepage range). Imagery only: price, stock and the Add-to-Cart
-- SKU continue to follow the first purchasable pack.
--
-- Additive and nullable. NULL means "fall back to the first active variant by
-- position", which is what every existing row will do, so no backfill is
-- needed and no existing behaviour changes on deploy.

ALTER TABLE "ProductFamily" ADD COLUMN "representativeVariantId" TEXT;

-- SetNull: retiring a pack must never delete the product it represented. A
-- dangling choice falls back to the default, and the presentation layer
-- re-checks that the pack is still active on every read regardless.
ALTER TABLE "ProductFamily"
  ADD CONSTRAINT "ProductFamily_representativeVariantId_fkey"
  FOREIGN KEY ("representativeVariantId") REFERENCES "ProductVariant"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ProductFamily_representativeVariantId_idx"
  ON "ProductFamily"("representativeVariantId");
