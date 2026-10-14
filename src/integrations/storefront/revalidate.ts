/**
 * Tell the storefront a product changed.
 *
 * The storefront caches the catalogue: an hour on the shop grid, a minute on a
 * product page, plus Next's own data cache in front of both. Nothing invalidated
 * any of it, so a published change was invisible to customers for up to an hour.
 * This is the signal that closes that gap.
 *
 * BEST-EFFORT AND NEVER THROWS.
 *
 * A publish that committed must not be reported as failed because a cache purge
 * timed out — the database is the source of truth and the caches expire on their
 * own regardless. Failures are logged so a persistently broken hook is visible
 * rather than silent.
 *
 * Only call this AFTER the transaction commits. Purging for a transaction that
 * then aborts would evict a correct cache and refill it from unchanged data.
 */
import { env } from '@/config/env';
import { logger } from '@/lib/logger';

/** Give up quickly: this is a courtesy call, not part of the write. */
const TIMEOUT_MS = 4000;

export async function revalidateStorefront(slug?: string): Promise<void> {
  if (!env.REVALIDATE_SECRET) {
    logger.debug('REVALIDATE_SECRET not set — storefront cache not purged');
    return;
  }

  const url = `${env.STOREFRONT_ORIGIN.replace(/\/$/, '')}/api/revalidate`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.REVALIDATE_SECRET}`,
      },
      body: JSON.stringify(slug ? { slug } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.warn({ status: response.status, slug }, 'storefront revalidation refused');
      return;
    }
    logger.info({ slug }, 'storefront cache purged');
  } catch (err) {
    logger.warn({ err, slug }, 'storefront revalidation failed');
  }
}

// ============================================================================
// WEBSITE PUBLICATIONS
//
// Unlike the product purge above, these THROW. A website publish is tracked:
// the CMS shows whether customers are seeing the new version, so a failed call
// has to reach the publish worker, which records it and retries.
// ============================================================================

const origin = () => env.STOREFRONT_ORIGIN.replace(/\/$/, '');

export class StorefrontError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorefrontError';
  }
}

/**
 * Ask the storefront to regenerate exactly these tags and paths.
 *
 * The storefront serves the previous pages until regeneration succeeds, so a
 * call that lands but whose regeneration later fails cannot blank the site.
 */
export async function revalidateSiteContent(plan: { tags: string[]; paths: string[]; version: number }): Promise<void> {
  if (!env.REVALIDATE_SECRET) {
    throw new StorefrontError('REVALIDATE_SECRET is not set on the API, so the storefront cannot be told to regenerate.');
  }

  let response: Response;
  try {
    response = await fetch(`${origin()}/api/revalidate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.REVALIDATE_SECRET}`,
      },
      body: JSON.stringify({ scope: 'site', ...plan }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new StorefrontError(`Could not reach ${origin()}/api/revalidate: ${(err as Error).message}`);
  }

  if (response.status === 401) {
    throw new StorefrontError('The storefront rejected the revalidation secret — REVALIDATE_SECRET differs between the API and the storefront.');
  }
  if (!response.ok) {
    throw new StorefrontError(`The storefront's revalidation endpoint answered ${response.status}.`);
  }
}

const VERSION_META = /<meta[^>]+name="zewa-content-version"[^>]+content="(\d+)"/i;

/**
 * Which publication a page is currently being served from, read from the
 * <meta name="zewa-content-version"> every content page renders.
 *
 * This is the proof the CMS reports. "The webhook returned 200" only says the
 * request arrived; the version in the served HTML says the regenerated page is
 * what customers get.
 *
 * Null when the page could not be fetched or carries no marker.
 */
export async function servedVersion(path: string): Promise<number | null> {
  try {
    const response = await fetch(`${origin()}${path}`, {
      headers: { 'user-agent': 'ZewaPublishVerifier/1.0' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return null;
    const match = VERSION_META.exec(await response.text());
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/** Trigger a full storefront build. The host keeps serving the old deploy until it succeeds. */
export async function triggerDeployHook(): Promise<void> {
  if (!env.STOREFRONT_DEPLOY_HOOK_URL) {
    throw new StorefrontError('No STOREFRONT_DEPLOY_HOOK_URL is configured.');
  }
  let response: Response;
  try {
    response = await fetch(env.STOREFRONT_DEPLOY_HOOK_URL, { method: 'POST', signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new StorefrontError(`Could not reach the deploy hook: ${(err as Error).message}`);
  }
  if (!response.ok) throw new StorefrontError(`The deploy hook answered ${response.status}.`);
}

export const deployHookConfigured = () => Boolean(env.STOREFRONT_DEPLOY_HOOK_URL);
