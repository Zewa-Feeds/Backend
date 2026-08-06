/**
 * Customer management — spec §7.
 *
 * Read-mostly: staff view profiles and order history, and an Admin can ban.
 * There is no staff-facing edit of customer details — that is the customer's own
 * data, and letting staff rewrite an email would break order attribution.
 *
 * Lifetime totals (order count, spend) are AGGREGATED rather than stored, so they
 * cannot drift out of step with the orders they summarise.
 */
import { AuditModule, CustomerStatus, PaymentStatus, type Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { notFound } from '@/lib/errors';
import { type AuditContext, writeAudit } from '@/modules/audit/audit.service';
import { listMeta, toSkipTake } from '@/middleware/validate';
import { toRupees } from '@/modules/products/products.serializer';
import { ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS } from '@/modules/orders/orders.serializer';

export interface ListParams {
  page: number;
  limit: number;
  q?: string;
  status?: CustomerStatus;
}

/**
 * Customer list (§7.1) with lifetime totals.
 *
 * Only PAID orders count toward spend — an unpaid or refunded order is not
 * revenue, and showing it as lifetime value would mislead.
 */
export async function list(params: ListParams) {
  const where: Prisma.CustomerWhereInput = {
    ...(params.status ? { status: params.status } : {}),
    ...(params.q
      ? {
          OR: [
            { firstName: { contains: params.q, mode: 'insensitive' } },
            { lastName: { contains: params.q, mode: 'insensitive' } },
            { email: { contains: params.q, mode: 'insensitive' } },
            { phone: { contains: params.q } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      select: {
        id: true,
        email: true,
        phone: true,
        firstName: true,
        lastName: true,
        status: true,
        registeredAt: true,
        orders: {
          select: { totalPaise: true, paymentStatus: true },
        },
      },
      orderBy: { registeredAt: 'desc' },
      ...toSkipTake(params),
    }),
    prisma.customer.count({ where }),
  ]);

  const data = rows.map((c) => {
    const spentPaise = c.orders
      .filter((o) => o.paymentStatus === PaymentStatus.PAID)
      .reduce((sum, o) => sum + o.totalPaise, 0);

    return {
      id: c.id,
      name: `${c.firstName} ${c.lastName}`.trim(),
      email: c.email,
      phone: c.phone,
      status: c.status,
      statusLabel: c.status === CustomerStatus.BANNED ? 'Banned' : 'Active',
      registeredAt: c.registeredAt,
      orders: c.orders.length,
      spentPaise,
      spent: toRupees(spentPaise),
    };
  });

  return { data, meta: listMeta(params.page, params.limit, total) };
}

/** Full profile (§7.2) — contact details, order history, addresses, reviews. */
export async function byId(id: string) {
  const customer = await prisma.customer.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      phone: true,
      firstName: true,
      lastName: true,
      status: true,
      registeredAt: true,
      emailVerifiedAt: true,
      addresses: {
        select: {
          id: true,
          name: true,
          phone: true,
          line1: true,
          line2: true,
          city: true,
          state: true,
          pincode: true,
          isDefault: true,
        },
        orderBy: { isDefault: 'desc' },
      },
      orders: {
        select: {
          orderNo: true,
          placedAt: true,
          totalPaise: true,
          status: true,
          paymentStatus: true,
          items: { select: { qty: true } },
        },
        orderBy: { placedAt: 'desc' },
      },
      reviews: {
        select: {
          id: true,
          rating: true,
          body: true,
          state: true,
          submittedAt: true,
          family: { select: { name: true, slug: true } },
        },
        orderBy: { submittedAt: 'desc' },
      },
    },
  });
  if (!customer) throw notFound('Customer');

  const spentPaise = customer.orders
    .filter((o) => o.paymentStatus === PaymentStatus.PAID)
    .reduce((sum, o) => sum + o.totalPaise, 0);

  return {
    id: customer.id,
    name: `${customer.firstName} ${customer.lastName}`.trim(),
    firstName: customer.firstName,
    lastName: customer.lastName,
    email: customer.email,
    phone: customer.phone,
    status: customer.status,
    statusLabel: customer.status === CustomerStatus.BANNED ? 'Banned' : 'Active',
    registeredAt: customer.registeredAt,
    emailVerified: Boolean(customer.emailVerifiedAt),

    orderCount: customer.orders.length,
    spentPaise,
    spent: toRupees(spentPaise),

    addresses: customer.addresses,

    orderHistory: customer.orders.map((o) => ({
      orderNo: o.orderNo,
      placedAt: o.placedAt,
      totalPaise: o.totalPaise,
      total: toRupees(o.totalPaise),
      itemCount: o.items.reduce((sum, i) => sum + i.qty, 0),
      status: o.status,
      statusLabel: ORDER_STATUS_LABELS[o.status],
      paymentStatus: o.paymentStatus,
      paymentLabel: PAYMENT_STATUS_LABELS[o.paymentStatus],
    })),

    reviews: customer.reviews.map((r) => ({
      id: r.id,
      product: r.family.name,
      productSlug: r.family.slug,
      rating: r.rating,
      excerpt: r.body.length > 120 ? `${r.body.slice(0, 120)}…` : r.body,
      state: r.state,
      submittedAt: r.submittedAt,
    })),
  };
}

/**
 * Ban / unban (§7.2) — Admin only.
 *
 * Banning prevents login. It deliberately does NOT delete the account or its
 * orders: the order history is business record, and §17.1 wants status changes to
 * be reversible.
 */
export async function setStatus(
  id: string,
  status: CustomerStatus,
  ctx: AuditContext,
): Promise<ReturnType<typeof byId>> {
  const existing = await prisma.customer.findUnique({
    where: { id },
    select: { id: true, email: true, firstName: true, lastName: true, status: true },
  });
  if (!existing) throw notFound('Customer');

  const name = `${existing.firstName} ${existing.lastName}`.trim();

  await prisma.$transaction(async (tx) => {
    await tx.customer.update({ where: { id }, data: { status } });
    await writeAudit(
      ctx,
      {
        module: AuditModule.CUSTOMERS,
        action:
          status === CustomerStatus.BANNED
            ? `Banned customer ${name} (${existing.email})`
            : `Unbanned customer ${name} (${existing.email})`,
        recordId: id,
      },
      tx,
    );
  });

  return byId(id);
}
