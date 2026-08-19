/**
 * Keeps a BullMQ worker from turning a broken Redis into a log flood.
 *
 * A BullMQ worker polls with a blocking `evalsha`. When Redis rejects every
 * command — an exhausted Upstash quota, a dead instance — that poll fails and is
 * retried immediately, forever. Two things go wrong:
 *
 *   1. Nothing is listening on the worker's 'error' event, so Node prints the
 *      raw ReplyError with its stack. Thousands of them, several per second,
 *      burying every other line in the service log.
 *   2. Each retry is itself a Redis command. On a quota-capped plan the retry
 *      storm is spending the very budget that ran out, so the outage cannot
 *      heal even after the window rolls over.
 *
 * So: log the failure once per minute rather than once per attempt, and after a
 * short run of consecutive errors pause the worker for a cooldown before letting
 * it try again. Pausing is LOCAL (it stops this process fetching) — it does not
 * write a paused flag to Redis, which would need the very connection that is
 * failing and would outlive the process.
 *
 * The worker resumes by itself, so a Redis that comes back needs no deploy.
 */
import type { Worker } from 'bullmq';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'worker.guard' });

/** Consecutive errors before backing off. Small — a healthy queue never errors. */
const ERRORS_BEFORE_PAUSE = 5;

/** How long to stay paused before trying again. */
const COOLDOWN_MS = 60_000;

/** Never log the same failure more than once a minute. */
const LOG_EVERY_MS = 60_000;

export function guardWorker(worker: Worker, name: string): void {
  let consecutive = 0;
  let lastLoggedAt = 0;
  let cooling = false;

  const resumeAfterCooldown = () => {
    setTimeout(() => {
      consecutive = 0;
      cooling = false;
      // resume() is synchronous in BullMQ 5; only pause() returns a promise.
      worker.resume();
      log.warn({ worker: name }, 'worker resumed — retrying the queue');
    }, COOLDOWN_MS).unref?.();
  };

  worker.on('error', (err: Error) => {
    consecutive += 1;

    const now = Date.now();
    if (now - lastLoggedAt > LOG_EVERY_MS) {
      lastLoggedAt = now;
      log.error(
        { err, worker: name, consecutiveErrors: consecutive },
        'worker cannot reach Redis — jobs are NOT being processed',
      );
    }

    if (!cooling && consecutive >= ERRORS_BEFORE_PAUSE) {
      cooling = true;
      log.error(
        { worker: name, cooldownMs: COOLDOWN_MS },
        'pausing worker to stop a retry storm; it will retry after the cooldown',
      );
      worker
        .pause()
        .catch((err: unknown) => log.error({ err, worker: name }, 'worker pause failed'));
      resumeAfterCooldown();
    }
  });

  // Any completed job proves the connection is healthy again.
  worker.on('completed', () => {
    if (consecutive > 0 && !cooling) {
      log.info({ worker: name }, 'worker recovered — processing jobs again');
    }
    consecutive = 0;
  });
}
