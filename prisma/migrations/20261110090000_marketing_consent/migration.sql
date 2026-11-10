-- Marketing consent: opt-in timestamp on the customer, opt-outs by email.
ALTER TABLE "Customer" ADD COLUMN "marketingOptInAt" TIMESTAMP(3);

CREATE TABLE "MarketingOptOut" (
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT,

    CONSTRAINT "MarketingOptOut_pkey" PRIMARY KEY ("email")
);
