/**
 * The publishedAt backfill migration.
 *
 * A data migration runs once, so what has to be tested is its SELECTIVITY: that
 * it touches exactly the rows it should and nothing else. The test applies the
 * migration's own SQL — read from the migration file rather than retyped, so the
 * two cannot drift — against fixtures covering every status.
 *
 * Runs against the local database (see vitest.setup.ts); the real catalogue is
 * never involved.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, ProductStatus } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { ns, sweepFixtures } from '@/test/fixtures';

const prisma = new PrismaClient();

const MIGRATION_SQL = readFileSync(
  'prisma/migrations/20260821090000_backfill_published_at/migration.sql',
  'utf8',
);

beforeAll(async () => {
  await sweepFixtures(prisma);
});
afterAll(async () => {
  await sweepFixtures(prisma);
  await prisma.$disconnect();
});

/** One product in a given state. Returns its id. */
async function make(opts: {
  status: ProductStatus;
  publishedAt?: Date | null;
  deletedAt?: Date | null;
}): Promise<string> {
  const row = await prisma.productFamily.create({
    data: {
      slug: ns('pub'),
      name: 'Backfill Test',
      shortDesc: 'x',
      category: 'BETTA',
      status: opts.status,
      publishedAt: opts.publishedAt ?? null,
      deletedAt: opts.deletedAt ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

const read = (id: string) =>
  prisma.productFamily.findUniqueOrThrow({
    where: { id },
    select: {
      publishedAt: true, createdAt: true, updatedAt: true, status: true,
      slug: true, name: true, shortDesc: true, deletedAt: true,
    },
  });

/** Apply the migration exactly as `prisma migrate deploy` would. */
const runMigration = () => prisma.$executeRawUnsafe(MIGRATION_SQL);

describe('publishedAt backfill', () => {
  it('stamps a customer-visible product that has no date', async () => {
    const id = await make({ status: ProductStatus.ACTIVE });
    const before = await read(id);
    expect(before.publishedAt).toBeNull();

    await runMigration();

    const after = await read(id);
    expect(after.publishedAt).toEqual(after.createdAt);
  });

  it('stamps COMING_SOON too — a listed, linkable page is published', async () => {
    const id = await make({ status: ProductStatus.COMING_SOON });
    await runMigration();
    const after = await read(id);
    expect(after.publishedAt).toEqual(after.createdAt);
  });

  it.each([ProductStatus.DRAFT, ProductStatus.INACTIVE, ProductStatus.DISCONTINUED])(
    'leaves %s alone — never seen means never published',
    async (status) => {
      const id = await make({ status });
      await runMigration();
      expect((await read(id)).publishedAt).toBeNull();
    },
  );

  it('never moves a date that already exists', async () => {
    const original = new Date('2025-01-15T09:30:00.000Z');
    const id = await make({ status: ProductStatus.ACTIVE, publishedAt: original });
    await runMigration();
    expect((await read(id)).publishedAt).toEqual(original);
  });

  it('skips soft-deleted products', async () => {
    const id = await make({ status: ProductStatus.ACTIVE, deletedAt: new Date() });
    await runMigration();
    expect((await read(id)).publishedAt).toBeNull();
  });

  it('changes no other field', async () => {
    const id = await make({ status: ProductStatus.ACTIVE });
    const before = await read(id);
    await runMigration();
    const after = await read(id);

    expect(after.slug).toBe(before.slug);
    expect(after.name).toBe(before.name);
    expect(after.shortDesc).toBe(before.shortDesc);
    expect(after.status).toBe(before.status);
    expect(after.createdAt).toEqual(before.createdAt);
    expect(after.deletedAt).toBeNull();
    /*
     * updatedAt is @updatedAt, which Prisma maintains — raw SQL does not touch
     * it. Deliberate: this is a correction of missing bookkeeping, not an edit
     * to the product, and it should not look like someone changed the listing.
     */
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it('affects exactly the eligible rows and no more', async () => {
    const eligible = [
      await make({ status: ProductStatus.ACTIVE }),
      await make({ status: ProductStatus.COMING_SOON }),
    ];
    const untouched = [
      await make({ status: ProductStatus.DRAFT }),
      await make({ status: ProductStatus.INACTIVE }),
      await make({ status: ProductStatus.DISCONTINUED }),
      await make({ status: ProductStatus.ACTIVE, deletedAt: new Date() }),
      await make({ status: ProductStatus.ACTIVE, publishedAt: new Date('2025-06-01T00:00:00.000Z') }),
    ];

    const changed = await runMigration();
    expect(changed).toBe(eligible.length);

    for (const id of eligible) {
      const row = await read(id);
      expect(row.publishedAt).toEqual(row.createdAt);
    }
    expect((await read(untouched[0]!)).publishedAt).toBeNull();
    expect((await read(untouched[1]!)).publishedAt).toBeNull();
    expect((await read(untouched[2]!)).publishedAt).toBeNull();
    expect((await read(untouched[3]!)).publishedAt).toBeNull();
    expect((await read(untouched[4]!)).publishedAt).toEqual(new Date('2025-06-01T00:00:00.000Z'));
  });

  it('is idempotent — a second run changes nothing', async () => {
    await make({ status: ProductStatus.ACTIVE });
    const first = await runMigration();
    expect(first).toBeGreaterThan(0);

    const second = await runMigration();
    expect(second).toBe(0);
  });
});
