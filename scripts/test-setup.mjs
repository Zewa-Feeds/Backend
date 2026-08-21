/**
 * Prepare the local integration-test environment.
 *
 * Waits for the docker services to accept connections, then applies migrations
 * to the test database. Idempotent: safe to run before every suite.
 *
 * Deliberately not `prisma db push` — the tests must run against the same
 * migration history production does, or a migration that works here and fails
 * there would go unnoticed until deploy.
 */
import { config } from 'dotenv';
import { execFileSync } from 'node:child_process';
import net from 'node:net';

config({ path: '.env.test', override: true });

const target = (url, fallbackPort) => {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port) || fallbackPort };
};

const services = [
  { name: 'postgres', ...target(process.env.DATABASE_URL, 5432) },
  { name: 'redis', ...target(process.env.REDIS_URL, 6379) },
];

/** Resolves once something is listening, or throws after ~60s. */
async function waitFor({ name, host, port }) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const open = await new Promise((resolve) => {
      const socket = net.connect({ host, port });
      socket.setTimeout(2000);
      socket.once('connect', () => (socket.destroy(), resolve(true)));
      socket.once('error', () => (socket.destroy(), resolve(false)));
      socket.once('timeout', () => (socket.destroy(), resolve(false)));
    });
    if (open) {
      console.log(`  ${name} ready on ${host}:${port}`);
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`${name} never came up on ${host}:${port} — is \`npm run docker:up\` running?`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

for (const service of services) await waitFor(service);

console.log('  applying migrations…');
execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
  stdio: 'inherit',
  env: { ...process.env },
});
console.log('  test database ready');
