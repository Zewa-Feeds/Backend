/**
 * Coupon routes — /api/v1/admin/coupons  (§10)
 *
 *   coupons.edit    Ops + Admin
 *   coupons.delete  Admin only
 */
import { Router } from 'express';
import {
  Category,
  CouponScope,
  CouponStacking,
  CouponTrigger,
  CustomerEligibility,
  DiscountType,
} from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '@/middleware/asyncHandler';
import { requirePermission } from '@/middleware/auth';
import { paginationSchema, validate } from '@/middleware/validate';
import { auditContext } from '@/modules/audit/audit.service';
import { priceCart } from '@/modules/checkout/pricing.service';
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

    // ---- Promotion configuration -------------------------------------------
    // Every field defaults to the behaviour that existed before it did, so a
    // client that omits all of them creates exactly the coupon it always would.
    name: z.string().trim().max(120).optional().nullable(),
    description: z.string().trim().max(500).optional().nullable(),
    /** Rupees in, paise out. Null means uncapped. */
    maxDiscount: z.coerce.number().nonnegative().max(1_000_000).optional().nullable(),
    stackingMode: z.nativeEnum(CouponStacking).default(CouponStacking.NON_STACKABLE),
    priority: z.coerce.number().int().min(0).max(1000).default(0),
    trigger: z.nativeEnum(CouponTrigger).default(CouponTrigger.CODE),
    combinesWithAutomatic: z.boolean().default(true),
    customerEligibility: z
      .nativeEnum(CustomerEligibility)
      .default(CustomerEligibility.ALL_CUSTOMERS),
    firstNOrders: z.coerce.number().int().min(1).max(50).optional().nullable(),
    minQty: z.coerce.number().int().min(1).max(999).optional().nullable(),
    maxQty: z.coerce.number().int().min(1).max(999).optional().nullable(),
    allowedStates: z.array(z.string().trim().max(60)).max(40).default([]),
    requireAllQualifiers: z.boolean().default(false),

    // ---- Targeting ---------------------------------------------------------
    qualifyingProductIds: z.array(z.string().uuid()).max(200).default([]),
    excludedProductIds: z.array(z.string().uuid()).max(200).default([]),
    variantIds: z.array(z.string().uuid()).max(200).default([]),
    qualifyingVariantIds: z.array(z.string().uuid()).max(200).default([]),
    categories: z.array(z.nativeEnum(Category)).max(20).default([]),
    qualifyingCategories: z.array(z.nativeEnum(Category)).max(20).default([]),
    customerEmails: z.array(z.string().trim().toLowerCase().email()).max(500).default([]),

    bxgy: z
      .object({
        buyQty: z.coerce.number().int().min(1).max(99),
        getQty: z.coerce.number().int().min(1).max(99),
        rewardPercentOff: z.coerce.number().int().min(1).max(100).default(100),
        maxRepeats: z.coerce.number().int().min(1).max(99).optional().nullable(),
      })
      .optional()
      .nullable(),
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
  .refine(
    (v) => v.customerEligibility !== CustomerEligibility.FIRST_N_ORDERS || v.firstNOrders !== null && v.firstNOrders !== undefined,
    { message: 'Enter how many orders the offer covers.', path: ['firstNOrders'] },
  )
  .refine(
    (v) =>
      v.customerEligibility !== CustomerEligibility.SPECIFIC_CUSTOMERS ||
      v.customerEmails.length > 0,
    { message: 'Add at least one customer email.', path: ['customerEmails'] },
  )
  .refine((v) => v.discountType !== DiscountType.BUY_X_GET_Y || v.bxgy !== null && v.bxgy !== undefined, {
    message: 'Set the buy and get quantities.',
    path: ['bxgy'],
  })
  .refine((v) => v.minQty === null || v.minQty === undefined || v.maxQty === null || v.maxQty === undefined || v.minQty <= v.maxQty, {
    message: 'Maximum quantity must be at least the minimum.',
    path: ['maxQty'],
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

    name: v.name ?? null,
    description: v.description ?? null,
    maxDiscountPaise:
      v.maxDiscount === null || v.maxDiscount === undefined
        ? null
        : Math.round(v.maxDiscount * 100),
    stackingMode: v.stackingMode,
    priority: v.priority,
    trigger: v.trigger,
    combinesWithAutomatic: v.combinesWithAutomatic,
    customerEligibility: v.customerEligibility,
    // Only meaningful for FIRST_N_ORDERS; cleared otherwise so a stale form
    // value cannot linger on a coupon that no longer uses it.
    firstNOrders:
      v.customerEligibility === CustomerEligibility.FIRST_N_ORDERS
        ? (v.firstNOrders ?? 1)
        : null,
    minQty: v.minQty ?? null,
    maxQty: v.maxQty ?? null,
    allowedStates: v.allowedStates,
    requireAllQualifiers: v.requireAllQualifiers,

    qualifyingProductIds: v.qualifyingProductIds,
    excludedProductIds: v.excludedProductIds,
    variantIds: v.variantIds,
    qualifyingVariantIds: v.qualifyingVariantIds,
    categories: v.categories,
    qualifyingCategories: v.qualifyingCategories,
    customerEmails:
      v.customerEligibility === CustomerEligibility.SPECIFIC_CUSTOMERS ? v.customerEmails : [],
    bxgy: v.discountType === DiscountType.BUY_X_GET_Y ? (v.bxgy ?? null) : null,
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

/**
 * Dry-run a promotion against a hypothetical cart.
 *
 * Answers "why is this not applying?" without an operator having to place a
 * real order to find out. It runs the SAME engine checkout runs, so what it
 * reports is what would actually happen — a reimplementation here would drift
 * and start lying, which is worse than having no preview at all.
 *
 * READ-ONLY BY CONSTRUCTION. It calls `priceCart`, which evaluates and prices
 * but never writes: usage counts, redemption rows and revenue totals are only
 * touched inside the checkout transaction, which this never enters. Running a
 * preview a hundred times changes nothing.
 */
couponsRouter.get(
  '/:id/analytics',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json({ data: await couponsService.analytics(req.params.id as string) });
  }),
);

