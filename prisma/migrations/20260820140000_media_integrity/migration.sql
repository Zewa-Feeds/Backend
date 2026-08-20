-- Media integrity: lifecycle status, many-to-many targeting, explicit hero.
--
-- Entirely additive. No column is dropped, no row is deleted, and every existing
-- asset keeps its id, URL, publicId, alt text and position. The storefront
-- behaves identically the moment this lands, because nothing reads the new
-- columns until the service does.
--
-- The legacy ProductMedia.variantId STAYS. It is the compatibility path while the
-- join table is backfilled and verified, and is only retired once the new model
-- has been proven in production.

-- ---------------------------------------------------------------------------
-- 1. Asset lifecycle.
--
-- READY, not PENDING, for existing rows: all 171 are already being served, and
-- defaulting them to PENDING would empty the storefront the instant a resolver
-- started filtering on status.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'MediaStatus') THEN
        CREATE TYPE "MediaStatus" AS ENUM ('PENDING', 'READY', 'FAILED', 'ARCHIVED');
    END IF;
END $$;

ALTER TABLE "ProductMedia"
    ADD COLUMN IF NOT EXISTS "status" "MediaStatus" NOT NULL DEFAULT 'READY';
ALTER TABLE "ProductMedia"
    ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "ProductMedia_status_idx" ON "ProductMedia"("status");

-- ---------------------------------------------------------------------------
-- 2. Many-to-many targeting.
--
-- The composite primary key is the duplicate-prevention mechanism: the same
-- asset cannot be assigned to the same pack twice, which also makes assignment
-- idempotent under retry.
--
-- Both foreign keys cascade, and both cascade the ASSOCIATION only — removing a
-- link never touches the ProductMedia row, so un-assigning an asset can never
-- destroy the underlying Cloudinary file.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "ProductMediaVariant" (
    "productMediaId" TEXT         NOT NULL,
    "variantId"      TEXT         NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductMediaVariant_pkey" PRIMARY KEY ("productMediaId", "variantId")
);

CREATE INDEX IF NOT EXISTS "ProductMediaVariant_variantId_idx"
    ON "ProductMediaVariant"("variantId");

ALTER TABLE "ProductMediaVariant"
    DROP CONSTRAINT IF EXISTS "ProductMediaVariant_productMediaId_fkey";
ALTER TABLE "ProductMediaVariant"
    ADD CONSTRAINT "ProductMediaVariant_productMediaId_fkey"
    FOREIGN KEY ("productMediaId") REFERENCES "ProductMedia"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProductMediaVariant"
    DROP CONSTRAINT IF EXISTS "ProductMediaVariant_variantId_fkey";
ALTER TABLE "ProductMediaVariant"
    ADD CONSTRAINT "ProductMediaVariant_variantId_fkey"
    FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. Explicit hero.
--
-- SetNull so a removed asset leaves "no hero" rather than a dangling reference.
-- The database can only guarantee the pointer resolves; that the asset belongs
-- to the same product and appears in that pack's resolved gallery is checked in
-- the service, since neither rule is expressible as a foreign key.
-- ---------------------------------------------------------------------------
ALTER TABLE "ProductVariant" ADD COLUMN IF NOT EXISTS "heroMediaId" TEXT;

CREATE INDEX IF NOT EXISTS "ProductVariant_heroMediaId_idx"
    ON "ProductVariant"("heroMediaId");

ALTER TABLE "ProductVariant"
    DROP CONSTRAINT IF EXISTS "ProductVariant_heroMediaId_fkey";
ALTER TABLE "ProductVariant"
    ADD CONSTRAINT "ProductVariant_heroMediaId_fkey"
    FOREIGN KEY ("heroMediaId") REFERENCES "ProductMedia"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 4. Backfill targeting from the legacy column.
--
-- Every asset that names a pack today gains the equivalent join row. Idempotent
-- via ON CONFLICT, so re-running this migration is safe and changes nothing.
--
-- The legacy column is deliberately left populated: the resolver reads both
-- until the new path is verified in production.
-- ---------------------------------------------------------------------------
INSERT INTO "ProductMediaVariant" ("productMediaId", "variantId")
SELECT m."id", m."variantId"
FROM "ProductMedia" AS m
WHERE m."variantId" IS NOT NULL
ON CONFLICT ("productMediaId", "variantId") DO NOTHING;
