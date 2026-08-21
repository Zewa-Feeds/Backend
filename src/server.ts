/**
 * Server entry point.
 *
 * Two responsibilities beyond listening:
 *
 * 1. Verify dependencies at boot. If Postgres or Redis is unreachable we exit
 *    non-zero rather than serving 500s — the platform then restarts us, and a
 *    crash-looping deploy is a much louder signal than a silently broken one.
 *
 * 2. Shut down gracefully. On SIGTERM we stop accepting connections, let
 *    in-flight requests finish, then close Postgres and Redis. Without this a
 *    deploy can kill a request mid-transaction.
 */
import type { Server } from 'node:http';
import { createApp } from '@/app';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';
import { checkDatabase, disconnectPrisma } from '@/lib/prisma';
import { checkRedis, disconnectRedis } from '@/lib/redis';
import { startEmailWorker } from '@/jobs/workers/email.worker';
import { startPaymentWorker } from '@/jobs/workers/payment.worker';
import { startMaintenanceWorker } from '@/jobs/workers/maintenance.worker';
import { closeQueues, scheduleMaintenance } from '@/jobs/queues';

/**
 * Workers hosted inside this process. Empty unless RUN_WORKERS_IN_API.
 *
 * Typed by the only capability shutdown needs, since the three workers carry
 * different job types and share no useful common supertype.
 */
type EmbeddedWorkers = { close: () => Promise<void> }[];

/**
 * Start the queue consumers inside the API process, and register the recurring
 * maintenance schedule.
 *
 * WHY ALL THREE AND NOT TWO. This used to start only the email and payment
 * workers, because those were the only queues that existed when it was written.
 * The maintenance worker and its schedule lived solely in the separate worker
 * entry point — so on a single-service deployment, media reconciliation never
 * ran at all. That is the one job whose entire purpose is surviving a missed
 * Cloudinary webhook, and without it a video whose notification was lost stays
 * hidden from customers forever while abandoned uploads bill indefinitely.
 *
 * WHY THE SCHEDULE IS SAFE TO REGISTER HERE. `scheduleMaintenance()` is
 * idempotent: BullMQ keys a repeatable job on its name plus its repeat options,
 * and the explicit `jobId` makes that guarantee legible rather than incidental.
 * Restarting the API, or running several instances behind a load balancer,
 * therefore leaves exactly one schedule rather than one per process.
 *
 * A failure to register must not stop the API booting. The queues still work,
 * the storefront still serves, and the next boot registers it — refusing to
 * serve HTTP because a housekeeping timer could not be written would be a much
 * worse outcome than a late sweep.
 */
async function startEmbeddedWorkers(): Promise<EmbeddedWorkers> {
  const workers: EmbeddedWorkers = [
    startEmailWorker(),
    startPaymentWorker(),
    startMaintenanceWorker(),
  ];

  try {
    await scheduleMaintenance();
    log.info('maintenance schedule registered');
  } catch (err) {
    log.error({ err }, 'could not register the maintenance schedule — sweeps may not run');
  }

  return workers;
}

const log = logger.child({ module: 'server' });

/** How long in-flight requests get to finish before we force the process down. */
const SHUTDOWN_GRACE_MS = 15_000;

/**
 * Postgres is required; Redis is not.
 *
 * Without Postgres there is no catalogue, no orders, nothing to serve — exiting
 * non-zero is right, because a crash-loop is a louder signal than silent 500s.
 *
 * Redis only backs rate limiting and queues, both of which degrade rather than
 * break (see middleware/rateLimit.ts). Refusing to boot without it meant an
 * expired cache quota could keep the entire storefront offline, so a bad Redis
 * is now a loud warning and the API serves on.
 */
async function verifyDependencies(): Promise<void> {
  const [database, cache] = await Promise.all([checkDatabase(), checkRedis()]);

  if (!database) {
    log.fatal('cannot reach Postgres — check DATABASE_URL and that the container is up');
    log.fatal('startup aborted: run `npm run docker:up` for local dependencies');
    process.exit(1);
  }

  if (!cache) {
    log.warn(
      'cannot reach Redis — check REDIS_URL. Starting anyway: rate limits are DISABLED ' +
        'and background jobs (payment confirmation, email) will not run until it returns.',
    );
  }
}

function installShutdownHandlers(server: Server, workers: EmbeddedWorkers): void {
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    // A second Ctrl-C should force-quit rather than queue another teardown.
    if (shuttingDown) {
      log.warn({ signal }, 'second signal received — exiting immediately');
      process.exit(1);
    }
    shuttingDown = true;
    log.info({ signal }, 'shutting down gracefully');

    // Backstop: never hang forever waiting on a stuck connection.
    const force = setTimeout(() => {
      log.error('graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    force.unref();

    try {
      // Stop accepting new connections; existing ones drain.
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      log.info('http server closed');

      /*
       * Close any in-process workers BEFORE the shared Prisma/Redis clients.
       * `close()` lets an in-flight job finish; tearing the connections down
       * first would kill it mid-write — a half-confirmed payment or a
       * duplicate email on retry.
       */
      if (workers.length > 0) {
        await Promise.allSettled(workers.map((w) => w.close()));
        await closeQueues();
        log.info({ workers: workers.length }, 'in-process workers closed');
      }

      await Promise.allSettled([disconnectPrisma(), disconnectRedis()]);
      log.info('shutdown complete');

      clearTimeout(force);
      process.exit(0);
    } catch (err) {
      log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // A thrown-but-uncaught error leaves the process in an unknown state. Log it
  // loudly and let the platform restart us clean.
  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'uncaught exception');
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    log.fatal({ reason }, 'unhandled promise rejection');
    void shutdown('unhandledRejection');
  });
}

async function main(): Promise<void> {
  await verifyDependencies();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    log.info(
      { port: env.PORT, env: env.NODE_ENV, node: process.version },
      `Zewa Feeds API listening on http://localhost:${env.PORT}`,
    );
  });

  // Slightly above typical load-balancer idle timeouts (60s) to avoid races
  // where the proxy reuses a socket we are closing.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  /*
   * Optionally host the queue consumers here. See RUN_WORKERS_IN_API in
   * config/env.ts for why a separate process is otherwise preferred.
   */
  const workers: EmbeddedWorkers = env.RUN_WORKERS_IN_API ? await startEmbeddedWorkers() : [];

  if (workers.length > 0) {
    log.warn(
      { workers: workers.length },
      'workers running INSIDE the API process — a stuck job can affect request latency',
    );
  }

  installShutdownHandlers(server, workers);
}

void main();
