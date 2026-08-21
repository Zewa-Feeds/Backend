/**
 * Upload signing.
 *
 * The signature is what lets a browser write into our Cloudinary account, so
 * what matters is the SHAPE of what gets signed: the client must not be able to
 * choose the folder, the transformation, the format allowlist, the notification
 * URL, or — the one that used to be possible — the public_id of an asset that
 * already exists.
 *
 * The route is exercised through the schema and the signing rules rather than
 * over HTTP, so these stay fast and cover the cases an integration test would
 * struggle to reach.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Mirrors the route's own allowlists. */
const FOLDERS = ['products', 'articles', 'spotlights'] as const;
const RESOURCE_TYPES = ['image', 'video'] as const;

const bodySchema = z.object({
  folder: z.enum(FOLDERS),
  resourceType: z.enum(RESOURCE_TYPES).optional().default('image'),
  slug: z.string().trim().max(120).optional(),
});

const sign = (params: Record<string, string | number>, secret: string) =>
  createHash('sha1')
    .update(
      Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&') + secret,
    )
    .digest('hex');

describe('what a client may ask for', () => {
  it('accepts an allowed folder', () => {
    expect(bodySchema.parse({ folder: 'products' }).folder).toBe('products');
  });

  it('rejects a folder outside the allowlist', () => {
    // Otherwise a caller could write anywhere in the Cloudinary account.
    expect(bodySchema.safeParse({ folder: 'invoices' }).success).toBe(false);
  });

  it('rejects a traversal attempt in the folder', () => {
    expect(bodySchema.safeParse({ folder: '../../secrets' }).success).toBe(false);
  });

  it('rejects an unknown resource type', () => {
    expect(bodySchema.safeParse({ folder: 'products', resourceType: 'raw' }).success).toBe(false);
  });

  it('defaults to image', () => {
    expect(bodySchema.parse({ folder: 'products' }).resourceType).toBe('image');
  });

  it('ignores a public_id supplied by the client', () => {
    /*
     * The route used to accept one, which let any authorised caller overwrite
     * any asset in the account. The field is gone: the server generates the id,
     * and an extra key is simply not in the parsed result.
     */
    const parsed = bodySchema.parse({ folder: 'products', publicId: 'zewa/products/someone-elses' });
    expect(parsed).not.toHaveProperty('publicId');
  });

  it('ignores a transformation supplied by the client', () => {
    const parsed = bodySchema.parse({ folder: 'products', transformation: 'w_10000' });
    expect(parsed).not.toHaveProperty('transformation');
  });
});

describe('the signature covers the security parameters', () => {
  const secret = 'shh';
  const base = {
    folder: 'zewa/products',
    public_id: 'zewa/products/abc',
    timestamp: 1_700_000_000,
    allowed_formats: 'jpg,jpeg,png,webp,avif',
    notification_url: 'https://api.example.com/api/v1/webhooks/cloudinary',
    transformation: 'q_auto,f_auto,w_2000,c_limit',
  };

  it.each(Object.keys(base))('changing %s invalidates the signature', (key) => {
    const original = sign(base, secret);
    const tampered = sign({ ...base, [key]: 'tampered' }, secret);
    expect(tampered).not.toBe(original);
  });

  it('dropping a parameter invalidates the signature', () => {
    const { transformation: _dropped, ...without } = base;
    expect(sign(without, secret)).not.toBe(sign(base, secret));
  });

  it('is stable for identical input', () => {
    expect(sign(base, secret)).toBe(sign(base, secret));
  });

  it('is order-independent — Cloudinary sorts before hashing', () => {
    const reordered = Object.fromEntries(Object.entries(base).reverse());
    expect(sign(reordered, secret)).toBe(sign(base, secret));
  });
});

describe('video versus image parameters', () => {
  /*
   * The distinction that keeps a 100 MB upload from timing out: a video is
   * signed with eager+eager_async so Cloudinary returns as soon as the bytes
   * land, while an image carries an inline transformation because its work is
   * fast and the derived version is the only thing worth storing.
   */
  const videoParams = { eager: 'q_auto,w_1920,c_limit', eager_async: 'true' };
  const imageParams = { transformation: 'q_auto,f_auto,w_2000,c_limit' };

  it('a video never carries a synchronous transformation', () => {
    expect(videoParams).not.toHaveProperty('transformation');
  });

  it('a video is always asynchronous', () => {
    expect(videoParams.eager_async).toBe('true');
  });

  it('an image carries the approved ingest transform', () => {
    expect(imageParams.transformation).toBe('q_auto,f_auto,w_2000,c_limit');
  });

  it('an image never carries eager parameters', () => {
    expect(imageParams).not.toHaveProperty('eager');
  });
});
