/**
 * Test runner.
 *
 * The resolver is pure and would run in milliseconds, but the integrity and
 * preview suites talk to the real database — composite keys, cascade direction
 * and transaction behaviour are the things being tested, and a mock would only
 * prove the mock was called.
 *
 * That database is remote (Neon), so a round trip costs roughly a second. Two
 * settings follow from that and neither is a workaround:
 *
 *   - testTimeout is raised well above the 5s default, which is sized for unit
 *     tests and times out on a handful of sequential queries;
 *   - fileParallelism is off, because three files opening transactions against
 *     one remote database contend for connections and each other's locks.
 *
 * Sequential and slower, but honest: a green run means the invariants hold.
 */
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 45_000,
    hookTimeout: 45_000,
    fileParallelism: false,
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
