/**
 * ZeptoMail notifications — /api/v1/webhooks/zeptomail
 *
 * Unauthenticated by necessity: ZeptoMail cannot hold a CMS session. The
 * `producer-signature` HMAC is the entire authentication, so it is verified before
 * the body is parsed, let alone acted on. Without that, this endpoint is an open
 * write into the mail log and "opened" stops meaning anything.
 *
 * Answers 200 once the signature checks out, including for events it does not act
 * on: ZeptoMail retries anything else, and retrying a notification we have
 * deliberately ignored achieves nothing but load. A bad signature gets 401 so a
 * misconfigured Mail Agent is visible rather than silently swallowed.
 */
import { Router, type Request } from 'express';
import { asyncHandler } from '@/middleware/asyncHandler';
import { logger } from '@/lib/logger';
import {
  interpret,
  verifyWebhook,
  type ZeptoNotification,
} from '@/integrations/zeptomail/webhook';
import * as emailLog from './email-log.service';

export const zeptomailWebhookRouter = Router();

const log = logger.child({ module: 'zeptomail-webhook' });

/**
 * The bytes as ZeptoMail sent them.
 *
 * The HMAC covers the RAW body, so the route is mounted with express.raw — see
 * app.ts. The fallbacks are defensive: if something upstream ever parses this
 * first, verification fails loudly rather than silently accepting anything.
 */
function rawBody(req: Request): string {
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  return typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
}

zeptomailWebhookRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const raw = rawBody(req);
    const verified = verifyWebhook(raw, req.get('producer-signature'));

    if (!verified.ok) {
      /*
       * Logged at warn, including the reason. NOT_CONFIGURED in particular is a
       * deployment problem that would otherwise look identical to an attack —
       * exactly the confusion the Phase 1 placeholder-token incident caused.
       */
      log.warn({ reason: verified.reason }, 'rejected zeptomail notification');
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid signature.' } });
      return;
    }

    let body: ZeptoNotification;
    try {
      body = JSON.parse(raw) as ZeptoNotification;
    } catch {
      // Signed but unparseable. Nothing a retry could fix.
      res.status(200).json({ data: { handled: false, reason: 'unparseable body' } });
      return;
    }

    const outcome = interpret(body);
    if (outcome.kind === 'IGNORED') {
      log.debug(
        { reason: outcome.reason, event: body.event_name, requestId: body.webhook_request_id },
        'notification ignored',
      );
      res.status(200).json({ data: { handled: false, reason: outcome.reason } });
      return;
    }

    const matched = await emailLog.recordOpens(outcome.messageIds);

    /*
     * A notification that matched nothing is logged at INFO rather than passed over:
     * it is the likeliest symptom of the Mail Agent being pointed at the wrong
     * environment, and silence would make that indistinguishable from "no opens
     * yet".
     */
    if (matched === 0) {
      log.info(
        { ids: outcome.messageIds.length, requestId: body.webhook_request_id },
        'open event matched no tracked email',
      );
    } else {
      log.info({ matched, requestId: body.webhook_request_id }, 'recorded email opens');
    }

    res.status(200).json({ data: { handled: true, matched } });
  }),
);
