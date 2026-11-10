/**
 * Error monitoring (Sentry). Off unless SENTRY_DSN is set.
 *
 * Until Nov 2026 SENTRY_DSN existed in the env schema and nothing read it, so
 * an outage was learned about from a customer. Now unexpected errors (5xx in
 * the API, crashes in the API or the worker) are reported when a DSN is
 * configured. Expected errors (404s, validation) are never sent.
 *
 * To switch on: create a Sentry project under a Zewa-owned account, copy its
 * DSN into SENTRY_DSN on Render, redeploy. Nothing else to change.
 *
 * Privacy: sendDefaultPii is false, so no IP addresses, cookies or request
 * bodies are sent. Errors carry the request method, path and request id only.
 */
import * as Sentry from '@sentry/node';
import { env } from '@/config/env';

let enabled = false;

export function initMonitoring(service: 'api' | 'worker'): void {
  if (!env.SENTRY_DSN || enabled) return;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    serverName: `zewa-${service}`,
    sendDefaultPii: false,
    tracesSampleRate: 0,
  });
  enabled = true;
}

export function captureError(err: unknown, context?: Record<string, unknown>): void {
  if (!enabled) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}

/** Give queued reports a moment to leave before the process exits. */
export async function flushMonitoring(): Promise<void> {
  if (enabled) await Sentry.flush(2000).catch(() => undefined);
}
