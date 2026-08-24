/**
 * Analytics & KPI Routes.
 *
 * Guarded by requireAuth + requireEnrolled2fa at the admin router level,
 * and scoped with requirePermission('orders.view') so Ops and Admin can access.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '@/middleware/asyncHandler';
import { requirePermission } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import * as analyticsService from './analytics.service';

export const analyticsRouter = Router();

analyticsRouter.use(requirePermission('orders.view'));

/**
 * §Overview: High-level KPI cards, sparklines, previous period deltas, and order mix.
 */
analyticsRouter.get(
  '/overview',
  validate({
    query: z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      compare: z.enum(['true', 'false']).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const fromStr = req.query.from as string | undefined;
    const toStr = req.query.to as string | undefined;
    const compare = req.query.compare !== 'false';

    const data = await analyticsService.getOverview(fromStr, toStr, compare);
    res.json({ data });
  }),
);

/**
 * §Revenue: Time-series breakdown, category share, family revenue, and state revenue.
 */
analyticsRouter.get(
  '/revenue',
  validate({
    query: z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      interval: z.enum(['day', 'week', 'month']).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const fromStr = req.query.from as string | undefined;
    const toStr = req.query.to as string | undefined;
    const interval = (req.query.interval as 'day' | 'week' | 'month') || 'day';

    const data = await analyticsService.getRevenueAnalytics(fromStr, toStr, interval);
    res.json({ data });
  }),
);

/**
 * §Products: Product performance table with sorting, search, and units sold.
 */
analyticsRouter.get(
  '/products',
  validate({
    query: z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      sort: z.enum(['revenue', 'units', 'orders', 'avgPrice']).optional(),
      dir: z.enum(['asc', 'desc']).optional(),
      search: z.string().optional(),
      page: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().max(100).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await analyticsService.getProductAnalytics({
      fromStr: req.query.from as string | undefined,
      toStr: req.query.to as string | undefined,
      sort: req.query.sort as 'revenue' | 'units' | 'orders' | 'avgPrice' | undefined,
      dir: req.query.dir as 'asc' | 'desc' | undefined,
      search: req.query.search as string | undefined,
      page: req.query.page ? Number(req.query.page) : 1,
      limit: req.query.limit ? Number(req.query.limit) : 20,
    });
    res.json(result);
  }),
);

/**
 * §Promotions: Coupon redemptions, attributed revenue, discount cost, and conversion rates.
 */
analyticsRouter.get(
  '/promotions',
  validate({
    query: z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      page: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().max(100).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const fromStr = req.query.from as string | undefined;
    const toStr = req.query.to as string | undefined;
    const page = req.query.page ? Number(req.query.page) : 1;
    const limit = req.query.limit ? Number(req.query.limit) : 20;

    const result = await analyticsService.getPromotionsAnalytics(fromStr, toStr, page, limit);
    res.json(result);
  }),
);

/**
 * §Customers: Repeat purchase rate, new vs returning segmentation, spend tiers.
 */
analyticsRouter.get(
  '/customers',
  validate({
    query: z.object({
      from: z.string().optional(),
      to: z.string().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const fromStr = req.query.from as string | undefined;
    const toStr = req.query.to as string | undefined;

    const data = await analyticsService.getCustomerAnalytics(fromStr, toStr);
    res.json({ data });
  }),
);

/**
 * §Geography: Orders, revenue, and AOV by State.
 */
analyticsRouter.get(
  '/geography',
  validate({
    query: z.object({
      from: z.string().optional(),
      to: z.string().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const fromStr = req.query.from as string | undefined;
    const toStr = req.query.to as string | undefined;

    const data = await analyticsService.getGeographicAnalytics(fromStr, toStr);
    res.json({ data });
  }),
);

/**
 * §Export: CSV stream for analytics reports.
 */
analyticsRouter.get(
  '/export',
  validate({
    query: z.object({
      type: z.enum(['revenue', 'products', 'promotions', 'geography']),
      from: z.string().optional(),
      to: z.string().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const type = req.query.type as 'revenue' | 'products' | 'promotions' | 'geography';
    const fromStr = req.query.from as string | undefined;
    const toStr = req.query.to as string | undefined;

    const { filename, csv } = await analyticsService.exportCsv(type, fromStr, toStr);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  }),
);
