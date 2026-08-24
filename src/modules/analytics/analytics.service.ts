/**
 * E-Commerce KPI & Analytics Service.
 *
 * All metrics are derived from authoritative stored records (Order, OrderItem,
 * Refund, Customer, CouponRedemption, ProductFamily).
 *
 * Financial Rules & Invariants:
 *   1. All financial figures are integer paise.
 *   2. Timezone is strictly IST (Asia/Kolkata, UTC+5:30) with exact calendar boundaries.
 *   3. Abandoned / unpaid checkouts (status = PENDING and paymentStatus = UNPAID)
 *      and CANCELLED orders are strictly excluded from financial revenue metrics.
 *   4. Order-cohort net sales (gross - discounts) is based on Order.placedAt.
 *   5. Refunds processed is an independent cash-event metric based on Refund.createdAt.
 *   6. Multi-coupon aggregate revenue in promotion summaries is deduplicated by order.
 */
import { OrderStatus, PaymentStatus, type Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export interface DateRange {
  from: Date;
  to: Date;
}

export interface MetricDelta {
  current: number;
  previous: number;
  pctChange: number | null;
  absChange: number;
}

export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // +05:30 in milliseconds

/**
 * Determine if an order qualifies as a confirmed revenue-generating order.
 * Excludes cancelled orders and abandoned unpaid pending checkouts.
 */
export function isRevenueOrder(status: OrderStatus, paymentStatus: PaymentStatus): boolean {
  if (status === OrderStatus.CANCELLED) return false;
  if (status === OrderStatus.PENDING && paymentStatus === PaymentStatus.UNPAID) return false;
  return true;
}

export function calcDelta(current: number, previous: number): MetricDelta {
  const absChange = current - previous;
  let pctChange: number | null = null;
  if (previous === 0) {
    pctChange = current === 0 ? 0 : 100;
  } else {
    pctChange = Number((((current - previous) / previous) * 100).toFixed(1));
  }
  return { current, previous, pctChange, absChange };
}

/**
 * Converts a YYYY-MM-DD date string in IST into an exact UTC Date boundary.
 */
export function parseIstDateStringToUtc(dateStr: string, isEndOfDay = false): Date {
  const [yearStr, monthStr, dayStr] = dateStr.split('T')[0]!.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);

  if (isNaN(year) || isNaN(month) || isNaN(day)) {
    throw new Error(`Invalid date string: ${dateStr}`);
  }

  const ms = isEndOfDay
    ? Date.UTC(year, month - 1, day, 23, 59, 59, 999) - IST_OFFSET_MS
    : Date.UTC(year, month - 1, day, 0, 0, 0, 0) - IST_OFFSET_MS;

  return new Date(ms);
}

/**
 * Get current date parts in Asia/Kolkata (IST).
 */
export function getNowInIst(): { year: number; month: number; day: number } {
  const nowUtc = Date.now();
  const istTime = new Date(nowUtc + IST_OFFSET_MS);
  return {
    year: istTime.getUTCFullYear(),
    month: istTime.getUTCMonth() + 1,
    day: istTime.getUTCDate(),
  };
}

/**
 * Normalise date inputs into exact Asia/Kolkata (IST) calendar day UTC boundaries.
 */
export function resolveDateRange(fromStr?: string, toStr?: string): DateRange {
  const nowIst = getNowInIst();
  let from: Date;
  let to: Date;

  if (toStr && /^\d{4}-\d{2}-\d{2}/.test(toStr)) {
    to = parseIstDateStringToUtc(toStr, true);
  } else {
    to = parseIstDateStringToUtc(
      `${nowIst.year}-${String(nowIst.month).padStart(2, '0')}-${String(nowIst.day).padStart(2, '0')}`,
      true,
    );
  }

  if (fromStr && /^\d{4}-\d{2}-\d{2}/.test(fromStr)) {
    from = parseIstDateStringToUtc(fromStr, false);
  } else {
    // Default: 30 days before `to` in IST
    const fromIstDate = new Date(to.getTime() + IST_OFFSET_MS);
    fromIstDate.setUTCDate(fromIstDate.getUTCDate() - 30);
    from = parseIstDateStringToUtc(
      `${fromIstDate.getUTCFullYear()}-${String(fromIstDate.getUTCMonth() + 1).padStart(2, '0')}-${String(fromIstDate.getUTCDate()).padStart(2, '0')}`,
      false,
    );
  }

  // Ensure from <= to
  if (from > to) {
    const tmp = from;
    from = to;
    to = tmp;
  }

  return { from, to };
}

