/**
 * Influencer affiliate routes — /api/v1/admin/influencers
 *
 * Gated by `coupons.edit`, because an affiliate IS a coupon with a profile
 * attached — anyone who may change discounts may run the affiliate programme,
 * and nobody else. Mounted under adminRouter, so staff JWT + enrolled 2FA are
 * already enforced above this file.
 *
 * There is no delete route, deliberately. An affiliate is deactivated, never
 * removed: their coupon is the link historical orders were attributed through.
 */
import { Router } from 'express';
import { InfluencerStatus } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '@/middleware/asyncHandler';
import { requirePermission } from '@/middleware/auth';
import { paginationSchema, validate } from '@/middleware/validate';
import { auditContext } from '@/modules/audit/audit.service';
import * as service from './influencers.service';

export const influencersRouter = Router();

influencersRouter.use(requirePermission('coupons.edit'));

const idParam = z.object({ id: z.string().uuid() });

/** §10.2 code shape: uppercase alphanumeric and hyphens, normalised on write. */
const codeSchema = z
  .string()
  .trim()
  .min(3, 'Code must be at least 3 characters.')
  .max(24)
  .regex(/^[A-Za-z0-9-]+$/, 'Use letters, numbers and hyphens only.');

const bodySchema = z.object({
  name: z.string().trim().min(2, 'Enter a name.').max(120),
  email: z.string().trim().email('Enter a valid email.').max(160).optional().or(z.literal('')),
  phone: z.string().trim().max(30).optional().or(z.literal('')),
  socialHandle: z.string().trim().max(80).optional().or(z.literal('')),
  notes: z.string().trim().max(500).optional().or(z.literal('')),
  couponCode: codeSchema,
  discountPct: z
    .number()
    .int('Use a whole percentage.')
    .min(service.MIN_INFLUENCER_PCT)
    .max(service.MAX_INFLUENCER_PCT),
  /** Rupees in, paise stored — the same convention as the coupon routes. */
  minOrder: z.number().nonnegative().max(1_000_000).optional().default(0),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  isActive: z.boolean().optional().default(true),
});

const listQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(80).optional(),
  status: z.nativeEnum(InfluencerStatus).optional(),
});

const ordersQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(80).optional(),
  status: z.string().trim().max(30).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const rangeQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

influencersRouter.get(
  '/',
  validate({ query: listQuerySchema }),
  asyncHandler(async (req, res) => {
    const { page, limit, q, status } = req.query as unknown as z.infer<typeof listQuerySchema>;
    res.json(await service.list({ page, limit, q, status }));
  }),
);

influencersRouter.post(
  '/',
  validate({ body: bodySchema }),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof bodySchema>;
    const data = await service.create(
      {
        name: b.name,
        email: b.email || null,
        phone: b.phone || null,
        socialHandle: b.socialHandle || null,
        notes: b.notes || null,
        couponCode: b.couponCode,
        discountPct: b.discountPct,
        minOrderPaise: Math.round(b.minOrder * 100),
        startsAt: b.startsAt,
        endsAt: b.endsAt,
        isActive: b.isActive,
      },
      auditContext(req),
    );
    res.status(201).json({ data });
  }),
);

influencersRouter.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json({ data: await service.getById(req.params.id!) });
  }),
);

influencersRouter.patch(
  '/:id',
  validate({ params: idParam, body: bodySchema.partial() }),
  asyncHandler(async (req, res) => {
    const b = req.body as Partial<z.infer<typeof bodySchema>>;
    const data = await service.update(
      req.params.id!,
      {
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.email !== undefined ? { email: b.email || null } : {}),
        ...(b.phone !== undefined ? { phone: b.phone || null } : {}),
        ...(b.socialHandle !== undefined ? { socialHandle: b.socialHandle || null } : {}),
        ...(b.notes !== undefined ? { notes: b.notes || null } : {}),
        ...(b.couponCode !== undefined ? { couponCode: b.couponCode } : {}),
        ...(b.discountPct !== undefined ? { discountPct: b.discountPct } : {}),
        ...(b.minOrder !== undefined ? { minOrderPaise: Math.round(b.minOrder * 100) } : {}),
        ...(b.startsAt !== undefined ? { startsAt: b.startsAt } : {}),
        ...(b.endsAt !== undefined ? { endsAt: b.endsAt } : {}),
        ...(b.isActive !== undefined ? { isActive: b.isActive } : {}),
      },
      auditContext(req),
    );
    res.json({ data });
  }),
);

influencersRouter.post(
  '/:id/activate',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json({
      data: await service.setStatus(req.params.id!, InfluencerStatus.ACTIVE, auditContext(req)),
    });
  }),
);

influencersRouter.post(
  '/:id/deactivate',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json({
      data: await service.setStatus(req.params.id!, InfluencerStatus.INACTIVE, auditContext(req)),
    });
  }),
);

influencersRouter.get(
  '/:id/analytics',
  validate({ params: idParam, query: rangeQuerySchema }),
  asyncHandler(async (req, res) => {
    const { from, to } = req.query as unknown as z.infer<typeof rangeQuerySchema>;
    res.json({ data: await service.analytics(req.params.id!, { from, to }) });
  }),
);

influencersRouter.get(
  '/:id/orders',
  validate({ params: idParam, query: ordersQuerySchema }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof ordersQuerySchema>;
    res.json(await service.attributedOrders(req.params.id!, q));
  }),
);
