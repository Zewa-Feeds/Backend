-- Imported rating baseline (Amazon) on ProductFamily.
--
-- Counts per star, not an average: an average cannot be combined with new
-- reviews without knowing how many ratings it came from. The public figure is
-- these counts plus every APPROVED Review row.
ALTER TABLE "ProductFamily" ADD COLUMN "externalReviewSource" TEXT;
ALTER TABLE "ProductFamily" ADD COLUMN "externalRatingCounts" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- Provenance for a review written on another platform.
ALTER TABLE "Review" ADD COLUMN "externalSource" TEXT;
ALTER TABLE "Review" ADD COLUMN "title" TEXT;

-- Imported reviews have no reviewer email — the source does not publish them,
-- and a placeholder would be a fake contact for a real person. Reviews left on
-- this site still carry one; the service requires it.
ALTER TABLE "Review" ALTER COLUMN "email" DROP NOT NULL;