/**
 * Calculate previous matching period for comparison.
 */
export function getPreviousPeriod(current: DateRange): DateRange {
  const durationMs = current.to.getTime() - current.from.getTime();
  const prevTo = new Date(current.from.getTime() - 1);
  const prevFrom = new Date(prevTo.getTime() - durationMs);
  return { from: prevFrom, to: prevTo };
}

export interface OverviewMetrics {
  grossRevenuePaise: MetricDelta;
  netRevenuePaise: MetricDelta;
  discountPaise: MetricDelta;
  shippingPaise: MetricDelta;
  taxPaise: MetricDelta;
  refundPaise: MetricDelta;
  totalOrders: MetricDelta;
  paidOrders: MetricDelta;
  cancelledOrders: MetricDelta;
  itemsSold: MetricDelta;
  aovPaise: MetricDelta;
  uniqueCustomers: MetricDelta;
  newCustomers: MetricDelta;
  returningCustomers: MetricDelta;
  couponUsageCount: MetricDelta;
  couponAttributedRevenuePaise: MetricDelta;
}

export interface PeriodSummary {
  grossRevenuePaise: number;
  netRevenuePaise: number;
  discountPaise: number;
  shippingPaise: number;
  taxPaise: number;
  refundPaise: number;
  totalOrders: number;
  paidOrders: number;
  cancelledOrders: number;
  itemsSold: number;
  aovPaise: number;
  uniqueCustomers: number;
  newCustomers: number;
  returningCustomers: number;
  couponUsageCount: number;
  couponAttributedRevenuePaise: number;
}

async function computePeriodSummary(range: DateRange): Promise<PeriodSummary> {
  const { from, to } = range;

  // 1. Orders placed in period
  const orders = await prisma.order.findMany({
    where: {
      placedAt: { gte: from, lte: to },
    },
    select: {
      id: true,
      email: true,
      status: true,
      paymentStatus: true,
      subtotalPaise: true,
      discountPaise: true,
      shippingPaise: true,
      taxPaise: true,
      totalPaise: true,
      couponCode: true,
      couponCodes: true,
      placedAt: true,
      items: {
        select: {
          qty: true,
        },
      },
    },
  });

  // 2. Refunds processed in period (Cash-event metric based on createdAt)
  const refunds = await prisma.refund.aggregate({
    where: {
      createdAt: { gte: from, lte: to },
    },
    _sum: { amountPaise: true },
    _count: { id: true },
  });
  const refundPaise = refunds._sum.amountPaise ?? 0;

  let grossRevenuePaise = 0;
  let discountPaise = 0;
  let shippingPaise = 0;
  let taxPaise = 0;
  let totalPayablePaise = 0;
  let totalOrders = orders.length;
  let revenueOrderCount = 0;
  let paidOrders = 0;
  let cancelledOrders = 0;
  let itemsSold = 0;
  let couponUsageCount = 0;
  let couponAttributedRevenuePaise = 0;

  const emailsInPeriod = new Set<string>();

  for (const o of orders) {
    emailsInPeriod.add(o.email.toLowerCase().trim());

    if (o.status === OrderStatus.CANCELLED) {
      cancelledOrders++;
    }

    const isRevenue = isRevenueOrder(o.status, o.paymentStatus);

    if (isRevenue) {
      revenueOrderCount++;
      grossRevenuePaise += o.subtotalPaise;
      discountPaise += o.discountPaise;
      shippingPaise += o.shippingPaise;
      taxPaise += o.taxPaise;
      totalPayablePaise += o.totalPaise;

      for (const item of o.items) {
        itemsSold += item.qty;
      }

      const hasCoupon = Boolean(o.couponCode || (o.couponCodes && o.couponCodes.length > 0));
      if (hasCoupon) {
        couponUsageCount++;
        couponAttributedRevenuePaise += o.totalPaise;
      }
    }

    if (
      o.paymentStatus === PaymentStatus.PAID ||
      o.status === OrderStatus.PROCESSING ||
      o.status === OrderStatus.SHIPPED ||
      o.status === OrderStatus.DELIVERED
    ) {
      paidOrders++;
    }
  }

  // Order-cohort net sales: gross catalogue value minus discounts for confirmed orders placed in period
  const netRevenuePaise = Math.max(0, grossRevenuePaise - discountPaise);

  // Paid AOV: Total customer payable revenue divided by valid revenue orders
  const aovPaise = revenueOrderCount > 0
    ? Math.round(totalPayablePaise / revenueOrderCount)
    : 0;

  // New vs Returning customers analysis
  let newCustomers = 0;
  let returningCustomers = 0;

  if (emailsInPeriod.size > 0) {
    const emailsList = Array.from(emailsInPeriod);
    const earliestOrders = await prisma.order.groupBy({
      by: ['email'],
      where: {
        email: { in: emailsList },
        status: { not: OrderStatus.CANCELLED },
      },
      _min: {
        placedAt: true,
      },
    });

    for (const record of earliestOrders) {
      if (record._min.placedAt && record._min.placedAt >= from && record._min.placedAt <= to) {
        newCustomers++;
      } else {
        returningCustomers++;
      }
    }
  }

  return {
    grossRevenuePaise,
    netRevenuePaise,
    discountPaise,
    shippingPaise,
    taxPaise,
    refundPaise,
    totalOrders,
    paidOrders,
    cancelledOrders,
    itemsSold,
    aovPaise,
    uniqueCustomers: emailsInPeriod.size,
    newCustomers,
    returningCustomers,
    couponUsageCount,
    couponAttributedRevenuePaise,
  };
}

