-- Find My Feed run log. Additive: a new table, nothing existing changes.
-- CreateTable
CREATE TABLE "FeedFinderRun" (
    "id" TEXT NOT NULL,
    "answers" JSONB NOT NULL,
    "outcome" TEXT NOT NULL,
    "noMatchCase" TEXT,
    "resultSku" TEXT,
    "addOnSkus" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "addedToCart" BOOLEAN NOT NULL DEFAULT false,
    "addedSkus" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeedFinderRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FeedFinderRun_createdAt_idx" ON "FeedFinderRun"("createdAt");

-- CreateIndex
CREATE INDEX "FeedFinderRun_outcome_createdAt_idx" ON "FeedFinderRun"("outcome", "createdAt");
