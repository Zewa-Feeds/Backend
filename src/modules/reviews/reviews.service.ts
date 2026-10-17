/**
 * Review moderation — spec §9.
 *
 * Every submitted review lands in PENDING and is invisible on the storefront
 * until an Ops Manager or Admin approves it. That is the whole point: the seed
 * data includes a review that is pure referral spam, and it must never
 * auto-publish.
 */
import { createHash } from 'node:crypto';
import { AuditModule, OrderStatus, ReviewState, type Prisma } from '@prisma/client';
import { env } from '@/config/env';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { AppError, ErrorCode, notFound } from '@/lib/errors';
import { signReviewToken, verifyReviewToken } from '@/lib/tokens';
import { emailQueue } from '@/jobs/queues';
import { type AuditContext, writeAudit } from '@/modules/audit/audit.service';
import { listMeta, toSkipTake } from '@/middleware/validate';

const log = logger.child({ module: 'reviews' });

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

  await alertStaff(created.id, created.family.name, created.rating, created.body, 'form');
  return serialize(created);
}

// ---- Email star links ---------------------------------------------------------
//
// The Seeds-earned email (sent on delivery) carries five star links per product.
// Each points at the storefront's /review page, which records the rating from
// the browser — NOT from the link itself, because mail security scanners fetch
// every link in a message and would otherwise cast five ratings per email.

export interface ReviewLinkProduct {
  name: string;
  /** Five URLs, for 1★ through 5★. */
  starUrls: string[];
}

/**
 * One entry per product family on the order, in order-line order.
 *
 * Lines whose SKU was later deleted have no family to review and are skipped.
 */
export async function reviewLinksForOrder(orderId: string): Promise<ReviewLinkProduct[]> {
  const items = await prisma.orderItem.findMany({
    where: { orderId },
    orderBy: { id: 'asc' },
    select: { variant: { select: { family: { select: { id: true, name: true } } } } },
  });

  const seen = new Set<string>();
  const base = `${env.STOREFRONT_ORIGIN.replace(/\/$/, '')}/review`;
  const products: ReviewLinkProduct[] = [];
  for (const item of items) {
    const family = item.variant?.family;
    if (!family || seen.has(family.id)) continue;
    seen.add(family.id);
    const t = signReviewToken({ sub: orderId, fam: family.id });
    products.push({
      name: family.name,
      starUrls: [1, 2, 3, 4, 5].map((n) => `${base}?t=${encodeURIComponent(t)}&r=${n}`),
    });
  }
  return products;
}

/** What the /review page needs to show, before or after a rating is recorded. */
export interface EmailReviewView {
  productName: string;
  productSlug: string;
  imageUrl: string | null;
  orderNo: string;
  firstName: string;
  rating: number | null;
  body: string;
}

async function resolveLink(token: string) {
  const claims = verifyReviewToken(token);
  const order = await prisma.order.findUnique({
    where: { id: claims.sub },
    select: {
      id: true,
      orderNo: true,
      email: true,
      status: true,
      customerId: true,
      shippingAddress: true,
      customer: { select: { firstName: true } },
      items: { select: { variant: { select: { familyId: true } } } },
    },
  });
  const onOrder = order?.items.some((i) => i.variant?.familyId === claims.fam);
  if (!order || !onOrder) throw notFound('Review link');
  /*
   * Delivered orders only. The email is sent on delivery, but an order can be
   * cancelled or returned afterwards — and an unexpected status here would mean
   * reviewing something the customer never kept.
   */
  if (order.status !== OrderStatus.DELIVERED) {
    throw new AppError(409, ErrorCode.CONFLICT, 'This order can no longer be reviewed.');
  }

  const family = await prisma.productFamily.findFirst({
    where: { id: claims.fam, deletedAt: null },
    select: {
      id: true,
      name: true,
      slug: true,
      media: { where: { type: 'IMAGE' }, orderBy: { position: 'asc' }, take: 1, select: { url: true } },
    },
  });
  if (!family) throw notFound('Product');

  const shipName = ((order.shippingAddress as { name?: string } | null)?.name ?? '').trim();
  const firstName = order.customer?.firstName || shipName.split(/\s+/)[0] || 'there';
  return { order, family, firstName };
}

