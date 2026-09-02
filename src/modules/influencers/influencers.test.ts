/**
 * Influencer affiliates — the rules that decide money and attribution.
 *
 * Pure unit tests over mocked Prisma: what is worth pinning here is the
 * VALIDATION and the SNAPSHOT, not that Prisma can write a row. The discount
 * itself is the existing coupon engine's job and is covered by its own suites —
 * an affiliate code is an ordinary coupon, which is the whole design.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const couponFindUnique = vi.fn();
const couponFindMany = vi.fn();
const couponCreate = vi.fn();
const couponUpdate = vi.fn();
const couponUpdateMany = vi.fn();
const influencerCreate = vi.fn();
const influencerFindUnique = vi.fn();
const influencerUpdate = vi.fn();
const auditCreate = vi.fn();

const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
  fn({
    coupon: {
      create: (...a: unknown[]) => couponCreate(...a),
      update: (...a: unknown[]) => couponUpdate(...a),
      updateMany: (...a: unknown[]) => couponUpdateMany(...a),
    },
    influencer: {
      create: (...a: unknown[]) => influencerCreate(...a),
      update: (...a: unknown[]) => influencerUpdate(...a),
    },
  }),
);

vi.mock('@/lib/prisma', () => ({
  prisma: {
    coupon: {
      findUnique: (...a: unknown[]) => couponFindUnique(...a),
      findMany: (...a: unknown[]) => couponFindMany(...a),
      create: (...a: unknown[]) => couponCreate(...a),
      update: (...a: unknown[]) => couponUpdate(...a),
      updateMany: (...a: unknown[]) => couponUpdateMany(...a),
    },
    influencer: {
      create: (...a: unknown[]) => influencerCreate(...a),
      findUnique: (...a: unknown[]) => influencerFindUnique(...a),
      update: (...a: unknown[]) => influencerUpdate(...a),
    },
    auditLog: { create: (...a: unknown[]) => auditCreate(...a) },
    $transaction: (fn: never) => transaction(fn),
  },
}));

vi.mock('@/modules/audit/audit.service', () => ({
  writeAudit: vi.fn().mockResolvedValue(undefined),
  buildDiff: vi.fn(() => ({})),
  auditContext: vi.fn(),
}));

import * as service from './influencers.service';
import { resolveAttribution } from '@/modules/checkout/attribution';

const ctx = { ip: '::1', userAgent: 't', actorId: 'u1', actorName: 'A', actorRole: 'Admin' } as never;

const profile = (over: Record<string, unknown> = {}) => ({
  id: 'inf-1', name: 'Rahul', email: null, phone: null, socialHandle: null, notes: null,
  status: 'ACTIVE', deactivatedAt: null, createdAt: new Date(), updatedAt: new Date(),
  coupons: [{
    id: 'cpn-1', code: 'RAHUL15', discountType: 'PERCENTAGE', discountValue: 15,
    isActive: true, startsAt: new Date(), endsAt: new Date(Date.now() + 8.64e7),
    minOrderPaise: 0, stackingMode: 'NON_STACKABLE', usedCount: 0,
  }],
  ...over,
});

const validInput = {
  name: 'Rahul',
  couponCode: 'rahul15',
  discountPct: 15,
  startsAt: new Date(),
  endsAt: new Date(Date.now() + 30 * 8.64e7),
};

beforeEach(() => {
  vi.clearAllMocks();
  couponFindUnique.mockResolvedValue(null);
  influencerCreate.mockResolvedValue({ id: 'inf-1' });
  couponCreate.mockResolvedValue({ id: 'cpn-1' });
  influencerFindUnique.mockResolvedValue(profile());
});

describe('creating an affiliate', () => {
  it('stores the code upper-cased, so RAHUL15 and rahul15 are one coupon', async () => {
    await service.create(validInput, ctx);
    expect(couponCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ code: 'RAHUL15' }) }),
    );
  });

  it('makes the coupon NON_STACKABLE — one percentage discount per order', async () => {
    await service.create(validInput, ctx);
    expect(couponCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stackingMode: 'NON_STACKABLE',
          discountType: 'PERCENTAGE',
          discountValue: 15,
          trigger: 'CODE',
        }),
      }),
    );
  });

  it('lets many customers use the code, and one customer use it twice', async () => {
    /*
     * Regression: this was created with perCustomerLimit 0, meaning "unlimited".
     * The engine refuses when priorRedemptions >= perCustomerLimit, so 0 refused
     * EVERY use — the first real order with an affiliate code failed with
     * "You have already used ORDERE2E14 0 times."
     */
    await service.create(validInput, ctx);
    const data = couponCreate.mock.calls[0]![0].data;
    expect(data.perCustomerLimit).toBeGreaterThan(1);
    expect(data.totalUsageLimit ?? null).toBeNull(); // no cap on total uses
  });

  it('never publishes a personal code on the storefront', async () => {
    await service.create(validInput, ctx);
    expect(couponCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ showAtCheckout: false }) }),
    );
  });

  it('rejects a duplicate code regardless of case', async () => {
    couponFindUnique.mockResolvedValue({ id: 'other-coupon' });
    await expect(service.create({ ...validInput, couponCode: 'RaHuL15' }, ctx)).rejects.toThrow(
      /already in use/i,
    );
    expect(influencerCreate).not.toHaveBeenCalled();
  });

  it('refuses a percentage outside the safe range', async () => {
    for (const pct of [0, -5, 91, 900]) {
      await expect(service.create({ ...validInput, discountPct: pct }, ctx)).rejects.toThrow(
        /between/i,
      );
    }
  });

  it('refuses a fractional percentage', async () => {
    await expect(service.create({ ...validInput, discountPct: 12.5 }, ctx)).rejects.toThrow();
  });
});

