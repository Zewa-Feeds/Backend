/**
 * Test environment bootstrap and teardown.
 *
 * ENVIRONMENT — this must run before anything imports `@/config/env`, which is
 * why it is the first entry in `setupFiles` and why dotenv is called at module
 * scope rather than inside a hook. It repoints DATABASE_URL and REDIS_URL at the
 * containers from `npm run docker:up`.
 *
 * The suite used to run against the shared hosted Postgres and a remote
 * free-tier Redis. Two consequences, both bad: a test could contaminate the real
 * catalogue, and reliability depended on someone else's connection limits — the
 * suite failed intermittently with 45s timeouts in whichever file happened to be
 * running, never on an assertion.
 *
 * `override: true` matters: a developer's `.env` is already loaded by the time
 * most tooling gets here, and without it the hosted URLs would win.
 */
import { config } from 'dotenv';
import { afterAll } from 'vitest';

config({ path: '.env.test', override: true });

process.on('unhandledRejection', (reason: unknown) => {
  if (reason instanceof Error && reason.message.includes('Connection is closed')) {
    return;
  }
});

/**
 * Close the Redis clients each isolated file opens.
 *
 * Vitest isolates the module registry per file, so every file reaching
 * `@/lib/redis` — directly or through the service graph — constructs its own
 * `redis` + `queueRedis` pair at import. Five of the nine do. Left open they
 * accumulate, and ioredis does not fail fast when a server refuses another
 * connection: it retries with backoff, so one command blocks for tens of
 * seconds.
 *
 * QUIT with a deadline, then force-close. Both halves are needed: `quit()` alone
 * waits for a reply that never arrives from a client still mid-handshake and
 * hangs until the hook timeout; `disconnect()` alone drops the socket without
 * telling the server, which then holds the slot until TCP timeout.
 */
afterAll(async () => {
  // Lazy: a file that never touched Redis must not construct a client here
  // purely in order to close it.
  const mod = await import('@/lib/redis').catch(() => null);
  if (!mod) return;

  await Promise.all(
    [mod.redis, mod.queueRedis].map(async (client) => {
      if (client.status === 'end') return;
      await Promise.race([
        client.quit().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
      client.disconnect();
    }),
  );
});
