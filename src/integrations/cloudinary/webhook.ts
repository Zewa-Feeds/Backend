/**
 * Cloudinary notification verification.
 *
 * Cloudinary signs every notification: SHA-1 of the raw body concatenated with
 * the timestamp header and the API secret. Verifying it is the only thing
 * separating "Cloudinary told us this asset is ready" from "anyone on the
 * internet told us that", and the consequence of getting it wrong is an attacker
 * flipping arbitrary media to READY or FAILED on a live storefront.
 *
 * Two rules the implementation must not bend:
 *
 *   - the RAW body is what gets hashed. Re-serialising the parsed JSON produces
 *     different bytes (key order, whitespace, unicode escapes) and every
 *     signature fails.
 *   - the comparison is constant-time. A byte-by-byte `===` on a signature leaks
 *     it through timing, one character at a time.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { env } from '@/config/env';

/**
 * How far out of date a notification may be.
 *
 * Cloudinary retries for a while, so this cannot be tight — but without any
 * bound a captured notification could be replayed forever. Two hours is well
 * inside Cloudinary's retry window and well outside anything useful to an
 * attacker sitting on an old capture.
 */
const MAX_AGE_SECONDS = 2 * 60 * 60;

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'NOT_CONFIGURED' | 'MISSING_HEADERS' | 'STALE' | 'BAD_SIGNATURE' };

/**
 * Is this notification genuinely from Cloudinary?
 *
 * `rawBody` must be the bytes as received. See the note above.
 */
export function verifyNotification(
  rawBody: string,
  signature: string | undefined,
  timestamp: string | undefined,
  now: number = Date.now(),
): VerifyResult {
  if (!env.CLOUDINARY_API_SECRET) return { ok: false, reason: 'NOT_CONFIGURED' };
  if (!signature || !timestamp) return { ok: false, reason: 'MISSING_HEADERS' };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'MISSING_HEADERS' };

  const ageSeconds = Math.abs(Math.floor(now / 1000) - ts);
  if (ageSeconds > MAX_AGE_SECONDS) return { ok: false, reason: 'STALE' };

  const expected = createHash('sha1')
    .update(`${rawBody}${timestamp}${env.CLOUDINARY_API_SECRET}`)
    .digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  // Length is checked first because timingSafeEqual throws on a mismatch, and
  // that throw would itself be an oracle.
  if (a.length !== b.length) return { ok: false, reason: 'BAD_SIGNATURE' };
  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'BAD_SIGNATURE' };
}

/** The subset of a Cloudinary notification this system acts on. */
export interface Notification {
  notification_type?: string;
  public_id?: string;
  resource_type?: string;
  secure_url?: string;
  width?: number;
  height?: number;
  duration?: number;
  format?: string;
  bytes?: number;
  eager?: { secure_url?: string; status?: string }[];
  error?: { message?: string } | string;
}

/**
 * What a notification means for the asset it names.
 *
 * Cloudinary sends several notification types and this system only cares about
 * three outcomes. Anything else is acknowledged and ignored rather than guessed
 * at — an unrecognised type must never move media to a wrong state.
 */
export type NotificationOutcome =
  | { kind: 'READY'; publicId: string }
  | { kind: 'FAILED'; publicId: string; reason: string }
  | { kind: 'IGNORED'; reason: string };

export function interpret(body: Notification): NotificationOutcome {
  const publicId = typeof body.public_id === 'string' ? body.public_id : null;
  if (!publicId) return { kind: 'IGNORED', reason: 'no public_id' };

  const errorMessage =
    typeof body.error === 'string' ? body.error : (body.error?.message ?? null);
  if (errorMessage) return { kind: 'FAILED', publicId, reason: errorMessage.slice(0, 500) };

  switch (body.notification_type) {
    /*
     * `upload` fires when the bytes land. For an image that is the whole story:
     * the ingest transformation is applied synchronously, so the asset is
     * finished. For a video it only means the original is stored — the derived
     * version is still transcoding, and `eager` will follow.
     */
    case 'upload':
      return body.resource_type === 'video'
        ? { kind: 'IGNORED', reason: 'video original stored; awaiting eager' }
        : { kind: 'READY', publicId };

    /* Asynchronous transcoding finished. This is what a video waits for. */
    case 'eager': {
      const failed = (body.eager ?? []).find((e) => e.status && e.status !== 'complete');
      return failed
        ? { kind: 'FAILED', publicId, reason: `eager transformation ${failed.status}` }
        : { kind: 'READY', publicId };
    }

    case 'error':
      return { kind: 'FAILED', publicId, reason: 'cloudinary reported an error' };

    default:
      return { kind: 'IGNORED', reason: `unhandled type ${body.notification_type ?? 'none'}` };
  }
}
