/**
 * Dashboard (§4) and global search (§3.1).
 *
 * §4 is explicit that the dashboard is "a lightweight, read-only operational
 * snapshot — not an analytics tool", and that revenue tiles and charts were
 * REMOVED in v2.0. So this returns exactly four things: three counters and an
 * activity feed. No revenue, no charts.
 *
 * The CMS currently renders a hardcoded ACTIVITY array; this replaces it with a
 * real feed derived from the audit log and recent orders.
 */
import { AuditModule, OrderStatus, ReviewState, type Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { LOW_STOCK_THRESHOLD } from '@/modules/products/products.serializer';
import { toRupees } from '@/modules/products/products.serializer';
import { ROLE_LABELS, type Permission, can } from '@/rbac/permissions';
import type { Role } from '@prisma/client';

export interface DashboardCounters {
  pendingOrders: number;
  lowStockProducts: number;
  pendingReviews: number;
  orderCounts?: {
    all: number;
    pending: number;
    processing: number;
    shipped: number;
    delivered: number;
    cancelled: number;
  };
}

export interface ActivityEntry {
  kind: 'order' | 'review' | 'stock' | 'content' | 'audit';
  text: string;
  actor: string;
  at: Date;
  /** Where the CMS's "View" link should go. */
  href: string | null;
  /** Accent colour, matching the CMS's activity feed dots. */
  tone: 'green' | 'amber' | 'red' | 'blue' | 'teal' | 'grey';
}

/**
 * The three counters (§4). Each is clickable in the CMS and deep-links to a
 * filtered list, so the numbers must match those filters exactly.
 */
export async function counters(role: Role): Promise<DashboardCounters> {
  // A Content Editor cannot see orders or reviews (§2.1), so those counters are
  // returned as 0 rather than leaking operational volume they have no access to.
  const canSeeOrders = can(role, 'orders.view');
  const canSeeReviews = can(role, 'reviews.moderate');

  const [orderGroups, lowStockProducts, pendingReviews] = await Promise.all([
    canSeeOrders
      ? prisma.order.groupBy({
          by: ['status'],
          _count: { id: true },
        })
      : [],
    countLowStockFamilies(),
    canSeeReviews ? prisma.review.count({ where: { state: ReviewState.PENDING } }) : 0,
  ]);

  const orderCounts = {
    all: 0,
    pending: 0,
    processing: 0,
    shipped: 0,
    delivered: 0,
    cancelled: 0,
  };

  for (const g of orderGroups) {
    const count = g._count.id;
    orderCounts.all += count;
    if (g.status === OrderStatus.PENDING) orderCounts.pending = count;
    else if (g.status === OrderStatus.PROCESSING) orderCounts.processing = count;
    else if (g.status === OrderStatus.SHIPPED) orderCounts.shipped = count;
    else if (g.status === OrderStatus.DELIVERED) orderCounts.delivered = count;
    else if (g.status === OrderStatus.CANCELLED) orderCounts.cancelled = count;
  }

  return {
    pendingOrders: orderCounts.pending,
    lowStockProducts,
    pendingReviews,
    orderCounts,
  };
}

/**
 * Families whose summed variant stock is below the low-stock threshold.
 *
 * Raw SQL because this needs a GROUP BY / HAVING over a join, which Prisma's
 * query API cannot express. Parameterised — the threshold is the only input and
 * it is a number from our own constant, never user data.
 */
async function countLowStockFamilies(): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM (
      SELECT f.id
      FROM "ProductFamily" f
      LEFT JOIN "ProductVariant" v ON v."familyId" = f.id AND v."isActive" = true
      WHERE f."deletedAt" IS NULL
        AND f.status IN ('ACTIVE', 'COMING_SOON')
      GROUP BY f.id
      HAVING COALESCE(SUM(v.stock), 0) < ${LOW_STOCK_THRESHOLD}
    ) AS low
  `;
  return Number(rows[0]?.count ?? 0);
}

/**
 * Recent activity feed (§4) — last 20 events.
 *
 * Merges two sources: the audit log (what staff did) and recent orders (what
 * customers did, which has no audit entry because no staff member acted).
 * Row-level filtering applies — an Editor sees only content events.
 */
export async function activity(role: Role, limit = 20): Promise<ActivityEntry[]> {
  const canSeeOrders = can(role, 'orders.view');

  const visibleModules: AuditModule[] = [AuditModule.CONTENT, AuditModule.PRODUCTS];
  if (canSeeOrders) {
    visibleModules.push(AuditModule.ORDERS, AuditModule.REVIEWS, AuditModule.COUPONS);
  }
  if (can(role, 'audit.all')) {
    visibleModules.push(AuditModule.USERS, AuditModule.SETTINGS, AuditModule.CUSTOMERS);
  }

  const [auditRows, orderRows] = await Promise.all([
    prisma.auditLog.findMany({
      where: { module: { in: visibleModules } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        module: true,
        action: true,
        recordId: true,
        actorName: true,
        createdAt: true,
      },
    }),
    canSeeOrders
      ? prisma.order.findMany({
          orderBy: { placedAt: 'desc' },
          take: 10,
          select: {
            orderNo: true,
            placedAt: true,
            totalPaise: true,
            email: true,
            customer: { select: { firstName: true, lastName: true } },
          },
        })
      : [],
  ]);

  const entries: ActivityEntry[] = [
    ...orderRows.map((o): ActivityEntry => ({
      kind: 'order',
      text: `New order ${o.orderNo} placed — ₹${toRupees(o.totalPaise).toLocaleString('en-IN')}`,
      actor: o.customer ? `${o.customer.firstName} ${o.customer.lastName}`.trim() : o.email,
      at: o.placedAt,
      href: `/orders/${o.orderNo}`,
      tone: 'green',
    })),
    ...auditRows.map((a): ActivityEntry => ({
      kind: auditKind(a.module),
      text: a.action,
      actor: a.actorName,
      at: a.createdAt,
      href: auditHref(a.module, a.recordId),
      tone: auditTone(a.module, a.action),
    })),
  ];

  return entries.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}

const auditKind = (module: AuditModule): ActivityEntry['kind'] => {
  if (module === AuditModule.ORDERS) return 'order';
  if (module === AuditModule.REVIEWS) return 'review';
  if (module === AuditModule.PRODUCTS) return 'stock';
  if (module === AuditModule.CONTENT) return 'content';
  return 'audit';
};

/** §17.2 colour coding. */
function auditTone(module: AuditModule, action: string): ActivityEntry['tone'] {
  if (/cancelled|deleted|rejected|banned|refund/i.test(action)) return 'red';
  if (/stock/i.test(action)) return 'amber';
  if (module === AuditModule.CONTENT) return 'teal';
  if (module === AuditModule.ORDERS) return 'blue';
  if (module === AuditModule.REVIEWS) return 'amber';
  return 'grey';
}

/** Deep link to the affected record, so "View" works. */
function auditHref(module: AuditModule, recordId: string | null): string | null {
  if (!recordId) return null;
  switch (module) {
    case AuditModule.ORDERS:
      return `/orders/${recordId}`;
    case AuditModule.PRODUCTS:
      // Product audit entries carry either a slug or a SKU; only slugs deep-link.
      return recordId.includes('-') && recordId === recordId.toLowerCase()
        ? `/products/${recordId}/edit`
        : '/products';
    case AuditModule.CONTENT:
      return recordId === 'homepage' ? '/content/homepage' : `/content/articles`;
    case AuditModule.REVIEWS:
      return '/reviews';
    case AuditModule.COUPONS:
      return '/coupons';
    case AuditModule.CUSTOMERS:
      return `/customers/${recordId}`;
    case AuditModule.USERS:
      return '/users';
    default:
      return null;
  }
}

// ============================================================================
// GLOBAL SEARCH (§3.1)
// ============================================================================

export interface SearchResults {
  orders: { orderNo: string; customerName: string; total: number; status: string }[];
  customers: { id: string; name: string; email: string }[];
  products: { slug: string; name: string; sku: string | null }[];
}

/**
 * Search orders, customers and products at once (§3.1 topbar search).
 *
 * Each section is gated on the role's permissions — an Editor searching gets
 * products only, never customer PII or order numbers.
 */
export async function search(query: string, role: Role): Promise<SearchResults> {
  const q = query.trim();
  if (q.length < 2) return { orders: [], customers: [], products: [] };

  const gate = (permission: Permission) => can(role, permission);

  const [orders, customers, products] = await Promise.all([
    gate('orders.view')
      ? prisma.order.findMany({
          where: {
            OR: [
              { orderNo: { contains: q, mode: 'insensitive' } },
              { email: { contains: q, mode: 'insensitive' } },
            ],
          },
          take: 5,
          orderBy: { placedAt: 'desc' },
          select: {
            orderNo: true,
            totalPaise: true,
            status: true,
            email: true,
            customer: { select: { firstName: true, lastName: true } },
          },
        })
      : [],

    gate('customers.view')
      ? prisma.customer.findMany({
          where: {
            OR: [
              { firstName: { contains: q, mode: 'insensitive' } },
              { lastName: { contains: q, mode: 'insensitive' } },
              { email: { contains: q, mode: 'insensitive' } },
            ],
          },
          take: 5,
          select: { id: true, firstName: true, lastName: true, email: true },
        })
      : [],

    gate('products.view')
      ? prisma.productFamily.findMany({
          where: {
            deletedAt: null,
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { variants: { some: { sku: { contains: q.toUpperCase() } } } },
            ],
          },
          take: 5,
          select: {
            slug: true,
            name: true,
            variants: { select: { sku: true }, take: 1 },
          },
        })
      : [],
  ]);

  return {
    orders: orders.map((o) => ({
      orderNo: o.orderNo,
      customerName: o.customer ? `${o.customer.firstName} ${o.customer.lastName}`.trim() : o.email,
      total: toRupees(o.totalPaise),
      status: o.status,
    })),
    customers: customers.map((c) => ({
      id: c.id,
      name: `${c.firstName} ${c.lastName}`.trim(),
      email: c.email,
    })),
    products: products.map((p) => ({
      slug: p.slug,
      name: p.name,
      sku: p.variants[0]?.sku ?? null,
    })),
  };
}

// ============================================================================
// AUDIT LOG (§12)
// ============================================================================

export interface AuditListParams {
  page: number;
  limit: number;
  q?: string;
  module?: AuditModule;
  actorId?: string;
  from?: Date;
  to?: Date;
}

/**
 * Audit log listing (§12.2).
 *
 * The row-level rule matters: an Ops Manager holds `audit.own` and must see ONLY
 * their own entries. That is forced here from the authenticated identity — the
 * `actorId` filter param is ignored for such users, so they cannot widen their own
 * view by passing someone else's id.
 */
export async function listAudit(params: AuditListParams, role: Role, selfId: string) {
  const seesAll = can(role, 'audit.all');

  const where: Prisma.AuditLogWhereInput = {
    // Forced, not merged — this is the whole point.
    ...(seesAll ? (params.actorId ? { actorId: params.actorId } : {}) : { actorId: selfId }),
    ...(params.module ? { module: params.module } : {}),
    ...(params.from || params.to
      ? {
          createdAt: {
            ...(params.from ? { gte: params.from } : {}),
            ...(params.to ? { lte: params.to } : {}),
          },
        }
      : {}),
    ...(params.q
      ? {
          OR: [
            { action: { contains: params.q, mode: 'insensitive' } },
            { recordId: { contains: params.q, mode: 'insensitive' } },
            { actorName: { contains: params.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.limit,
      take: params.limit,
      select: {
        id: true,
        actorName: true,
        actorRole: true,
        module: true,
        action: true,
        recordId: true,
        diff: true,
        ip: true,
        createdAt: true,
      },
    }),
    prisma.auditLog.count({ where }),
  ]);

  return {
    data: rows.map((r) => ({
      // BigInt is not JSON-serialisable.
      id: String(r.id),
      ts: r.createdAt,
      user: r.actorName,
      role: r.actorRole,
      mod: r.module,
      act: r.action,
      rec: r.recordId,
      diff: r.diff,
      ip: r.ip,
    })),
    meta: {
      page: params.page,
      limit: params.limit,
      total,
      pages: Math.max(1, Math.ceil(total / params.limit)),
      scope: seesAll ? 'all' : 'own',
    },
  };
}

/** Distinct actors, for the §12.2 user filter. Admin only. */
export async function auditActors() {
  const users = await prisma.cmsUser.findMany({
    select: { id: true, name: true, role: true },
    orderBy: { name: 'asc' },
  });
  return users.map((u) => ({ id: u.id, name: u.name, role: ROLE_LABELS[u.role] }));
}
