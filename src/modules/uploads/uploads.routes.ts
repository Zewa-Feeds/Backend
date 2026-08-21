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
import { createHash, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '@/middleware/asyncHandler';
import { requirePermission } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { notConfigured } from '@/lib/errors';
import { env } from '@/config/env';
import { currentUser } from '@/middleware/auth';
import { openTicket } from './lifecycle.service';
import { prisma } from '@/lib/prisma';

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
      /**
       * The product being edited, so an abandoned upload can be traced back.
       * Optional: articles and spotlights are not part of a product gallery.
       */
      slug: z.string().trim().max(120).optional(),
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
     * THE PUBLIC ID IS GENERATED HERE, never accepted from the client.
     *
     * Two things follow from that. A client cannot aim an upload at an existing
     * asset and overwrite it — the previous version of this route took a
     * `publicId` parameter, which let any authorised caller replace any file in
     * the account. And because the server decides the name, it can record what
     * is about to exist BEFORE the browser is told where to upload, which is the
     * only way an abandoned upload is ever findable again.
     */
    const fileId = randomUUID();
    const publicId = `${folder}/${fileId}`;

    const family = req.body.slug
      ? await prisma.productFamily.findFirst({
          where: { slug: req.body.slug, deletedAt: null },
          select: { id: true },
        })
      : null;

    /*
     * Where Cloudinary reports the outcome.
     *
     * Signed, so a client cannot point notifications elsewhere or strip them to
     * keep an upload from ever being marked FAILED. Omitted when no public
     * origin is configured — locally there is nothing for Cloudinary to reach,
     * and the reconciliation sweep covers that case.
     */
    const notificationUrl = env.PUBLIC_API_ORIGIN
      ? `${env.PUBLIC_API_ORIGIN.replace(/\/$/, '')}/api/v1/webhooks/cloudinary`
      : null;

    /*
     * Every param here is signed, so the client cannot change any of them.
     *
     * Images transform inline (fast, and the derived version is the only thing
     * stored). Video uses eager+async so the request returns as soon as the
     * bytes arrive — see VIDEO_EAGER_TRANSFORM for why.
     */
    const params: Record<string, string | number> = {
      folder,
      public_id: fileId,
      timestamp,
      allowed_formats: ALLOWED_FORMATS[resourceType],
      ...(notificationUrl ? { notification_url: notificationUrl } : {}),
      ...(resourceType === 'video'
        ? {
            eager: VIDEO_EAGER_TRANSFORM,
            eager_async: 'true',
            ...(notificationUrl ? { eager_notification_url: notificationUrl } : {}),
          }
        : { transformation: IMAGE_INGEST_TRANSFORM }),
    };

    // Recorded before the browser is told anything, so an upload that never
    // comes back is still traceable. See UploadTicket.
    await openTicket({
      publicId,
      resourceType,
      folder,
      familyId: family?.id ?? null,
      requestedById: currentUser(req).id,
    });

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
        /* The client MUST echo this back unchanged; it is part of the signature. */
        publicId: fileId,
        ...(notificationUrl ? { notificationUrl } : {}),
        ...(params.eager_notification_url ? { eagerNotificationUrl: params.eager_notification_url } : {}),
        /** Client-side pre-check limit, so the browser and Cloudinary agree. */
        maxBytes: resourceType === 'video' ? 100 * 1024 * 1024 : 10 * 1024 * 1024,
        // Resource type selects the endpoint; a video posted to /image/upload is
        // rejected by Cloudinary regardless of signature validity.
        uploadUrl: `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/${resourceType}/upload`,
      },
    });
  }),
);
