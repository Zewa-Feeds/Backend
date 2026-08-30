-- Give every still-live session a token row, immediately before the code that
-- requires one starts serving.
--
-- ── WHY THIS IS A MIGRATION AND NOT CODE ────────────────────────────────────
-- Sessions opened by the PREVIOUS build wrote a CmsSession row but no token row,
-- because only the new build writes one. Something has to bridge that, or the
-- deploy signs out everyone who is signed in at the moment it happens.
--
-- The alternative was a fallback inside refresh() that, on a token miss, looked
-- the session up the old way. That is compatibility code sitting on the
-- authentication path forever, and it keeps a second, weaker lookup alive
-- indefinitely. Doing it here instead means refresh() has exactly ONE way to
-- resolve a token, and this runs once, at deploy, before the new code starts.
--
-- Idempotent: re-running inserts nothing.
INSERT INTO "CmsSessionToken" ("id", "sessionId", "tokenHash", "expiresAt", "createdAt")
SELECT gen_random_uuid(), s."id", s."refreshTokenHash", s."expiresAt", s."createdAt"
  FROM "CmsSession" s
 WHERE s."revokedAt" IS NULL
   AND s."expiresAt" > now()
   AND NOT EXISTS (
     SELECT 1 FROM "CmsSessionToken" t WHERE t."tokenHash" = s."refreshTokenHash"
   );
