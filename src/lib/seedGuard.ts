/**
 * Refuse to seed anything but a local database.
 *
 * `npm run seed` creates the staff accounts with a password, a fixed TOTP
 * secret and backup codes that are all in this repository. Run against
 * production, that is a full admin takeover with known credentials, and a
 * developer's .env can point at production. So the seed checks its target
 * before it writes anything, rather than relying on a sentence in the docs.
 *
 * Allowed: NODE_ENV is not "production" AND the database host is a local
 * one (localhost, 127.0.0.1, ::1, or the docker-compose service name).
 * Everything else — Supabase, Neon, Render, any remote host — is refused.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'postgres', 'db']);

export function seedTargetProblem(env: { NODE_ENV?: string; DATABASE_URL?: string }): string | null {
  if (env.NODE_ENV === 'production') {
    return 'NODE_ENV is "production".';
  }
  if (!env.DATABASE_URL) return 'DATABASE_URL is not set.';
  let host: string;
  try {
    host = new URL(env.DATABASE_URL).hostname.toLowerCase();
  } catch {
    return 'DATABASE_URL is not a valid URL.';
  }
  if (!LOCAL_HOSTS.has(host)) {
    return `the database host "${host}" is not a local database.`;
  }
  return null;
}

export function assertSeedTargetIsLocal(env: NodeJS.ProcessEnv = process.env): void {
  const problem = seedTargetProblem(env);
  if (problem) {
    throw new Error(
      `Refusing to seed: ${problem}\n` +
        'The seed creates staff accounts with credentials that are in the source code, ' +
        'so it only ever runs against a local development database.',
    );
  }
}
