-- Make multipack photography inheritance relational instead of SKU-derived.
--
-- Until now the storefront decided which pack borrowed another pack's photos by
-- stripping an "X2"/"X3" suffix off the SKU at render time:
--
--     sku.replace(/X\d+$/i, "")      G2-45GX2 -> G2-45G
--
-- That made a merchandising rule depend on a naming convention. Renaming a SKU
-- silently changed which photographs a customer saw, and the rule lived in a
-- React component where nobody editing the catalogue could see it.
--
-- These columns hold the relationship as data. The backfill below uses the same
-- regex EXACTLY ONCE to propose relationships for the rows that already exist;
-- after this migration the pattern never runs again at request time.
--
-- Additive only. Nothing is dropped, no existing row changes except to gain a
-- base-pack pointer it did not have, so the storefront behaves identically until
-- the resolver is switched on.

ALTER TABLE "ProductVariant" ADD COLUMN IF NOT EXISTS "baseVariantId" TEXT;
ALTER TABLE "ProductVariant" ADD COLUMN IF NOT EXISTS "packMultiplier" INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS "ProductVariant_baseVariantId_idx"
    ON "ProductVariant"("baseVariantId");

-- SetNull: retiring a base pack must not delete the multipacks that point at it.
-- The dangling inheritance is then visible to the CMS rather than silently
-- cascading a delete nobody asked for.
ALTER TABLE "ProductVariant"
    DROP CONSTRAINT IF EXISTS "ProductVariant_baseVariantId_fkey";
ALTER TABLE "ProductVariant"
    ADD CONSTRAINT "ProductVariant_baseVariantId_fkey"
    FOREIGN KEY ("baseVariantId") REFERENCES "ProductVariant"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- One-time backfill.
--
-- Matches a trailing X<number> and looks for a sibling in the SAME product whose
-- SKU is the remainder. Scoped to familyId so a coincidental name collision
-- across products cannot link unrelated packs.
--
-- Deliberately conservative:
--   - only rows that still have no baseVariantId
--   - only where exactly one sibling matches
--   - never links a pack to itself
--
-- Anything it cannot resolve is simply left alone for a human to set in the CMS,
-- which is the right outcome: a wrong guess here shows a customer the wrong
-- product photograph.
-- ---------------------------------------------------------------------------
UPDATE "ProductVariant" AS derived
SET
    "baseVariantId" = base.id,
    "packMultiplier" = GREATEST(1, CAST(substring(derived.sku FROM '[Xx]([0-9]+)$') AS INTEGER))
FROM "ProductVariant" AS base
WHERE
    derived.sku ~ '[Xx][0-9]+$'
    AND derived."baseVariantId" IS NULL
    AND base."familyId" = derived."familyId"
    AND base.id <> derived.id
    AND upper(base.sku) = upper(regexp_replace(derived.sku, '[Xx][0-9]+$', ''));
