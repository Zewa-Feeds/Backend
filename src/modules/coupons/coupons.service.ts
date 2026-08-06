/**
 * Coupon management — spec §10.
 *
 * The status model is worth explaining. §10.2 says coupons that pass their end
 * date auto-set to Expired, and expired coupons cannot be reactivated. So status
 * is DERIVED, not stored:
 *
 *   Expired   endsAt < now                    (terminal — a new coupon is needed)
 *   Inactive  isActive false, or not started yet
 *   Active    isActive, within the window
 *
 * Deriving it means a coupon expires on time without a cron job, and no row can
 * drift into a state that contradicts its own dates.
 */
import { AuditModule, CouponScope, DiscountType, type Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AppError, ErrorCode, conflict, notFound } from '@/lib/errors';
import { type AuditContext, buildDiff, writeAudit } from '@/modules/audit/audit.service';
import { listMeta, toSkipTake } from '@/middleware/validate';
import { toRupees } from '@/modules/products/products.serializer';
import { formatInr } from '@/modules/orders/tax';

export type CouponStatus = 'Active' | 'Inactive' | 'Expired';

const COUPON_SELECT = {
  id: true,
  code: true,
  discountType: true,
  discountValue: true,
  minOrderPaise: true,
  startsAt: true,
  endsAt: true,
  totalUsageLimit: true,
  perCustomerLimit: true,
  usedCount: true,
  isActive: true,
  scope: true,
  revenuePaise: true,
  discountedPaise: true,
  confirmedOrders: true,
  createdAt: true,
  updatedAt: true,
  products: {
    select: {
      family: { select: { id: true, name: true, slug: true, category: true } },
    },
  },
} satisfies Prisma.CouponSelect;

type CouponRow = Prisma.CouponGetPayload<{ select: typeof COUPON_SELECT }>;

/** Derived status (§10.2). */
export function couponStatus(coupon: {
  isActive: boolean;
  startsAt: Date;
  endsAt: Date;
}): CouponStatus {
  const now = new Date();
  if (coupon.endsAt < now) return 'Expired';
  if (!coupon.isActive || coupon.startsAt > now) return 'Inactive';
  return 'Active';
}

function serialize(c: CouponRow) {
  const isPercentage = c.discountType === DiscountType.PERCENTAGE;
  return {
    id: c.id,
    code: c.code,
    discountType: c.discountType,
    // The CMS's `type` column shows "Percentage" / "Flat".
    type: isPercentage ? 'Percentage' : 'Flat',
    // Percentage is a whole number; FLAT is stored in paise and shown in rupees.
    val: isPercentage ? c.discountValue : toRupees(c.discountValue),
    discountValueRaw: c.discountValue,
    discountLabel: isPercentage ? `${c.discountValue}% off` : `${formatInr(c.discountValue)} off`,
    minOrderPaise: c.minOrderPaise,
    min: toRupees(c.minOrderPaise),
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    totalUsageLimit: c.totalUsageLimit,
    limit: c.totalUsageLimit,
    perCustomerLimit: c.perCustomerLimit,
    perCust: c.perCustomerLimit,
    used: c.usedCount,
    isActive: c.isActive,
    status: couponStatus(c),
    createdAt: c.createdAt,

    // ---- Scope (§10.2 extension) -------------------------------------------
    scope: c.scope,
    scopeLabel: c.scope === CouponScope.ALL_PRODUCTS ? 'All products' : 'Specific products',
    productIds: c.products.map((p) => p.family.id),
    products: c.products.map((p) => ({
      id: p.family.id,
      name: p.family.name,
      slug: p.family.slug,
      category: p.family.category,
    })),

    // ---- Revenue attribution ----------------------------------------------
    // Confirmed orders only, so an abandoned cart never inflates the figure.
    revenuePaise: c.revenuePaise,
    revenue: toRupees(c.revenuePaise),
    discountedPaise: c.discountedPaise,
    discounted: toRupees(c.discountedPaise),
    confirmedOrders: c.confirmedOrders,
    /** Mean confirmed order value on this coupon — the useful comparison. */
    avgOrderPaise: c.confirmedOrders > 0 ? Math.round(c.revenuePaise / c.confirmedOrders) : 0,
  };
}

