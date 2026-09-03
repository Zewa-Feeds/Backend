/**
 * Influencer affiliates — the profile behind an affiliate coupon code.
 *
 * ── WHY THIS IS NOT A SECOND DISCOUNT SYSTEM ────────────────────────────────
 * An influencer is a PROFILE hung off the existing Coupon. Their code is an
 * ordinary coupon row: it is validated, made eligible, stacked, priced and
 * redeemed by exactly the same engine as SPECIAL10. Nothing here computes a
 * discount, and nothing here is consulted at checkout.
 *
 * That is the whole point. A parallel affiliate discount path would be a second
 * place for money to be decided, and the two would eventually disagree.
 *
 * ── WHERE THE NUMBERS COME FROM ─────────────────────────────────────────────
 * Reporting reads what the order and redemption ledgers already record:
 *
 *   Order.influencer*        immutable snapshot, written at purchase
 *   CouponRedemption         one row per use, with confirmedAt / releasedAt
 *
 * Revenue counts CONFIRMED orders only — the same definition the coupon module
 * already uses for its own revenue columns — so a cancelled or refunded order
 * can never be reported as affiliate earnings.
 */
import { InfluencerStatus, type Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AppError, ErrorCode, conflict, notFound } from '@/lib/errors';
import { type AuditContext, buildDiff, writeAudit } from '@/modules/audit/audit.service';
import { AuditModule } from '@prisma/client';
import { listMeta, toSkipTake } from '@/middleware/validate';
import { toRupees } from '@/modules/products/products.serializer';

/**
 * Orders that count as affiliate earnings.
 *
 * Reuses the project's existing definition of a real order rather than
 * inventing one, so "affiliate revenue" and "coupon revenue" can never
 * disagree: not cancelled, and either paid or a COD order ops has accepted.
 */
export const EARNING_ORDER_WHERE = {
  status: { not: 'CANCELLED' },
  OR: [
    { paymentStatus: { in: ['PAID', 'PARTIALLY_REFUNDED'] } },
    {
      paymentMethod: 'COD',
      status: { in: ['PROCESSING', 'SHIPPED', 'DELIVERED'] },
    },
  ],
} satisfies Prisma.OrderWhereInput;

const INFLUENCER_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  socialHandle: true,
  notes: true,
  status: true,
  deactivatedAt: true,
  createdAt: true,
  updatedAt: true,
  coupons: {
    where: { deletedAt: null },
    select: {
      id: true,
      code: true,
      discountType: true,
      discountValue: true,
      isActive: true,
      startsAt: true,
      endsAt: true,
      minOrderPaise: true,
      maxDiscountPaise: true,
      totalUsageLimit: true,
      perCustomerLimit: true,
      stackingMode: true,
      allowedStates: true,
      usedCount: true,
    },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.InfluencerSelect;

type InfluencerRow = Prisma.InfluencerGetPayload<{ select: typeof INFLUENCER_SELECT }>;

function serialize(row: InfluencerRow) {
  const coupon = row.coupons[0] ?? null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    socialHandle: row.socialHandle,
    notes: row.notes,
    status: row.status,
    deactivatedAt: row.deactivatedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    coupon: coupon
      ? {
          id: coupon.id,
          code: coupon.code,
          discountType: coupon.discountType,
          discountValue: coupon.discountValue,
          isActive: coupon.isActive,
          startsAt: coupon.startsAt,
          endsAt: coupon.endsAt,
          minOrderPaise: coupon.minOrderPaise,
          minOrder: toRupees(coupon.minOrderPaise),
          maxDiscountPaise: coupon.maxDiscountPaise,
          maxDiscount: coupon.maxDiscountPaise === null ? null : toRupees(coupon.maxDiscountPaise),
          totalUsageLimit: coupon.totalUsageLimit,
          perCustomerLimit: coupon.perCustomerLimit,
          stackingMode: coupon.stackingMode,
          allowedStates: coupon.allowedStates,
          usedCount: coupon.usedCount,
        }
      : null,
    /** Every code they have ever had, so a renamed code still reads sensibly. */
    couponCodes: row.coupons.map((c) => c.code),
  };
}

export type SerializedInfluencer = ReturnType<typeof serialize>;

// ---- Reads -----------------------------------------------------------------

