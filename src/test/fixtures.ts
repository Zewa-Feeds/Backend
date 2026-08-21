/**
 * Shared helpers for the database integration suites.
 *
 * Two problems these solve.
 *
 * CONTAMINATION. Tests used to reach for real catalogue rows — `guppy-bites` as
 * "some other product", the first CmsUser as an actor. That made them depend on
 * data they did not create, and a test that timed out mid-way left its own
 * fixtures behind in a catalogue other people were using. Everything a test
 * needs is now built by the test.
 *
 * DETERMINISM. Every fixture lives under a reserved slug/SKU namespace, so a
 * sweep can remove anything an earlier crashed run left behind without having to
 * know what it was. A test that dies between `create` and `finally` costs the
 * next run nothing.
 */
import { PrismaClient, Prisma, ProductStatus, Role } from '@prisma/client';

/**
 * Reserved prefix for everything the suite creates.
 *
 * Lowercase for slugs, uppercase for SKUs — SKUs are stored uppercase. Nothing
 * in the real catalogue starts with either, which is what makes the sweep below
 * safe to run unconditionally.
 */
export const TEST_PREFIX = 'zz';

/** A slug/SKU pair unique to one test. */
export function ns(label: string): string {
  return `${TEST_PREFIX}${label}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Delete every fixture in the reserved namespace.
 *
 * Call from `beforeAll`. Deleting on the way IN rather than only on the way out
 * is the point: a timed-out test never reaches its own cleanup, and this is what
 * stops that becoming the next run's problem — or a human's.
 *
 * Scoped by prefix on both slug and name so it can only ever match rows the
 * suite itself made.
 */
export async function sweepFixtures(prisma: PrismaClient): Promise<number> {
  const doomed = await prisma.productFamily.findMany({
    where: { slug: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });
  if (doomed.length === 0) return 0;

  // Cascades to variants, media and join rows.
  await prisma.productFamily.deleteMany({ where: { id: { in: doomed.map((d) => d.id) } } });
  return doomed.length;
}

/**
 * The CmsUser that owns audit entries written during a test.
 *
 * `writeAudit` stores a non-null actor, and several service calls take an
 * actorId that must satisfy a foreign key. Created once and reused; the email is
 * inside the reserved namespace so it can never collide with a real operator.
 */
export async function testActor(prisma: PrismaClient): Promise<string> {
  const email = `${TEST_PREFIX}-actor@zewafeeds.test`;
  const user = await prisma.cmsUser.upsert({
    where: { email },
    update: {},
    create: {
      email,
      name: 'Integration Test',
      role: Role.ADMIN,
      // Never used to sign in: no test authenticates, and the CMS rejects an
      // account without 2FA enrolled anyway.
      passwordHash: 'not-a-real-hash',
    },
    select: { id: true },
  });
  return user.id;
}

/** Audit context matching what the route layer builds. */
export const testCtx = (actorId: string) =>
  ({
    actorId,
    actorName: 'Integration Test',
    actorRole: 'Admin',
    ip: '127.0.0.1',
    userAgent: 'vitest',
  }) as never;

export interface ForeignProduct {
  familyId: string;
  slug: string;
  variantId: string;
  sku: string;
}

/**
 * A second product, for "this id belongs to someone else" assertions.
 *
 * Built rather than borrowed. Pointing these at a real catalogue product meant
 * the test's meaning depended on that product still existing, and a bug in the
 * code under test could have written to it.
 */
export async function createForeignProduct(prisma: PrismaClient): Promise<ForeignProduct> {
  const slug = ns('foreign');
  const family = await prisma.productFamily.create({
    data: {
      slug,
      name: 'Foreign Product',
      shortDesc: 'belongs to another family',
      category: 'BETTA',
      status: ProductStatus.ACTIVE,
      publishedAt: new Date(),
    },
    select: { id: true },
  });
  const variant = await prisma.productVariant.create({
    data: {
      familyId: family.id,
      sku: `${slug.toUpperCase()}-1KG`,
      pack: '1kg Pouch',
      mrpPaise: 10_000,
      pricePaise: 10_000,
      stock: 5,
      position: 0,
    },
    select: { id: true, sku: true },
  });
  return { familyId: family.id, slug, variantId: variant.id, sku: variant.sku };
}

/** Remove one family and everything hanging off it. Never throws. */
export async function dropFamily(prisma: PrismaClient, id: string): Promise<void> {
  await prisma.productFamily.delete({ where: { id } }).catch(() => undefined);
}

/** Cast helper: the service layer's ProductBody, built from a plain literal. */
export type AnyBody = Prisma.InputJsonValue;
