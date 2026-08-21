/**
 * Cloudinary service integration and probe tests.
 *
 * Covers Admin API authentication via HTTP Basic Auth, asset presence/readiness
 * probing, video poster frame generation, and hover video transformation rewrite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hoverVideoUrl, probeAsset, videoPosterUrl } from './cloudinary.service';

vi.mock('@/config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      CLOUDINARY_CLOUD_NAME: 'test_cloud',
      CLOUDINARY_API_KEY: 'test_key',
      CLOUDINARY_API_SECRET: 'test_secret',
    },
  };
});

describe('probeAsset', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('authenticates via HTTP Basic Auth header', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ width: 1920, height: 1080, duration: 25, eager: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await probeAsset('zewa/products/vid1', 'video');
    expect(result).toEqual({
      exists: true,
      ready: true,
      width: 1920,
      height: 1080,
      durationSec: 25,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.cloudinary.com/v1_1/test_cloud/resources/video/upload/zewa%2Fproducts%2Fvid1');
    expect(init.method).toBe('GET');

    const expectedAuth = `Basic ${Buffer.from('test_key:test_secret').toString('base64')}`;
    expect((init.headers as Record<string, string>)['Authorization']).toBe(expectedAuth);
  });

  it('reports not ready if eager transformation is still in progress', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          width: 1920,
          height: 1080,
          eager: [{ status: 'processing' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await probeAsset('zewa/products/vid2', 'video');
    expect(result).toEqual({
      exists: true,
      ready: false,
      width: 1920,
      height: 1080,
      durationSec: undefined,
    });
  });

  it('reports exists: false and ready: false on definite 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Resource not found' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await probeAsset('zewa/products/nonexistent', 'video');
    expect(result).toEqual({ exists: false, ready: false });
  });

  it('returns null on 401/403 auth errors (treated as unknown, not missing)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Invalid credentials' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await probeAsset('zewa/products/vid3', 'video');
    expect(result).toBeNull();
  });

  it('returns null on 500 server error or network rejection', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

    const result = await probeAsset('zewa/products/vid4', 'video');
    expect(result).toBeNull();
  });
});

describe('video URLs', () => {
  it('generates first-frame poster URL', () => {
    const poster = videoPosterUrl('zewa/products/sample-video');
    expect(poster).toBe(
      'https://res.cloudinary.com/test_cloud/video/upload/so_0,q_auto,f_jpg/zewa/products/sample-video.jpg',
    );
  });

  it('generates hover video derivative URL', () => {
    const masterUrl =
      'https://res.cloudinary.com/test_cloud/video/upload/v1785741959/zewa/products/sample.mp4';
    const hover = hoverVideoUrl(masterUrl);
    expect(hover).toBe(
      'https://res.cloudinary.com/test_cloud/video/upload/f_auto,q_auto,w_640,c_limit/v1785741959/zewa/products/sample.mp4',
    );
  });

  it('does not re-transform an already transformed URL', () => {
    const alreadyTransformed =
      'https://res.cloudinary.com/test_cloud/video/upload/f_auto,q_auto,w_640,c_limit/v1785741959/zewa/products/sample.mp4';
    expect(hoverVideoUrl(alreadyTransformed)).toBe(alreadyTransformed);
  });
});
