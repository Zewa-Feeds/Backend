-- Replace the single previous-token chain link with a row per issued token.
--
-- A two-slot chain (current + previous) cannot survive two tabs rotating at the
-- same instant: the second rotation overwrites the link and orphans the token
-- the first tab is still holding. One row per token keeps every token issued
-- inside its replay window resolvable to its session.

CREATE TABLE "CmsSessionToken" (
  "id"           TEXT NOT NULL,
  "sessionId"    TEXT NOT NULL,
  "tokenHash"    TEXT NOT NULL,
  "expiresAt"    TIMESTAMP(3) NOT NULL,
  "supersededAt" TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CmsSessionToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CmsSessionToken_tokenHash_key" ON "CmsSessionToken"("tokenHash");
CREATE INDEX "CmsSessionToken_sessionId_idx" ON "CmsSessionToken"("sessionId");
CREATE INDEX "CmsSessionToken_expiresAt_idx" ON "CmsSessionToken"("expiresAt");

ALTER TABLE "CmsSessionToken"
  ADD CONSTRAINT "CmsSessionToken_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "CmsSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry every live session's current token across, so sessions that exist right
-- now keep working through the deploy instead of being logged out by it.
INSERT INTO "CmsSessionToken" ("id", "sessionId", "tokenHash", "expiresAt", "createdAt")
SELECT gen_random_uuid(), "id", "refreshTokenHash", "expiresAt", "createdAt"
  FROM "CmsSession"
 WHERE "revokedAt" IS NULL;

-- Superseded by the table above.
DROP INDEX IF EXISTS "CmsSession_previousTokenHash_key";
ALTER TABLE "CmsSession"
  DROP COLUMN "previousTokenHash",
  DROP COLUMN "previousTokenExpiresAt";
