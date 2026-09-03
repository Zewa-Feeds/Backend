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
import {
  AuditModule,
  type Category,
  CouponScope,
  CouponStacking,
  CouponTargetRole,
  CouponTrigger,
  CustomerEligibility,
  DiscountType,
  type Prisma,
} from '@prisma/client';
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
  name: true,
  description: true,
  maxDiscountPaise: true,
  stackingMode: true,
  priority: true,
  trigger: true,
  combinesWithAutomatic: true,
  showAtCheckout: true,
  customerEligibility: true,
  firstNOrders: true,
  minQty: true,
  maxQty: true,
  allowedStates: true,
  requireAllQualifiers: true,
  revenuePaise: true,
  discountedPaise: true,
  confirmedOrders: true,
  createdAt: true,
  updatedAt: true,
  products: {
    select: {
      role: true,
      family: { select: { id: true, name: true, slug: true, category: true } },
    },
  },
  variants: {
    select: {
      role: true,
      variant: { select: { id: true, sku: true, pack: true, familyId: true } },
    },
  },
  categories: { select: { role: true, category: true } },
  customers: { select: { email: true } },
  bxgy: { select: { buyQty: true, getQty: true, rewardPercentOff: true, maxRepeats: true } },
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

/** How each stacking mode reads in the CMS. */
const STACKING_LABELS: Record<CouponStacking, string> = {
  [CouponStacking.STACKABLE]: 'Stackable',
  [CouponStacking.NON_STACKABLE]: 'On its own',
  [CouponStacking.EXCLUSIVE]: 'Exclusive',
  [CouponStacking.GLOBALLY_STACKABLE]: 'Always applies',
};

const ELIGIBILITY_LABELS: Record<CustomerEligibility, string> = {
  [CustomerEligibility.ALL_CUSTOMERS]: 'All customers',
  [CustomerEligibility.FIRST_ORDER]: 'First order only',
  [CustomerEligibility.FIRST_N_ORDERS]: 'First N orders',
  [CustomerEligibility.EXISTING_CUSTOMER]: 'Returning customers',
  [CustomerEligibility.SPECIFIC_CUSTOMERS]: 'Specific customers',
};

const DATE_FMT = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'long' });

/**
 * One sentence describing what a promotion actually does.
 *
 * Shown in the CMS before saving, because the editor has ten sections and a
 * reader cannot hold all of them at once — "10% off, up to ₹300, for a
 * customer's first 2 orders, when the cart is at least ₹999" is checkable at a
 * glance in a way a form full of controls is not.
 *
 * Built from the SAME row the engine evaluates, so it cannot drift into
 * describing a promotion that does not exist.
 */
