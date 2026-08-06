-- CreateEnum
CREATE TYPE "CouponScope" AS ENUM ('ALL_PRODUCTS', 'SPECIFIC_PRODUCTS');

-- AlterTable
ALTER TABLE "Coupon" ADD COLUMN     "confirmedOrders" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "discountedPaise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "revenuePaise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "scope" "CouponScope" NOT NULL DEFAULT 'ALL_PRODUCTS';

-- AlterTable
ALTER TABLE "CouponRedemption" ADD COLUMN     "cartValuePaise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "discountPaise" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "CouponProduct" (
    "couponId" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,

    CONSTRAINT "CouponProduct_pkey" PRIMARY KEY ("couponId","familyId")
);

-- CreateIndex
CREATE INDEX "CouponProduct_familyId_idx" ON "CouponProduct"("familyId");

-- AddForeignKey
ALTER TABLE "CouponProduct" ADD CONSTRAINT "CouponProduct_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponProduct" ADD CONSTRAINT "CouponProduct_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "ProductFamily"("id") ON DELETE CASCADE ON UPDATE CASCADE;