export interface ListParams {
  page: number;
  limit: number;
  q?: string;
  status?: CouponStatus;
}

export async function list(params: ListParams) {
  const where: Prisma.CouponWhereInput = {
    deletedAt: null,
    ...(params.q ? { code: { contains: params.q.toUpperCase() } } : {}),
  };

  // Status is derived, so it cannot be a SQL filter. The coupon table is small
  // (tens of rows), so filtering after serialization is cheaper than raw SQL.
  const needsStatusFilter = Boolean(params.status);

  const [rows, total] = await Promise.all([
    prisma.coupon.findMany({
      where,
      select: COUPON_SELECT,
      orderBy: { createdAt: 'desc' },
      ...(needsStatusFilter ? {} : toSkipTake(params)),
    }),
    prisma.coupon.count({ where }),
  ]);

  let data = rows.map(serialize);

  if (needsStatusFilter) {
    data = data.filter((c) => c.status === params.status);
    const { skip, take } = toSkipTake(params);
    return {
      data: data.slice(skip, skip + take),
      meta: listMeta(params.page, params.limit, data.length),
    };
  }

  return { data, meta: listMeta(params.page, params.limit, total) };
}

export async function byId(id: string) {
  const coupon = await prisma.coupon.findFirst({
    where: { id, deletedAt: null },
    select: COUPON_SELECT,
  });
  if (!coupon) throw notFound('Coupon');
  return serialize(coupon);
}

export interface CouponInput {
  code: string;
  discountType: DiscountType;
  /** Whole percent for PERCENTAGE, paise for FLAT. */
  discountValue: number;
  minOrderPaise: number;
  startsAt: Date;
  endsAt: Date;
  totalUsageLimit: number | null;
  perCustomerLimit: number;
  isActive: boolean;
  scope: CouponScope;
  /** Product family ids — required and non-empty when scope is SPECIFIC_PRODUCTS. */
  productIds: string[];
}

/**
 * Validate the scope selection.
 *
 * A SPECIFIC_PRODUCTS coupon with no products would match nothing and silently
 * fail at checkout, so it is rejected at write time instead.
 */
async function assertScopeValid(scope: CouponScope, productIds: string[]): Promise<string[]> {
  if (scope === CouponScope.ALL_PRODUCTS) return [];

  const unique = [...new Set(productIds)];
  if (unique.length === 0) {
    throw new AppError(
      422,
      ErrorCode.VALIDATION_FAILED,
      'Select at least one product for a product-specific coupon.',
      { fields: { productIds: 'Pick at least one product.' } },
    );
  }

  const found = await prisma.productFamily.findMany({
    where: { id: { in: unique }, deletedAt: null },
    select: { id: true },
  });
  if (found.length !== unique.length) {
    throw new AppError(422, ErrorCode.VALIDATION_FAILED, 'One or more selected products no longer exist.', {
      fields: { productIds: 'Refresh and reselect.' },
    });
  }

  return unique;
}

export async function create(input: CouponInput, ctx: AuditContext) {
  const existing = await prisma.coupon.findUnique({
    where: { code: input.code },
    select: { id: true, deletedAt: true },
  });
  if (existing && !existing.deletedAt) {
    throw conflict('That coupon code already exists.', ErrorCode.CONFLICT, { field: 'code' });
  }

  const productIds = await assertScopeValid(input.scope, input.productIds);
  const { productIds: _omit, ...couponData } = input;

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.coupon.create({
      data: {
        ...couponData,
        products: { create: productIds.map((familyId) => ({ familyId })) },
      },
      select: COUPON_SELECT,
    });
    await writeAudit(
      ctx,
      {
        module: AuditModule.COUPONS,
        action:
          input.scope === CouponScope.SPECIFIC_PRODUCTS
            ? `Created coupon ${input.code} for ${productIds.length} specific product(s)`
            : `Created coupon ${input.code} for all products`,
        recordId: row.id,
      },
      tx,
    );
    return row;
  });

  return serialize(created);
}

