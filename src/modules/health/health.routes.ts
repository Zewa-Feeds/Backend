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
 * Deeper diagnostics. Deliberately not behind auth (it exposes no secrets) but it
 * does hit the database, so it sits apart from the polled endpoints.
 */
healthRouter.get(
  '/info',
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
