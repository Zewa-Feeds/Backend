/**
 * A partial PATCH must not erase a coupon's targeting — against a real database.
 *
 * `update` replaces the four targeting relations by deleting and recreating
 * them. `buildTargeting` maps an absent list to `[]`, so replacing them all on
 * every call would wipe qualifying products, categories and the customer list
 * whenever the body did not resend them. That was harmless while the route
 * validated against the CREATE schema (which always filled the arrays) and
 * became a data-loss bug the moment PATCH accepted partial bodies.
 *
 * This is deliberately a database test, not a mock: what is under test is the
 * rows that survive the transaction.
 */
import type { Category } from '@prisma/client';
import type * as AuditService from '@/modules/audit/audit.service';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { update } from './coupons.service';

vi.mock('@/modules/audit/audit.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AuditService>()),
  writeAudit: vi.fn(),
}));

const CTX = { actorId: null, actorName: 'test', ip: '::1' } as never;
const CODE = `ZZPATCH${Date.now().toString().slice(-6)}`;

let couponId: string;
let categoryOfInterest: Category;

beforeAll(async () => {
  // A category that exists in this schema, whatever the enum happens to hold.
  const anyVariant = await prisma.productFamily.findFirst({ select: { category: true } });
  categoryOfInterest = anyVariant!.category;

  const created = await prisma.coupon.create({
    data: {
      code: CODE,
      discountType: 'PERCENTAGE',
      discountValue: 10,
      minOrderPaise: 0,
      startsAt: new Date(Date.now() - 86_400_000),
      endsAt: new Date(Date.now() + 86_400_000),
      perCustomerLimit: 3,
      isActive: true,
      categories: { create: [{ category: categoryOfInterest, role: 'DISCOUNT' }] },
      customers: { create: [{ email: 'keep-me@example.com' }] },
    },
    select: { id: true },
  });
  couponId = created.id;
});

afterAll(async () => {
  await prisma.coupon.deleteMany({ where: { code: CODE } });
  await prisma.$disconnect();
});

describe('partial coupon update', () => {
  it('keeps targeting when the body does not mention it', async () => {
    // The exact body the CMS active-toggle sends.
    await update(couponId, { isActive: false } as never, CTX);

    const after = await prisma.coupon.findUnique({
      where: { id: couponId },
      select: {
        isActive: true,
        perCustomerLimit: true,
        categories: { select: { category: true } },
        customers: { select: { email: true } },
      },
    });

    expect(after!.isActive).toBe(false);
    // The point of the test: these are untouched, not wiped.
    expect(after!.categories).toHaveLength(1);
    expect(after!.customers.map((c) => c.email)).toEqual(['keep-me@example.com']);
    // And the limit did not revert to the column default of 1.
    expect(after!.perCustomerLimit).toBe(3);
  });

  it('still replaces targeting when the body does send it', async () => {
    await update(couponId, { customerEmails: ['new@example.com'] } as never, CTX);

    const after = await prisma.coupon.findUnique({
      where: { id: couponId },
      select: {
        categories: { select: { category: true } },
        customers: { select: { email: true } },
      },
    });

    expect(after!.customers.map((c) => c.email)).toEqual(['new@example.com']);
    // A relation the body still did not mention stays as it was.
    expect(after!.categories).toHaveLength(1);
  });
});
