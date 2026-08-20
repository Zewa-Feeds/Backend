/**
 * Per-file teardown for the integration suite.
 *
 * Vitest isolates the module registry per test file, so every file that reaches
 * `@/lib/redis` — directly or through the service graph — constructs its OWN
 * pair of clients (`redis` and `queueRedis`) at import time. Five of the nine
 * files do. Nothing closed them, so a full run accumulated up to ten open
 * connections against a remote, free-tier Key Value instance, on top of whatever
 * an earlier run had left behind.
 *
 * ioredis does not fail fast when a server refuses another connection: it
 * retries with backoff (`maxRetriesPerRequest: 3`), so a single command can
 * block for tens of seconds. That is the shape of the failures this suite kept
 * producing — normally-fast tests stalling past the 45s budget, in whichever
 * file happened to be running, including files that never touch Redis
 * themselves but import a module graph that opens it.
 *
 * Closing them per file keeps the count at two rather than ten. It changes no
 * assertion and hides no failure; it stops the test harness leaking the
 * connections that were causing them.
 */
import { afterAll } from 'vitest';

afterAll(async () => {
  // Imported lazily: a file that never touched Redis must not construct a
  // client here purely in order to close it.
  const mod = await import('@/lib/redis').catch(() => null);
  if (!mod) return;

  /*
   * QUIT if it is quick, force-close if it is not.
   *
   * The two obvious options are each wrong on their own. `quit()` alone waits
   * for a reply that never arrives from a client still mid-handshake, hanging
   * until the hook timeout once per file — that turned a nine-minute suite into
   * forty-five. `disconnect()` alone drops the socket without telling the
   * server, so a remote free-tier instance keeps the connection until TCP
   * timeout and successive runs pile up: three back-to-back suites went 209s,
   * 239s, 367s, the last one timing out.
   *
   * Sending QUIT lets the server free the slot immediately; the deadline means
   * a client that cannot answer costs a second and a half rather than a hook.
   */
  await Promise.all(
    [mod.redis, mod.queueRedis].map(async (client) => {
      if (client.status === 'end') return;
      await Promise.race([
        client.quit().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
      // Idempotent: a client QUIT already closed is simply already 'end'.
      client.disconnect();
    }),
  );
});
