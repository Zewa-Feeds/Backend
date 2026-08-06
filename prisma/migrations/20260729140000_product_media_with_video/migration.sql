-- Product gallery: photos AND video in one ordered list.
--
-- Written by hand rather than generated, so this is a RENAME that preserves
-- existing rows. `prisma migrate dev` would have dropped ProductImage and
-- created ProductMedia, silently losing every gallery image.

-- 1. The discriminator.
CREATE TYPE "MediaType" AS ENUM ('IMAGE', 'VIDEO');

-- 2. Rename the table and its constraints/indexes, keeping data intact.
ALTER TABLE "ProductImage" RENAME TO "ProductMedia";
ALTER TABLE "ProductMedia" RENAME CONSTRAINT "ProductImage_pkey" TO "ProductMedia_pkey";
ALTER TABLE "ProductMedia"
  RENAME CONSTRAINT "ProductImage_familyId_fkey" TO "ProductMedia_familyId_fkey";
ALTER INDEX "ProductImage_familyId_position_idx" RENAME TO "ProductMedia_familyId_position_idx";

-- 3. New columns. Every existing row is a photo, which is what the default gives.
ALTER TABLE "ProductMedia"
  ADD COLUMN "type"        "MediaType" NOT NULL DEFAULT 'IMAGE',
  ADD COLUMN "posterUrl"   TEXT,
  ADD COLUMN "width"       INTEGER,
  ADD COLUMN "height"      INTEGER,
  ADD COLUMN "durationSec" DOUBLE PRECISION;

-- 4. `isPrimary` is gone: position 0 IS the primary image. Two sources of truth
--    for "which image leads" drift, and the serializer already fell back to
--    images[0] whenever no row was flagged.
--
--    Preserve intent first — if a row was flagged primary, move it to front —
--    then drop the column.
UPDATE "ProductMedia" SET "position" = -1 WHERE "isPrimary" = true;
ALTER TABLE "ProductMedia" DROP COLUMN "isPrimary";

-- Renumber to contiguous 0..n-1 per family, preserving the order above.
WITH ordered AS (
  SELECT "id", ROW_NUMBER() OVER (
           PARTITION BY "familyId" ORDER BY "position", "id"
         ) - 1 AS new_position
  FROM "ProductMedia"
)
UPDATE "ProductMedia" m
SET "position" = o.new_position
FROM ordered o
WHERE m."id" = o."id";

-- 5. Guard the "at most one video per product" rule at the DB level too, so a
--    direct SQL write cannot violate what the service validates.
CREATE UNIQUE INDEX "ProductMedia_one_video_per_family"
  ON "ProductMedia" ("familyId")
  WHERE ("type" = 'VIDEO');
