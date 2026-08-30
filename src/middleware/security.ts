/**
 * Security middleware — helmet, CORS, and body limits.
 */
import cors from 'cors';
import helmet from 'helmet';
import type { RequestHandler } from 'express';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'security' });

/**
 * Helmet defaults, minus CSP.
 *
 * This is a JSON API: it never serves HTML, so a CSP has nothing to protect. The
 * exception is invoice PDFs, which are a download rather than a rendered document.
 */
export const helmetMiddleware: RequestHandler = helmet({
  contentSecurityPolicy: false,
  // Allows the CMS on a different origin to trigger a PDF download.
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  referrerPolicy: { policy: 'no-referrer' },
});

/**
 * CORS — strict allowlist of exactly the storefront and CMS origins.
 *
 * `credentials: true` is required because the CMS sends its refresh-token cookie.
 * That is also why a wildcard origin is impossible here, and good: with
 * credentials enabled, `*` would let any site drive an authenticated CMS session.
 */
export const corsMiddleware: RequestHandler = cors({
  origin(origin, callback) {
    // Same-origin/server-to-server requests (curl, health checks) send no Origin.
    if (!origin) return callback(null, true);

    if (env.corsOrigins.includes(origin)) return callback(null, true);

    log.warn({ origin }, 'CORS: blocked disallowed origin');
    // Deny by omission, not by error: the browser blocks it, and we avoid a 500.
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  /*
   * EVERY custom header any client sends must be listed here, or the browser
   * fails the PREFLIGHT and the real request is never sent at all.
   *
   * This list is why "remember me" was broken. The CMS started sending its
   * refresh token in an `X-Refresh-Token` header; this array was not updated to
   * match, so Chrome rejected the preflight with
   * `HeaderDisallowedByPreflightResponse` and every POST /auth/refresh died in
   * the browser. The CMS saw a thrown fetch, could not tell "network down" from
   * "session invalid", and signed the user out — on hard refresh, in new tabs,
   * and whenever a 15-minute access token expired.
   *
   * `Access-Control-Max-Age: 86400` below made it worse: a browser that once
   * cached the failing preflight kept failing for a day without asking again.
   */
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Request-Id',
    'Idempotency-Key',
    'X-Preview-Token',
    'X-Refresh-Token',
  ],
  exposedHeaders: ['X-Request-Id', 'Content-Disposition'],
  maxAge: 86_400,
});

/**
 * Body size limits. Product and article payloads carry rich text and can be
 * chunky; nothing legitimate approaches 1 MB.
 */
export const BODY_LIMIT = '1mb';

/**
 * Razorpay webhooks need the RAW body to verify the HMAC signature — a parsed and
 * re-serialised object will not match the signature. This path is mounted with
 * express.raw() before the JSON parser; see app.ts.
 */
export const RAW_BODY_ROUTES = ['/api/v1/webhooks/razorpay'];
