-- Website content, media library and versioned static publishing.
--
-- Purely additive: new enums, new tables, nullable/defaulted Article columns.
-- No existing row is rewritten, so this is safe to deploy ahead of the code
-- that uses it.

-- CreateEnum
CREATE TYPE "MediaStorage" AS ENUM ('CLOUDINARY', 'STATIC', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "PublicationStatus" AS ENUM ('QUEUED', 'DEPLOYING', 'LIVE', 'FAILED', 'SUPERSEDED');

-- AlterTable
ALTER TABLE "Article" ADD COLUMN     "coverAlt" TEXT,
ADD COLUMN     "coverAssetId" TEXT,
ADD COLUMN     "coverMobileAssetId" TEXT,
ADD COLUMN     "focusKeyword" TEXT,
ADD COLUMN     "ogDescription" TEXT,
ADD COLUMN     "ogTitle" TEXT,
ADD COLUMN     "revisedAt" TIMESTAMP(3),
ADD COLUMN     "relatedSlugs" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "scheduledAt" TIMESTAMP(3),
ADD COLUMN     "seoKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "shortTitle" TEXT,
ADD COLUMN     "stat" TEXT,
ADD COLUMN     "statLabel" TEXT,
ADD COLUMN     "tagColor" TEXT,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];


-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "storage" "MediaStorage" NOT NULL,
    "type" "MediaType" NOT NULL,
    "publicId" TEXT,
    "url" TEXT NOT NULL,
    "format" TEXT,
    "mimeType" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "bytes" INTEGER,
    "durationSec" DOUBLE PRECISION,
    "posterUrl" TEXT,
    "title" TEXT NOT NULL,
    "altText" TEXT NOT NULL DEFAULT '',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "revision" INTEGER NOT NULL DEFAULT 1,
    "previousUrls" JSONB NOT NULL DEFAULT '[]',
    "previousPublicIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteContentDraft" (
    "key" TEXT NOT NULL DEFAULT 'site',
    "sections" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "SiteContentDraft_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "SitePublication" (
    "id" TEXT NOT NULL,
    "version" SERIAL NOT NULL,
    "snapshot" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" TEXT,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "rolledBackFrom" INTEGER,
    "status" "PublicationStatus" NOT NULL DEFAULT 'QUEUED',
    "method" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "verifiedPaths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "liveAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "publishedByName" TEXT NOT NULL,

    CONSTRAINT "SitePublication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_publicId_key" ON "MediaAsset"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_url_key" ON "MediaAsset"("url");

-- CreateIndex
CREATE INDEX "MediaAsset_archivedAt_createdAt_idx" ON "MediaAsset"("archivedAt", "createdAt");

-- CreateIndex
CREATE INDEX "MediaAsset_type_idx" ON "MediaAsset"("type");

-- CreateIndex
CREATE UNIQUE INDEX "SitePublication_version_key" ON "SitePublication"("version");

-- CreateIndex
CREATE INDEX "SitePublication_status_createdAt_idx" ON "SitePublication"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SitePublication_isCurrent_idx" ON "SitePublication"("isCurrent");

-- CreateIndex
CREATE INDEX "Article_scheduledAt_idx" ON "Article"("scheduledAt");

-- AddForeignKey
ALTER TABLE "Article" ADD CONSTRAINT "Article_coverAssetId_fkey" FOREIGN KEY ("coverAssetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Article" ADD CONSTRAINT "Article_coverMobileAssetId_fkey" FOREIGN KEY ("coverMobileAssetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "CmsUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Exactly one publication may be current. Not expressible in the Prisma schema,
-- so it lives only here — do not `prisma db push` this schema, it would drop it.
-- The publish transaction clears the old flag before setting the new one; this
-- index turns any interleaving that would leave two current rows into an error
-- instead of an ambiguous storefront.
CREATE UNIQUE INDEX "SitePublication_one_current" ON "SitePublication"("isCurrent") WHERE "isCurrent";
