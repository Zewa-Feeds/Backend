// Prisma configuration. Replaces the deprecated `package.json#prisma` key,
// which Prisma 7 removes.
import 'dotenv/config';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    /*
     * Migrations must NOT go through the connection pooler.
     *
     * `migrate deploy` takes a Postgres advisory lock so two deploys cannot
     * migrate the same database at once. An advisory lock belongs to a
     * SESSION, but pgbouncer in transaction mode hands each statement whichever
     * backend happens to be free — so the lock is taken on one connection and
     * the release lands on another. It then sits held by an idle pooler session
     * until that backend is recycled, and every deploy in the meantime fails:
     *
     *   Error: P1002
     *   Timed out trying to acquire a postgres advisory lock
     *   (SELECT pg_advisory_lock(72707369)). Timeout: 10000ms.
     *
     * That is what broke the deploy on 21 Sep 2026: DATABASE_URL pointed at
     * Neon's `-pooler` host, a pooler session was holding the lock, and the
     * build failed before the new code ever started.
     *
     * DIRECT_URL is the same Neon database with `-pooler` removed from the
     * host. Only the migration engine reads it; the running app still uses the
     * pooled DATABASE_URL, which is what a serverless-ish runtime wants. The
     * fallback keeps a local checkout working, where there is no pooler and the
     * two URLs are the same thing.
     */
    url: process.env.DIRECT_URL || process.env.DATABASE_URL,
  },
});
