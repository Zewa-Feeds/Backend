/**
 * Express application assembly.
 *
 * Middleware order matters and is deliberate:
 *   1. requestId    — so every later log line can be correlated
 *   2. helmet/cors  — reject early, before parsing a body
 *   3. raw webhook  — BEFORE express.json(), because HMAC needs the raw bytes
 *   4. parsers      — json/urlencoded/cookies
 *   5. logging      — has the request id, does not have the response yet
 *   6. routers      — public and admin, mounted separately
 *   7. 404 + errors — always last
 */
import express, { type Express } from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';

import { env } from '@/config/env';
import { logger } from '@/lib/logger';
import { requestId } from '@/middleware/requestId';
import { BODY_LIMIT, corsMiddleware, helmetMiddleware } from '@/middleware/security';
import { errorHandler, notFoundHandler } from '@/middleware/errorHandler';
import { healthRouter } from '@/modules/health/health.routes';
import { apiRouter } from '@/routes';

export function createApp(): Express {
  const app = express();

  // Behind Railway/Render/Fly, the client IP arrives in X-Forwarded-For. Rate
  // limiting is per-IP, so without this every request looks like it came from the
  // proxy and one user could exhaust everyone's budget.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(requestId);
  app.use(helmetMiddleware);
  app.use(corsMiddleware);
  app.use(compression());

  // ---- Raw body for webhook signature verification ------------------------
  // Must precede express.json(): re-serialising a parsed body changes the bytes
  // and the HMAC no longer matches.
  app.use('/api/v1/webhooks/razorpay', express.raw({ type: 'application/json', limit: '256kb' }));
  /* Cloudinary signs the RAW body — see webhook.ts. Parsing first breaks every
     signature, so this must stay above express.json(). */
  app.use('/api/v1/webhooks/cloudinary', express.raw({ type: '*/*', limit: '256kb' }));

  app.use(express.json({ limit: BODY_LIMIT }));
  app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));
  app.use(cookieParser());

  // ---- Request logging ----------------------------------------------------
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id as string,
      // Health checks poll constantly; logging them buries real traffic.
      autoLogging: {
        ignore: (req) => req.url?.startsWith('/health') ?? false,
      },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      customProps: (req) => ({ requestId: req.id }),
    }),
  );

  // ---- Routes -------------------------------------------------------------
  // Health sits outside /api/v1 so infrastructure probes never depend on API
  // versioning, and it is not rate limited.
  app.use('/health', healthRouter);

  app.use('/api/v1', apiRouter);

  // Root — a friendly marker, not an API surface.
  app.get('/', (_req, res) => {
    res.json({
      service: 'zewa-feeds-api',
      version: 'v1',
      docs: env.isProd ? undefined : '/api/v1',
    });
  });

  // ---- Terminal handlers --------------------------------------------------
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