export async function list(params: {
  page: number;
  limit: number;
  q?: string;
  status?: InfluencerStatus;
}) {
  const { skip, take } = toSkipTake(params);

  const where: Prisma.InfluencerWhereInput = {
    ...(params.status ? { status: params.status } : {}),
    ...(params.q
      ? {
          OR: [
            { name: { contains: params.q, mode: 'insensitive' } },
            { email: { contains: params.q, mode: 'insensitive' } },
            { socialHandle: { contains: params.q, mode: 'insensitive' } },
            { coupons: { some: { code: { contains: params.q, mode: 'insensitive' } } } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.influencer.findMany({
      where,
      select: INFLUENCER_SELECT,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.influencer.count({ where }),
  ]);

  /*
   * Totals for the listing come from ONE grouped query rather than a summary
   * per row: the list shows orders and revenue for every influencer, and a
   * per-row aggregate would be N round trips against a database that is already
   * ~800ms away.
   */
  const ids = rows.map((r) => r.id);
  const totals = ids.length
    ? await prisma.order.groupBy({
        by: ['influencerId'],
        where: { influencerId: { in: ids }, ...EARNING_ORDER_WHERE },
        _count: { _all: true },
        _sum: { totalPaise: true, influencerDiscountPaise: true },
      })
    : [];
  const allOrders = ids.length
    ? await prisma.order.groupBy({
        by: ['influencerId'],
        where: { influencerId: { in: ids } },
        _count: { _all: true },
      })
    : [];

  const earned = new Map(totals.map((t) => [t.influencerId, t]));
  const attempted = new Map(allOrders.map((t) => [t.influencerId, t._count._all]));

  return {
    data: rows.map((row) => {
      const e = earned.get(row.id);
      const netPaise = e?._sum.totalPaise ?? 0;
      return {
        ...serialize(row),
        totalOrders: attempted.get(row.id) ?? 0,
        successfulOrders: e?._count._all ?? 0,
        netRevenuePaise: netPaise,
        netRevenue: toRupees(netPaise),
        discountGivenPaise: e?._sum.influencerDiscountPaise ?? 0,
      };
    }),
    meta: listMeta(params.page, params.limit, total),
  };
}

export async function getById(id: string): Promise<SerializedInfluencer> {
  const row = await prisma.influencer.findUnique({ where: { id }, select: INFLUENCER_SELECT });
  if (!row) throw notFound('Influencer not found.');
  return serialize(row);
}

/**
 * Everything the detail page's summary cards show.
 *
 * Gross is the cart value BEFORE the affiliate discount, so
 * `gross - discount = net` holds exactly; net is what the customer actually
 * paid, which is what a commission is calculated from.
 */
export async function analytics(id: string, range?: { from?: Date; to?: Date }) {
  const influencer = await prisma.influencer.findUnique({ where: { id }, select: { id: true } });
  if (!influencer) throw notFound('Influencer not found.');

  const placedAt =
    range?.from || range?.to
      ? { placedAt: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } }
      : {};
  const scope: Prisma.OrderWhereInput = { influencerId: id, ...placedAt };

  const [attempted, earning, cancelled, refunded, bounds] = await Promise.all([
    prisma.order.aggregate({ where: scope, _count: { _all: true } }),
    prisma.order.aggregate({
      where: { ...scope, ...EARNING_ORDER_WHERE },
      _count: { _all: true },
      _sum: { totalPaise: true, subtotalPaise: true, influencerDiscountPaise: true },
    }),
    prisma.order.count({ where: { ...scope, status: 'CANCELLED' } }),
    prisma.order.count({ where: { ...scope, paymentStatus: { in: ['REFUNDED', 'PARTIALLY_REFUNDED'] } } }),
    prisma.order.aggregate({ where: scope, _min: { placedAt: true }, _max: { placedAt: true } }),
  ]);

  const successfulOrders = earning._count._all;
  const grossPaise = earning._sum.subtotalPaise ?? 0;
  const discountPaise = earning._sum.influencerDiscountPaise ?? 0;
  const netPaise = earning._sum.totalPaise ?? 0;

  return {
    /** Every order that carried the code, whatever became of it. */
    totalUses: attempted._count._all,
    totalOrders: attempted._count._all,
    successfulOrders,
    cancelledOrders: cancelled,
    refundedOrders: refunded,
    grossRevenuePaise: grossPaise,
    grossRevenue: toRupees(grossPaise),
    discountGivenPaise: discountPaise,
    discountGiven: toRupees(discountPaise),
    netRevenuePaise: netPaise,
    netRevenue: toRupees(netPaise),
    averageOrderValuePaise: successfulOrders > 0 ? Math.round(netPaise / successfulOrders) : 0,
    averageOrderValue: toRupees(successfulOrders > 0 ? Math.round(netPaise / successfulOrders) : 0),
    firstOrderAt: bounds._min.placedAt,
    latestOrderAt: bounds._max.placedAt,
  };
}

/** The attributed-orders table, read from each order's own snapshot. */
export async function attributedOrders(
  id: string,
  params: { page: number; limit: number; status?: string; from?: Date; to?: Date; q?: string },
) {
  const { skip, take } = toSkipTake(params);

  const where: Prisma.OrderWhereInput = {
    influencerId: id,
    ...(params.status ? { status: params.status as never } : {}),
    ...(params.from || params.to
      ? { placedAt: { ...(params.from ? { gte: params.from } : {}), ...(params.to ? { lte: params.to } : {}) } }
      : {}),
    ...(params.q
      ? {
          OR: [
            { orderNo: { contains: params.q, mode: 'insensitive' as const } },
            { email: { contains: params.q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.order.findMany({
      where,
      select: {
        id: true,
        orderNo: true,
        email: true,
        shippingAddress: true,
        placedAt: true,
        status: true,
        paymentStatus: true,
        subtotalPaise: true,
        totalPaise: true,
        influencerCouponCode: true,
        influencerDiscountPct: true,
        influencerDiscountPaise: true,
      },
      orderBy: { placedAt: 'desc' },
      skip,
      take,
    }),
    prisma.order.count({ where }),
  ]);

  return {
    data: rows.map((o) => ({
      id: o.id,
      orderNo: o.orderNo,
      /* The customer's name lives in the address snapshot, as elsewhere. */
      customerName: (o.shippingAddress as { name?: string } | null)?.name ?? null,
      email: o.email,
      placedAt: o.placedAt,
      status: o.status,
      paymentStatus: o.paymentStatus,
      subtotalPaise: o.subtotalPaise,
      subtotal: toRupees(o.subtotalPaise),
      discountPaise: o.influencerDiscountPaise ?? 0,
      discount: toRupees(o.influencerDiscountPaise ?? 0),
      totalPaise: o.totalPaise,
      total: toRupees(o.totalPaise),
      couponCode: o.influencerCouponCode,
      discountPct: o.influencerDiscountPct,
    })),
    meta: listMeta(params.page, params.limit, total),
  };
}

// ---- Writes ----------------------------------------------------------------

/**
 * Percentage bounds for an affiliate code.
 *
 * The brief asks for roughly 12–15%, but the range is not hardcoded: this is a
 * SAFETY ceiling, not the business rule. Any percentage inside it is allowed and
 * the admin picks the exact figure; the CMS suggests 12–15 in its own copy.
 * A ceiling still matters — nothing should be able to write a 900% coupon.
 */
export const MIN_INFLUENCER_PCT = 1;
/**
 * Per-customer cap on an affiliate code.
 *
 * Deliberately large rather than zero: the engine treats 0 as "no uses allowed",
 * and an affiliate code is meant to be shared, so one enthusiastic customer
 * ordering twice must not be refused. Still finite, so a leaked code cannot be
 * farmed indefinitely by a single account.
 */
export const MAX_USES_PER_CUSTOMER = 100;
export const MAX_INFLUENCER_PCT = 90;

/**
 * Stacking modes an AFFILIATE code may use.
 *
 * GLOBALLY_STACKABLE is deliberately absent. That mode means "combines with
 * anything", and it exists for a perk that is not a percentage off the cart —
 * the free-shipping first-order benefit. An affiliate percentage marked that way
 * would ride on top of SPECIAL10 and compound into a double discount, which is
 * the exact failure the mode was built to prevent. Free shipping still applies
 * alongside every option below, because ZEWA1 carries that property, not these.
 */
export const AFFILIATE_STACKING = ['NON_STACKABLE', 'STACKABLE', 'EXCLUSIVE'] as const;
export type AffiliateStacking = (typeof AFFILIATE_STACKING)[number];

export interface InfluencerInput {
  name: string;
  email?: string | null;
  phone?: string | null;
  socialHandle?: string | null;
  notes?: string | null;
  couponCode: string;
  /** PERCENTAGE uses `discountPct`; FLAT uses `discountPaise`. */
  discountType?: 'PERCENTAGE' | 'FLAT';
  discountPct?: number;
  discountPaise?: number;
  minOrderPaise?: number;
  /** Ceiling on a percentage discount, in paise. Null for no cap. */
  maxDiscountPaise?: number | null;
  /** Total redemptions allowed across all customers. Null for unlimited. */
  totalUsageLimit?: number | null;
  /** How many times ONE customer may use it. */
  perCustomerLimit?: number;
  stackingMode?: AffiliateStacking;
  /** States this code may be used for delivery to. Empty means everywhere. */
  allowedStates?: string[];
  startsAt: Date;
  endsAt: Date;
  isActive?: boolean;
}

/**
 * Codes are stored upper-case and compared that way.
 *
 * `Coupon.code` is unique, and the whole system already upper-cases a code
 * before looking it up, so normalising on write is what makes "rahul15" and
 * "RAHUL15" the same coupon rather than two.
 */
export const normaliseCode = (code: string): string => code.trim().toUpperCase();

async function assertCodeFree(code: string, exceptCouponId?: string): Promise<void> {
  const existing = await prisma.coupon.findUnique({
    where: { code: normaliseCode(code) },
    select: { id: true },
  });
  if (existing && existing.id !== exceptCouponId) {
    throw conflict(`Coupon code ${normaliseCode(code)} is already in use.`, ErrorCode.COUPON_DUPLICATE);
  }
}

/**
 * Validate the discount shape.
 *
 * A percentage is bounded because nothing should be able to write a 900% code.
 * A flat amount is bounded only by sanity — the engine already floors a discount
 * at the cart value, so an over-large flat code cannot make an order negative.
 */
function assertDiscount(input: {
  discountType?: 'PERCENTAGE' | 'FLAT';
  discountPct?: number;
  discountPaise?: number;
}): void {
  const type = input.discountType ?? 'PERCENTAGE';
  if (type === 'FLAT') {
    const paise = input.discountPaise ?? 0;
    if (!Number.isInteger(paise) || paise <= 0) {
      throw new AppError(422, ErrorCode.VALIDATION_FAILED, 'Enter a flat discount amount.', {
        fields: { discountAmount: 'Enter an amount greater than zero.' },
      });
    }
    return;
  }
  assertPct(input.discountPct ?? 0);
}

function assertPct(pct: number): void {
  if (!Number.isInteger(pct) || pct < MIN_INFLUENCER_PCT || pct > MAX_INFLUENCER_PCT) {
    throw new AppError(
      422,
      ErrorCode.VALIDATION_FAILED,
      `Discount must be a whole percentage between ${MIN_INFLUENCER_PCT} and ${MAX_INFLUENCER_PCT}.`,
      { fields: { discountPct: `Enter a value between ${MIN_INFLUENCER_PCT} and ${MAX_INFLUENCER_PCT}.` } },
    );
  }
}

/**
 * Create the affiliate and their coupon together.
 *
 * One transaction, because an influencer with no code cannot earn and a code
 * with no owner cannot be reported on — a half-written pair is not a state the
 * admin screens can render.
 *
 * The coupon is deliberately NON_STACKABLE: an affiliate code is a percentage
 * off the cart, and the house rule is one percentage discount per order. It
 * still combines with the free-shipping first-order benefit, because that is
 * GLOBALLY_STACKABLE and rides alongside anything.
 */
export async function create(input: InfluencerInput, ctx: AuditContext) {
  assertDiscount(input);
  const code = normaliseCode(input.couponCode);
  await assertCodeFree(code);

  const created = await prisma.$transaction(async (tx) => {
    const influencer = await tx.influencer.create({
      data: {
        name: input.name.trim(),
        email: input.email?.trim() || null,
        phone: input.phone?.trim() || null,
        socialHandle: input.socialHandle?.trim() || null,
        notes: input.notes?.trim() || null,
      },
      select: { id: true },
    });

    await tx.coupon.create({
      data: {
        code,
        name: `${input.name.trim()} — affiliate`,
        description: `Influencer code for ${input.name.trim()}`,
        discountType: input.discountType ?? 'PERCENTAGE',
        discountValue:
          (input.discountType ?? 'PERCENTAGE') === 'FLAT'
            ? (input.discountPaise ?? 0)
            : (input.discountPct ?? 0),
        // Only meaningful for a percentage; a flat coupon is already its own cap.
        maxDiscountPaise:
          (input.discountType ?? 'PERCENTAGE') === 'PERCENTAGE'
            ? (input.maxDiscountPaise ?? null)
            : null,
        minOrderPaise: input.minOrderPaise ?? 0,
        totalUsageLimit: input.totalUsageLimit ?? null,
        allowedStates: input.allowedStates ?? [],
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        isActive: input.isActive ?? true,
        trigger: 'CODE',
        /*
         * Defaults to NON_STACKABLE — one percentage discount per order — but
         * the admin may relax it per influencer. GLOBALLY_STACKABLE is not on
         * offer; see AFFILIATE_STACKING.
         */
        stackingMode: input.stackingMode ?? 'NON_STACKABLE',
        customerEligibility: 'ALL_CUSTOMERS',
        /*
         * An affiliate code is shared publicly by the creator, so ONE customer
         * may legitimately use it more than once — unlike a personal voucher.
         * The engine refuses when priorRedemptions >= perCustomerLimit, so 0
         * would block every use; this is the "effectively unlimited" value.
         */
        perCustomerLimit: input.perCustomerLimit ?? MAX_USES_PER_CUSTOMER,
        influencerId: influencer.id,
        // Personal to one creator — never advertised on the storefront.
        showAtCheckout: false,
      },
    });

    return influencer.id;
  });

  await writeAudit(ctx, {
    module: AuditModule.COUPONS,
    action: 'Created influencer affiliate',
    recordId: created,
    diff: buildDiff(null, { name: input.name, code, discountPct: input.discountPct }),
  });

  return getById(created);
}

/** Update the profile, and the coupon's own settings alongside it. */
export async function update(
  id: string,
  input: Partial<InfluencerInput>,
  ctx: AuditContext,
) {
  const before = await prisma.influencer.findUnique({ where: { id }, select: INFLUENCER_SELECT });
  if (!before) throw notFound('Influencer not found.');
  const coupon = before.coupons[0] ?? null;

  if (input.discountPct !== undefined || input.discountPaise !== undefined) {
    assertDiscount({
      discountType: input.discountType ?? (coupon?.discountType as 'PERCENTAGE' | 'FLAT'),
      discountPct: input.discountPct,
      discountPaise: input.discountPaise,
    });
  }
  if (input.couponCode !== undefined && coupon) {
    await assertCodeFree(input.couponCode, coupon.id);
  }

  await prisma.$transaction(async (tx) => {
    await tx.influencer.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.email !== undefined ? { email: input.email?.trim() || null } : {}),
        ...(input.phone !== undefined ? { phone: input.phone?.trim() || null } : {}),
        ...(input.socialHandle !== undefined
          ? { socialHandle: input.socialHandle?.trim() || null }
          : {}),
        ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
      },
    });

    if (coupon) {
      await tx.coupon.update({
        where: { id: coupon.id },
        data: {
          ...(input.couponCode !== undefined ? { code: normaliseCode(input.couponCode) } : {}),
          ...(input.discountType !== undefined ? { discountType: input.discountType } : {}),
          ...(input.discountPct !== undefined ? { discountValue: input.discountPct } : {}),
          ...(input.discountPaise !== undefined ? { discountValue: input.discountPaise } : {}),
          ...(input.maxDiscountPaise !== undefined
            ? { maxDiscountPaise: input.maxDiscountPaise }
            : {}),
          ...(input.totalUsageLimit !== undefined
            ? { totalUsageLimit: input.totalUsageLimit }
            : {}),
          ...(input.perCustomerLimit !== undefined
            ? { perCustomerLimit: input.perCustomerLimit }
            : {}),
          ...(input.stackingMode !== undefined ? { stackingMode: input.stackingMode } : {}),
          ...(input.allowedStates !== undefined ? { allowedStates: input.allowedStates } : {}),
          ...(input.minOrderPaise !== undefined ? { minOrderPaise: input.minOrderPaise } : {}),
          ...(input.startsAt !== undefined ? { startsAt: input.startsAt } : {}),
          ...(input.endsAt !== undefined ? { endsAt: input.endsAt } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
      });
    }
  });

  const after = await getById(id);
  await writeAudit(ctx, {
    module: AuditModule.COUPONS,
    action: 'Updated influencer affiliate',
    recordId: id,
    diff: buildDiff(
      serialize(before) as unknown as Record<string, unknown>,
      after as unknown as Record<string, unknown>,
    ),
  });
  return after;
}

/**
 * Stop or resume future earning. Never deletes anything.
 *
 * Deactivating disables the coupon so it cannot be used again, and leaves every
 * order, redemption and figure exactly where it is — the reports for what they
 * already sold must keep working.
 */
export async function setStatus(id: string, status: InfluencerStatus, ctx: AuditContext) {
  const row = await prisma.influencer.findUnique({ where: { id }, select: INFLUENCER_SELECT });
  if (!row) throw notFound('Influencer not found.');

  const active = status === InfluencerStatus.ACTIVE;
  await prisma.$transaction(async (tx) => {
    await tx.influencer.update({
      where: { id },
      data: { status, deactivatedAt: active ? null : new Date() },
    });
    // Their codes follow the profile, so a deactivated affiliate cannot earn.
    await tx.coupon.updateMany({
      where: { influencerId: id, deletedAt: null },
      data: { isActive: active },
    });
  });

  await writeAudit(ctx, {
    module: AuditModule.COUPONS,
    action: active ? 'Reactivated influencer affiliate' : 'Deactivated influencer affiliate',
    recordId: id,
  });
  return getById(id);
}