export async function update(id: string, input: Partial<CouponInput>, ctx: AuditContext) {
  const existing = await prisma.coupon.findFirst({
    where: { id, deletedAt: null },
    select: COUPON_SELECT,
  });
  if (!existing) throw notFound('Coupon');

  // §10.2: expired coupons cannot be reactivated — a new coupon must be created.
  // Enforced here rather than only in the UI, since the endpoint is callable directly.
  if (couponStatus(existing) === 'Expired') {
    const extendsWindow = input.endsAt && input.endsAt > existing.endsAt;
    if (input.isActive === true || extendsWindow) {
      throw new AppError(
        409,
        ErrorCode.CONFLICT,
        'Expired coupons cannot be reactivated. Create a new coupon instead.',
      );
    }
  }

  // The code appears on past redemptions, so renaming would break their meaning.
  if (input.code && input.code !== existing.code) {
    const clash = await prisma.coupon.findUnique({
      where: { code: input.code },
      select: { id: true },
    });
    if (clash) {
      throw conflict('That coupon code already exists.', ErrorCode.CONFLICT, { field: 'code' });
    }
  }

  // Scope changes replace the product set wholesale.
  const scope = input.scope ?? existing.scope;
  const productIds =
    input.productIds !== undefined || input.scope !== undefined
      ? await assertScopeValid(scope, input.productIds ?? existing.products.map((p) => p.family.id))
      : null;

  const { productIds: _omit, ...couponData } = input;

  const updated = await prisma.$transaction(async (tx) => {
    // Replace rather than diff: the set is small and a full replace is atomic.
    if (productIds !== null) {
      await tx.couponProduct.deleteMany({ where: { couponId: id } });
      if (productIds.length > 0) {
        await tx.couponProduct.createMany({
          data: productIds.map((familyId) => ({ couponId: id, familyId })),
        });
      }
    }

    const row = await tx.coupon.update({
      where: { id },
      data: couponData,
      select: COUPON_SELECT,
    });

    await writeAudit(
      ctx,
      {
        module: AuditModule.COUPONS,
        action: `Updated coupon ${existing.code}`,
        recordId: id,
        // Product lists are relations, not scalars — summarise the count instead.
        diff: buildDiff(
          { ...existing, productCount: existing.products.length },
          { ...row, productCount: row.products.length },
        ),
      },
      tx,
    );
    return row;
  });

  return serialize(updated);
}

/**
 * Redemption detail for one coupon — who used it and what it earned.
 *
 * Only confirmed redemptions carry revenue; pending ones are shown so a manager
 * can see attempts in flight, but they are labelled.
 */
export async function redemptions(
  couponId: string,
  params: { page: number; limit: number },
) {
  const coupon = await prisma.coupon.findFirst({
    where: { id: couponId, deletedAt: null },
    select: { id: true, code: true },
  });
  if (!coupon) throw notFound('Coupon');

  const where: Prisma.CouponRedemptionWhereInput = { couponId };

  const [rows, total] = await Promise.all([
    prisma.couponRedemption.findMany({
      where,
      orderBy: { redeemedAt: 'desc' },
      ...toSkipTake(params),
      select: {
        id: true,
        email: true,
        cartValuePaise: true,
        discountPaise: true,
        confirmedAt: true,
        redeemedAt: true,
        order: {
          select: { orderNo: true, status: true, paymentStatus: true, totalPaise: true },
        },
      },
    }),
    prisma.couponRedemption.count({ where }),
  ]);

  return {
    data: rows.map((r) => ({
      id: r.id,
      orderNo: r.order.orderNo,
      email: r.email,
      orderStatus: r.order.status,
      paymentStatus: r.order.paymentStatus,
      cartValuePaise: r.cartValuePaise,
      cartValue: toRupees(r.cartValuePaise),
      discountPaise: r.discountPaise,
      discount: toRupees(r.discountPaise),
      confirmed: r.confirmedAt !== null,
      confirmedAt: r.confirmedAt,
      redeemedAt: r.redeemedAt,
    })),
    meta: { ...listMeta(params.page, params.limit, total), code: coupon.code },
  };
}

