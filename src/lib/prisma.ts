/**
 * Prisma client singleton.
 *
 * A single instance per process — the client owns a connection pool, so creating
 * more than one exhausts Postgres connections. `globalThis` caching keeps tsx
 * watch-mode reloads from leaking pools during development.
 */
import { PrismaClient } from '@prisma/client';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'prisma' });

/**
 * Log config is declared `as const` so Prisma can infer which `$on` events exist.
 * Without it, the event names widen to `never` and `$on` becomes uncallable.
 */
const logConfig = [
  { emit: 'event', level: 'query' },
  { emit: 'event', level: 'warn' },
  { emit: 'event', level: 'error' },
] as const;

/**
 * Interactive-transaction budget.
 *
 * Prisma defaults to a 5s timeout, which assumes a low-latency database. Against
 * a remote Postgres (Neon in ap-southeast-1 measures ~950ms per round trip) a
 * multi-statement transaction blows that easily: product create issues ~6
 * sequential queries and times out with "Transaction already closed".
 *
 * Raised here, on the client, so every one of the ~44 transactions in the codebase
 * inherits it rather than each call site needing to remember. Individual calls can
 * still override — checkout passes its own tighter budget, because a slow checkout
 * should fail fast rather than hold stock rows.
 *
 * These are CEILINGS, not delays: a fast transaction still commits immediately.
 */
const TRANSACTION_OPTIONS = {
  /** How long to wait for a connection from the pool before giving up. */
  maxWait: 10_000,
  /** How long the transaction body may take once started. */
  timeout: 30_000,
} as const;

const createClient = () =>
  new PrismaClient({
    log: [...logConfig],
    transactionOptions: TRANSACTION_OPTIONS,
  });

type Client = ReturnType<typeof createClient>;

const globalForPrisma = globalThis as unknown as { prisma?: Client };

export const prisma: Client = globalForPrisma.prisma ?? createClient();

if (env.isDev) {
  globalForPrisma.prisma = prisma;

  prisma.$on('query', (e) => {
    // Slow-query visibility while developing. Noisy by design at debug level.
    if (e.duration >= 100) {
      log.debug({ durationMs: e.duration, query: e.query }, 'slow query');
    }
  });
}

prisma.$on('warn', (e) => log.warn({ target: e.target }, e.message));
prisma.$on('error', (e) => log.error({ target: e.target }, e.message));

/** Liveness check used by /health/ready. */
export async function checkDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (err) {
    log.error({ err }, 'database health check failed');
    return false;
  }
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
  log.info('prisma disconnected');
}
