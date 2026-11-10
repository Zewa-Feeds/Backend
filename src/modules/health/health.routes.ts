/**
 * Health endpoints.
 *
 * /health        LIVENESS  — is the process up? Never touches dependencies, so a
 *                            transient DB blip does not get the container killed.
 * /health/ready  READINESS — can it actually serve traffic? Checks Postgres and
 *                            Redis. This is what Docker HEALTHCHECK and the load
 *                            balancer poll.
 *
 * The distinction matters: restarting a container because Postgres was briefly
 * slow makes an outage worse, not better.
 */
import { Router } from 'express';
import { asyncHandler } from '@/middleware/asyncHandler';
import { checkDatabase, prisma } from '@/lib/prisma';
import { checkRedis } from '@/lib/redis';
import { env } from '@/config/env';
import { requireAuth, requireEnrolled2fa, requirePermission } from '@/middleware/auth';

export const healthRouter = Router();

const startedAt = Date.now();

/** Liveness — cheap and dependency-free. */
healthRouter.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    env: env.NODE_ENV,
  });
});

/** Readiness — checks every dependency the API cannot serve without. */
healthRouter.get(
  '/ready',
  asyncHandler(async (_req, res) => {
    const [database, cache] = await Promise.all([checkDatabase(), checkRedis()]);
    const healthy = database && cache;

    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ready' : 'degraded',
      checks: {
        database: database ? 'up' : 'down',
        redis: cache ? 'up' : 'down',
      },
    });
  }),
);

/**
 * Deeper diagnostics: environment, Node version and live business counts.
 *
 * Admin-only. It exposes no secrets, but the order count is commercially
 * sensitive (anyone polling it could track sales volume), and the runtime
 * details help an attacker fingerprint the stack. Uptime monitors use /ready.
 */
healthRouter.get(
  '/info',
  requireAuth,
  requireEnrolled2fa,
  requirePermission('settings.manage'),
  asyncHandler(async (_req, res) => {
    const [products, orders, staff] = await Promise.all([
      prisma.productFamily.count({ where: { deletedAt: null } }),
      prisma.order.count(),
      prisma.cmsUser.count({ where: { deletedAt: null } }),
    ]);

    res.json({
      status: 'ok',
      env: env.NODE_ENV,
      node: process.version,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      counts: { products, orders, staff },
    });
  }),
);
