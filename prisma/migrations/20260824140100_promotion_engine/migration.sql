-- The promotion engine: stacking, eligibility, targeting and Buy X Get Y.
--
-- ENTIRELY ADDITIVE. No column is dropped or renamed and no row is deleted, so
-- every coupon that works today keeps working. The defaults are chosen to
-- reproduce current behaviour exactly:
--
--   stackingMode        NON_STACKABLE   one coupon per cart, as before
--   trigger             CODE            the customer still types it
--   customerEligibility ALL_CUSTOMERS   no order-history restriction
--   priority            0               nothing outranks anything
--   CouponProduct.role  DISCOUNT        which is what SPECIFIC_PRODUCTS meant
--
-- Stacking, automatic promotions and order-history rules are therefore opt-in,
-- per coupon, by hand. Nothing changes for a coupon nobody edits.
--
-- The one piece of non-trivial DDL is CouponProduct's primary key, which widens
-- to include `role` so a family can both QUALIFY a promotion and RECEIVE it.
-- Existing rows survive: the column is added with a default first, so every row
-- is already DISCOUNT by the time the key is rebuilt.

-- CreateEnum
CREATE TYPE "CouponStacking" AS ENUM ('STACKABLE', 'NON_STACKABLE', 'EXCLUSIVE');

-- CreateEnum
CREATE TYPE "CouponTrigger" AS ENUM ('CODE', 'AUTOMATIC');

-- CreateEnum
CREATE TYPE "CustomerEligibility" AS ENUM ('ALL_CUSTOMERS', 'FIRST_ORDER', 'FIRST_N_ORDERS', 'EXISTING_CUSTOMER', 'SPECIFIC_CUSTOMERS');

-- CreateEnum
CREATE TYPE "CouponTargetRole" AS ENUM ('DISCOUNT', 'QUALIFY', 'EXCLUDE');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "couponCodes" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Coupon" ADD COLUMN     "allowedStates" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "combinesWithAutomatic" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "customerEligibility" "CustomerEligibility" NOT NULL DEFAULT 'ALL_CUSTOMERS',
ADD COLUMN     "description" TEXT,
ADD COLUMN     "firstNOrders" INTEGER,
ADD COLUMN     "maxDiscountPaise" INTEGER,
ADD COLUMN     "maxQty" INTEGER,
ADD COLUMN     "minQty" INTEGER,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "requireAllQualifiers" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stackingMode" "CouponStacking" NOT NULL DEFAULT 'NON_STACKABLE',
ADD COLUMN     "trigger" "CouponTrigger" NOT NULL DEFAULT 'CODE';

-- AlterTable
ALTER TABLE "CouponProduct" DROP CONSTRAINT "CouponProduct_pkey",
ADD COLUMN     "role" "CouponTargetRole" NOT NULL DEFAULT 'DISCOUNT',
ADD CONSTRAINT "CouponProduct_pkey" PRIMARY KEY ("couponId", "familyId", "role");

-- AlterTable
ALTER TABLE "CouponRedemption" ADD COLUMN     "releasedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CouponVariant" (
    "couponId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "role" "CouponTargetRole" NOT NULL DEFAULT 'DISCOUNT',

    CONSTRAINT "CouponVariant_pkey" PRIMARY KEY ("couponId","variantId","role")
);

-- CreateTable
CREATE TABLE "CouponCategory" (
    "couponId" TEXT NOT NULL,
    "category" "Category" NOT NULL,
    "role" "CouponTargetRole" NOT NULL DEFAULT 'DISCOUNT',

    CONSTRAINT "CouponCategory_pkey" PRIMARY KEY ("couponId","category","role")
);

-- CreateTable
CREATE TABLE "CouponCustomer" (
    "couponId" TEXT NOT NULL,
    "email" TEXT NOT NULL,

    CONSTRAINT "CouponCustomer_pkey" PRIMARY KEY ("couponId","email")
);

-- CreateTable
CREATE TABLE "CouponBxgy" (
    "couponId" TEXT NOT NULL,
    "buyQty" INTEGER NOT NULL,
    "getQty" INTEGER NOT NULL,
    "rewardPercentOff" INTEGER NOT NULL DEFAULT 100,
    "maxRepeats" INTEGER,

    CONSTRAINT "CouponBxgy_pkey" PRIMARY KEY ("couponId")
);

-- CreateIndex
CREATE INDEX "CouponVariant_variantId_idx" ON "CouponVariant"("variantId");

-- CreateIndex
CREATE INDEX "CouponCustomer_email_idx" ON "CouponCustomer"("email");

-- CreateIndex
CREATE INDEX "Order_email_status_paymentStatus_idx" ON "Order"("email", "status", "paymentStatus");

-- CreateIndex
CREATE INDEX "Coupon_trigger_isActive_priority_idx" ON "Coupon"("trigger", "isActive", "priority");

-- AddForeignKey
ALTER TABLE "CouponVariant" ADD CONSTRAINT "CouponVariant_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponVariant" ADD CONSTRAINT "CouponVariant_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponCategory" ADD CONSTRAINT "CouponCategory_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponCustomer" ADD CONSTRAINT "CouponCustomer_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponBxgy" ADD CONSTRAINT "CouponBxgy_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: an order placed before stacking existed carried exactly one code.
-- Populating the array keeps order history queryable through either column.
UPDATE "Order"
SET "couponCodes" = ARRAY["couponCode"]
WHERE "couponCode" IS NOT NULL;
