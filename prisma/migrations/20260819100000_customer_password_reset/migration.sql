-- Password reset tokens for storefront customers.
--
-- Customers could sign in and change a known password, but a forgotten one was a
-- dead end: the forgot-password endpoint logged the request and returned 200
-- without ever issuing a token. This table is what makes the flow real.
--
-- Only the sha256 of the token is stored. The plaintext exists in the customer's
-- inbox and nowhere else, so a database dump cannot be replayed to seize an
-- account. `usedAt` enforces single use and `expiresAt` bounds the window.

CREATE TABLE IF NOT EXISTS "CustomerPasswordReset" (
    "id"         TEXT         NOT NULL,
    "customerId" TEXT         NOT NULL,
    "tokenHash"  TEXT         NOT NULL,
    "expiresAt"  TIMESTAMP(3) NOT NULL,
    "usedAt"     TIMESTAMP(3),
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerPasswordReset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CustomerPasswordReset_tokenHash_key"
    ON "CustomerPasswordReset"("tokenHash");

CREATE INDEX IF NOT EXISTS "CustomerPasswordReset_customerId_idx"
    ON "CustomerPasswordReset"("customerId");

-- Supports sweeping expired rows without a sequential scan.
CREATE INDEX IF NOT EXISTS "CustomerPasswordReset_expiresAt_idx"
    ON "CustomerPasswordReset"("expiresAt");

-- Cascade: deleting a customer must not strand their reset tokens.
ALTER TABLE "CustomerPasswordReset"
    DROP CONSTRAINT IF EXISTS "CustomerPasswordReset_customerId_fkey";
ALTER TABLE "CustomerPasswordReset"
    ADD CONSTRAINT "CustomerPasswordReset_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
