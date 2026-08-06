/**
 * Redis connections.
 *
 * Two separate clients, deliberately:
 *   - `redis`      general use — rate limiting, caching, OTP challenge storage.
 *   - `queueRedis` BullMQ only. BullMQ requires maxRetriesPerRequest: null and
 *                  issues blocking commands, which would stall shared use.
 */
import Redis from 'ioredis';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'redis' });

const baseOptions = {
  // Fail fast rather than hanging a request on a dead Redis.
  connectTimeout: 10_000,
  // Exponential backoff, capped.
  retryStrategy: (times: number) => Math.min(times * 200, 3_000),
  enableOfflineQueue: true,
} as const;

export const redis = new Redis(env.REDIS_URL, {
  ...baseOptions,
  maxRetriesPerRequest: 3,
});

/** BullMQ's required settings differ — see note above. */
export const queueRedis = new Redis(env.REDIS_URL, {
  ...baseOptions,
  maxRetriesPerRequest: null,
});

for (const [name, client] of [
  ['redis', redis],
  ['queueRedis', queueRedis],
] as const) {
  client.on('error', (err) => log.error({ err, client: name }, 'redis error'));
  client.on('connect', () => log.info({ client: name }, 'redis connected'));
  client.on('reconnecting', () => log.warn({ client: name }, 'redis reconnecting'));
}

/** Liveness check used by /health/ready. */
export async function checkRedis(): Promise<boolean> {
  try {
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch (err) {
    log.error({ err }, 'redis health check failed');
    return false;
  }
}

export async function disconnectRedis(): Promise<void> {
  await Promise.allSettled([redis.quit(), queueRedis.quit()]);
  log.info('redis disconnected');
}