/**
 * Attribute revenue to a coupon when an order is CONFIRMED.
 *
 * Called from the payment-confirmation path and from the COD accept transition —
 * never at checkout, because an unpaid or cancelled order is not revenue.
 * Idempotent: `confirmedAt: null` in the WHERE means a repeat call counts nothing.
 */
export async function confirmRedemption(
  orderId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const redemption = await tx.couponRedemption.findFirst({
    where: { orderId, confirmedAt: null },
    select: { id: true, couponId: true, cartValuePaise: true, discountPaise: true },
  });
  if (!redemption) return;

  const marked = await tx.couponRedemption.updateMany({
    where: { id: redemption.id, confirmedAt: null },
    data: { confirmedAt: new Date() },
  });
  // Lost a race with another confirmation signal — the other one counted it.
  if (marked.count === 0) return;

  await tx.coupon.update({
    where: { id: redemption.couponId },
    data: {
      revenuePaise: { increment: redemption.cartValuePaise },
      discountedPaise: { increment: redemption.discountPaise },
      confirmedOrders: { increment: 1 },
    },
  });
}

/**
 * Reverse an attribution when a confirmed order is later cancelled or refunded,
 * so reported revenue stays truthful.
 */
export async function reverseRedemption(
  orderId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const redemption = await tx.couponRedemption.findFirst({
    where: { orderId, confirmedAt: { not: null } },
    select: { id: true, couponId: true, cartValuePaise: true, discountPaise: true },
  });
  if (!redemption) return;

  const cleared = await tx.couponRedemption.updateMany({
    where: { id: redemption.id, confirmedAt: { not: null } },
    data: { confirmedAt: null },
  });
  if (cleared.count === 0) return;

  await tx.coupon.update({
    where: { id: redemption.couponId },
    data: {
      revenuePaise: { decrement: redemption.cartValuePaise },
      discountedPaise: { decrement: redemption.discountPaise },
      confirmedOrders: { decrement: 1 },
    },
  });
}

/** Soft delete — redemption history references the coupon (§10.1 Admin only). */
export async function remove(id: string, ctx: AuditContext): Promise<void> {
  const existing = await prisma.coupon.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, code: true },
  });
  if (!existing) throw notFound('Coupon');

  await prisma.$transaction(async (tx) => {
    await tx.coupon.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    await writeAudit(
      ctx,
      { module: AuditModule.COUPONS, action: `Deleted coupon ${existing.code}`, recordId: id },
      tx,
    );
  });
}

// ============================================================================
// PUBLIC VALIDATION (§10.2 dependency — the storefront's "Have a coupon?" input)
// ============================================================================

export interface ValidationResult {
  code: string;
  discountPaise: number;
  discountLabel: string;
  newSubtotalPaise: number;
  scope: CouponScope;
  /** For SPECIFIC_PRODUCTS: the cart value the discount was computed on. */
  eligibleSubtotalPaise: number;
  /** Names of the cart lines the coupon applied to, for the storefront to show. */
  appliedTo: string[];
}

/** One cart line, as far as coupon eligibility is concerned. */
export interface EligibilityLine {
  familyId: string;
  productName: string;
  lineTotalPaise: number;
}

/**
 * Validate a code against a cart.
 *
 * Every rejection returns a distinct error code so the storefront can explain
 * *why* — "expired" and "minimum not met" need different messages. Deliberately
 * not a generic "invalid": that would be worse UX for no security gain, since the
 * customer already holds the code.
 */
