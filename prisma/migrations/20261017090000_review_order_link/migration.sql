-- Reviews left through the star links in an order email are tied to that
-- order, one per product, so a second click updates instead of duplicating.
-- Additive: nullable column, existing reviews keep orderId NULL (and NULLs
-- never collide in the unique index).
-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "orderId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Review_orderId_familyId_key" ON "Review"("orderId", "familyId");

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

