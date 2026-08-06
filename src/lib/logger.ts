/**
 * Structured logging. JSON in production (machine-parseable, ships to any log
 * aggregator); pretty-printed in development.
 *
 * Use this, never console.log — the eslint config enforces it.
 */
import pino from 'pino';
import { env } from '@/config/env';

/**
 * Keys scrubbed from logs wherever they appear. Passwords, tokens, and 2FA
 * secrets must never reach a log line, and neither should customer PII beyond
 * what we need to trace a request.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-razorpay-signature"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.passwordHash',
  '*.twofaSecret',
  '*.refreshToken',
  '*.accessToken',
  '*.challengeToken',
  '*.code',
  '*.otp',
  '*.backupCode',
  'password',
  'passwordHash',
  'twofaSecret',
  'refreshToken',
  'accessToken',
];

/**
 * Pretty-print only when pino-pretty is actually installed.
 *
 * It is a devDependency, so `npm prune --omit=dev` strips it from the production
 * image. Keying this off NODE_ENV alone would crash any container running with
 * NODE_ENV != production (a staging box, a local `docker run`) because pino
 * throws when it cannot resolve a transport target. Resolve it instead.
 */
function prettyTransport() {
  if (env.isProd) return undefined;
  try {
    require.resolve('pino-pretty');
    return {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname,service',
      },
    };
  } catch {
    // Not installed — fall through to structured JSON on stdout.
    return undefined;
  }
}

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: REDACT_PATHS,
    censor: '[redacted]',
  },
  base: { service: 'zewa-api' },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: prettyTransport(),
});

/** Child logger tagged with a subsystem name, e.g. logger for the email worker. */
export const childLogger = (name: string) => logger.child({ module: name });