function describe(c: CouponRow): string {
  const parts: string[] = [];

  switch (c.discountType) {
    case DiscountType.PERCENTAGE:
      parts.push(
        `${c.discountValue}% off${
          c.maxDiscountPaise !== null ? `, up to ${formatInr(c.maxDiscountPaise)}` : ''
        }`,
      );
      break;
    case DiscountType.FLAT:
      parts.push(`${formatInr(c.discountValue)} off`);
      break;
    case DiscountType.FREE_SHIPPING:
      parts.push('Free shipping');
      break;
    case DiscountType.BUY_X_GET_Y:
      parts.push(
        c.bxgy
          ? c.bxgy.rewardPercentOff >= 100
            ? `Buy ${c.bxgy.buyQty} get ${c.bxgy.getQty} free`
            : `Buy ${c.bxgy.buyQty} get ${c.bxgy.getQty} at ${c.bxgy.rewardPercentOff}% off`
          : 'Buy X get Y',
      );
      break;
  }

  const discountFamilies = c.products.filter((x) => x.role === CouponTargetRole.DISCOUNT);
  const discountCategories = c.categories.filter((x) => x.role === CouponTargetRole.DISCOUNT);
  if (discountFamilies.length === 1) {
    parts.push(`on ${discountFamilies[0]!.family.name}`);
  } else if (discountFamilies.length > 1) {
    parts.push(`on ${discountFamilies.length} products`);
  } else if (discountCategories.length > 0) {
    parts.push(`on ${discountCategories.length} categor${discountCategories.length === 1 ? 'y' : 'ies'}`);
  }

  const qualifying = c.products.filter((x) => x.role === CouponTargetRole.QUALIFY);
  if (qualifying.length > 0) {
    const names = qualifying.map((x) => x.family.name);
    parts.push(
      `when the cart contains ${c.requireAllQualifiers ? names.join(' and ') : names.join(' or ')}`,
    );
  }

  switch (c.customerEligibility) {
    case CustomerEligibility.FIRST_ORDER:
      parts.push("on a customer's first order");
      break;
    case CustomerEligibility.FIRST_N_ORDERS:
      parts.push(`for a customer's first ${c.firstNOrders ?? 1} orders`);
      break;
    case CustomerEligibility.EXISTING_CUSTOMER:
      parts.push('for returning customers');
      break;
    case CustomerEligibility.SPECIFIC_CUSTOMERS:
      parts.push(`for ${c.customers.length} named customer${c.customers.length === 1 ? '' : 's'}`);
      break;
    default:
      break;
  }

  if (c.minOrderPaise > 0) parts.push(`when the cart is at least ${formatInr(c.minOrderPaise)}`);
  if (c.minQty !== null) parts.push(`with ${c.minQty} or more qualifying items`);
  if (c.allowedStates.length > 0) parts.push(`for delivery to ${c.allowedStates.join(', ')}`);

  parts.push(
    c.trigger === CouponTrigger.AUTOMATIC
      ? 'applied automatically'
      : `with code ${c.code}`,
  );

  if (c.stackingMode === CouponStacking.EXCLUSIVE) parts.push('exclusive of all other offers');
  else if (c.stackingMode === CouponStacking.NON_STACKABLE) parts.push('not combinable');
  else parts.push('combinable with other stackable offers');

  parts.push(`valid until ${DATE_FMT.format(c.endsAt)}`);

  const sentence = parts.join(', ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + '.';
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
    // `products` keeps its original meaning — what the discount comes off — so
    // the existing CMS picker and list column keep working untouched.
    productIds: c.products
      .filter((p) => p.role === CouponTargetRole.DISCOUNT)
      .map((p) => p.family.id),
    products: c.products
      .filter((p) => p.role === CouponTargetRole.DISCOUNT)
      .map((p) => ({
        id: p.family.id,
        name: p.family.name,
        slug: p.family.slug,
        category: p.family.category,
      })),
    qualifyingProductIds: c.products
      .filter((p) => p.role === CouponTargetRole.QUALIFY)
      .map((p) => p.family.id),
    qualifyingProducts: c.products
      .filter((p) => p.role === CouponTargetRole.QUALIFY)
      .map((p) => ({ id: p.family.id, name: p.family.name, slug: p.family.slug })),
    excludedProductIds: c.products
      .filter((p) => p.role === CouponTargetRole.EXCLUDE)
      .map((p) => p.family.id),
    excludedProducts: c.products
      .filter((p) => p.role === CouponTargetRole.EXCLUDE)
      .map((p) => ({ id: p.family.id, name: p.family.name, slug: p.family.slug })),

    variantIds: c.variants
      .filter((v) => v.role === CouponTargetRole.DISCOUNT)
      .map((v) => v.variant.id),
    variants: c.variants.map((v) => ({
      id: v.variant.id,
      sku: v.variant.sku,
      pack: v.variant.pack,
      familyId: v.variant.familyId,
      role: v.role,
    })),
    categories: c.categories
      .filter((x) => x.role === CouponTargetRole.DISCOUNT)
      .map((x) => x.category),
    categoryTargets: c.categories.map((x) => ({ category: x.category, role: x.role })),
    customerEmails: c.customers.map((x) => x.email),

    // ---- Promotion configuration -------------------------------------------
    name: c.name,
    description: c.description,
    maxDiscountPaise: c.maxDiscountPaise,
    maxDiscount: c.maxDiscountPaise === null ? null : toRupees(c.maxDiscountPaise),
    stackingMode: c.stackingMode,
    stackingLabel: STACKING_LABELS[c.stackingMode],
    priority: c.priority,
    trigger: c.trigger,
    automatic: c.trigger === CouponTrigger.AUTOMATIC,
    combinesWithAutomatic: c.combinesWithAutomatic,
    showAtCheckout: c.showAtCheckout,
    customerEligibility: c.customerEligibility,
    eligibilityLabel: ELIGIBILITY_LABELS[c.customerEligibility],
    firstNOrders: c.firstNOrders,
    minQty: c.minQty,
    maxQty: c.maxQty,
    allowedStates: c.allowedStates,
    requireAllQualifiers: c.requireAllQualifiers,
    bxgy: c.bxgy,
    /** One sentence describing the whole promotion, for the CMS to show before save. */
    summary: describe(c),

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
  /** Product family ids the discount comes off — non-empty when SPECIFIC_PRODUCTS. */
  productIds: string[];

  // ---- Promotion configuration (all optional; defaults preserve behaviour) --
  name?: string | null;
  description?: string | null;
  maxDiscountPaise?: number | null;
  stackingMode?: CouponStacking;
  priority?: number;
  trigger?: CouponTrigger;
  combinesWithAutomatic?: boolean;
  showAtCheckout?: boolean;
  customerEligibility?: CustomerEligibility;
  firstNOrders?: number | null;
  minQty?: number | null;
  maxQty?: number | null;
  allowedStates?: string[];
  requireAllQualifiers?: boolean;

  // ---- Targeting -----------------------------------------------------------
  /** Families that must be present for the promotion to fire. */
  qualifyingProductIds?: string[];
  /** Families carved out of the discountable set. */
  excludedProductIds?: string[];
  /** Pack-level targets. */
  variantIds?: string[];
  qualifyingVariantIds?: string[];
  /** Category-level targets. */
  categories?: Category[];
  qualifyingCategories?: Category[];
  /** Emails for SPECIFIC_CUSTOMERS eligibility. */
  customerEmails?: string[];
  /** Buy X Get Y configuration, when discountType is BUY_X_GET_Y. */
  bxgy?: { buyQty: number; getQty: number; rewardPercentOff: number; maxRepeats: number | null } | null;
}

/**
 * Every targeting row a coupon should have, flattened.
 *
 * Written as a full replacement on each save rather than diffed: the sets are
 * small, and replacing wholesale inside the transaction is atomic in a way a
 * partial diff is not.
 */
interface TargetingRows {
  products: { familyId: string; role: CouponTargetRole }[];
  variants: { variantId: string; role: CouponTargetRole }[];
  categories: { category: Category; role: CouponTargetRole }[];
  customers: { email: string }[];
}

function buildTargeting(input: Partial<CouponInput>, discountFamilyIds: string[]): TargetingRows {
  const dedupe = <T>(xs: readonly T[]) => [...new Set(xs)];
  return {
    products: [
      ...dedupe(discountFamilyIds).map((familyId) => ({
        familyId,
        role: CouponTargetRole.DISCOUNT,
      })),
      ...dedupe(input.qualifyingProductIds ?? []).map((familyId) => ({
        familyId,
        role: CouponTargetRole.QUALIFY,
      })),
      ...dedupe(input.excludedProductIds ?? []).map((familyId) => ({
        familyId,
        role: CouponTargetRole.EXCLUDE,
      })),
    ],
    variants: [
      ...dedupe(input.variantIds ?? []).map((variantId) => ({
        variantId,
        role: CouponTargetRole.DISCOUNT,
      })),
      ...dedupe(input.qualifyingVariantIds ?? []).map((variantId) => ({
        variantId,
        role: CouponTargetRole.QUALIFY,
      })),
    ],
    categories: [
      ...dedupe(input.categories ?? []).map((category) => ({
        category,
        role: CouponTargetRole.DISCOUNT,
      })),
      ...dedupe(input.qualifyingCategories ?? []).map((category) => ({
        category,
        role: CouponTargetRole.QUALIFY,
      })),
    ],
    customers: dedupe((input.customerEmails ?? []).map((e) => e.toLowerCase().trim()))
      .filter(Boolean)
      .map((email) => ({ email })),
  };
}

/**
 * Scalar promotion columns, separated from the relation writes.
 *
 * Generic so a full `CouponInput` keeps `code` required on the way through —
 * a `Partial` return here would make every create look like it might omit it.
 */
function scalarFields<T extends Partial<CouponInput>>(input: T) {
  const {
    productIds: _p,
    qualifyingProductIds: _q,
    excludedProductIds: _e,
    variantIds: _v,
    qualifyingVariantIds: _qv,
    categories: _c,
    qualifyingCategories: _qc,
    customerEmails: _ce,
    bxgy: _b,
    ...scalars
  } = input;
  return scalars;
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

/**
 * Reject promotion settings that contradict themselves.
 *
 * Caught at write time rather than at checkout, because every one of these
 * produces a promotion that silently never fires — the worst failure mode for a
 * marketing campaign, since nobody notices until the campaign is over.
 */
function assertPromotionCoherent(input: Partial<CouponInput>): void {
  const fields: Record<string, string> = {};

  if (input.customerEligibility === CustomerEligibility.FIRST_N_ORDERS) {
    const n = input.firstNOrders;
    if (n === null || n === undefined || n < 1) {
      fields.firstNOrders = 'Enter how many orders the offer covers.';
    }
  }

  if (
    input.customerEligibility === CustomerEligibility.SPECIFIC_CUSTOMERS &&
    (input.customerEmails?.length ?? 0) === 0
  ) {
    fields.customerEmails = 'Add at least one customer email.';
  }

  if (input.discountType === DiscountType.BUY_X_GET_Y) {
    if (!input.bxgy) {
      fields.bxgy = 'Set the buy and get quantities.';
    } else {
      if (input.bxgy.buyQty < 1) fields.bxgy = 'Buy quantity must be at least 1.';
      if (input.bxgy.getQty < 1) fields.bxgy = 'Get quantity must be at least 1.';
    }
  }

  if (
    input.minQty !== null &&
    input.minQty !== undefined &&
    input.maxQty !== null &&
    input.maxQty !== undefined &&
    input.minQty > input.maxQty
  ) {
    fields.maxQty = 'Maximum quantity must be at least the minimum.';
  }

  if (Object.keys(fields).length > 0) {
    throw new AppError(422, ErrorCode.VALIDATION_FAILED, 'Check the promotion settings.', {
      fields,
    });
  }
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
  assertPromotionCoherent(input);
  const targeting = buildTargeting(input, productIds);
  const couponData = scalarFields(input);

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.coupon.create({
      data: {
        ...couponData,
        products: { create: targeting.products },
        variants: { create: targeting.variants },
        categories: { create: targeting.categories },
        customers: { create: targeting.customers },
        ...(input.bxgy ? { bxgy: { create: input.bxgy } } : {}),
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
  const currentDiscountFamilies = existing.products
    .filter((p) => p.role === CouponTargetRole.DISCOUNT)
    .map((p) => p.family.id);
  const productIds =
    input.productIds !== undefined || input.scope !== undefined
      ? await assertScopeValid(scope, input.productIds ?? currentDiscountFamilies)
      : currentDiscountFamilies;

  assertPromotionCoherent({ ...existing, ...input } as Partial<CouponInput>);
  const targeting = buildTargeting(input, productIds);
  const couponData = scalarFields(input);

  const updated = await prisma.$transaction(async (tx) => {
    /*
     * Replace rather than diff: the sets are small, and a full replace inside
     * the transaction is atomic in a way a partial diff is not. Deleting first
     * also means a role change (QUALIFY -> DISCOUNT on the same family) cannot
     * collide with the composite primary key.
     */
    await tx.couponProduct.deleteMany({ where: { couponId: id } });
    await tx.couponVariant.deleteMany({ where: { couponId: id } });
    await tx.couponCategory.deleteMany({ where: { couponId: id } });
    await tx.couponCustomer.deleteMany({ where: { couponId: id } });

    if (targeting.products.length > 0) {
      await tx.couponProduct.createMany({
        data: targeting.products.map((r) => ({ couponId: id, ...r })),
      });
    }
    if (targeting.variants.length > 0) {
      await tx.couponVariant.createMany({
        data: targeting.variants.map((r) => ({ couponId: id, ...r })),
      });
    }
    if (targeting.categories.length > 0) {
      await tx.couponCategory.createMany({
        data: targeting.categories.map((r) => ({ couponId: id, ...r })),
      });
    }
    if (targeting.customers.length > 0) {
      await tx.couponCustomer.createMany({
        data: targeting.customers.map((r) => ({ couponId: id, ...r })),
      });
    }

    if (input.bxgy !== undefined) {
      if (input.bxgy === null) {
        await tx.couponBxgy.deleteMany({ where: { couponId: id } });
      } else {
        await tx.couponBxgy.upsert({
          where: { couponId: id },
          create: { couponId: id, ...input.bxgy },
          update: input.bxgy,
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
  // An order may carry several stacked promotions, so every unconfirmed
  // redemption on it is attributed — not just the first.
  const redemptions = await tx.couponRedemption.findMany({
    where: { orderId, confirmedAt: null, releasedAt: null },
    select: { id: true, couponId: true, cartValuePaise: true, discountPaise: true },
  });

  for (const redemption of redemptions) {
    const marked = await tx.couponRedemption.updateMany({
      where: { id: redemption.id, confirmedAt: null },
      data: { confirmedAt: new Date() },
    });
    // Lost a race with another confirmation signal — the other one counted it.
    if (marked.count === 0) continue;

    await tx.coupon.update({
      where: { id: redemption.couponId },
      data: {
        revenuePaise: { increment: redemption.cartValuePaise },
        discountedPaise: { increment: redemption.discountPaise },
        confirmedOrders: { increment: 1 },
      },
    });
  }
}

/**
 * Reverse an attribution when a confirmed order is later cancelled or refunded,
 * so reported revenue stays truthful.
 */
export async function reverseRedemption(
  orderId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const redemptions = await tx.couponRedemption.findMany({
    where: { orderId, confirmedAt: { not: null } },
    select: { id: true, couponId: true, cartValuePaise: true, discountPaise: true },
  });

  for (const redemption of redemptions) {
    const cleared = await tx.couponRedemption.updateMany({
      where: { id: redemption.id, confirmedAt: { not: null } },
      data: { confirmedAt: null },
    });
    if (cleared.count === 0) continue;

    await tx.coupon.update({
      where: { id: redemption.couponId },
      data: {
        revenuePaise: { decrement: redemption.cartValuePaise },
        discountedPaise: { decrement: redemption.discountPaise },
        confirmedOrders: { decrement: 1 },
      },
    });
  }
}

/**
 * Hand a coupon use back when an order will never complete.
 *
 * `usedCount` was incremented at checkout, and nothing ever gave it back — so an
 * abandoned Razorpay checkout, which the payment worker sweeps to CANCELLED and
 * restocks, permanently burned a use of the coupon AND the customer's
 * per-customer allowance. A 500-use coupon could exhaust without 500 sales, and
 * a shopper who changed their mind could never use the code again.
 *
 * Releasing marks the redemption rather than deleting it: the history stays
 * auditable, and `releasedAt` is what the per-customer count filters on.
 *
 * Idempotent via `releasedAt: null` in the WHERE, so a cancel followed by a
 * refund cannot hand the same use back twice.
 */
export async function releaseRedemption(
  orderId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const redemptions = await tx.couponRedemption.findMany({
    where: { orderId, releasedAt: null },
    select: { id: true, couponId: true },
  });

  for (const redemption of redemptions) {
    const released = await tx.couponRedemption.updateMany({
      where: { id: redemption.id, releasedAt: null },
      data: { releasedAt: new Date() },
    });
    if (released.count === 0) continue;

    // Floor at zero: a coupon edited down to a smaller usedCount must not go
    // negative because an older order was cancelled afterwards.
    await tx.coupon.updateMany({
      where: { id: redemption.couponId, usedCount: { gt: 0 } },
      data: { usedCount: { decrement: 1 } },
    });
  }
}

/**
 * Per-coupon analytics for the CMS detail page.
 *
 * Deliberately its own call, not folded into `byId`: these are aggregates over
 * the redemption table, and the coupon editor should not pay for them on every
 * open. Nothing here is on the checkout path.
 */
export async function analytics(couponId: string) {
  const coupon = await prisma.coupon.findFirst({
    where: { id: couponId, deletedAt: null },
    select: {
      id: true,
      code: true,
      usedCount: true,
      totalUsageLimit: true,
      revenuePaise: true,
      discountedPaise: true,
      confirmedOrders: true,
    },
  });
  if (!coupon) throw notFound('Coupon');

  const [uniqueCustomers, bounds, released, pending] = await Promise.all([
    prisma.couponRedemption.findMany({
      where: { couponId, releasedAt: null },
      select: { email: true },
      distinct: ['email'],
    }),
    prisma.couponRedemption.aggregate({
      where: { couponId, releasedAt: null },
      _min: { redeemedAt: true },
      _max: { redeemedAt: true },
    }),
    prisma.couponRedemption.count({ where: { couponId, releasedAt: { not: null } } }),
    prisma.couponRedemption.count({
      where: { couponId, confirmedAt: null, releasedAt: null },
    }),
  ]);

  return {
    code: coupon.code,
    /** Uses consumed. Released ones have already been handed back to this count. */
    used: coupon.usedCount,
    limit: coupon.totalUsageLimit,
    remaining:
      coupon.totalUsageLimit === null
        ? null
        : Math.max(0, coupon.totalUsageLimit - coupon.usedCount),
    uniqueCustomers: uniqueCustomers.length,
    confirmedOrders: coupon.confirmedOrders,
    /** Redemptions on orders that have not been confirmed yet. */
    pendingRedemptions: pending,
    /** Redemptions handed back after a cancellation or full refund. */
    releasedRedemptions: released,
    revenuePaise: coupon.revenuePaise,
    revenue: toRupees(coupon.revenuePaise),
    discountedPaise: coupon.discountedPaise,
    discounted: toRupees(coupon.discountedPaise),
    avgOrderPaise:
      coupon.confirmedOrders > 0 ? Math.round(coupon.revenuePaise / coupon.confirmedOrders) : 0,
    firstRedeemedAt: bounds._min.redeemedAt,
    lastRedeemedAt: bounds._max.redeemedAt,
  };
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

/**
 * Offers the storefront may advertise.
 *
 * OPT-IN ONLY. `showAtCheckout` defaults to false, so a private referral code or
 * an influencer's personal code is never published by accident — listing every
 * active code would hand BENS12 and every creator's code to every shopper.
 *
 * Returns only what a shopper needs to decide whether to type it: the code, a
 * human label and the minimum spend. No usage counts, no internal names, and
 * nothing that would let a code be reverse-engineered.
 */
export async function listPublicOffers() {
  const now = new Date();
  const rows = await prisma.coupon.findMany({
    where: {
      showAtCheckout: true,
      isActive: true,
      deletedAt: null,
      startsAt: { lte: now },
      endsAt: { gte: now },
      // A personal code is never a public offer, whatever the flag says.
      influencerId: null,
    },
    select: {
      code: true,
      name: true,
      description: true,
      discountType: true,
      discountValue: true,
      minOrderPaise: true,
      customerEligibility: true,
      endsAt: true,
    },
    orderBy: [{ priority: 'asc' }, { code: 'asc' }],
    take: 12,
  });

  return rows.map((c) => ({
    code: c.code,
    name: c.name,
    description: c.description,
    /** "10% off", "₹200 off", "Free shipping" — built server-side. */
    discountLabel:
      c.discountType === DiscountType.PERCENTAGE
        ? `${c.discountValue}% off`
        : c.discountType === DiscountType.FREE_SHIPPING
          ? 'Free shipping'
          : `${formatInr(c.discountValue)} off`,
    minOrderPaise: c.minOrderPaise,
    minOrder: toRupees(c.minOrderPaise),
    firstOrderOnly: c.customerEligibility === CustomerEligibility.FIRST_ORDER,
    endsAt: c.endsAt,
  }));
}
