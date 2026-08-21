/**
 * Cloudinary notifications — /api/v1/webhooks/cloudinary
 *
 * Unauthenticated by necessity: Cloudinary cannot hold a CMS session. The
 * signature is the entire authentication, so verification happens before the
 * body is looked at, let alone acted on.
 *
 * Always answers 200 once the signature checks out, including for notifications
 * it does not act on. Cloudinary retries anything else, and retrying a
 * notification we have deliberately ignored achieves nothing but load. A
 * rejected signature gets 401 so a misconfiguration is visible rather than
 * silently swallowed.
 */
import { Router, type Request } from 'express';
import { asyncHandler } from '@/middleware/asyncHandler';
import { logger } from '@/lib/logger';
import { interpret, verifyNotification, type Notification } from '@/integrations/cloudinary/webhook';
import { applyNotification } from './lifecycle.service';

export const cloudinaryWebhookRouter = Router();

const log = logger.child({ module: 'cloudinary-webhook' });

/**
 * The bytes as Cloudinary sent them.
 *
 * The signature covers the RAW body: re-serialising parsed JSON changes key
 * order and whitespace and every signature fails. The route is mounted with
 * express.raw for this reason — see app.ts.
 */
function rawBody(req: Request): string {
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  // Defensive: if something upstream ever parses this first, signature
  // verification will fail loudly rather than silently accepting anything.
  return typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
}

cloudinaryWebhookRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const raw = rawBody(req);
    const verified = verifyNotification(
      raw,
      req.get('x-cld-signature'),
      req.get('x-cld-timestamp'),
    );

    if (!verified.ok) {
      log.warn({ reason: verified.reason }, 'rejected cloudinary notification');
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid signature.' } });
      return;
    }

    let body: Notification;
    try {
      body = JSON.parse(raw) as Notification;
    } catch {
      // Signed but unparseable. Nothing to retry into.
      res.status(200).json({ data: { handled: false, reason: 'unparseable body' } });
      return;
    }

    const outcome = interpret(body);
    if (outcome.kind === 'IGNORED') {
      log.debug({ reason: outcome.reason, type: body.notification_type }, 'notification ignored');
      res.status(200).json({ data: { handled: false, reason: outcome.reason } });
      return;
    }

    const result = await applyNotification({
      publicId: outcome.publicId,
      outcome: outcome.kind,
      reason: outcome.kind === 'FAILED' ? outcome.reason : undefined,
      width: body.width ?? null,
      height: body.height ?? null,
      durationSec: body.duration ?? null,
    });

    log.info({ publicId: outcome.publicId, outcome: outcome.kind, ...result }, 'notification applied');
    res.status(200).json({ data: { handled: true, outcome: outcome.kind, ...result } });
  }),
);
