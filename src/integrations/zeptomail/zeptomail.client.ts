/**
 * ZeptoMail transactional email client (§15).
 *
 * Plain fetch against ZeptoMail's v1.1 API rather than their SDK — one endpoint,
 * one auth header, and no extra dependency to keep patched.
 *
 * When no token is configured, sends are LOGGED and reported as skipped rather
 * than thrown. That keeps dev and CI usable while making the no-op obvious, and
 * production refuses to boot without a token (see config/env.ts).
 */
import { env } from '@/config/env';
import { logger } from '@/lib/logger';
import { upstreamFailed } from '@/lib/errors';

const log = logger.child({ module: 'zeptomail' });

const API_URL = 'https://api.zeptomail.in/v1.1/email';
const TIMEOUT_MS = 15_000;

export interface SendEmailInput {
  to: { email: string; name?: string }[];
  subject: string;
  htmlBody: string;
  textBody?: string;
  attachments?: { name: string; content: string; mimeType: string }[];
  /** Correlates a send with the order it belongs to, in logs. */
  reference?: string;
}

export interface SendEmailResult {
  sent: boolean;
  messageId: string | null;
  skipped?: boolean;
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  if (!env.ZEPTOMAIL_TOKEN || !env.ZEPTOMAIL_FROM) {
    log.warn(
      { to: input.to.map((t) => t.email), subject: input.subject, reference: input.reference },
      'ZeptoMail not configured — email skipped',
    );
    return { sent: false, messageId: null, skipped: true };
  }

  // A hung mail provider must not hold a queue worker open indefinitely.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        // ZeptoMail expects the token verbatim, including its "Zoho-enczapikey" prefix.
        Authorization: env.ZEPTOMAIL_TOKEN,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        from: { address: env.ZEPTOMAIL_FROM, name: env.ZEPTOMAIL_FROM_NAME },
        to: input.to.map((t) => ({ email_address: { address: t.email, name: t.name } })),
        subject: input.subject,
        htmlbody: input.htmlBody,
        ...(input.textBody ? { textbody: input.textBody } : {}),
        ...(input.attachments?.length
          ? {
              attachments: input.attachments.map((a) => ({
                name: a.name,
                content: a.content,
                mime_type: a.mimeType,
              })),
            }
          : {}),
      }),
      signal: controller.signal,
    });

    const payload = (await response.json().catch(() => ({}))) as {
      data?: { message_id?: string }[];
      message?: string;
      error?: unknown;
    };

    if (!response.ok) {
      log.error(
        { status: response.status, payload, reference: input.reference },
        'zeptomail rejected the send',
      );
      // Thrown so BullMQ retries — a 5xx or rate limit is usually transient.
      throw upstreamFailed('ZeptoMail');
    }

    const messageId = payload.data?.[0]?.message_id ?? null;
    log.info(
      { to: input.to.map((t) => t.email), subject: input.subject, messageId, reference: input.reference },
      'email sent',
    );
    return { sent: true, messageId };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      log.error({ reference: input.reference }, 'zeptomail request timed out');
      throw upstreamFailed('ZeptoMail');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
