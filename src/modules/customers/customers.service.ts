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
import { AppError, ErrorCode, notFound } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { type AuditContext, writeAudit } from '@/modules/audit/audit.service';
import { listMeta, toSkipTake } from '@/middleware/validate';
import { toRupees } from '@/modules/products/products.serializer';
import { ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS } from '@/modules/orders/orders.serializer';
import { sendEmail } from '@/integrations/zeptomail/zeptomail.client';
import { buildCustomEmail, type CustomEmailInput } from '@/integrations/zeptomail/templates';

const log = logger.child({ module: 'customers.service' });

export interface ListParams {
  page: number;
  limit: number;
  q?: string;
  status?: CustomerStatus;
  sort?: string;
  dir?: 'asc' | 'desc';
}

/**
 * Customer list (§7.1) with lifetime totals and sorting.
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

  const rows = await prisma.customer.findMany({
    where,
    select: {
      id: true,
      email: true,
      phone: true,
      firstName: true,
      lastName: true,
      status: true,
      registeredAt: true,
      emailVerifiedAt: true,
      orders: {
        select: { totalPaise: true, paymentStatus: true },
      },
    },
  });

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
      emailVerified: Boolean(c.emailVerifiedAt),
      orders: c.orders.length,
      spentPaise,
      spent: toRupees(spentPaise),
    };
  });

  const sort = params.sort || 'spend';
  const dir = params.dir || (sort === 'name' ? 'asc' : 'desc');

  data.sort((a, b) => {
    if (sort === 'name') {
      const diff = (a.name || a.email).localeCompare(b.name || b.email, undefined, { sensitivity: 'base' });
      return dir === 'desc' ? -diff : diff;
    }
    if (sort === 'orders') {
      const diff = dir === 'asc' ? a.orders - b.orders : b.orders - a.orders;
      if (diff !== 0) return diff;
      return (a.name || a.email).localeCompare(b.name || b.email, undefined, { sensitivity: 'base' });
    }
    if (sort === 'registered') {
      const aTime = new Date(a.registeredAt).getTime();
      const bTime = new Date(b.registeredAt).getTime();
      return dir === 'asc' ? aTime - bTime : bTime - aTime;
    }
    // Default: 'spend' (Total ordered value)
    const diff = dir === 'asc' ? a.spentPaise - b.spentPaise : b.spentPaise - a.spentPaise;
    if (diff !== 0) return diff;
    return (a.name || a.email).localeCompare(b.name || b.email, undefined, { sensitivity: 'base' });
  });

  const total = data.length;
  const { skip, take } = toSkipTake(params);
  const paged = data.slice(skip, skip + take);

  return { data: paged, meta: listMeta(params.page, params.limit, total) };
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

export interface SendCustomerEmailInput {
  audience: 'all' | 'with_orders' | 'selected' | 'custom';
  customerIds?: string[];
  customEmails?: string[];
  subject: string;
  heading: string;
  message: string;
  ctaText?: string | null;
  ctaUrl?: string | null;
}

/**
 * Renders live preview of a custom or broadcast email using the official Zewa Feeds email branding.
 */
export function previewCustomerEmail(input: {
  heading: string;
  message: string;
  subject?: string;
  ctaText?: string | null;
  ctaUrl?: string | null;
  customerName?: string | null;
}) {
  return buildCustomEmail(input);
}

/**
 * Dispatches bulk common or custom emails to targeted customer groups or email addresses.
 */
export async function sendCustomerEmail(
  input: SendCustomerEmailInput,
  ctx: AuditContext,
) {
  let recipients: { email: string; name?: string }[] = [];

  if (input.audience === 'all') {
    const customers = await prisma.customer.findMany({
      where: { status: CustomerStatus.ACTIVE },
      select: { email: true, firstName: true, lastName: true },
    });
    recipients = customers.map((c) => ({
      email: c.email.trim(),
      name: `${c.firstName} ${c.lastName}`.trim(),
    }));
  } else if (input.audience === 'with_orders') {
    const customers = await prisma.customer.findMany({
      where: {
        status: CustomerStatus.ACTIVE,
        orders: { some: {} },
      },
      select: { email: true, firstName: true, lastName: true },
    });
    recipients = customers.map((c) => ({
      email: c.email.trim(),
      name: `${c.firstName} ${c.lastName}`.trim(),
    }));
  } else if (input.audience === 'selected') {
    if (!input.customerIds?.length) {
      throw new AppError(ErrorCode.BAD_REQUEST, 'No customers selected.');
    }
    const customers = await prisma.customer.findMany({
      where: {
        id: { in: input.customerIds },
      },
      select: { email: true, firstName: true, lastName: true },
    });
    recipients = customers.map((c) => ({
      email: c.email.trim(),
      name: `${c.firstName} ${c.lastName}`.trim(),
    }));
  } else if (input.audience === 'custom') {
    if (!input.customEmails?.length) {
      throw new AppError(ErrorCode.BAD_REQUEST, 'No email addresses provided.');
    }
    recipients = input.customEmails.map((e) => ({
      email: e.trim(),
    }));
  }

  const seen = new Set<string>();
  const uniqueRecipients = recipients.filter((r) => {
    const emailNorm = r.email.toLowerCase();
    if (!emailNorm || !emailNorm.includes('@') || seen.has(emailNorm)) return false;
    seen.add(emailNorm);
    return true;
  });

  if (uniqueRecipients.length === 0) {
    throw new AppError(ErrorCode.BAD_REQUEST, 'No valid recipients found.');
  }

  let sentCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const recipient of uniqueRecipients) {
    const rendered = buildCustomEmail({
      heading: input.heading,
      message: input.message,
      subject: input.subject,
      ctaText: input.ctaText,
      ctaUrl: input.ctaUrl,
      customerName: recipient.name,
    });

    try {
      const res = await sendEmail({
        to: [{ email: recipient.email, name: recipient.name }],
        subject: rendered.subject,
        htmlBody: rendered.html,
        reference: `broadcast-${input.audience}`,
      });

      if (res.sent) sentCount++;
      else if (res.skipped) skippedCount++;
      else failedCount++;
    } catch (err) {
      failedCount++;
      log.error({ err, recipient: recipient.email }, 'failed to send customer email');
    }
  }

  await writeAudit(ctx, {
    module: AuditModule.CUSTOMERS,
    action: `Broadcast email "${input.subject}" sent to ${uniqueRecipients.length} recipient(s) (audience: ${input.audience}, sent: ${sentCount}, skipped: ${skippedCount}, failed: ${failedCount})`,
    recordId: `broadcast-${Date.now()}`,
  });

  return {
    total: uniqueRecipients.length,
    sentCount,
    failedCount,
    skippedCount,
    message: `Email dispatched to ${uniqueRecipients.length} recipient${uniqueRecipients.length === 1 ? '' : 's'}.`,
  };
}

