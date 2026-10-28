-- Product categories move from the "Category" enum to a table the CMS manages,
-- so launching a new product line no longer needs a schema change and deploy.
--
-- The enum values become the table's `code`s verbatim, so every existing
-- ProductFamily.category and CouponCategory.category value is carried over
-- unchanged — the column just becomes TEXT with a foreign key.

-- One transaction: a failure part-way leaves the enum and data untouched.
BEGIN;

-- CreateTable
CREATE TABLE "ProductCategory" (
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductCategory_pkey" PRIMARY KEY ("code")
);

CREATE UNIQUE INDEX "ProductCategory_label_key" ON "ProductCategory"("label");
CREATE INDEX "ProductCategory_isActive_position_idx" ON "ProductCategory"("isActive", "position");

-- Seed every former enum value. Labels and order match the old
-- CATEGORY_LABELS / ACTIVE_CATEGORIES in products.serializer.ts.
INSERT INTO "ProductCategory" ("code", "label", "position", "isActive") VALUES
    ('DRIED_BSF_LARVAE',     'Dried BSF Larvae',      10, true),
    ('SLOW_SINKING_PELLETS', 'Slow-Sinking Granules', 20, true),
    ('BOTTOM_DWELLERS',      'Bottom Dwellers',       30, true),
    ('FLOATING_PELLETS',     'Floating Pellets',      40, true),
    ('HATCHERY_FEEDS',       'Hatchery Feeds',        50, true),
    -- Legacy species values: valid on old rows, not offered for new products.
    ('BETTA',                'Betta',                 900, false),
    ('CICHLID',              'Cichlid',               910, false),
    ('HATCHERY',             'Hatchery',              920, false),
    ('GUPPY',                'Guppy',                 930, false);

-- The default existed only for the seed rows above; Prisma sets @updatedAt.
ALTER TABLE "ProductCategory" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable: enum → text, values preserved
ALTER TABLE "ProductFamily" ALTER COLUMN "category" TYPE TEXT USING "category"::text;
ALTER TABLE "CouponCategory" ALTER COLUMN "category" TYPE TEXT USING "category"::text;

-- AddForeignKey. RESTRICT on delete: a category still in use cannot be removed.
ALTER TABLE "ProductFamily" ADD CONSTRAINT "ProductFamily_category_fkey" FOREIGN KEY ("category") REFERENCES "ProductCategory"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CouponCategory" ADD CONSTRAINT "CouponCategory_category_fkey" FOREIGN KEY ("category") REFERENCES "ProductCategory"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DropEnum
DROP TYPE "Category";

COMMIT;
