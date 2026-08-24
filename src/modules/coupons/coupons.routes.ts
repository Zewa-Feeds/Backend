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
  CouponTargetRole,
  CouponTrigger,
  CustomerEligibility,
  DiscountType,
} from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { asyncHandler } from '@/middleware/asyncHandler';
import { requirePermission } from '@/middleware/auth';
import { paginationSchema, validate } from '@/middleware/validate';
import { auditContext } from '@/modules/audit/audit.service';
import { priceCart } from '@/modules/checkout/pricing.service';
import { PROMOTION_SELECT, type PromotionRow } from '@/modules/promotions/types';
import { resolveTargeting } from '@/modules/promotions/targeting';
import { promotionStatus } from '@/modules/promotions/eligibility';
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
    body: z
      .object({
        code: z.string().trim().toUpperCase().min(1).max(30).optional(),
        coupon: couponBodySchema.optional(),
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
      })
      .refine((v) => Boolean(v.code || v.coupon), {
        message: 'Provide either a coupon code or a promotion configuration.',
        path: ['code'],
      }),
  }),
  asyncHandler(async (req, res) => {
    const body = req.body as {
      code?: string;
      coupon?: ReturnType<typeof couponBodySchema.parse>;
      lines: { sku: string; qty: number }[];
      email?: string;
      state?: string;
      applied: string[];
    };

    const overlayPromotions: PromotionRow[] = [];
    let targetCode = body.code ?? '';
    let targetCouponRow: PromotionRow | null = null;

    if (body.coupon) {
      const c = body.coupon;
      targetCode = c.code;
      const row: PromotionRow = {
        id: 'preview-coupon',
        code: c.code,
        name: c.name,
        description: c.description,
        discountType: c.discountType,
        discountValue: c.discountValue,
        maxDiscountPaise: c.maxDiscountPaise,
        minOrderPaise: c.minOrderPaise,
        minQty: c.minQty,
        maxQty: c.maxQty,
        startsAt: c.startsAt,
        endsAt: c.endsAt,
        totalUsageLimit: c.totalUsageLimit,
        perCustomerLimit: c.perCustomerLimit,
        usedCount: 0,
        isActive: c.isActive,
        scope: c.scope,
        stackingMode: c.stackingMode,
        priority: c.priority,
        trigger: c.trigger,
        combinesWithAutomatic: c.combinesWithAutomatic,
        customerEligibility: c.customerEligibility,
        firstNOrders: c.firstNOrders,
        allowedStates: c.allowedStates,
        requireAllQualifiers: c.requireAllQualifiers,
        products: [
          ...c.productIds.map((id) => ({ familyId: id, role: CouponTargetRole.DISCOUNT })),
          ...c.qualifyingProductIds.map((id) => ({ familyId: id, role: CouponTargetRole.QUALIFY })),
          ...c.excludedProductIds.map((id) => ({ familyId: id, role: CouponTargetRole.EXCLUDE })),
        ],
        variants: [
          ...c.variantIds.map((id) => ({ variantId: id, role: CouponTargetRole.DISCOUNT })),
          ...c.qualifyingVariantIds.map((id) => ({ variantId: id, role: CouponTargetRole.QUALIFY })),
        ],
        categories: [
          ...c.categories.map((cat) => ({ category: cat, role: CouponTargetRole.DISCOUNT })),
          ...c.qualifyingCategories.map((cat) => ({ category: cat, role: CouponTargetRole.QUALIFY })),
        ],
        customers: c.customerEmails.map((email) => ({ email })),
        bxgy: c.bxgy
          ? {
              buyQty: c.bxgy.buyQty,
              getQty: c.bxgy.getQty,
              rewardPercentOff: c.bxgy.rewardPercentOff,
              maxRepeats: c.bxgy.maxRepeats ?? null,
            }
          : null,
      };
      targetCouponRow = row;
      overlayPromotions.push(row);
    }

    const cart = await priceCart({
      lines: body.lines,
      couponCodes: [...body.applied, targetCode],
      email: body.email,
      state: body.state,
      overlayPromotions,
    });

    const couponRow = targetCouponRow ?? (await prisma.coupon.findUnique({
      where: { code: targetCode, deletedAt: null },
      select: PROMOTION_SELECT,
    }));

    const applied = cart.coupons.find((c) => c.code === targetCode);
    const rejection = cart.issues.find(
      (i) => i.sku === '__coupon__' && i.couponCode === targetCode,
    );

    const promoLines = cart.lines.map((l) => ({
      variantId: l.variantId,
      familyId: l.familyId,
      category: l.category,
      sku: l.sku,
      productName: l.productName,
      qty: l.qty,
      unitPricePaise: l.unitPricePaise,
      lineTotalPaise: l.lineTotalPaise,
    }));

    const targeting = couponRow ? resolveTargeting(couponRow, promoLines) : null;

    let evaluationChecks: { key: string; label: string; passed: boolean; detail: string }[] = [];
    let linesBreakdown: {
      sku: string;
      name: string;
      pack: string;
      qty: number;
      unitPricePaise: number;
      lineTotalPaise: number;
      isQualifying: boolean;
      isDiscounted: boolean;
      isExcluded: boolean;
      excludeReason: string | null;
    }[] = [];

    if (couponRow && targeting) {
      const status = promotionStatus(couponRow);
      const statusPassed = status === 'Active';
      const statusDetail = status === 'Active'
        ? 'Promotion is active and within valid schedule dates.'
        : (status === 'Expired' ? 'Promotion schedule has expired.' : 'Promotion is currently inactive or start date is in the future.');

      const minOrderPassed = couponRow.minOrderPaise === 0 || cart.subtotalPaise >= couponRow.minOrderPaise;
      const minOrderDetail = couponRow.minOrderPaise === 0
        ? 'No minimum spend requirement.'
        : (minOrderPassed
            ? `Cart subtotal (₹${cart.subtotalPaise / 100}) meets the ₹${couponRow.minOrderPaise / 100} minimum.`
            : `Cart subtotal (₹${cart.subtotalPaise / 100}) is below the required ₹${couponRow.minOrderPaise / 100} minimum.`);

      const qtyPassed = (couponRow.minQty === null || targeting.qualifyingQty >= couponRow.minQty) &&
                        (couponRow.maxQty === null || targeting.qualifyingQty <= couponRow.maxQty);
      const qtyDetail = couponRow.minQty === null && couponRow.maxQty === null
        ? 'No item quantity restriction.'
        : (qtyPassed
            ? `Cart has ${targeting.qualifyingQty} qualifying item(s), satisfying quantity requirements.`
            : (couponRow.minQty !== null && targeting.qualifyingQty < couponRow.minQty
                ? `Cart has ${targeting.qualifyingQty} qualifying item(s), below the minimum requirement of ${couponRow.minQty}.`
                : `Cart has ${targeting.qualifyingQty} qualifying item(s), exceeding the maximum allowed ${couponRow.maxQty}.`));

      const productPassed = targeting.qualifies && (couponRow.discountType === DiscountType.FREE_SHIPPING || targeting.discountableIdx.length > 0);
      const productDetail = targeting.qualifies
        ? (couponRow.discountType === DiscountType.FREE_SHIPPING
            ? 'Promotion waives shipping fees across eligible items.'
            : (targeting.discountableIdx.length > 0
                ? `${targeting.discountableIdx.length} product(s) in cart qualify to receive the discount.`
                : 'No items in cart qualify to receive the discount.'))
        : 'Required qualifying products are not present in cart.';

      let customerPassed = true;
      let customerDetail = 'Eligible for all customers.';
      if (couponRow.customerEligibility === CustomerEligibility.FIRST_ORDER) {
        customerDetail = 'Valid on customer\'s first order.';
        if (rejection?.code === 'COUPON_NOT_ELIGIBLE') customerPassed = false;
      } else if (couponRow.customerEligibility === CustomerEligibility.FIRST_N_ORDERS) {
        customerDetail = `Valid on first ${couponRow.firstNOrders ?? 1} orders.`;
        if (rejection?.code === 'COUPON_NOT_ELIGIBLE') customerPassed = false;
      } else if (couponRow.customerEligibility === CustomerEligibility.SPECIFIC_CUSTOMERS) {
        const allowed = new Set(couponRow.customers.map((c) => c.email.toLowerCase()));
        customerPassed = Boolean(body.email && allowed.has(body.email.toLowerCase()));
        customerDetail = customerPassed
          ? `Customer email ${body.email} is authorized.`
          : (body.email ? `Customer email ${body.email} is not authorized for this specific customer offer.` : 'Customer email required to test customer eligibility.');
      } else if (couponRow.customerEligibility === CustomerEligibility.EXISTING_CUSTOMER) {
        customerDetail = 'Valid for returning customers.';
        if (rejection?.code === 'COUPON_NOT_ELIGIBLE') customerPassed = false;
      }

      let locationPassed = true;
      let locationDetail = 'Available for delivery nationwide.';
      if (couponRow.allowedStates && couponRow.allowedStates.length > 0) {
        if (body.state) {
          const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z]/g, '');
          const allowed = couponRow.allowedStates.map(norm);
          locationPassed = allowed.includes(norm(body.state));
          locationDetail = locationPassed
            ? `Delivery to ${body.state} is eligible.`
            : `Delivery to ${body.state} is restricted (Allowed: ${couponRow.allowedStates.join(', ')}).`;
        } else {
          locationDetail = `Restricted to states: ${couponRow.allowedStates.join(', ')}.`;
        }
      }

      const stackingPassed = !cart.issues.some((i) => i.sku === '__coupon__' && i.couponCode === targetCode && i.code === 'COUPON_STACKING_CONFLICT');
      const stackingDetail = stackingPassed
        ? (couponRow.stackingMode === CouponStacking.STACKABLE
            ? 'Configured as stackable with eligible promotions.'
            : (couponRow.stackingMode === CouponStacking.EXCLUSIVE ? 'Exclusive offer outranking other promotions.' : 'Cannot be combined with other offers.'))
        : 'Cannot be combined with other active promotion(s) in cart.';

      evaluationChecks = [
        { key: 'status', label: 'Active Status & Dates', passed: statusPassed, detail: statusDetail },
        { key: 'minOrder', label: 'Minimum Spend', passed: minOrderPassed, detail: minOrderDetail },
        { key: 'quantity', label: 'Item Quantity', passed: qtyPassed, detail: qtyDetail },
        { key: 'targeting', label: 'Product Targeting', passed: productPassed, detail: productDetail },
        { key: 'customer', label: 'Customer Eligibility', passed: customerPassed, detail: customerDetail },
        { key: 'location', label: 'Delivery Location', passed: locationPassed, detail: locationDetail },
        { key: 'stacking', label: 'Stacking & Combinations', passed: stackingPassed, detail: stackingDetail },
      ];

      linesBreakdown = cart.lines.map((l, i) => {
        const isQualifying = targeting.qualifyingIdx.includes(i);
        const isDiscounted = targeting.discountableIdx.includes(i);
        const isExcluded = couponRow.products.some(p => p.role === CouponTargetRole.EXCLUDE && p.familyId === l.familyId);
        return {
          sku: l.sku,
          name: l.productName,
          pack: l.pack,
          qty: l.qty,
          unitPricePaise: l.unitPricePaise,
          lineTotalPaise: l.lineTotalPaise,
          isQualifying,
          isDiscounted,
          isExcluded,
          excludeReason: isExcluded ? 'Product excluded from discount by rule' : null,
        };
      });
    } else {
      linesBreakdown = cart.lines.map((l) => ({
        sku: l.sku,
        name: l.productName,
        pack: l.pack,
        qty: l.qty,
        unitPricePaise: l.unitPricePaise,
        lineTotalPaise: l.lineTotalPaise,
        isQualifying: false,
        isDiscounted: false,
        isExcluded: false,
        excludeReason: null,
      }));
    }

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
          lines: linesBreakdown,
        },
        evaluationChecks,
        stack: cart.coupons.map((c) => ({
          code: c.code,
          discountPaise: c.discountPaise,
          discountLabel: c.discountLabel,
          automatic: c.automatic,
          stackingMode: c.stackingMode,
        })),
        otherRejections: cart.issues
          .filter((i) => i.sku === '__coupon__' && i.couponCode !== targetCode)
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
