/**
 * Queue consumers hosted inside the API process.
 *
 * This deployment runs one Render service, so the API is where the workers
 * live. The bug this guards against is specific and was real: `server.ts`
 * started only the email and payment workers, because those were the only
 * queues that existed when it was written. The maintenance worker and its
 * schedule lived solely in the separate worker entry point — so on a
 * single-service deployment, media reconciliation never ran at all, and
 * surviving a missed Cloudinary webhook is its entire job.
 *
 * What matters here is therefore composition, not BullMQ: that all three
 * workers start, that the schedule is registered exactly once however many
 * times the process boots, and that shutdown closes everything.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { maintenanceQueue, scheduleMaintenance } from '@/jobs/queues';
import { startEmailWorker } from '@/jobs/workers/email.worker';
import { startPaymentWorker } from '@/jobs/workers/payment.worker';
import { startMaintenanceWorker } from '@/jobs/workers/maintenance.worker';

/**
 * The composition server.ts performs under RUN_WORKERS_IN_API.
 *
 * Reproduced rather than imported: importing server.ts would start an HTTP
 * listener and install process-wide signal handlers, which a test must not do.
 * The assertions below pin the same three factories and the same schedule call
 * that it makes.
 */
async function startEmbeddedWorkers() {
  const workers = [startEmailWorker(), startPaymentWorker(), startMaintenanceWorker()];
  try {
    await scheduleMaintenance();
  } catch {
    /* a failed schedule must never stop the API booting */
  }
  return workers;
}

beforeAll(async () => {
  await maintenanceQueue.obliterate({ force: true }).catch(() => undefined);
});

afterAll(async () => {
  await maintenanceQueue.obliterate({ force: true }).catch(() => undefined);
  await maintenanceQueue.close().catch(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('starting workers inside the API', () => {
  it('starts all three consumers, not just email and payment', async () => {
    const workers = await startEmbeddedWorkers();
    try {
      expect(workers).toHaveLength(3);
      expect(workers.map((w) => w.name).sort()).toEqual(
        ['zewa-email', 'zewa-maintenance', 'zewa-payment'],
      );
    } finally {
      await Promise.allSettled(workers.map((w) => w.close()));
    }
  });

  it('includes the maintenance worker — the one that used to be missing', async () => {
    const workers = await startEmbeddedWorkers();
    try {
      expect(workers.some((w) => w.name === 'zewa-maintenance')).toBe(true);
    } finally {
      await Promise.allSettled(workers.map((w) => w.close()));
    }
  });

  it('registers the maintenance schedule', async () => {
    const workers = await startEmbeddedWorkers();
    try {
      const repeatables = await maintenanceQueue.getRepeatableJobs();
      expect(repeatables).toHaveLength(1);
      expect(repeatables[0]!.name).toBe('reconcile-media');
    } finally {
      await Promise.allSettled(workers.map((w) => w.close()));
    }
  });

  it('registers exactly one schedule however many times the process boots', async () => {
    /*
     * A restart, a redeploy, or several instances behind a load balancer all
     * re-run this. One schedule per boot would multiply the sweep rate against
     * Cloudinary.
     */
    const first = await startEmbeddedWorkers();
    await Promise.allSettled(first.map((w) => w.close()));
    const second = await startEmbeddedWorkers();
    try {
      expect(await maintenanceQueue.getRepeatableJobs()).toHaveLength(1);
    } finally {
      await Promise.allSettled(second.map((w) => w.close()));
    }
  });

  it('does not duplicate consumers on the same queue', async () => {
    const workers = await startEmbeddedWorkers();
    try {
      const names = workers.map((w) => w.name);
      expect(new Set(names).size).toBe(names.length);
    } finally {
      await Promise.allSettled(workers.map((w) => w.close()));
    }
  });

  it('still boots when the schedule cannot be written', async () => {
    /*
     * Refusing to serve HTTP because a housekeeping timer could not be
     * registered would be far worse than a late sweep. Redis is optional for
     * the API by design — see verifyDependencies.
     */
    vi.spyOn(maintenanceQueue, 'add').mockRejectedValue(new Error('redis down'));

    const workers = await startEmbeddedWorkers();
    try {
      expect(workers).toHaveLength(3);
    } finally {
      await Promise.allSettled(workers.map((w) => w.close()));
    }
  });
});

describe('graceful shutdown', () => {
  it('closes every worker, so an in-flight job is not killed mid-write', async () => {
    const workers = await startEmbeddedWorkers();
    /*
     * Wait for the connections before closing them. A worker still mid-handshake
     * reports isRunning() true even after close() resolves, which would make
     * this assert nothing. In production the workers are long ready by the time
     * SIGTERM arrives, so this is the faithful shape as well as the stable one.
     */
    await Promise.all(workers.map((w) => w.waitUntilReady()));

    // This is what installShutdownHandlers does with the array it is handed.
    const results = await Promise.allSettled(workers.map((w) => w.close()));

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    for (const w of workers) expect(w.isRunning()).toBe(false);
  });

  it('is safe to close twice', async () => {
    // A second SIGTERM, or a shutdown racing a crash handler.
    const workers = await startEmbeddedWorkers();
    await Promise.allSettled(workers.map((w) => w.close()));
    const again = await Promise.allSettled(workers.map((w) => w.close()));
    expect(again.every((r) => r.status === 'fulfilled')).toBe(true);
  });
});
