/**
 * Cloudinary asset lifecycle — the DELETE half of the upload story.
 *
 * Uploads never touch this API (the browser posts direct with a signed payload,
 * see modules/uploads). Deletes must come from here, because destroying an asset
 * requires the API secret and can therefore never be delegated to the client:
 * a browser-issued delete would let anyone with the page open wipe the library.
 *
 * Every function here is BEST-EFFORT and never throws. A gallery edit that
 * committed successfully must not be reported as failed because a CDN cleanup
 * call timed out — the database is the source of truth, and a surviving orphan
 * costs storage, not correctness. Failures are logged so they are visible.
 */
import { createHash } from 'node:crypto';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';

/** Cloudinary asset kinds we manage. Mirrors the upload signature's resourceType. */
type ResourceType = 'image' | 'video';

const isConfigured = () =>
  Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);

/**
 * Cloudinary's signing scheme: sort params alphabetically, join as a query
 * string, append the API secret, SHA-1 the result.
 */
function sign(params: Record<string, string | number>): string {
  const toSign = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
  return createHash('sha1').update(`${toSign}${env.CLOUDINARY_API_SECRET}`).digest('hex');
}

/**
 * Destroy one asset.
 *
 * `resourceType` matters: a video destroyed via the image endpoint returns
 * "not found" and the asset survives. We do not store the resource type on every
 * row, so an image delete that misses is retried as a video before giving up.
 */
async function destroyOne(publicId: string, resourceType: ResourceType): Promise<boolean> {
  const timestamp = Math.floor(Date.now() / 1000);
  const body = new URLSearchParams({
    public_id: publicId,
    timestamp: String(timestamp),
    api_key: env.CLOUDINARY_API_KEY as string,
    signature: sign({ public_id: publicId, timestamp }),
  });

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/${resourceType}/destroy`,
    { method: 'POST', body },
  );

  if (!response.ok) return false;
  const result = (await response.json()) as { result?: string };
  return result.result === 'ok';
}

/**
 * Destroy assets that a gallery no longer references.
 *
 * Call AFTER the surrounding transaction commits — a destroy is not
 * rollback-able, so running it inside a transaction that later aborts would
 * delete an asset the database still points at.
 */
export async function destroyAssets(publicIds: string[]): Promise<void> {
  if (publicIds.length === 0) return;

  if (!isConfigured()) {
    logger.warn(
      { count: publicIds.length },
      'Cloudinary not configured — orphaned assets not deleted',
    );
    return;
  }

  const results = await Promise.allSettled(
    publicIds.map(async (publicId) => {
      // Try image first (the common case), then video.
      const ok = (await destroyOne(publicId, 'image')) || (await destroyOne(publicId, 'video'));
      if (!ok) throw new Error(`destroy returned not-ok for ${publicId}`);
      return publicId;
    }),
  );

  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed > 0) {
    logger.warn(
      { failed, total: publicIds.length },
      'some orphaned Cloudinary assets could not be deleted',
    );
  } else {
    logger.info({ count: publicIds.length }, 'orphaned Cloudinary assets deleted');
  }
}

/**
 * Poster frame URL for an uploaded video.
 *
 * Cloudinary renders a frame on demand when a video's public_id is requested with
 * an image extension, so no separate upload is needed. `so_0` pins it to the
 * first frame; without it Cloudinary picks the midpoint, which for a product
 * video is often a motion-blurred frame.
 */
export function videoPosterUrl(publicId: string): string | null {
  if (!env.CLOUDINARY_CLOUD_NAME) return null;
  return `https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/video/upload/so_0,q_auto,f_jpg/${publicId}.jpg`;
}
