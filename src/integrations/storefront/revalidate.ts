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
