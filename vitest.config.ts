/**
 * Test runner.
 *
 * The resolver and presentation layers are pure and run in milliseconds, but the
 * integrity, preview, identity and draft suites talk to a real database —
 * composite keys, cascade direction, unique constraints and transaction
 * behaviour are the things being tested, and a mock would only prove the mock
 * was called.
 *
 * That database is now LOCAL: `.env.test` points at the Postgres and Redis
 * containers in docker/docker-compose.yml.
 *
 *   npm run test:setup     start the containers, migrate, seed
 *   npm test               run against them
 *
 * It used to be the shared hosted instance, which meant a test could contaminate
 * the real catalogue and that reliability depended on a remote free tier. Round
 * trips are now sub-millisecond instead of ~70ms, so the suite is both faster
 * and deterministic.
 *
 * `fileParallelism` stays off: several files opening transactions against one
 * database contend for each other's locks, and a green run has to mean the
 * invariants hold rather than that the scheduler was kind.
 */import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 45_000,
    hookTimeout: 45_000,
    fileParallelism: false,
    /* Loads .env.test and closes per-file Redis clients. See vitest.setup.ts. */
    setupFiles: ['./vitest.setup.ts'],
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
