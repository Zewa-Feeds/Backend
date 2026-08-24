-- AlterEnum
ALTER TYPE "TwofaMethod" ADD VALUE 'EMAIL_OTP';

-- CreateTable
CREATE TABLE "CmsEmailOtp" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "otpHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CmsEmailOtp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CmsEmailOtp_userId_idx" ON "CmsEmailOtp"("userId");

-- CreateIndex
CREATE INDEX "CmsEmailOtp_expiresAt_idx" ON "CmsEmailOtp"("expiresAt");

-- AddForeignKey
ALTER TABLE "CmsEmailOtp" ADD CONSTRAINT "CmsEmailOtp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "CmsUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