/**
 * Generate time-series trend points for sparklines and charts in IST calendar intervals.
 */
async function computeTimeSeries(range: DateRange, interval: 'day' | 'week' | 'month' = 'day') {
  const { from, to } = range;

  const orders = await prisma.order.findMany({
    where: {
      placedAt: { gte: from, lte: to },
    },
    select: {
      placedAt: true,
      status: true,
      paymentStatus: true,
      subtotalPaise: true,
      discountPaise: true,
      shippingPaise: true,
      taxPaise: true,
      totalPaise: true,
      items: { select: { qty: true } },
    },
    orderBy: { placedAt: 'asc' },
  });

  const buckets: Record<string, {
    date: string;
    grossRevenuePaise: number;
    netRevenuePaise: number;
    discountPaise: number;
    shippingPaise: number;
    taxPaise: number;
    orders: number;
    itemsSold: number;
  }> = {};

  for (const o of orders) {
    if (!isRevenueOrder(o.status, o.paymentStatus)) continue;

    // Convert UTC placedAt timestamp to IST calendar date parts
    const istDate = new Date(o.placedAt.getTime() + IST_OFFSET_MS);
    const y = istDate.getUTCFullYear();
    const m = String(istDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(istDate.getUTCDate()).padStart(2, '0');

    let key: string;
    if (interval === 'month') {
      key = `${y}-${m}`;
    } else if (interval === 'week') {
      const weekStart = new Date(istDate);
      weekStart.setUTCDate(istDate.getUTCDate() - istDate.getUTCDay());
      key = `${weekStart.getUTCFullYear()}-${String(weekStart.getUTCMonth() + 1).padStart(2, '0')}-${String(weekStart.getUTCDate()).padStart(2, '0')}`;
    } else {
      key = `${y}-${m}-${d}`;
    }

    if (!buckets[key]) {
      buckets[key] = {
        date: key,
        grossRevenuePaise: 0,
        netRevenuePaise: 0,
        discountPaise: 0,
        shippingPaise: 0,
        taxPaise: 0,
        orders: 0,
        itemsSold: 0,
      };
    }

    const b = buckets[key]!;
    b.grossRevenuePaise += o.subtotalPaise;
    b.discountPaise += o.discountPaise;
    b.shippingPaise += o.shippingPaise;
    b.taxPaise += o.taxPaise;
    b.netRevenuePaise += Math.max(0, o.subtotalPaise - o.discountPaise);
    b.orders += 1;
    for (const item of o.items) {
      b.itemsSold += item.qty;
    }
  }

  return Object.values(buckets);
}

/**
 * Overview endpoint handler.
 */
export async function getOverview(fromStr?: string, toStr?: string, compare = true) {
  const currentRange = resolveDateRange(fromStr, toStr);
  const prevRange = getPreviousPeriod(currentRange);

  const [currentSummary, prevSummary, timeSeries, statusGroups, paymentGroups] = await Promise.all([
    computePeriodSummary(currentRange),
    compare ? computePeriodSummary(prevRange) : computePeriodSummary(prevRange),
    computeTimeSeries(currentRange, 'day'),
    prisma.order.groupBy({
      by: ['status'],
      where: { placedAt: { gte: currentRange.from, lte: currentRange.to } },
      _count: { id: true },
    }),
    prisma.order.groupBy({
      by: ['paymentMethod', 'paymentStatus'],
      where: { placedAt: { gte: currentRange.from, lte: currentRange.to } },
      _count: { id: true },
    }),
  ]);

  const kpis: OverviewMetrics = {
    grossRevenuePaise: calcDelta(currentSummary.grossRevenuePaise, prevSummary.grossRevenuePaise),
    netRevenuePaise: calcDelta(currentSummary.netRevenuePaise, prevSummary.netRevenuePaise),
    discountPaise: calcDelta(currentSummary.discountPaise, prevSummary.discountPaise),
    shippingPaise: calcDelta(currentSummary.shippingPaise, prevSummary.shippingPaise),
    taxPaise: calcDelta(currentSummary.taxPaise, prevSummary.taxPaise),
    refundPaise: calcDelta(currentSummary.refundPaise, prevSummary.refundPaise),
    totalOrders: calcDelta(currentSummary.totalOrders, prevSummary.totalOrders),
    paidOrders: calcDelta(currentSummary.paidOrders, prevSummary.paidOrders),
    cancelledOrders: calcDelta(currentSummary.cancelledOrders, prevSummary.cancelledOrders),
    itemsSold: calcDelta(currentSummary.itemsSold, prevSummary.itemsSold),
    aovPaise: calcDelta(currentSummary.aovPaise, prevSummary.aovPaise),
    uniqueCustomers: calcDelta(currentSummary.uniqueCustomers, prevSummary.uniqueCustomers),
    newCustomers: calcDelta(currentSummary.newCustomers, prevSummary.newCustomers),
    returningCustomers: calcDelta(currentSummary.returningCustomers, prevSummary.returningCustomers),
    couponUsageCount: calcDelta(currentSummary.couponUsageCount, prevSummary.couponUsageCount),
    couponAttributedRevenuePaise: calcDelta(currentSummary.couponAttributedRevenuePaise, prevSummary.couponAttributedRevenuePaise),
  };

  const statusDistribution: Record<string, number> = {
    PENDING: 0,
    PROCESSING: 0,
    SHIPPED: 0,
    DELIVERED: 0,
    CANCELLED: 0,
  };
  for (const sg of statusGroups) {
    statusDistribution[sg.status] = sg._count.id;
  }

  return {
    range: currentRange,
    comparisonRange: prevRange,
    kpis,
    timeSeries,
    statusDistribution,
    paymentBreakdown: paymentGroups.map((pg) => ({
      method: pg.paymentMethod,
      status: pg.paymentStatus,
      count: pg._count.id,
    })),
  };
}

/**
 * Detailed Revenue Analytics.
 */
export async function getRevenueAnalytics(fromStr?: string, toStr?: string, interval: 'day' | 'week' | 'month' = 'day') {
  const range = resolveDateRange(fromStr, toStr);

  const [timeSeries, orders] = await Promise.all([
    computeTimeSeries(range, interval),
    prisma.order.findMany({
      where: {
        placedAt: { gte: range.from, lte: range.to },
      },
      select: {
        id: true,
        status: true,
        paymentStatus: true,
        subtotalPaise: true,
        discountPaise: true,
        shippingPaise: true,
        taxPaise: true,
        totalPaise: true,
        paymentMethod: true,
        shippingAddress: true,
        items: {
          select: {
            sku: true,
            productName: true,
            lineTotalPaise: true,
            qty: true,
            variant: {
              select: {
                family: {
                  select: {
                    id: true,
                    name: true,
                    category: true,
                  },
                },
              },
            },
          },
        },
      },
    }),
  ]);

  const categoryMap: Record<string, { category: string; grossPaise: number; units: number; orderCount: Set<string> }> = {};
  const stateMap: Record<string, { state: string; grossPaise: number; orders: number }> = {};
  const paymentMethodMap: Record<string, { method: string; grossPaise: number; count: number }> = {};

  for (const o of orders) {
    if (!isRevenueOrder(o.status, o.paymentStatus)) continue;

    const address = o.shippingAddress as Record<string, string> | null;
    const state = address?.state || 'Unknown';

    if (!stateMap[state]) stateMap[state] = { state, grossPaise: 0, orders: 0 };
    stateMap[state].grossPaise += o.subtotalPaise;
    stateMap[state].orders += 1;

    if (!paymentMethodMap[o.paymentMethod]) {
      paymentMethodMap[o.paymentMethod] = { method: o.paymentMethod, grossPaise: 0, count: 0 };
    }
    paymentMethodMap[o.paymentMethod]!.grossPaise += o.subtotalPaise;
    paymentMethodMap[o.paymentMethod]!.count += 1;

    for (const item of o.items) {
      const cat = item.variant?.family?.category || 'OTHER';
      if (!categoryMap[cat]) {
        categoryMap[cat] = { category: cat, grossPaise: 0, units: 0, orderCount: new Set() };
      }
      categoryMap[cat]!.grossPaise += item.lineTotalPaise;
      categoryMap[cat]!.units += item.qty;
      categoryMap[cat]!.orderCount.add(o.id);
    }
  }

  const byCategory = Object.values(categoryMap).map((c) => ({
    category: c.category,
    grossPaise: c.grossPaise,
    units: c.units,
    orders: c.orderCount.size,
  })).sort((a, b) => b.grossPaise - a.grossPaise);

  const byState = Object.values(stateMap).sort((a, b) => b.grossPaise - a.grossPaise);
  const byPaymentMethod = Object.values(paymentMethodMap);

  return {
    range,
    interval,
    timeSeries,
    byCategory,
    byState,
    byPaymentMethod,
  };
}

/**
 * Product Performance Table.
 */
export async function getProductAnalytics(params: {
  fromStr?: string;
  toStr?: string;
  sort?: 'revenue' | 'units' | 'orders' | 'avgPrice';
  dir?: 'asc' | 'desc';
  search?: string;
  page?: number;
  limit?: number;
}) {
  const range = resolveDateRange(params.fromStr, params.toStr);
  const page = Math.max(1, Number(params.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(params.limit) || 20));
  const sort = params.sort || 'revenue';
  const dir = params.dir || 'desc';
  const search = params.search?.toLowerCase().trim();

  const orders = await prisma.order.findMany({
    where: {
      placedAt: { gte: range.from, lte: range.to },
    },
    select: {
      id: true,
      status: true,
      paymentStatus: true,
      items: {
        select: {
          sku: true,
          productName: true,
          pack: true,
          unitPricePaise: true,
          qty: true,
          lineTotalPaise: true,
          orderId: true,
          variant: {
            select: {
              id: true,
              family: {
                select: {
                  name: true,
                  category: true,
                  slug: true,
                },
              },
            },
          },
        },
      },
    },
  });

  const productAgg: Record<string, {
    sku: string;
    productName: string;
    pack: string;
    category: string;
    familySlug: string | null;
    unitsSold: number;
    grossSalesPaise: number;
    orders: Set<string>;
  }> = {};

  for (const o of orders) {
    if (!isRevenueOrder(o.status, o.paymentStatus)) continue;

    for (const item of o.items) {
      if (!productAgg[item.sku]) {
        productAgg[item.sku] = {
          sku: item.sku,
          productName: item.productName,
          pack: item.pack,
          category: item.variant?.family?.category || 'OTHER',
          familySlug: item.variant?.family?.slug || null,
          unitsSold: 0,
          grossSalesPaise: 0,
          orders: new Set(),
        };
      }
      const p = productAgg[item.sku]!;
      p.unitsSold += item.qty;
      p.grossSalesPaise += item.lineTotalPaise;
      p.orders.add(item.orderId);
    }
  }

  let list = Object.values(productAgg).map((p) => ({
    sku: p.sku,
    productName: p.productName,
    pack: p.pack,
    category: p.category,
    familySlug: p.familySlug,
    unitsSold: p.unitsSold,
    grossSalesPaise: p.grossSalesPaise,
    orderCount: p.orders.size,
    avgSellingPricePaise: p.unitsSold > 0 ? Math.round(p.grossSalesPaise / p.unitsSold) : 0,
  }));

  if (search) {
    list = list.filter(
      (p) =>
        p.productName.toLowerCase().includes(search) ||
        p.sku.toLowerCase().includes(search) ||
        p.pack.toLowerCase().includes(search),
    );
  }

  list.sort((a, b) => {
    let diff = 0;
    if (sort === 'units') diff = a.unitsSold - b.unitsSold;
    else if (sort === 'orders') diff = a.orderCount - b.orderCount;
    else if (sort === 'avgPrice') diff = a.avgSellingPricePaise - b.avgSellingPricePaise;
    else diff = a.grossSalesPaise - b.grossSalesPaise;
    return dir === 'asc' ? diff : -diff;
  });

  const totalCount = list.length;
  const paginated = list.slice((page - 1) * limit, page * limit);

  return {
    range,
    data: paginated,
    meta: {
      page,
      limit,
      totalCount,
      totalPages: Math.ceil(totalCount / limit) || 1,
    },
  };
}

/**
 * Promotions & Coupons Analytics.
 */
export async function getPromotionsAnalytics(fromStr?: string, toStr?: string, page = 1, limit = 20) {
  const range = resolveDateRange(fromStr, toStr);

  const [redemptions, totalOrdersCount, allCoupons] = await Promise.all([
    prisma.couponRedemption.findMany({
      where: {
        redeemedAt: { gte: range.from, lte: range.to },
        releasedAt: null,
      },
      include: {
        coupon: true,
        order: {
          select: {
            status: true,
            paymentStatus: true,
            totalPaise: true,
          },
        },
      },
    }),
    prisma.order.count({
      where: {
        placedAt: { gte: range.from, lte: range.to },
        status: { not: OrderStatus.CANCELLED },
      },
    }),
    prisma.coupon.findMany({
      select: {
        id: true,
        code: true,
        name: true,
        discountType: true,
        discountValue: true,
        trigger: true,
        stackingMode: true,
        isActive: true,
      },
    }),
  ]);

  const couponAgg: Record<string, {
    couponId: string;
    code: string;
    name: string | null;
    discountType: string;
    discountValue: number;
    trigger: string;
    stackingMode: string;
    isActive: boolean;
    redemptions: number;
    attributedRevenuePaise: number;
    discountCostPaise: number;
    orders: Set<string>;
  }> = {};

  for (const c of allCoupons) {
    couponAgg[c.id] = {
      couponId: c.id,
      code: c.code,
      name: c.name,
      discountType: c.discountType,
      discountValue: c.discountValue,
      trigger: c.trigger,
      stackingMode: c.stackingMode,
      isActive: c.isActive,
      redemptions: 0,
      attributedRevenuePaise: 0,
      discountCostPaise: 0,
      orders: new Set(),
    };
  }

  let totalDiscountsGivenPaise = 0;
  let totalAttributedRevenuePaise = 0;
  const uniqueOrdersWithCoupon = new Set<string>();

  for (const r of redemptions) {
    if (r.order && !isRevenueOrder(r.order.status, r.order.paymentStatus)) continue;

    totalDiscountsGivenPaise += r.discountPaise;

    // Deduplicate order revenue in aggregate summary across multi-coupon orders
    if (!uniqueOrdersWithCoupon.has(r.orderId)) {
      uniqueOrdersWithCoupon.add(r.orderId);
      totalAttributedRevenuePaise += r.cartValuePaise;
    }

    if (!couponAgg[r.couponId]) {
      couponAgg[r.couponId] = {
        couponId: r.couponId,
        code: r.coupon?.code || 'UNKNOWN',
        name: r.coupon?.name || null,
        discountType: r.coupon?.discountType || 'PERCENTAGE',
        discountValue: r.coupon?.discountValue || 0,
        trigger: r.coupon?.trigger || 'CODE',
        stackingMode: r.coupon?.stackingMode || 'NON_STACKABLE',
        isActive: r.coupon?.isActive ?? true,
        redemptions: 0,
        attributedRevenuePaise: 0,
        discountCostPaise: 0,
        orders: new Set(),
      };
    }

    // Per-coupon touchpoint attribution
    const c = couponAgg[r.couponId]!;
    c.redemptions += 1;
    c.attributedRevenuePaise += r.cartValuePaise;
    c.discountCostPaise += r.discountPaise;
    c.orders.add(r.orderId);
  }

  const list = Object.values(couponAgg).map((c) => ({
    couponId: c.couponId,
    code: c.code,
    name: c.name,
    discountType: c.discountType,
    discountValue: c.discountValue,
    trigger: c.trigger,
    stackingMode: c.stackingMode,
    isActive: c.isActive,
    redemptionCount: c.redemptions,
    attributedRevenuePaise: c.attributedRevenuePaise,
    discountCostPaise: c.discountCostPaise,
    orderCount: c.orders.size,
    aovPaise: c.redemptions > 0 ? Math.round(c.attributedRevenuePaise / c.redemptions) : 0,
  })).sort((a, b) => b.attributedRevenuePaise - a.attributedRevenuePaise || b.redemptionCount - a.redemptionCount);

  const couponUsageRatePct = totalOrdersCount > 0
    ? Number(((uniqueOrdersWithCoupon.size / totalOrdersCount) * 100).toFixed(1))
    : 0;

  const paginated = list.slice((page - 1) * limit, page * limit);

  return {
    range,
    summary: {
      totalRedemptions: redemptions.length,
      totalDiscountsGivenPaise,
      totalAttributedRevenuePaise,
      couponOrdersCount: uniqueOrdersWithCoupon.size,
      totalOrdersCount,
      couponUsageRatePct,
    },
    data: paginated,
    meta: {
      page,
      limit,
      totalCount: list.length,
      totalPages: Math.ceil(list.length / limit) || 1,
    },
  };
}

/**
 * Customer Retention & Purchasing Behavior.
 */
export async function getCustomerAnalytics(fromStr?: string, toStr?: string) {
  const range = resolveDateRange(fromStr, toStr);

  const [ordersInPeriod, allCustomerOrders] = await Promise.all([
    prisma.order.findMany({
      where: {
        placedAt: { gte: range.from, lte: range.to },
        status: { not: OrderStatus.CANCELLED },
      },
      select: {
        email: true,
        totalPaise: true,
        customerId: true,
      },
    }),
    prisma.order.groupBy({
      by: ['email'],
      where: { status: { not: OrderStatus.CANCELLED } },
      _count: { id: true },
      _sum: { totalPaise: true },
      _min: { placedAt: true },
      _max: { placedAt: true },
    }),
  ]);

  const totalRegisteredCustomers = await prisma.customer.count();

  let totalCustomersWithOrders = allCustomerOrders.length;
  let repeatCustomersCount = 0;

  const customerSpendTiers = {
    under500: 0,
    under1500: 0,
    under5000: 0,
    above5000: 0,
  };

  const topCustomers = allCustomerOrders
    .map((c) => {
      const count = c._count.id;
      const spend = c._sum.totalPaise || 0;
      if (count >= 2) repeatCustomersCount++;

      if (spend < 50000) customerSpendTiers.under500++;
      else if (spend < 150000) customerSpendTiers.under1500++;
      else if (spend < 500000) customerSpendTiers.under5000++;
      else customerSpendTiers.above5000++;

      const parts = c.email.split('@');
      const masked = parts.length === 2 && parts[0]!.length > 2
        ? `${parts[0]!.substring(0, 2)}***@${parts[1]}`
        : c.email;

      return {
        emailMasked: masked,
        orderCount: count,
        totalSpendPaise: spend,
        firstOrderAt: c._min.placedAt,
        lastOrderAt: c._max.placedAt,
      };
    })
    .sort((a, b) => b.totalSpendPaise - a.totalSpendPaise)
    .slice(0, 10);

  const repeatPurchaseRatePct = totalCustomersWithOrders > 0
    ? Number(((repeatCustomersCount / totalCustomersWithOrders) * 100).toFixed(1))
    : 0;

  let registeredOrderCount = 0;
  let guestOrderCount = 0;
  for (const o of ordersInPeriod) {
    if (o.customerId) registeredOrderCount++;
    else guestOrderCount++;
  }

  return {
    range,
    totalRegisteredCustomers,
    totalCustomersWithOrders,
    repeatCustomersCount,
    repeatPurchaseRatePct,
    guestVsRegisteredInPeriod: {
      registered: registeredOrderCount,
      guest: guestOrderCount,
    },
    customerSpendTiers,
    topCustomers,
  };
}

/**
 * Geographic Breakdown by State.
 */
export async function getGeographicAnalytics(fromStr?: string, toStr?: string) {
  const range = resolveDateRange(fromStr, toStr);

  const orders = await prisma.order.findMany({
    where: {
      placedAt: { gte: range.from, lte: range.to },
    },
    select: {
      status: true,
      paymentStatus: true,
      shippingAddress: true,
      subtotalPaise: true,
      shippingPaise: true,
      totalPaise: true,
    },
  });

  const stateMap: Record<string, {
    state: string;
    orders: number;
    grossRevenuePaise: number;
    shippingRevenuePaise: number;
  }> = {};

  let totalGross = 0;

  for (const o of orders) {
    if (!isRevenueOrder(o.status, o.paymentStatus)) continue;

    const address = o.shippingAddress as Record<string, string> | null;
    const state = (address?.state || 'Unknown').trim();

    if (!stateMap[state]) {
      stateMap[state] = {
        state,
        orders: 0,
        grossRevenuePaise: 0,
        shippingRevenuePaise: 0,
      };
    }
    const s = stateMap[state]!;
    s.orders += 1;
    s.grossRevenuePaise += o.subtotalPaise;
    s.shippingRevenuePaise += o.shippingPaise;
    totalGross += o.subtotalPaise;
  }

  const list = Object.values(stateMap).map((s) => ({
    state: s.state,
    orders: s.orders,
    grossRevenuePaise: s.grossRevenuePaise,
    shippingRevenuePaise: s.shippingRevenuePaise,
    aovPaise: s.orders > 0 ? Math.round(s.grossRevenuePaise / s.orders) : 0,
    revenueSharePct: totalGross > 0 ? Number(((s.grossRevenuePaise / totalGross) * 100).toFixed(1)) : 0,
  })).sort((a, b) => b.grossRevenuePaise - a.grossRevenuePaise);

  return {
    range,
    data: list,
  };
}

/**
 * CSV Exporter.
 */
export async function exportCsv(type: 'revenue' | 'products' | 'promotions' | 'geography', fromStr?: string, toStr?: string): Promise<{ filename: string; csv: string }> {
  const range = resolveDateRange(fromStr, toStr);
  const fromTag = range.from.toISOString().split('T')[0];
  const toTag = range.to.toISOString().split('T')[0];

  if (type === 'products') {
    const res = await getProductAnalytics({ fromStr, toStr, limit: 1000 });
    const headers = ['SKU', 'Product Name', 'Pack', 'Category', 'Units Sold', 'Orders', 'Gross Catalogue Sales (INR)', 'Avg Price (INR)'];
    const rows = res.data.map((p) => [
      `"${p.sku}"`,
      `"${p.productName.replace(/"/g, '""')}"`,
      `"${p.pack}"`,
      `"${p.category}"`,
      p.unitsSold,
      p.orderCount,
      (p.grossSalesPaise / 100).toFixed(2),
      (p.avgSellingPricePaise / 100).toFixed(2),
    ]);
    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    return { filename: `products-analytics-${fromTag}-${toTag}.csv`, csv };
  }

  if (type === 'promotions') {
    const res = await getPromotionsAnalytics(fromStr, toStr, 1, 1000);
    const headers = ['Coupon Code', 'Name', 'Type', 'Trigger', 'Redemptions', 'Attributed Revenue (INR)', 'Discount Given (INR)', 'AOV (INR)', 'Status'];
    const rows = res.data.map((c) => [
      `"${c.code}"`,
      `"${(c.name || '').replace(/"/g, '""')}"`,
      `"${c.discountType}"`,
      `"${c.trigger}"`,
      c.redemptionCount,
      (c.attributedRevenuePaise / 100).toFixed(2),
      (c.discountCostPaise / 100).toFixed(2),
      (c.aovPaise / 100).toFixed(2),
      c.isActive ? 'Active' : 'Inactive',
    ]);
    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    return { filename: `promotions-analytics-${fromTag}-${toTag}.csv`, csv };
  }

  if (type === 'geography') {
    const res = await getGeographicAnalytics(fromStr, toStr);
    const headers = ['State', 'Orders', 'Gross Revenue (INR)', 'Shipping Revenue (INR)', 'AOV (INR)', 'Revenue Share %'];
    const rows = res.data.map((s) => [
      `"${s.state}"`,
      s.orders,
      (s.grossRevenuePaise / 100).toFixed(2),
      (s.shippingRevenuePaise / 100).toFixed(2),
      (s.aovPaise / 100).toFixed(2),
      s.revenueSharePct,
    ]);
    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    return { filename: `geography-analytics-${fromTag}-${toTag}.csv`, csv };
  }

  // Default: Revenue time series
  const res = await getRevenueAnalytics(fromStr, toStr, 'day');
  const headers = ['Date', 'Gross Revenue (INR)', 'Net Revenue (INR)', 'Discounts (INR)', 'Shipping (INR)', 'Tax (INR)', 'Orders', 'Items Sold'];
  const rows = res.timeSeries.map((t) => [
    t.date,
    (t.grossRevenuePaise / 100).toFixed(2),
    (t.netRevenuePaise / 100).toFixed(2),
    (t.discountPaise / 100).toFixed(2),
    (t.shippingPaise / 100).toFixed(2),
    (t.taxPaise / 100).toFixed(2),
    t.orders,
    t.itemsSold,
  ]);
  const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  return { filename: `revenue-analytics-${fromTag}-${toTag}.csv`, csv };
}
