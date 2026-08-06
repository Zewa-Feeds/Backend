/**
 * Worker process entry point — `npm run worker`.
 *
 * Deliberately a SEPARATE process from the API:
 *   - mail throughput and PDF generation cannot slow an HTTP request
 *   - workers can be scaled or restarted independently
 *   - a crash in a job handler does not take the API down
 *
 * Shuts down gracefully so an in-flight job finishes rather than being killed
 * mid-send, which would otherwise mean a duplicate email on retry.
 */
import { startEmailWorker } from './workers/email.worker';
import { startPaymentWorker } from './workers/payment.worker';
import { checkDatabase, disconnectPrisma } from '@/lib/prisma';
import { checkRedis, disconnectRedis } from '@/lib/redis';
import { closeQueues } from './queues';
import { logger } from '@/lib/logger';
import { env } from '@/config/env';

const log = logger.child({ module: 'worker' });

const SHUTDOWN_GRACE_MS = 30_000;

async function main(): Promise<void> {
  const [db, redis] = await Promise.all([checkDatabase(), checkRedis()]);
  if (!db || !redis) {
    log.fatal({ db, redis }, 'worker cannot reach its dependencies — exiting');
    process.exit(1);
  }

  const workers = [startEmailWorker(), startPaymentWorker()];

  log.info(
    { env: env.NODE_ENV, workers: workers.length, autoConfirm: env.RAZORPAY_AUTO_CONFIRM },
    'Zewa Feeds worker started',
  );

  if (env.RAZORPAY_AUTO_CONFIRM) {
    log.warn('TEST MODE ACTIVE: online payments auto-confirm after 30s without charging');
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    log.info({ signal }, 'worker shutting down');

    const force = setTimeout(() => {
      log.error('worker shutdown timed out — forcing exit');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    force.unref();

    try {
      // close(false) lets active jobs finish before the connection drops.
      await Promise.allSettled(workers.map((w) => w.close()));
      await closeQueues();
      await Promise.allSettled([disconnectPrisma(), disconnectRedis()]);
      clearTimeout(force);
      log.info('worker shutdown complete');
      process.exit(0);
    } catch (err) {
      log.error({ err }, 'error during worker shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'worker uncaught exception');
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    log.fatal({ reason }, 'worker unhandled rejection');
    void shutdown('unhandledRejection');
  });
}

void main();
