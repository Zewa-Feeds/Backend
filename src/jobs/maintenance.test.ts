/**
 * The reconciliation schedule and its single-flight lock.
 *
 * Two things are worth testing here and neither is "does BullMQ work". The
 * schedule must be idempotent, because every worker boot re-asserts it and
 * several workers boot at once — a bug there means one sweep per instance,
 * multiplying the request rate against Cloudinary. And the lock must actually
 * exclude, because two sweeps running together could both decide the same
 * orphan is destroyable.
 *
 * Runs against the local Redis from `npm run test:setup`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { maintenanceQueue, scheduleMaintenance, QUEUE_NAMES } from '@/jobs/queues';
import { redis, queueRedis } from '@/lib/redis';

const LOCK_KEY = 'zewa:maintenance:reconcile-media:lock';

beforeAll(async () => {
  await maintenanceQueue.obliterate({ force: true }).catch(() => undefined);
});

afterEach(async () => {
  await redis.del(LOCK_KEY).catch(() => undefined);
});

afterAll(async () => {
  await maintenanceQueue.obliterate({ force: true }).catch(() => undefined);
  await maintenanceQueue.close().catch(() => undefined);
});

describe('the recurring schedule', () => {
  it('registers one repeatable sweep', async () => {
    await scheduleMaintenance();
    const repeatables = await maintenanceQueue.getRepeatableJobs();
    expect(repeatables).toHaveLength(1);
    expect(repeatables[0]!.name).toBe('reconcile-media');
  });

  it('runs hourly — often enough to matter, rarely enough to be free', async () => {
    await scheduleMaintenance();
    const [job] = await maintenanceQueue.getRepeatableJobs();
    expect(job!.every).toBe(String(60 * 60 * 1000));
  });

  it('is idempotent: re-registering leaves exactly one', async () => {
    /*
     * The case that matters in production — several worker instances booting
     * together, each asserting the schedule. One schedule per instance would
     * multiply the sweep rate against Cloudinary.
     */
    await scheduleMaintenance();
    await scheduleMaintenance();
    await scheduleMaintenance();
    expect(await maintenanceQueue.getRepeatableJobs()).toHaveLength(1);
  });

  it('survives concurrent registration', async () => {
    await Promise.all([scheduleMaintenance(), scheduleMaintenance(), scheduleMaintenance()]);
    expect(await maintenanceQueue.getRepeatableJobs()).toHaveLength(1);
  });

  it('uses the shared queue the rest of the system knows about', () => {
    expect(maintenanceQueue.name).toBe(QUEUE_NAMES.maintenance);
  });
});

describe('the single-flight lock', () => {
  /** The same acquire the worker performs. */
  const acquire = () => redis.set(LOCK_KEY, String(Date.now()), 'EX', 900, 'NX');

  it('lets the first caller through', async () => {
    expect(await acquire()).toBe('OK');
  });

  it('refuses a second caller while the first holds it', async () => {
    await acquire();
    expect(await acquire()).toBeNull();
  });

  it('excludes exactly one winner under a concurrent race', async () => {
    // NX is an atomic test-and-set; a GET-then-SET would let both through.
    const results = await Promise.all([acquire(), acquire(), acquire(), acquire()]);
    expect(results.filter((r) => r === 'OK')).toHaveLength(1);
  });

  it('is released so the next sweep can run', async () => {
    await acquire();
    await redis.del(LOCK_KEY);
    expect(await acquire()).toBe('OK');
  });

  it('expires on its own if a process dies holding it', async () => {
    // Otherwise a crash mid-sweep would wedge housekeeping until someone noticed.
    await redis.set(LOCK_KEY, 'held', 'EX', 900, 'NX');
    const ttl = await redis.ttl(LOCK_KEY);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(900);
  });
});

describe('job options', () => {
  it('does not retry housekeeping hard', async () => {
    /*
     * Every sweep is idempotent and runs again on the next tick, so a failure
     * costs one interval. Retrying hard would stack overlapping sweeps against
     * Cloudinary during exactly the outage that caused the failure.
     */
    await scheduleMaintenance();
    const job = await maintenanceQueue.add('reconcile-media', { kind: 'reconcile-media' });
    expect(job.opts.attempts).toBe(2);
    await job.remove();
  });
});
