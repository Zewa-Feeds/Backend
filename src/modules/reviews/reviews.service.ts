/**
 * Review moderation — spec §9.
 *
 * Every submitted review lands in PENDING and is invisible on the storefront
 * until an Ops Manager or Admin approves it. That is the whole point: the seed
 * data includes a review that is pure referral spam, and it must never
 * auto-publish.
 */
import { AuditModule, ReviewState, type Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { notFound } from '@/lib/errors';
import { type AuditContext, writeAudit } from '@/modules/audit/audit.service';
import { listMeta, toSkipTake } from '@/middleware/validate';

const REVIEW_SELECT = {
  id: true,
  rating: true,
  body: true,
  isVerifiedPurchase: true,
  state: true,
  email: true,
  guestName: true,
  submittedAt: true,
  moderatedAt: true,
  family: { select: { id: true, name: true, slug: true } },
  customer: { select: { id: true, firstName: true, lastName: true } },
  moderatedBy: { select: { name: true } },
} satisfies Prisma.ReviewSelect;

type ReviewRow = Prisma.ReviewGetPayload<{ select: typeof REVIEW_SELECT }>;

function serialize(r: ReviewRow) {
  const customerName = r.customer
    ? `${r.customer.firstName} ${r.customer.lastName}`.trim()
    : (r.guestName ?? 'Guest');

  return {
    id: r.id,
    // CMS column names.
    prod: r.family.name,
    productSlug: r.family.slug,
    familyId: r.family.id,
    cust: customerName,
    email: r.email,
    rating: r.rating,
    body: r.body,
    // §9 list shows the first 100 characters.
    excerpt: r.body.length > 100 ? `${r.body.slice(0, 100)}…` : r.body,
    vp: r.isVerifiedPurchase,
    state: r.state,
    at: r.submittedAt,
    moderatedAt: r.moderatedAt,
    moderatedBy: r.moderatedBy?.name ?? null,
  };
}

export interface ListParams {
  page: number;
  limit: number;
  q?: string;
  state?: ReviewState;
}

export async function list(params: ListParams) {
  const where: Prisma.ReviewWhereInput = {
    ...(params.state ? { state: params.state } : {}),
    ...(params.q
      ? {
          OR: [
            { body: { contains: params.q, mode: 'insensitive' } },
            { email: { contains: params.q, mode: 'insensitive' } },
            { family: { name: { contains: params.q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const [rows, total, counts] = await Promise.all([
    prisma.review.findMany({
      where,
      select: REVIEW_SELECT,
      orderBy: { submittedAt: 'desc' },
      ...toSkipTake(params),
    }),
    prisma.review.count({ where }),
    // Tab counts (§9) — always the unfiltered totals, so the badges stay stable
    // regardless of which tab is open.
    prisma.review.groupBy({ by: ['state'], _count: true }),
  ]);

  const tabCounts = {
    PENDING: 0,
    APPROVED: 0,
    REJECTED: 0,
    ...Object.fromEntries(counts.map((c) => [c.state, c._count])),
  };

  return {
    data: rows.map(serialize),
    meta: { ...listMeta(params.page, params.limit, total), counts: tabCounts },
  };
}

export async function setState(
  id: string,
  state: ReviewState,
  actorId: string,
  ctx: AuditContext,
) {
  const existing = await prisma.review.findUnique({
    where: { id },
    select: { id: true, rating: true, family: { select: { name: true } } },
  });
  if (!existing) throw notFound('Review');

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.review.update({
      where: { id },
      data: { state, moderatedById: actorId, moderatedAt: new Date() },
      select: REVIEW_SELECT,
    });
    await writeAudit(
      ctx,
      {
        module: AuditModule.REVIEWS,
        action: `${state === ReviewState.APPROVED ? 'Approved' : state === ReviewState.REJECTED ? 'Rejected' : 'Reset'} review on ${existing.family.name} — ${existing.rating}★`,
        recordId: id,
      },
      tx,
    );
    return row;
  });

  return serialize(updated);
}

/**
 * "Approve All Visible" (§9) — for batching approvals after a campaign.
 *
 * One audit entry with the count rather than N entries: the operator performed a
 * single deliberate action, and N rows would bury the rest of the log.
 */
export async function approveAllPending(
  actorId: string,
  ctx: AuditContext,
): Promise<{ approved: number }> {
  const pending = await prisma.review.findMany({
    where: { state: ReviewState.PENDING },
    select: { id: true },
  });

  if (pending.length === 0) return { approved: 0 };

  await prisma.$transaction(async (tx) => {
    await tx.review.updateMany({
      where: { state: ReviewState.PENDING },
      data: { state: ReviewState.APPROVED, moderatedById: actorId, moderatedAt: new Date() },
    });
    await writeAudit(
      ctx,
      {
        module: AuditModule.REVIEWS,
        action: `Approved all ${pending.length} pending review${pending.length === 1 ? '' : 's'}`,
        recordId: 'batch',
      },
      tx,
    );
  });

  return { approved: pending.length };
}

// ---- Public submission ------------------------------------------------------

export interface SubmitInput {
  productSlug: string;
  rating: number;
  body: string;
  email: string;
  guestName?: string;
  customerId?: string;
}

/**
 * Submit a review from the storefront. Always PENDING (§9).
 *
 * `isVerifiedPurchase` is computed server-side from delivered order history — a
 * client must never be able to claim it, since it is a trust signal on the PDP.
 */
export async function submit(input: SubmitInput) {
  const family = await prisma.productFamily.findFirst({
    where: { slug: input.productSlug, deletedAt: null },
    select: { id: true },
  });
  if (!family) throw notFound('Product');

  const purchased = await prisma.orderItem.findFirst({
    where: {
      order: { email: input.email.toLowerCase(), status: 'DELIVERED' },
      variant: { familyId: family.id },
    },
    select: { id: true },
  });

  const created = await prisma.review.create({
    data: {
      familyId: family.id,
      customerId: input.customerId ?? null,
      guestName: input.guestName ?? null,
      email: input.email.toLowerCase(),
      rating: input.rating,
      body: input.body,
      isVerifiedPurchase: Boolean(purchased),
      state: ReviewState.PENDING,
    },
    select: REVIEW_SELECT,
  });

  return serialize(created);
}
