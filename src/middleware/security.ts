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
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Request-Id',
    'Idempotency-Key',
    'X-Preview-Token',
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
