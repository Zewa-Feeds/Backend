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

const log = logger.child({ module: 'server' });

/** How long in-flight requests get to finish before we force the process down. */
const SHUTDOWN_GRACE_MS = 15_000;

async function verifyDependencies(): Promise<void> {
  const [database, cache] = await Promise.all([checkDatabase(), checkRedis()]);

  if (!database) {
    log.fatal('cannot reach Postgres — check DATABASE_URL and that the container is up');
  }
  if (!cache) {
    log.fatal('cannot reach Redis — check REDIS_URL and that the container is up');
  }
  if (!database || !cache) {
    log.fatal('startup aborted: run `npm run docker:up` for local dependencies');
    process.exit(1);
  }
}

function installShutdownHandlers(server: Server): void {
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

  installShutdownHandlers(server);
}

void main();