describe('deactivating an affiliate', () => {
  it('disables their coupons but deletes nothing', async () => {
    await service.setStatus('inf-1', 'INACTIVE' as never, ctx);
    expect(influencerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'INACTIVE', deactivatedAt: expect.any(Date) }),
      }),
    );
    expect(couponUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { isActive: false } }),
    );
  });

  it('re-enables them on reactivation and clears the timestamp', async () => {
    await service.setStatus('inf-1', 'ACTIVE' as never, ctx);
    expect(influencerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deactivatedAt: null }) }),
    );
    expect(couponUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { isActive: true } }),
    );
  });
});

describe('the order attribution snapshot', () => {
  const applied = (over: Record<string, unknown> = {}) => [
    {
      couponId: 'cpn-1', code: 'RAHUL15', name: null, discountType: 'PERCENTAGE',
      discountPaise: 21450, discountLabel: '15% off', stackingMode: 'NON_STACKABLE',
      trigger: 'CODE', automatic: false, appliedTo: [], freeShipping: false, ...over,
    },
  ] as never;

  it('takes the discount from the ENGINE, never from the request', async () => {
    couponFindMany.mockResolvedValue([{
      id: 'cpn-1', code: 'RAHUL15', discountType: 'PERCENTAGE', discountValue: 15,
      influencerId: 'inf-1', influencer: { id: 'inf-1', name: 'Rahul' },
    }]);
    const snap = await resolveAttribution(applied());
    expect(snap).toMatchObject({
      influencerId: 'inf-1',
      influencerName: 'Rahul',
      influencerCouponCode: 'RAHUL15',
      influencerDiscountPct: 15,
      influencerDiscountPaise: 21450, // the priced figure, not a client value
    });
  });

  it('is null when no applied coupon belongs to an affiliate', async () => {
    couponFindMany.mockResolvedValue([]);
    expect(await resolveAttribution(applied({ code: 'SPECIAL10' }))).toBeNull();
  });

  it('is null for an order with no coupons at all', async () => {
    expect(await resolveAttribution([])).toBeNull();
  });

  it('records no percentage for a flat-value affiliate coupon', async () => {
    couponFindMany.mockResolvedValue([{
      id: 'cpn-1', code: 'RAHULFLAT', discountType: 'FLAT', discountValue: 20000,
      influencerId: 'inf-1', influencer: { id: 'inf-1', name: 'Rahul' },
    }]);
    const snap = await resolveAttribution(applied({ discountType: 'FLAT', discountPaise: 20000 }));
    expect(snap?.influencerDiscountPct).toBeNull();
    expect(snap?.influencerDiscountPaise).toBe(20000);
  });
});