function view(
  link: Awaited<ReturnType<typeof resolveLink>>,
  review: { rating: number; body: string } | null,
): EmailReviewView {
  return {
    productName: link.family.name,
    productSlug: link.family.slug,
    imageUrl: link.family.media[0]?.url ?? null,
    orderNo: link.order.orderNo,
    firstName: link.firstName,
    rating: review?.rating ?? null,
    body: review?.body ?? '',
  };
}

/** Read-only: what this link is for, and any rating already left through it. */
export async function getEmailReview(token: string): Promise<EmailReviewView> {
  const link = await resolveLink(token);
  const existing = await prisma.review.findUnique({
    where: { orderId_familyId: { orderId: link.order.id, familyId: link.family.id } },
    select: { rating: true, body: true },
  });
  return view(link, existing);
}

/**
 * Record (or change) the rating from an email link, optionally with a note.
 *
 * One row per product per order. Any change sends the review back to PENDING:
 * an approved 5★ that becomes a 1★ with new text is a different review, and the
 * moderation rule (§9) is that nothing reaches the PDP unchecked.
 *
 * A verified purchase by construction — the token names a delivered order that
 * contains this product.
 */
export async function rateFromEmail(input: {
  token: string;
  rating: number;
  body?: string;
}): Promise<EmailReviewView> {
  const link = await resolveLink(input.token);
  const where = { orderId_familyId: { orderId: link.order.id, familyId: link.family.id } };
  const before = await prisma.review.findUnique({ where, select: { rating: true, body: true } });
  const body = input.body ?? before?.body ?? '';

  const saved = await prisma.review.upsert({
    where,
    create: {
      familyId: link.family.id,
      orderId: link.order.id,
      customerId: link.order.customerId,
      guestName: link.order.customerId ? null : link.firstName,
      email: link.order.email.toLowerCase(),
      rating: input.rating,
      body,
      isVerifiedPurchase: true,
      state: ReviewState.PENDING,
    },
    update: {
      rating: input.rating,
      body,
      state: ReviewState.PENDING,
      moderatedAt: null,
      moderatedById: null,
    },
    select: { id: true, rating: true, body: true },
  });

  // Alert on a new rating, a changed rating or a new note — not on a repeat
  // click of the same star, which a reloaded page produces.
  const changed = !before || before.rating !== saved.rating || before.body !== saved.body;
  if (changed) {
    await alertStaff(saved.id, link.family.name, saved.rating, saved.body, 'email', link.order.orderNo);
  }
  return view(link, saved);
}

/**
 * Tell staff a review is waiting. Queued, never awaited past the enqueue, and
 * never fatal: a customer's rating must not fail because an alert could not be
 * queued.
 */
async function alertStaff(
  reviewId: string,
  productName: string,
  rating: number,
  body: string,
  source: 'form' | 'email',
  orderNo?: string,
): Promise<void> {
  const excerpt = body.length > 200 ? `${body.slice(0, 200)}…` : body;
  const version = `${rating}-${createHash('sha1').update(body).digest('hex').slice(0, 10)}`;
  try {
    await emailQueue.add(
      'staff-new-review',
      {
        kind: 'staff',
        template: 'staff-new-review',
        context: { reviewId, version, productName, rating, excerpt, source, orderNo: orderNo ?? null },
      },
      // Unique per version of the review, so a changed rating alerts again but a
      // retried job does not.
      { jobId: `staff-review-${reviewId}-${version}` },
    );
  } catch (err) {
    log.error({ err, reviewId }, 'failed to queue staff review alert');
  }
}
