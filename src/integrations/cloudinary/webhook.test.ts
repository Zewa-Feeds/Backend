/**
 * Webhook authentication and interpretation.
 *
 * The signature is the only thing separating "Cloudinary says this asset is
 * ready" from "anyone on the internet says so", and the consequence of getting
 * it wrong is a stranger flipping media to READY or FAILED on a live storefront.
 * Pure functions, so these are exhaustive and instant.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { interpret, verifyNotification } from './webhook';

const SECRET = 'test_cloudinary_secret';

vi.mock('@/config/env', () => ({
  env: { CLOUDINARY_API_SECRET: 'test_cloudinary_secret' },
}));

const sign = (body: string, ts: string) =>
  createHash('sha1').update(`${body}${ts}${SECRET}`).digest('hex');

const NOW = 1_700_000_000_000;
const TS = String(Math.floor(NOW / 1000));

describe('notification authentication', () => {
  const body = JSON.stringify({ notification_type: 'upload', public_id: 'zewa/products/a' });

  it('accepts a correctly signed notification', () => {
    expect(verifyNotification(body, sign(body, TS), TS, NOW)).toEqual({ ok: true });
  });

  it('rejects a wrong signature', () => {
    expect(verifyNotification(body, 'f'.repeat(40), TS, NOW)).toEqual({
      ok: false, reason: 'BAD_SIGNATURE',
    });
  });

  it('rejects a signature for different bytes', () => {
    // The forger signed their own payload; we verify against what arrived.
    const other = JSON.stringify({ notification_type: 'upload', public_id: 'zewa/products/b' });
    expect(verifyNotification(body, sign(other, TS), TS, NOW).ok).toBe(false);
  });

  it('rejects a body that was re-serialised', () => {
    // Key order changes the bytes, which is why the RAW body must be hashed.
    const reordered = JSON.stringify({ public_id: 'zewa/products/a', notification_type: 'upload' });
    expect(verifyNotification(reordered, sign(body, TS), TS, NOW).ok).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(verifyNotification(body, undefined, TS, NOW)).toEqual({
      ok: false, reason: 'MISSING_HEADERS',
    });
  });

  it('rejects a missing timestamp', () => {
    expect(verifyNotification(body, sign(body, TS), undefined, NOW)).toEqual({
      ok: false, reason: 'MISSING_HEADERS',
    });
  });

  it('rejects a non-numeric timestamp', () => {
    expect(verifyNotification(body, sign(body, 'abc'), 'abc', NOW).ok).toBe(false);
  });

  it('rejects a replayed notification from hours ago', () => {
    const old = String(Math.floor(NOW / 1000) - 3 * 60 * 60);
    expect(verifyNotification(body, sign(body, old), old, NOW)).toEqual({
      ok: false, reason: 'STALE',
    });
  });

  it('accepts one that is merely late, inside the retry window', () => {
    const late = String(Math.floor(NOW / 1000) - 30 * 60);
    expect(verifyNotification(body, sign(body, late), late, NOW)).toEqual({ ok: true });
  });

  it('rejects a signature of the wrong length without throwing', () => {
    // timingSafeEqual throws on a length mismatch; that throw would be an oracle.
    expect(() => verifyNotification(body, 'abc', TS, NOW)).not.toThrow();
    expect(verifyNotification(body, 'abc', TS, NOW).ok).toBe(false);
  });
});

describe('what a notification means', () => {
  it('an image upload is finished on arrival', () => {
    expect(interpret({ notification_type: 'upload', public_id: 'p', resource_type: 'image' }))
      .toEqual({ kind: 'READY', publicId: 'p' });
  });

  it('a video upload is NOT finished — only the original landed', () => {
    const out = interpret({ notification_type: 'upload', public_id: 'p', resource_type: 'video' });
    expect(out.kind).toBe('IGNORED');
  });

  it('an eager notification finishes a video', () => {
    expect(interpret({ notification_type: 'eager', public_id: 'p', eager: [{ status: 'complete' }] }))
      .toEqual({ kind: 'READY', publicId: 'p' });
  });

  it('an eager entry that did not complete is a failure', () => {
    const out = interpret({ notification_type: 'eager', public_id: 'p', eager: [{ status: 'failed' }] });
    expect(out.kind).toBe('FAILED');
  });

  it('an explicit error is a failure, whatever the type', () => {
    const out = interpret({ notification_type: 'upload', public_id: 'p', error: { message: 'too big' } });
    expect(out).toEqual({ kind: 'FAILED', publicId: 'p', reason: 'too big' });
  });

  it('a string error is handled too', () => {
    expect(interpret({ public_id: 'p', error: 'rejected' }).kind).toBe('FAILED');
  });

  it('ignores a notification with no public_id rather than guessing', () => {
    expect(interpret({ notification_type: 'upload' }).kind).toBe('IGNORED');
  });

  it('ignores an unrecognised type rather than moving media to a wrong state', () => {
    expect(interpret({ notification_type: 'moderation', public_id: 'p' }).kind).toBe('IGNORED');
  });
});
