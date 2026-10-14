/**
 * Getting a publication in front of customers — and proving it.
 *
 * The storefront serves pages it pre-rendered. A publish changes which snapshot
 * the API calls current; this makes the storefront regenerate the affected
 * pages and then READS THEM BACK, checking the version marker in the served
 * HTML. Only that observation marks a publication LIVE.
 *
 * FAILURE IS SAFE BY CONSTRUCTION. Regeneration is stale-while-revalidate: if a
 * page cannot be rebuilt (the API is down mid-regeneration, a render throws),
 * the storefront keeps the last page it built successfully. A full rebuild
 * through the deploy hook is atomic on both Netlify and Vercel. So the worst a
 * failure here can do is leave the previous version visible — which the CMS
 * then reports, with a Retry button.
 *
 * STALE JOBS CANNOT REGRESS THE SITE. A job carries a publication id, not
 * content. If that publication is no longer current when the job runs, the job
 * marks it SUPERSEDED and does nothing: the storefront always fetches whatever
 * is current, so an old job finishing late could only ever re-request the new
 * content anyway.
 */
import { PublicationStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import * as storefront from '@/integrations/storefront/revalidate';
import { type Snapshot, planFor } from './site.service';

const log = logger.child({ module: 'site.publisher' });

export interface PublisherDeps {
  revalidate: typeof storefront.revalidateSiteContent;
  servedVersion: typeof storefront.servedVersion;
  deployHook: typeof storefront.triggerDeployHook;
  deployHookConfigured: () => boolean;
  sleep: (ms: number) => Promise<void>;
  /** How long to wait for pages to show the new version. */
  verifyBudgetMs: { revalidate: number; 'deploy-hook': number };
  pollEveryMs: { revalidate: number; 'deploy-hook': number };
}

export const defaultDeps: PublisherDeps = {
  revalidate: storefront.revalidateSiteContent,
  servedVersion: storefront.servedVersion,
  deployHook: storefront.triggerDeployHook,
  deployHookConfigured: storefront.deployHookConfigured,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  verifyBudgetMs: { revalidate: 90_000, 'deploy-hook': 20 * 60_000 },
  pollEveryMs: { revalidate: 5_000, 'deploy-hook': 30_000 },
};

/** At most this many pages are read back; the rest regenerate on first visit. */
const MAX_VERIFIED_PATHS = 8;

export type Outcome =
  | { result: 'live'; verifiedPaths: string[] }
  | { result: 'superseded' }
  | { result: 'missing' }
  | { result: 'already-live' };

export class PublishAttemptFailed extends Error {
  constructor(message: string, readonly fallbackToDeployHook = false) {
    super(message);
    this.name = 'PublishAttemptFailed';
  }
}

async function stillCurrent(id: string) {
  const row = await prisma.sitePublication.findUnique({ where: { id }, select: { isCurrent: true } });
  return Boolean(row?.isCurrent);
}

/**
 * Pick the pages to read back: the most-visited affected ones first.
 * Removed articles are excluded — their absence is the change.
 */
function pagesToVerify(paths: string[]): string[] {
  const priority = ['/', '/blog', '/about', '/products'];
  const ordered = [...priority.filter((p) => paths.includes(p)), ...paths.filter((p) => !priority.includes(p))];
  return ordered.filter((p) => p !== '/sitemap.xml').slice(0, MAX_VERIFIED_PATHS);
}

/**
 * One attempt. Throws PublishAttemptFailed to let the queue retry; the caller
 * decides whether this was the last attempt.
 */
export async function runPublication(
  publicationId: string,
  mode: 'revalidate' | 'deploy-hook',
  deps: PublisherDeps = defaultDeps,
): Promise<Outcome> {
  const pub = await prisma.sitePublication.findUnique({
    where: { id: publicationId },
    select: { id: true, version: true, isCurrent: true, status: true, scopes: true, snapshot: true },
  });
  if (!pub) return { result: 'missing' };

  if (!pub.isCurrent) {
    if (pub.status !== PublicationStatus.LIVE) {
      await prisma.sitePublication.update({ where: { id: pub.id }, data: { status: PublicationStatus.SUPERSEDED } });
    }
    return { result: 'superseded' };
  }
  // A duplicate delivery of a job that already succeeded. A deploy-hook run is
  // an explicit rebuild request, so it is never skipped.
  if (pub.status === PublicationStatus.LIVE && mode === 'revalidate') return { result: 'already-live' };

  await prisma.sitePublication.update({
    where: { id: pub.id },
    data: { status: PublicationStatus.DEPLOYING, method: mode, attempts: { increment: 1 } },
  });

  const plan = planFor(pub.scopes, pub.snapshot as unknown as Snapshot);

  try {
    if (mode === 'revalidate') {
      await deps.revalidate({ tags: plan.tags, paths: plan.paths, version: pub.version });
    } else {
      await deps.deployHook();
    }
  } catch (err) {
    throw new PublishAttemptFailed((err as Error).message, mode === 'revalidate');
  }

  const targets = pagesToVerify(plan.paths);
  const confirmed = new Set<string>();
  const deadline = Date.now() + deps.verifyBudgetMs[mode];
  const lastSeen = new Map<string, number | null>();

  while (confirmed.size < targets.length) {
    for (const path of targets) {
      if (confirmed.has(path)) continue;
      // The first read after revalidation may return the stale page while it
      // regenerates in the background; that read is what triggers the rebuild.
      const seen = await deps.servedVersion(path);
      lastSeen.set(path, seen);
      if (seen !== null && seen >= pub.version) confirmed.add(path);
    }
    if (confirmed.size === targets.length) break;

    if (!(await stillCurrent(pub.id))) {
      await prisma.sitePublication.update({ where: { id: pub.id }, data: { status: PublicationStatus.SUPERSEDED } });
      return { result: 'superseded' };
    }
    if (Date.now() >= deadline) break;
    await deps.sleep(deps.pollEveryMs[mode]);
  }

  if (confirmed.size < targets.length) {
    const pending = targets
      .filter((p) => !confirmed.has(p))
      .map((p) => `${p} (serving ${lastSeen.get(p) === null ? 'no version marker' : `v${lastSeen.get(p)}`})`);
    await prisma.sitePublication.update({
      where: { id: pub.id },
      data: { verifiedPaths: [...confirmed] },
    });
    throw new PublishAttemptFailed(
      `The storefront has not picked up v${pub.version} yet on ${pending.join(', ')}. The previous version is still being served.`,
      mode === 'revalidate',
    );
  }

  // A newer publication may have become current while we verified — the pages
  // then serve that one (>= our version), which is fine, but do not claim LIVE
  // for a version that is no longer the current one.
  if (!(await stillCurrent(pub.id))) {
    await prisma.sitePublication.update({ where: { id: pub.id }, data: { status: PublicationStatus.SUPERSEDED } });
    return { result: 'superseded' };
  }

  await prisma.sitePublication.update({
    where: { id: pub.id },
    data: { status: PublicationStatus.LIVE, liveAt: new Date(), lastError: null, verifiedPaths: [...confirmed] },
  });
  log.info({ version: pub.version, mode, verified: confirmed.size }, 'website publication is live');
  return { result: 'live', verifiedPaths: [...confirmed] };
}

/**
 * Record a failed attempt. On the last one, mark FAILED — and if targeted
 * regeneration is what failed and a build hook exists, escalate to a full
 * rebuild rather than leave the site behind.
 */
export async function recordFailure(
  publicationId: string,
  err: Error,
  final: boolean,
  deps: Pick<PublisherDeps, 'deployHookConfigured'> = defaultDeps,
): Promise<'retrying' | 'failed' | 'escalated'> {
  const message = err.message.slice(0, 1000);
  const escalate = final && err instanceof PublishAttemptFailed && err.fallbackToDeployHook && deps.deployHookConfigured();

  await prisma.sitePublication.updateMany({
    // Never overwrite a terminal state written by a newer run.
    where: { id: publicationId, status: { in: [PublicationStatus.QUEUED, PublicationStatus.DEPLOYING] } },
    data: {
      lastError: escalate ? `${message} Escalating to a full rebuild.` : message,
      ...(final && !escalate ? { status: PublicationStatus.FAILED } : {}),
    },
  });

  if (escalate) return 'escalated';
  return final ? 'failed' : 'retrying';
}
