/**
 * `prisma migrate deploy` over a DIRECT (unpooled) connection.
 *
 * WHY THIS EXISTS
 *
 * `migrate deploy` takes a session-scoped Postgres advisory lock so two deploys
 * cannot migrate the same database at once. An advisory lock belongs to a
 * SESSION — but pgbouncer in transaction mode hands each statement whichever
 * backend happens to be free, so the lock is taken on one connection and the
 * release lands on another. It then sits held by an idle pooler session until
 * that backend is recycled, and every deploy in between dies with:
 *
 *   Error: P1002
 *   Timed out trying to acquire a postgres advisory lock
 *   (SELECT pg_advisory_lock(72707369)). Timeout: 10000ms.
 *
 * That is exactly what broke the 21 Sep 2026 deploy: DATABASE_URL pointed at
 * Neon's `-pooler` host, `pg_locks` showed the lock held by an idle connection
 * whose application_name was "pgbouncer", and the build failed before the new
 * code ever started serving.
 *
 * WHY A SCRIPT RATHER THAN CONFIG
 *
 * `datasource.directUrl` in schema.prisma is rejected by Prisma 7, and a
 * `datasource` block in prisma.config.ts is silently DROPPED by the 6.19 CLI
 * this project pins — a probe showed it resolving to `undefined`, so it would
 * have looked configured while changing nothing. Overriding the environment for
 * this one command is version-proof: Prisma always reads DATABASE_URL.
 *
 * The running app is untouched and keeps using the pooled URL, which is what it
 * wants for ordinary queries.
 */
import { execFileSync } from 'node:child_process';
// Load .env the way every other entry point does. Render sets real environment
// variables and has no .env, so this is a no-op there; locally it is the only
// place DATABASE_URL lives, and without it the script wrongly reported that
// nothing was configured.
import 'dotenv/config';

const direct = process.env.DIRECT_URL?.trim();
const pooled = process.env.DATABASE_URL?.trim();

if (!pooled && !direct) {
  console.error('migrate-deploy: neither DATABASE_URL nor DIRECT_URL is set.');
  process.exit(1);
}

const url = direct || pooled;

/** Host only — never print credentials into a build log. */
const hostOf = (value) => {
  try {
    return new URL(value).host;
  } catch {
    return '(unparseable)';
  }
};

if (direct) {
  if (hostOf(direct).includes('-pooler')) {
    // Not fatal: a non-Neon pooler will not match this, and the deploy should
    // still go ahead. But it is almost always a copy-paste slip worth naming.
    console.warn(
      `migrate-deploy: WARNING — DIRECT_URL still points at a "-pooler" host ` +
        `(${hostOf(direct)}). Migrations may fail with P1002. Remove "-pooler" ` +
        `from the host to get a direct connection.`,
    );
  }
  console.log(`migrate-deploy: migrating over direct host ${hostOf(direct)}`);
} else {
  console.log(
    `migrate-deploy: DIRECT_URL is not set; using DATABASE_URL (${hostOf(pooled)}). ` +
      `If that is a pooled host, set DIRECT_URL to the same database without ` +
      `"-pooler" to avoid P1002 advisory-lock timeouts.`,
  );
}

execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: url },
});
