/**
 * Image and video uploads — /api/v1/admin/uploads
 *
 * Signed-upload pattern: the browser uploads DIRECTLY to Cloudinary using a
 * short-lived signature minted here. The bytes never pass through this API —
 * which matters most for video, where proxying a 100 MB file would tie up the
 * event loop and blow memory.
 *
 * Why this way rather than proxying the file:
 *   - no multipart handling, no temp files, no memory spike on a 10 MB photo
 *   - the API secret stays server-side; the browser only ever sees a signature
 *     scoped to one folder and one timestamp
 *   - Cloudinary enforces the constraints we sign (folder, allowed formats), so a
 *     tampered client cannot upload elsewhere in the account
 */
import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '@/middleware/asyncHandler';
import { requirePermission } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { notConfigured } from '@/lib/errors';
import { env } from '@/config/env';

export const uploadsRouter = Router();

// Uploading is an editorial action: products need products.edit, and content
// authors need articles.create. products.view would be too permissive — an Editor
// with read-only product access should not be able to fill the asset library.
uploadsRouter.use(requirePermission('articles.create'));

/** Folders a signature may target. An allowlist, so a client cannot pick its own. */
const FOLDERS = ['products', 'articles', 'spotlights'] as const;

/**
 * Cloudinary resource types we mint signatures for.
 *
 * This is part of the SIGNED payload and selects the upload endpoint, so a client
 * cannot upload a 200 MB video against an image signature (or vice versa) — the
 * signature would not match.
 */
const RESOURCE_TYPES = ['image', 'video'] as const;
type ResourceType = (typeof RESOURCE_TYPES)[number];

/**
 * Ingest transformation for IMAGES, applied by Cloudinary during upload.
 *
 * Signed, so the client cannot remove it and push an untouched 40 MB original.
 * Caps at 2000px with auto format/quality (serves WebP/AVIF where supported).
 *
 * Images only. Video deliberately does NOT use `transformation` — see below.
 */
const IMAGE_INGEST_TRANSFORM = 'q_auto,f_auto,w_2000,c_limit';

/**
 * Video processing, requested as an ASYNCHRONOUS EAGER transformation.
 *
 * WHY THIS MATTERS: passing `transformation` on a video upload makes Cloudinary
 * transcode BEFORE responding. Measured on this account, a 10.9 MB 1080p clip
 * took 43 SECONDS to return. A 67 MB file therefore runs for minutes, and the
 * browser gives up long before that — the upload appeared to "vanish" with no
 * error because the request never completed.
 *
 * `eager` + `eager_async=true` instead returns as soon as the bytes land and
 * transcodes in the background. The original is stored and immediately
 * playable, so nothing depends on the derived version being ready.
 *
 * Both values are signed, so a client cannot switch back to a synchronous
 * transform or request arbitrary (billable) derivations.
 */
const VIDEO_EAGER_TRANSFORM = 'q_auto,w_1920,c_limit';

/**
 * Formats Cloudinary will accept. Anything else is rejected at ingest, so a
 * renamed `.exe` never lands in the account even if the client-side check is
 * bypassed.
 */
const ALLOWED_FORMATS: Record<ResourceType, string> = {
  image: 'jpg,jpeg,png,webp,avif',
  video: 'mp4,webm,mov',
};

/**
 * Mint an upload signature.
 *
 * Cloudinary's scheme: sort the params alphabetically, join as a query string,
 * append the API secret, SHA-1 the result. The browser sends the same params plus
 * this signature; Cloudinary rejects any mismatch, so the client cannot alter the
 * folder or add transformations we did not authorise.
 */
uploadsRouter.post(
  '/signature',
  validate({
    body: z.object({
      folder: z.enum(FOLDERS),
      /** Defaults to image, so existing callers keep working unchanged. */
      resourceType: z.enum(RESOURCE_TYPES).optional().default('image'),
      /** Optional public_id so a re-upload can replace an existing asset. */
      publicId: z
        .string()
        .trim()
        .max(120)
        .regex(/^[\w-]+$/, 'Use letters, numbers, hyphens and underscores only.')
        .optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
      throw notConfigured('Cloudinary');
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const folder = `zewa/${req.body.folder}`;
    const resourceType: ResourceType = req.body.resourceType;

    /*
     * Every param here is signed, so the client cannot change any of them.
     *
     * Images transform inline (fast, and we want the derived version to be the
     * only thing stored). Video uses eager+async so the request returns as soon
     * as the bytes arrive — see VIDEO_EAGER_TRANSFORM for why.
     */
    const params: Record<string, string | number> =
      resourceType === 'video'
        ? {
            folder,
            timestamp,
            eager: VIDEO_EAGER_TRANSFORM,
            eager_async: 'true',
            allowed_formats: ALLOWED_FORMATS.video,
            ...(req.body.publicId ? { public_id: req.body.publicId } : {}),
          }
        : {
            folder,
            timestamp,
            transformation: IMAGE_INGEST_TRANSFORM,
            allowed_formats: ALLOWED_FORMATS.image,
            ...(req.body.publicId ? { public_id: req.body.publicId } : {}),
          };

    const toSign = Object.keys(params)
      .sort()
      .map((key) => `${key}=${params[key]}`)
      .join('&');

    const signature = createHash('sha1')
      .update(`${toSign}${env.CLOUDINARY_API_SECRET}`)
      .digest('hex');

    res.json({
      data: {
        signature,
        timestamp,
        apiKey: env.CLOUDINARY_API_KEY,
        cloudName: env.CLOUDINARY_CLOUD_NAME,
        folder,
        resourceType,
        // Exactly one of these is set. The client must echo back whichever it
        // receives, and nothing else, or the signature check fails.
        ...(params.transformation ? { transformation: params.transformation } : {}),
        ...(params.eager ? { eager: params.eager, eagerAsync: 'true' } : {}),
        allowedFormats: params.allowed_formats,
        /** Client-side pre-check limit, so the browser and Cloudinary agree. */
        maxBytes: resourceType === 'video' ? 100 * 1024 * 1024 : 10 * 1024 * 1024,
        ...(req.body.publicId ? { publicId: req.body.publicId } : {}),
        // Resource type selects the endpoint; a video posted to /image/upload is
        // rejected by Cloudinary regardless of signature validity.
        uploadUrl: `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/${resourceType}/upload`,
      },
    });
  }),
);
