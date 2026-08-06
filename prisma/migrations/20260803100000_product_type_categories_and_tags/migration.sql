-- Product-type categories + a species tag array.
--
-- The old Category enum held FISH SPECIES (BETTA/CICHLID/HATCHERY/GUPPY). The
-- real catalogue is browsed by how a feed BEHAVES, and species is many-valued
-- per product — so the two axes are now separate:
--
--   Category            product type   (one per product, this enum)
--   ProductFamily.tags  species        (many per product, text[])
--
-- Legacy species values are NOT dropped: Postgres cannot remove an enum value
-- that existing rows or a stored filter might reference. They stay valid but
-- unused by new products.

ALTER TYPE "Category" ADD VALUE IF NOT EXISTS 'DRIED_BSF_LARVAE';
ALTER TYPE "Category" ADD VALUE IF NOT EXISTS 'FLOATING_PELLETS';
ALTER TYPE "Category" ADD VALUE IF NOT EXISTS 'SLOW_SINKING_PELLETS';
ALTER TYPE "Category" ADD VALUE IF NOT EXISTS 'BOTTOM_DWELLERS';
ALTER TYPE "Category" ADD VALUE IF NOT EXISTS 'HATCHERY_FEEDS';

ALTER TABLE "ProductFamily"
  ADD COLUMN IF NOT EXISTS "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
