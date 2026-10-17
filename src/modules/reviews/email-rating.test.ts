/**
 * Star ratings from the Seeds-earned email (reviews.service rateFromEmail).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db, queueAdd } = vi.hoisted(() => ({
  db: {
    order: { findUnique: vi.fn() },
    productFamily: { findFirst: vi.fn() },
    review: { findUnique: vi.fn(), upsert: vi.fn() },
    orderItem: { findMany: vi.fn() },
  },
  queueAdd: vi.fn(),
}));
vi.mock('@/lib/prisma', () => ({ prisma: db }));
vi.mock('@/jobs/queues', () => ({ emailQueue: { add: (...a: unknown[]) => queueAdd(...a) } }));
vi.mock('@/lib/logger', () => {
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return { logger: { ...log, child: () => log } };
});
vi.mock('@/config/env', () => ({
  env: {
    STOREFRONT_ORIGIN: 'https://zewafeeds.com',
    JWT_ACCESS_SECRET: 'a'.repeat(40),
    JWT_REFRESH_SECRET: 'r'.repeat(40),
    JWT_PREVIEW_SECRET: 'p'.repeat(40),
    ACCESS_TOKEN_TTL: '15m',
    PREVIEW_TOKEN_TTL: '15m',
    REFRESH_TOKEN_TTL: '30d',
  },
}));

import { signPreviewToken, signReviewToken } from '@/lib/tokens';
import { rateFromEmail, reviewLinksForOrder } from './reviews.service';

const ORDER = {
  id: 'ord-1',
  orderNo: '27ZFO132',
  email: 'Nik@Example.com',
  status: 'DELIVERED',
  customerId: 'cust-1',
  shippingAddress: { name: 'Nik Mulakkal' },
  customer: { firstName: 'Nik' },
  items: [{ variant: { familyId: 'fam-1' } }],
};
const FAMILY = { id: 'fam-1', name: 'Betta Bites', slug: 'betta-bites', media: [{ url: 'https://img/1.jpg' }] };
const token = () => signReviewToken({ sub: 'ord-1', fam: 'fam-1' });

beforeEach(() => {
  vi.clearAllMocks();
  queueAdd.mockResolvedValue({});
  db.order.findUnique.mockResolvedValue(ORDER);
  db.productFamily.findFirst.mockResolvedValue(FAMILY);
  db.review.findUnique.mockResolvedValue(null);
  db.review.upsert.mockImplementation(async ({ create }) => ({ id: 'rev-1', rating: create.rating, body: create.body }));
});

describe('rateFromEmail', () => {
  it('records a star-only rating as a pending, verified review tied to the order', async () => {
    const out = await rateFromEmail({ token: token(), rating: 5 });

    const call = db.review.upsert.mock.calls[0]![0];
    expect(call.where).toEqual({ orderId_familyId: { orderId: 'ord-1', familyId: 'fam-1' } });
    expect(call.create).toMatchObject({
      rating: 5,
      body: '',
      orderId: 'ord-1',
      customerId: 'cust-1',
      email: 'nik@example.com',
      isVerifiedPurchase: true,
      state: 'PENDING',
    });
    expect(out).toMatchObject({ productName: 'Betta Bites', productSlug: 'betta-bites', rating: 5, firstName: 'Nik' });
  });

  it('alerts staff on a new rating, but not on a repeat click of the same star', async () => {
    await rateFromEmail({ token: token(), rating: 5 });
    expect(queueAdd).toHaveBeenCalledTimes(1);
    expect(queueAdd.mock.calls[0]![1]).toMatchObject({
      template: 'staff-new-review',
      context: { rating: 5, source: 'email', orderNo: '27ZFO132', productName: 'Betta Bites' },
    });

    queueAdd.mockClear();
    db.review.findUnique.mockResolvedValue({ rating: 5, body: '' });
    db.review.upsert.mockResolvedValue({ id: 'rev-1', rating: 5, body: '' });
    await rateFromEmail({ token: token(), rating: 5 });
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('keeps the note when only the star changes, and re-queues moderation', async () => {
    db.review.findUnique.mockResolvedValue({ rating: 5, body: 'Great pellets' });
    db.review.upsert.mockResolvedValue({ id: 'rev-1', rating: 4, body: 'Great pellets' });
    await rateFromEmail({ token: token(), rating: 4 });

    const call = db.review.upsert.mock.calls[0]![0];
    expect(call.update).toMatchObject({ rating: 4, body: 'Great pellets', state: 'PENDING', moderatedAt: null });
    expect(queueAdd).toHaveBeenCalledTimes(1);
  });

  it('refuses an order that is no longer delivered', async () => {
    db.order.findUnique.mockResolvedValue({ ...ORDER, status: 'CANCELLED' });
    await expect(rateFromEmail({ token: token(), rating: 5 })).rejects.toMatchObject({ status: 409 });
    expect(db.review.upsert).not.toHaveBeenCalled();
  });

  it('refuses a product that is not on the order', async () => {
    await expect(
      rateFromEmail({ token: signReviewToken({ sub: 'ord-1', fam: 'fam-OTHER' }), rating: 5 }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a token of another type, even one signed with the same secret', async () => {
    const preview = signPreviewToken({ sub: 'ord-1', kind: 'product', slug: 'betta-bites' });
    await expect(rateFromEmail({ token: preview, rating: 5 })).rejects.toMatchObject({ status: 401 });
    await expect(rateFromEmail({ token: 'garbage.token.here', rating: 5 })).rejects.toMatchObject({ status: 401 });
  });
});

describe('reviewLinksForOrder', () => {
  it('gives each product on the order five links to the storefront, once per product', async () => {
    db.orderItem.findMany.mockResolvedValue([
      { variant: { family: { id: 'fam-1', name: 'Betta Bites' } } },
      { variant: { family: { id: 'fam-1', name: 'Betta Bites' } } },
      { variant: null },
      { variant: { family: { id: 'fam-2', name: 'Guppy Bites' } } },
    ]);
    const links = await reviewLinksForOrder('ord-1');

    expect(links.map((l) => l.name)).toEqual(['Betta Bites', 'Guppy Bites']);
    expect(links[0]!.starUrls).toHaveLength(5);
    expect(links[0]!.starUrls[4]).toMatch(/^https:\/\/zewafeeds\.com\/review\?t=.+&r=5$/);
  });
});
