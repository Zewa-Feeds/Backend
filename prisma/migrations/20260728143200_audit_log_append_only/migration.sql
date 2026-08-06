-- ============================================================================
-- Make the audit log append-only at the DATABASE level (spec §12).
--
-- §12: "This log is append-only — no one can edit or delete entries, including
-- Admins." Enforcing that only in application code is a promise, not a
-- guarantee: a bug, a rogue migration, or a compromised app credential could
-- still rewrite history. A rule in Postgres makes it structurally true.
--
-- Implemented with RULEs rather than GRANTs because Prisma connects as the owner
-- of the schema in most managed-Postgres setups, and an owner can always
-- re-grant itself privileges. Rules apply to the table regardless of role, owner
-- and superuser included.
--
-- To legitimately prune old entries (a retention policy, years from now), drop
-- the rule inside a transaction, delete, and recreate it — a deliberate,
-- reviewable act rather than an accident.
-- ============================================================================

-- Silently discard UPDATEs. DO INSTEAD NOTHING makes the statement a no-op
-- rather than an error, so a stray ORM write cannot take the API down; the row
-- simply never changes.
CREATE OR REPLACE RULE audit_log_no_update AS
  ON UPDATE TO "AuditLog"
  DO INSTEAD NOTHING;

CREATE OR REPLACE RULE audit_log_no_delete AS
  ON DELETE TO "AuditLog"
  DO INSTEAD NOTHING;
