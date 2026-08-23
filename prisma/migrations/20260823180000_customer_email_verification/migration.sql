-- CreateTable
CREATE TABLE "CustomerEmailVerification" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerEmailVerification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerEmailVerification_tokenHash_key" ON "CustomerEmailVerification"("tokenHash");

-- CreateIndex
CREATE INDEX "CustomerEmailVerification_customerId_idx" ON "CustomerEmailVerification"("customerId");

-- CreateIndex
CREATE INDEX "CustomerEmailVerification_expiresAt_idx" ON "CustomerEmailVerification"("expiresAt");

-- AddForeignKey
ALTER TABLE "CustomerEmailVerification" ADD CONSTRAINT "CustomerEmailVerification_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill existing customer accounts: mark registered customers as verified so they are not locked out
UPDATE "Customer" SET "emailVerifiedAt" = "registeredAt" WHERE "passwordHash" IS NOT NULL AND "emailVerifiedAt" IS NULL;
