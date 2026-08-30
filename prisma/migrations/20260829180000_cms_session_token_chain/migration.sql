-- CmsSession: rotate refresh tokens IN PLACE, as a token chain, instead of
-- creating a new row per rotation.
--
-- Purely additive, so the currently-deployed build keeps working against this
-- schema until the matching code ships.

ALTER TABLE "CmsSession"
  ADD COLUMN "previousTokenHash"      TEXT,
  ADD COLUMN "previousTokenExpiresAt" TIMESTAMP(3),
  ADD COLUMN "rotatedAt"              TIMESTAMP(3),
  ADD COLUMN "rememberMe"             BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "revokedReason"          TEXT;

CREATE UNIQUE INDEX "CmsSession_previousTokenHash_key"
  ON "CmsSession"("previousTokenHash");

-- Backfill: existing rows predate the rememberMe column, so classify them the
-- way the old code did — a lifetime meaningfully longer than the 8h default was
-- a "remember me for 7 days" session. Done ONCE here, so no live code path ever
-- has to guess again.
UPDATE "CmsSession"
   SET "rememberMe" = true
 WHERE "expiresAt" - "createdAt" > INTERVAL '24 hours';