export async function validateForCart(
  code: string,
  subtotalPaise: number,
  email?: string,
  /**
   * Cart lines, needed for SPECIFIC_PRODUCTS scope. Optional so the standalone
   * `POST /coupons/validate` endpoint still works without a full cart — it then
   * treats the coupon as cart-wide, and checkout re-validates with lines.
   */
  lines?: EligibilityLine[],
): Promise<ValidationResult> {
  const coupon = await prisma.coupon.findFirst({
    where: { code: code.toUpperCase().trim(), deletedAt: null },
    select: COUPON_SELECT,
  });

  if (!coupon) {
    throw new AppError(404, ErrorCode.COUPON_NOT_FOUND, 'That coupon code is not recognised.');
  }

  const status = couponStatus(coupon);
  if (status === 'Expired') {
    throw new AppError(409, ErrorCode.COUPON_EXPIRED, 'That coupon has expired.');
  }
  if (status === 'Inactive') {
    throw new AppError(409, ErrorCode.COUPON_INACTIVE, 'That coupon is not currently active.');
  }

  if (subtotalPaise < coupon.minOrderPaise) {
    throw new AppError(
      409,
      ErrorCode.COUPON_MIN_ORDER,
      `Spend ${formatInr(coupon.minOrderPaise)} or more to use this coupon.`,
      { details: { minOrderPaise: coupon.minOrderPaise } },
    );
  }

  if (coupon.totalUsageLimit !== null && coupon.usedCount >= coupon.totalUsageLimit) {
    throw new AppError(
      409,
      ErrorCode.COUPON_LIMIT_REACHED,
      'That coupon has reached its usage limit.',
    );
  }

  // Per-customer limit is keyed on email, since guest checkout has no account.
  if (email) {
    const used = await prisma.couponRedemption.count({
      where: { couponId: coupon.id, email: email.toLowerCase() },
    });
    if (used >= coupon.perCustomerLimit) {
      throw new AppError(
        409,
        ErrorCode.COUPON_ALREADY_USED,
        coupon.perCustomerLimit === 1
          ? 'You have already used this coupon.'
          : `You have already used this coupon ${coupon.perCustomerLimit} times.`,
      );
    }
  }

  // ---- Scope: which part of the cart is discountable? ---------------------
  let eligibleSubtotalPaise = subtotalPaise;
  let appliedTo: string[] = [];

  if (coupon.scope === CouponScope.SPECIFIC_PRODUCTS) {
    const allowed = new Set(coupon.products.map((p) => p.family.id));

    if (lines && lines.length > 0) {
      const eligible = lines.filter((l) => allowed.has(l.familyId));

      if (eligible.length === 0) {
        throw new AppError(
          409,
          ErrorCode.COUPON_INACTIVE,
          `${coupon.code} only applies to selected products, and none are in your cart.`,
          { details: { eligibleProducts: coupon.products.map((p) => p.family.name) } },
        );
      }

      // Discount the eligible portion ONLY. Applying a percentage to the whole
      // cart would silently discount excluded products.
      eligibleSubtotalPaise = eligible.reduce((sum, l) => sum + l.lineTotalPaise, 0);
      appliedTo = eligible.map((l) => l.productName);
    } else {
      // No lines supplied (standalone validate). Report the restriction rather
      // than quoting a discount that checkout may reduce.
      appliedTo = coupon.products.map((p) => p.family.name);
    }
  }

  const discountPaise =
    coupon.discountType === DiscountType.PERCENTAGE
      ? Math.round((eligibleSubtotalPaise * coupon.discountValue) / 100)
      : // A flat discount must never exceed what it applies to, or the total
        // goes negative — capped at the eligible portion, not the whole cart.
        Math.min(coupon.discountValue, eligibleSubtotalPaise);

  return {
    code: coupon.code,
    discountPaise,
    discountLabel:
      coupon.discountType === DiscountType.PERCENTAGE
        ? `${coupon.discountValue}% off`
        : `${formatInr(coupon.discountValue)} off`,
    newSubtotalPaise: subtotalPaise - discountPaise,
    scope: coupon.scope,
    eligibleSubtotalPaise,
    appliedTo,
  };
}