couponsRouter.post(
  '/preview',
  validate({
    body: z.object({
      code: z.string().trim().toUpperCase().min(1).max(30),
      lines: z
        .array(
          z.object({
            sku: z.string().trim().max(40),
            qty: z.coerce.number().int().min(1).max(99),
          }),
        )
        .min(1, 'Add at least one product.')
        .max(50),
      /** Whose eligibility to test — order history is read for this address. */
      email: z.string().trim().toLowerCase().email().optional(),
      state: z.string().trim().max(60).optional(),
      /** Codes to treat as already applied, for testing stacking. */
      applied: z.array(z.string().trim().max(30)).max(10).default([]),
    }),
  }),
  asyncHandler(async (req, res) => {
    const body = req.body as {
      code: string;
      lines: { sku: string; qty: number }[];
      email?: string;
      state?: string;
      applied: string[];
    };

    const cart = await priceCart({
      lines: body.lines,
      couponCodes: [...body.applied, body.code],
      email: body.email,
      state: body.state,
    });

    const applied = cart.coupons.find((c) => c.code === body.code);
    const rejection = cart.issues.find(
      (i) => i.sku === '__coupon__' && i.couponCode === body.code,
    );

    res.json({
      data: {
        eligible: Boolean(applied),
        reason: applied ? null : (rejection?.message ?? 'This promotion does not apply.'),
        reasonCode: applied ? null : (rejection?.code ?? null),
        discountPaise: applied?.discountPaise ?? 0,
        discountLabel: applied?.discountLabel ?? null,
        appliedTo: applied?.appliedTo ?? [],
        freeShipping: applied?.freeShipping ?? false,
        // The whole priced outcome, so an operator can see the interaction with
        // other promotions rather than just this one in isolation.
        cart: {
          subtotalPaise: cart.subtotalPaise,
          discountPaise: cart.discountPaise,
          shippingPaise: cart.shippingPaise,
          taxPaise: cart.taxPaise,
          totalPaise: cart.totalPaise,
        },
        stack: cart.coupons.map((c) => ({
          code: c.code,
          discountPaise: c.discountPaise,
          discountLabel: c.discountLabel,
          automatic: c.automatic,
          stackingMode: c.stackingMode,
        })),
        otherRejections: cart.issues
          .filter((i) => i.sku === '__coupon__' && i.couponCode !== body.code)
          .map((i) => ({ code: i.couponCode, reason: i.message })),
      },
    });
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
