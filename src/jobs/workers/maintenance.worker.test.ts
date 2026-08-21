/**
 * The maintenance worker end to end: a queued job really does run the sweeps.
 *
 * The schedule and the lock are covered separately; what this pins is the wiring
 * between them — that the job the scheduler enqueues reaches the handler, that
 * the handler calls reconciliation, and that a second job arriving while one is
 * in flight is skipped rather than run twice.
 *
 * Uses the local Redis and Postgres from `npm run test:setup`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Worker } from 'bullmq';
import { maintenanceQueue } from '@/jobs/queues';
import { redis } from '@/lib/redis';
import * as reconcile from '@/modules/uploads/reconcile.service';
import { startMaintenanceWorker } from './maintenance.worker';

const LOCK_KEY = 'zewa:maintenance:reconcile-media:lock';
const EMPTY = {
  pendingChecked: 0, promoted: 0, failed: 0,
  orphansFound: 0, orphansDestroyed: 0, skippedUnknown: 0,
};

let worker: Worker;

beforeAll(async () => {
  await maintenanceQueue.obliterate({ force: true }).catch(() => undefined);
  worker = startMaintenanceWorker();
  await worker.waitUntilReady();
});

afterAll(async () => {
  await worker.close();
  await maintenanceQueue.obliterate({ force: true }).catch(() => undefined);
  await maintenanceQueue.close().catch(() => undefined);
});

beforeEach(async () => {
  await redis.del(LOCK_KEY).catch(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Wait for a queued job to finish, without guessing at a sleep. */
const settled = (jobId: string) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('job never settled')), 20_000);
    const done = () => { clearTimeout(timer); resolve(); };
    worker.on('completed', (j) => { if (j.id === jobId) done(); });
    worker.on('failed', (j) => { if (j?.id === jobId) done(); });
  });

describe('a queued reconciliation job', () => {
  it('actually runs the sweeps', async () => {
    const spy = vi.spyOn(reconcile, 'reconcileMediaLifecycle').mockResolvedValue(EMPTY);

    const job = await maintenanceQueue.add('reconcile-media', { kind: 'reconcile-media' });
    await settled(job.id as string);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('releases the lock afterwards, so the next hour can run', async () => {
    vi.spyOn(reconcile, 'reconcileMediaLifecycle').mockResolvedValue(EMPTY);

    const job = await maintenanceQueue.add('reconcile-media', { kind: 'reconcile-media' });
    await settled(job.id as string);

    expect(await redis.get(LOCK_KEY)).toBeNull();
  });

  it('skips when another sweep already holds the lock', async () => {
    /*
     * The overlap case: a previous run overran, or a manual trigger landed on
     * top of the schedule. Two sweeps together would each probe Cloudinary for
     * the same assets and could both decide the same orphan is destroyable.
     */
    await redis.set(LOCK_KEY, 'held-by-another-process', 'EX', 900);
    const spy = vi.spyOn(reconcile, 'reconcileMediaLifecycle').mockResolvedValue(EMPTY);

    const job = await maintenanceQueue.add('reconcile-media', { kind: 'reconcile-media' });
    await settled(job.id as string);

    expect(spy).not.toHaveBeenCalled();
    // The other holder's lock is untouched — releasing it would defeat the point.
    expect(await redis.get(LOCK_KEY)).toBe('held-by-another-process');
  });

  it('releases the lock even when a sweep throws', async () => {
    // Otherwise one failure wedges housekeeping until the TTL expires.
    vi.spyOn(reconcile, 'reconcileMediaLifecycle').mockRejectedValue(new Error('cloudinary down'));

    const job = await maintenanceQueue.add('reconcile-media', { kind: 'reconcile-media' });
    await settled(job.id as string);

    expect(await redis.get(LOCK_KEY)).toBeNull();
  });

  it('ignores an unrecognised maintenance job rather than guessing', async () => {
    const spy = vi.spyOn(reconcile, 'reconcileMediaLifecycle').mockResolvedValue(EMPTY);

    const job = await maintenanceQueue.add('something-else', { kind: 'not-a-real-job' } as never);
    await settled(job.id as string);

    expect(spy).not.toHaveBeenCalled();
  });

  it('runs sweeps one at a time', () => {
    // Concurrency above 1 would multiply the request rate against Cloudinary
    // during exactly the minute it is busiest.
    expect(worker.opts.concurrency).toBe(1);
  });
});
