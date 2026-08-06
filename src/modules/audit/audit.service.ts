/**
 * Audit trail (§12).
 *
 * Two rules that make this trustworthy:
 *
 * 1. **Entries are server-derived.** The CMS mock exposed `log(mod, rec, act)` and
 *    called it from pages. That is deliberately NOT ported as an endpoint — a
 *    client that can write arbitrary audit rows can forge history and repudiate
 *    its own actions. Every entry here is written by the service performing the
 *    mutation, from data the server already knows.
 *
 * 2. **The write joins the caller's transaction.** Pass `tx` and the audit row
 *    commits or rolls back with the mutation, so a successful change can never
 *    end up unlogged.
 *
 * The table itself rejects UPDATE and DELETE at the Postgres level
 * (migration 20260728143200) — see README.
 */
import type { AuditModule, Prisma, PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import { prisma } from '@/lib/prisma';
import { ROLE_LABELS } from '@/rbac/permissions';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'audit' });

/** Accepts either the base client or a transaction client. */
type Db = PrismaClient | Prisma.TransactionClient;

export interface AuditContext {
  actorId: string | null;
  actorName: string;
  actorRole: string;
  ip: string;
  userAgent?: string;
}

export interface AuditEntry {
  module: AuditModule;
  /** Human-readable, past tense, specific (§12.1). */
  action: string;
  recordId?: string | null;
  diff?: Prisma.InputJsonValue | null;
}

/**
 * Client IP.
 *
 * Express populates `req.ip` from X-Forwarded-For only because `trust proxy` is
 * set in app.ts. Without that it would report the load balancer's address and
 * every audit row would show the same IP.
 */
export function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/** Build the actor context from an authenticated request. */
export function auditContext(req: Request): AuditContext {
  const user = req.user;
  return {
    actorId: user?.id ?? null,
    actorName: user?.name ?? 'Unauthenticated',
    actorRole: user ? ROLE_LABELS[user.role] : '—',
    ip: clientIp(req),
    userAgent: req.get('user-agent') ?? undefined,
  };
}

/**
 * Write one entry.
 *
 * Pass `db` as a transaction client whenever the audit must be atomic with the
 * mutation — which is nearly always.
 */
export async function writeAudit(
  ctx: AuditContext,
  entry: AuditEntry,
  db: Db = prisma,
): Promise<void> {
  await db.auditLog.create({
    data: {
      actorId: ctx.actorId,
      actorName: ctx.actorName,
      actorRole: ctx.actorRole,
      module: entry.module,
      action: entry.action,
      recordId: entry.recordId ?? null,
      diff: entry.diff ?? undefined,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    },
  });
}

/**
 * Fire-and-forget variant for auth events.
 *
 * Login attempts (§14.4 requires logging failures too) must be recorded even when
 * the request itself fails, and a logging problem must never mask the auth
 * outcome. Errors are logged, not thrown.
 */
export function writeAuditSafe(ctx: AuditContext, entry: AuditEntry): void {
  void writeAudit(ctx, entry).catch((err) => {
    log.error({ err, module: entry.module, action: entry.action }, 'audit write failed');
  });
}

/**
 * Shallow before/after diff, for the `diff` column.
 *
 * Only changed keys are kept, and listed sensitive keys are dropped entirely —
 * a password hash or TOTP secret must never land in the audit table.
 */
const NEVER_DIFF = new Set([
  'passwordHash',
  'password',
  'twofaSecret',
  'passwordHistory',
  'refreshTokenHash',
  'tokenVersion',
]);

export function buildDiff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): Prisma.InputJsonValue | undefined {
  const changed: Record<string, { from: Prisma.JsonValue; to: Prisma.JsonValue }> = {};

  for (const [key, next] of Object.entries(after)) {
    if (NEVER_DIFF.has(key)) continue;
    const prev = before?.[key];
    if (JSON.stringify(prev) !== JSON.stringify(next)) {
      // Round-trip through JSON so Dates become strings and undefined becomes
      // null — the column is jsonb, and unserialisable values would throw.
      changed[key] = { from: toJson(prev), to: toJson(next) };
    }
  }

  return Object.keys(changed).length > 0 ? changed : undefined;
}

/** Coerce an arbitrary value into something jsonb can store. */
function toJson(value: unknown): Prisma.JsonValue {
  if (value === undefined || value === null) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as Prisma.JsonValue;
  } catch {
    return String(value);
  }
}
