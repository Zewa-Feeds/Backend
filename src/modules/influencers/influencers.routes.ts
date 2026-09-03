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

const bodyFields = z.object({
  name: z.string().trim().min(2, 'Enter a name.').max(120),
  email: z.string().trim().email('Enter a valid email.').max(160).optional().or(z.literal('')),
  phone: z.string().trim().max(30).optional().or(z.literal('')),
  socialHandle: z.string().trim().max(80).optional().or(z.literal('')),
  notes: z.string().trim().max(500).optional().or(z.literal('')),
  couponCode: codeSchema,

  discountType: z.enum(['PERCENTAGE', 'FLAT']).optional().default('PERCENTAGE'),
  /** Used when discountType is PERCENTAGE. */
  discountPct: z
    .number()
    .int('Use a whole percentage.')
    .min(service.MIN_INFLUENCER_PCT)
    .max(service.MAX_INFLUENCER_PCT)
    .optional(),
  /** Used when discountType is FLAT. Rupees in, paise stored. */
  discountAmount: z.number().positive().max(1_000_000).optional(),

  /** Rupees in, paise stored — the same convention as the coupon routes. */
  minOrder: z.number().nonnegative().max(1_000_000).optional().default(0),
  /** Ceiling on a percentage discount, in rupees. Omit or null for no cap. */
  maxDiscount: z.number().positive().max(1_000_000).nullable().optional(),

  /** Total redemptions across all customers. Null/omitted means unlimited. */
  totalUsageLimit: z.number().int().positive().max(1_000_000).nullable().optional(),
  /** How many times one customer may use it. */
  perCustomerLimit: z.number().int().positive().max(1000).optional(),

  /*
   * NON_STACKABLE by default — one percentage discount per order. The admin may
   * relax it per influencer. GLOBALLY_STACKABLE is deliberately not accepted:
   * see AFFILIATE_STACKING in the service.
   */
  stackingMode: z.enum(service.AFFILIATE_STACKING).optional(),

  /** Restrict delivery states. Empty means anywhere we ship. */
  allowedStates: z.array(z.string().trim().min(2).max(60)).max(40).optional(),

  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  isActive: z.boolean().optional().default(true),
});

/*
 * Cross-field rules live on the CREATE schema only. `.refine()` returns a
 * ZodEffects, which has no `.partial()` — and a PATCH sending just a name has
 * no discount or dates to check against anyway. The service re-validates the
 * discount on update, so nothing is trusted to the schema alone.
 */
const bodySchema = bodyFields
  .refine(
    (v) => (v.discountType === 'FLAT' ? v.discountAmount != null : v.discountPct != null),
    { message: 'Enter the discount for the chosen type.', path: ['discountPct'] },
  )
  .refine((v) => v.endsAt > v.startsAt, {
    message: 'The end date must be after the start date.',
    path: ['endsAt'],
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
        discountType: b.discountType,
        discountPct: b.discountPct,
        discountPaise: b.discountAmount == null ? undefined : Math.round(b.discountAmount * 100),
        minOrderPaise: Math.round(b.minOrder * 100),
        maxDiscountPaise: b.maxDiscount == null ? null : Math.round(b.maxDiscount * 100),
        totalUsageLimit: b.totalUsageLimit ?? null,
        perCustomerLimit: b.perCustomerLimit,
        stackingMode: b.stackingMode,
        allowedStates: b.allowedStates,
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
  validate({ params: idParam, body: bodyFields.partial() }),
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
        ...(b.discountType !== undefined ? { discountType: b.discountType } : {}),
        ...(b.discountPct !== undefined ? { discountPct: b.discountPct } : {}),
        ...(b.discountAmount !== undefined
          ? { discountPaise: Math.round(b.discountAmount * 100) }
          : {}),
        ...(b.maxDiscount !== undefined
          ? { maxDiscountPaise: b.maxDiscount === null ? null : Math.round(b.maxDiscount * 100) }
          : {}),
        ...(b.totalUsageLimit !== undefined ? { totalUsageLimit: b.totalUsageLimit } : {}),
        ...(b.perCustomerLimit !== undefined ? { perCustomerLimit: b.perCustomerLimit } : {}),
        ...(b.stackingMode !== undefined ? { stackingMode: b.stackingMode } : {}),
        ...(b.allowedStates !== undefined ? { allowedStates: b.allowedStates } : {}),
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
