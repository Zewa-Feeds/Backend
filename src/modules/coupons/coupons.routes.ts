/**
 * Coupon routes — /api/v1/admin/coupons  (§10)
 *
 *   coupons.edit    Ops + Admin
 *   coupons.delete  Admin only
 */
import { Router } from 'express';
import { CouponScope, DiscountType } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '@/middleware/asyncHandler';
import { requirePermission } from '@/middleware/auth';
import { paginationSchema, validate } from '@/middleware/validate';
import { auditContext } from '@/modules/audit/audit.service';
import * as couponsService from './coupons.service';

export const couponsRouter = Router();

couponsRouter.use(requirePermission('coupons.edit'));

const idParam = z.object({ id: z.string().uuid() });

/**
 * Coupon body.
 *
 * `discountValue` means different things per type, so it is normalised here:
 * percent stays a whole number, flat converts rupees → paise.
 */
const couponBodySchema = z
  .object({
    // §10.2: uppercase alphanumeric + hyphens only.
    code: z
      .string()
      .trim()
      .toUpperCase()
      .min(3, 'At least 3 characters.')
      .max(30)
      .regex(/^[A-Z0-9][A-Z0-9-]*$/, 'Use uppercase letters, numbers and hyphens only.'),
    discountType: z.nativeEnum(DiscountType),
    discountValue: z.coerce.number().positive('Enter a discount value.'),
    minOrder: z.coerce.number().nonnegative().max(1_000_000).default(0),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    totalUsageLimit: z.coerce.number().int().positive().nullable().default(null),
    perCustomerLimit: z.coerce.number().int().positive().max(100).default(1),
    isActive: z.boolean().default(true),

    /** ALL_PRODUCTS, or SPECIFIC_PRODUCTS with a non-empty productIds list. */
    scope: z.nativeEnum(CouponScope).default(CouponScope.ALL_PRODUCTS),
    productIds: z.array(z.string().uuid()).max(200).default([]),
  })
  // Caught here so the form gets a field-keyed error rather than a generic 500.
  .refine(
    (v) => v.scope !== CouponScope.SPECIFIC_PRODUCTS || v.productIds.length > 0,
    { message: 'Select at least one product.', path: ['productIds'] },
  )
  .refine((v) => v.endsAt > v.startsAt, {
    message: 'The end date must be after the start date.',
    path: ['endsAt'],
  })
  .refine((v) => v.discountType !== DiscountType.PERCENTAGE || v.discountValue <= 100, {
    message: 'A percentage discount cannot exceed 100%.',
    path: ['discountValue'],
  })
  .transform((v) => ({
    code: v.code,
    discountType: v.discountType,
    discountValue:
      v.discountType === DiscountType.PERCENTAGE
        ? Math.round(v.discountValue)
        : Math.round(v.discountValue * 100),
    minOrderPaise: Math.round(v.minOrder * 100),
    startsAt: v.startsAt,
    endsAt: v.endsAt,
    totalUsageLimit: v.totalUsageLimit,
    perCustomerLimit: v.perCustomerLimit,
    isActive: v.isActive,
    scope: v.scope,
    // ALL_PRODUCTS ignores any ids that were left in the form state.
    productIds: v.scope === CouponScope.SPECIFIC_PRODUCTS ? v.productIds : [],
  }));

/**
 * Coupon status is a DERIVED display string (§10.2), not a database enum, so it
 * cannot use the shared `enumFilter` helper — that one uppercases its input.
 * "All" (the CMS's unset sentinel) maps to no filter.
 */
const statusFilter = z.preprocess(
  (v) => (typeof v === 'string' && (v === 'All' || v === '') ? undefined : v),
  z.enum(['Active', 'Inactive', 'Expired']).optional(),
);

const listQuerySchema = paginationSchema.extend({
  status: statusFilter,
});

couponsRouter.get(
  '/',
  validate({ query: listQuerySchema }),
  asyncHandler(async (req, res) => {
    res.json(await couponsService.list(req.query as never));
  }),
);

couponsRouter.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json({ data: await couponsService.byId(req.params.id as string) });
  }),
);

/**
 * Per-coupon redemption report: which orders used it and what they were worth.
 *
 * Backs the revenue figure on the coupon list — a manager can click through from
 * the total to the individual orders behind it.
 */
couponsRouter.get(
  '/:id/redemptions',
  validate({ params: idParam, query: paginationSchema }),
  asyncHandler(async (req, res) => {
    res.json(await couponsService.redemptions(req.params.id as string, req.query as never));
  }),
);

couponsRouter.post(
  '/',
  validate({ body: couponBodySchema }),
  asyncHandler(async (req, res) => {
    const coupon = await couponsService.create(req.body, auditContext(req));
    res.status(201).json({ data: coupon });
  }),
);

couponsRouter.patch(
  '/:id',
  validate({ params: idParam, body: couponBodySchema }),
  asyncHandler(async (req, res) => {
    const coupon = await couponsService.update(
      req.params.id as string,
      req.body,
      auditContext(req),
    );
    res.json({ data: coupon });
  }),
);

couponsRouter.delete(
  '/:id',
  requirePermission('coupons.delete'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await couponsService.remove(req.params.id as string, auditContext(req));
    res.json({ data: { ok: true } });
  }),
);
