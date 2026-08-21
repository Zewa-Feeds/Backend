/**
 * Maintenance worker — periodic housekeeping.
 *
 * Currently one job: media reconciliation. The Cloudinary webhook is the fast
 * path for moving an asset from PENDING to READY, and this is what makes a
 * MISSED webhook survivable. Notifications get lost — a deploy mid-flight, an
 * outage, a URL that was wrong for an hour — and without something asking
 * Cloudinary directly, a video sits PENDING forever and never reaches a
 * customer, while an abandoned upload bills forever.
 *
 * Runs in the worker process rather than the API for the same reason everything
 * else does: a sweep that talks to Cloudinary for a hundred assets must not sit
 * inside an HTTP request or compete with one.
 */
import { Worker, type Job } from 'bullmq';
import { queueRedis, redis } from '@/lib/redis';
import { logger } from '@/lib/logger';
import { QUEUE_NAMES, type MaintenanceJob } from '@/jobs/queues';
import { guardWorker } from '@/jobs/workers/guard';
import { reconcileMediaLifecycle } from '@/modules/uploads/reconcile.service';

const log = logger.child({ module: 'worker.maintenance' });

/**
 * Only one sweep at a time, across every process.
 *
 * BullMQ already delivers a job to one worker, but that is not the whole story:
 * a repeatable job whose previous run overran, a manual trigger, and a retry can
 * all overlap. Two sweeps running together would each probe Cloudinary for the
 * same assets and — worse — could both decide the same orphan is destroyable.
 *
 * A Redis key with an expiry is the right shape here: it is held only while the
 * work runs, and if the process dies holding it the lock expires on its own
 * rather than wedging housekeeping until someone notices.
 */
const LOCK_KEY = 'zewa:maintenance:reconcile-media:lock';
const LOCK_TTL_SECONDS = 15 * 60;

async function withLock<T>(fn: () => Promise<T>): Promise<T | 'skipped'> {
  // NX: set only if absent. The atomic test-and-set is the whole point — a
  // GET-then-SET would let two workers both see it free.
  const acquired = await redis.set(LOCK_KEY, String(Date.now()), 'EX', LOCK_TTL_SECONDS, 'NX');
  if (acquired !== 'OK') return 'skipped';

  try {
    return await fn();
  } finally {
    await redis.del(LOCK_KEY).catch(() => undefined);
  }
}

async function handleReconcile(job: Job<MaintenanceJob>): Promise<void> {
  const outcome = await withLock(async () => {
    const started = Date.now();
    const report = await reconcileMediaLifecycle();
    return { ...report, durationMs: Date.now() - started };
  });

  if (outcome === 'skipped') {
    // Not an error: another sweep is already doing exactly this work.
    log.info({ jobId: job.id }, 'reconciliation skipped — another sweep holds the lock');
    return;
  }

  const worthReporting =
    outcome.promoted > 0 || outcome.failed > 0 || outcome.orphansDestroyed > 0;

  // Quiet when there is nothing to say. This runs hourly forever, and a log line
  // per hour saying "nothing happened" buries the ones that matter.
  if (worthReporting) {
    log.info(outcome, 'media reconciliation made changes');
  } else {
    log.debug(outcome, 'media reconciliation found nothing to do');
  }
}

export function startMaintenanceWorker(): Worker<MaintenanceJob> {
  const worker = new Worker<MaintenanceJob>(
    QUEUE_NAMES.maintenance,
    async (job) => {
      if (job.data.kind === 'reconcile-media') return handleReconcile(job);
      log.warn({ kind: (job.data as { kind?: string }).kind }, 'unknown maintenance job');
    },
    {
      connection: queueRedis,
      /*
       * One at a time. Housekeeping has no latency requirement and the sweeps
       * talk to an external API — concurrency here would only multiply the
       * request rate against Cloudinary during the exact minute it is busiest.
       */
      concurrency: 1,
    },
  );

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, err }, 'maintenance job failed');
  });

  // Without this, a Redis outage prints a raw ReplyError several times a second.
  guardWorker(worker, 'maintenance');

  return worker;
}
