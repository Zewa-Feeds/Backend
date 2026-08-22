-- Product display order (PRODUCT order, not variant order).
--
-- Every customer-facing listing sorted by [status, name], so the catalogue was
-- alphabetical by accident. This adds an explicit merchandising sequence that a
-- CMS operator controls by dragging.
--
-- NOT related to ProductVariant.position (packs inside one product) or
-- ProductMedia.position (gallery). Those are untouched.

ALTER TABLE "ProductFamily" ADD COLUMN "displayOrder" INTEGER NOT NULL DEFAULT 0;

-- Seed from the PDP Content Master v5 running order, as parsed into
-- scripts/derived-meta.json when the catalogue was imported. That file is the
-- catalogue's own document sequence, so the order this installs is the one the
-- glossary already describes rather than an invented one.
--
-- Any product NOT in that document — anything added since, or added later on a
-- fresh database — sorts after the known thirteen, alphabetically by name, so
-- the result is deterministic whatever the table contains.
WITH ordered AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      ORDER BY
        CASE "slug"
      WHEN 'dried-bsf-larvae' THEN 0
      WHEN 'guppy-bites' THEN 1
      WHEN 'tetra-pellets' THEN 2
      WHEN 'betta-bites' THEN 3
      WHEN 'micro-pellets' THEN 4
      WHEN 'shrimp-grazers' THEN 5
      WHEN 'cichlid-bites-c4' THEN 6
      WHEN 'cichlid-bites-c5' THEN 7
      WHEN 'pleco-bites' THEN 8
      WHEN 'goldfish-bites' THEN 9
      WHEN 'monster-sticks' THEN 10
      WHEN 'koi-bites' THEN 11
      WHEN 'hatchery-feeds' THEN 12
        END NULLS LAST,
        "name" ASC
    ) - 1 AS "pos"
  FROM "ProductFamily"
)
UPDATE "ProductFamily" AS f
SET "displayOrder" = o."pos"
FROM ordered AS o
WHERE f."id" = o."id";

CREATE INDEX "ProductFamily_displayOrder_idx" ON "ProductFamily"("displayOrder");
