/**
 * The publish worker's promises, with the storefront simulated:
 *
 *   - LIVE only when the served pages carry the new version
 *   - a failed regeneration is retried, then FAILED — and escalates to a full
 *     rebuild when a deploy hook exists
 *   - a job for a version that is no longer current does nothing
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient, PublicationStatus } from '@prisma/client';
import { PublishAttemptFailed, recordFailure, runPublication, type PublisherDeps } from './publisher';

const prisma = new PrismaClient();

const SNAPSHOT = {
  schema: 1,
  sections: { home: {}, products: {}, blog: {}, about: {} },
  articles: [{ slug: 'a' }],
  source: {},
};

async function publication(version: number, current = true) {
  if (current) await prisma.sitePublication.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } });
  return prisma.sitePublication.create({
    data: {
      version,
      snapshot: SNAPSHOT,
      contentHash: `h${version}`,
      scopes: ['home', 'about'],
      isCurrent: current,
      publishedByName: 'test',
    },
  });
}

function deps(over: Partial<PublisherDeps> = {}): PublisherDeps {
  return {
    revalidate: vi.fn().mockResolvedValue(undefined),
    servedVersion: vi.fn().mockResolvedValue(null),
    deployHook: vi.fn().mockResolvedValue(undefined),
    deployHookConfigured: () => false,
    sleep: vi.fn().mockResolvedValue(undefined),
    verifyBudgetMs: { revalidate: 50, 'deploy-hook': 50 },
    pollEveryMs: { revalidate: 0, 'deploy-hook': 0 },
    ...over,
  };
}

beforeEach(async () => {
  await prisma.sitePublication.deleteMany({});
});

afterAll(async () => {
  await prisma.sitePublication.deleteMany({});
  await prisma.$disconnect();
});

describe('runPublication', () => {
  it('marks LIVE only once every affected page serves the new version', async () => {
    const pub = await publication(5);
    let reads = 0;
    const d = deps({
      // The first read returns the stale page (stale-while-revalidate), the next the fresh one.
      servedVersion: vi.fn().mockImplementation(async () => (reads++ < 2 ? 4 : 5)),
    });

    const out = await runPublication(pub.id, 'revalidate', d);
    expect(out).toEqual({ result: 'live', verifiedPaths: ['/', '/about'] });
    expect(d.revalidate).toHaveBeenCalledWith({ tags: ['site:home', 'site:about'], paths: ['/', '/about'], version: 5 });

    const row = await prisma.sitePublication.findUniqueOrThrow({ where: { id: pub.id } });
    expect(row.status).toBe(PublicationStatus.LIVE);
    expect(row.liveAt).not.toBeNull();
  });

  it('fails the attempt — leaving the old pages up — when the storefront never shows the version', async () => {
    const pub = await publication(6);
    const d = deps({ servedVersion: vi.fn().mockResolvedValue(5) });
    await expect(runPublication(pub.id, 'revalidate', d)).rejects.toThrow(/still being served/);
    expect((await prisma.sitePublication.findUniqueOrThrow({ where: { id: pub.id } })).status).toBe(PublicationStatus.DEPLOYING);
  });

  it('fails the attempt when the revalidation call itself is refused', async () => {
    const pub = await publication(7);
    const d = deps({ revalidate: vi.fn().mockRejectedValue(new Error('secret mismatch')) });
    await expect(runPublication(pub.id, 'revalidate', d)).rejects.toBeInstanceOf(PublishAttemptFailed);
  });

  it('does nothing for a version that is no longer current', async () => {
    const old = await publication(8);
    await publication(9);
    const d = deps();
    expect(await runPublication(old.id, 'revalidate', d)).toEqual({ result: 'superseded' });
    expect(d.revalidate).not.toHaveBeenCalled();
    expect((await prisma.sitePublication.findUniqueOrThrow({ where: { id: old.id } })).status).toBe(PublicationStatus.SUPERSEDED);
  });

  it('is idempotent: a duplicate job for a LIVE version is a no-op', async () => {
    const pub = await publication(10);
    await prisma.sitePublication.update({ where: { id: pub.id }, data: { status: PublicationStatus.LIVE } });
    const d = deps();
    expect(await runPublication(pub.id, 'revalidate', d)).toEqual({ result: 'already-live' });
    expect(d.revalidate).not.toHaveBeenCalled();
  });
});

describe('recordFailure', () => {
  it('retries quietly, then marks FAILED on the last attempt', async () => {
    const pub = await publication(11);
    await prisma.sitePublication.update({ where: { id: pub.id }, data: { status: PublicationStatus.DEPLOYING } });
    const err = new PublishAttemptFailed('boom', true);
    expect(await recordFailure(pub.id, err, false, { deployHookConfigured: () => false })).toBe('retrying');
    expect(await recordFailure(pub.id, err, true, { deployHookConfigured: () => false })).toBe('failed');
    const row = await prisma.sitePublication.findUniqueOrThrow({ where: { id: pub.id } });
    expect(row).toMatchObject({ status: PublicationStatus.FAILED, lastError: 'boom' });
  });

  it('escalates a failed targeted regeneration to a full rebuild when a hook exists', async () => {
    const pub = await publication(12);
    await prisma.sitePublication.update({ where: { id: pub.id }, data: { status: PublicationStatus.DEPLOYING } });
    const outcome = await recordFailure(pub.id, new PublishAttemptFailed('x', true), true, { deployHookConfigured: () => true });
    expect(outcome).toBe('escalated');
    expect((await prisma.sitePublication.findUniqueOrThrow({ where: { id: pub.id } })).status).toBe(PublicationStatus.DEPLOYING);
  });
});
