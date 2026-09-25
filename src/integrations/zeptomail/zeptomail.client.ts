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
  /**
   * Ask ZeptoMail to report opens for this message (§Phase 2).
   *
   * Implemented provider-side as a 1×1 transparent pixel, so this decides whether
   * an invisible image goes into the mail. Decided per template by
   * `modules/emails/tracking.ts`; omitted entirely when false so the payload is
   * unchanged for everything that does not opt in.
   */
  trackOpens?: boolean;
}

export interface SendEmailResult {
  sent: boolean;
  messageId: string | null;
  skipped?: boolean;
}

/**
 * Build the Authorization header from whatever form the token was pasted in.
 *
 * ZeptoMail's header is `Zoho-enczapikey <token>`, but their dashboard shows the
 * key on its own in some panels and with the prefix in others. Pasting the bare
 * key gets a 401 whose message — "Invalid API Token found" — points at the token
 * being wrong rather than at a missing prefix, which is a long way to go for a
 * copy-paste. Accept either form and normalise here.
 *
 * The comparison is case-insensitive because the docs spell it both
 * "Zoho-enczapikey" and "zoho-enczapikey".
 */
const AUTH_PREFIX = 'Zoho-enczapikey ';

/**
 * Tokens that mean "nobody has configured this yet".
 *
 * `render.yaml` seeds ZEPTOMAIL_TOKEN with a literal placeholder so a fresh
 * deploy boots (the production env check only asserts the variable is SET). The
 * comment there promised that a placeholder would skip sends safely — it did
 * not. The skip below tests `!token`, and a placeholder is a non-empty string,
 * so every send was built with `Zoho-enczapikey placeholder-not-configured` and
 * came back 401 `SERR_157 Invalid API Token found`.
 *
 * That cost real time to diagnose, because the log says the token is INVALID —
 * which reads as "the key is wrong" and sends you to the ZeptoMail dashboard,
 * not to a deploy default that was never replaced. For CMS login OTP it is worse
 * than a wrong key: nobody can sign in, and the reason looks like a provider
 * outage.
 *
 * Matching the placeholder here makes the promise true: an unreplaced default
 * skips loudly and says what to do, instead of impersonating a configured
 * provider. A real key can never collide — ZeptoMail keys are base64-ish blobs.
 */
const PLACEHOLDER_TOKENS = new Set(['placeholder-not-configured', 'placeholder', 'changeme']);

function isConfigured(token: string | undefined): token is string {
  if (!token) return false;
  const bare = token.trim().replace(new RegExp(`^${AUTH_PREFIX.trim()}\\s*`, 'i'), '');
  return bare.length > 0 && !PLACEHOLDER_TOKENS.has(bare.toLowerCase());
}

function authHeader(token: string): string {
  const trimmed = token.trim();
  return trimmed.toLowerCase().startsWith(AUTH_PREFIX.trim().toLowerCase())
    ? trimmed
    : `${AUTH_PREFIX}${trimmed}`;
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  if (!isConfigured(env.ZEPTOMAIL_TOKEN) || !env.ZEPTOMAIL_FROM) {
    log.warn(
      {
        to: input.to.map((t) => t.email),
        subject: input.subject,
        reference: input.reference,
        reason: !env.ZEPTOMAIL_FROM
          ? 'ZEPTOMAIL_FROM is not set'
          : 'ZEPTOMAIL_TOKEN is unset or still the deploy placeholder',
      },
      'ZeptoMail not configured — email skipped. Set ZEPTOMAIL_TOKEN to the real key.',
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
        Authorization: authHeader(env.ZEPTOMAIL_TOKEN),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        from: { address: env.ZEPTOMAIL_FROM, name: env.ZEPTOMAIL_FROM_NAME },
        to: input.to.map((t) => ({ email_address: { address: t.email, name: t.name } })),
        /*
         * Replies go to a mailbox a human reads, not to the sending address.
         * Every one of these emails invites a reply ("something wrong with your
         * order? just reply"), and that promise is only true if the address on
         * the way back is monitored.
         */
        ...(env.ZEPTOMAIL_REPLY_TO
          ? {
              reply_to: [
                { address: env.ZEPTOMAIL_REPLY_TO, name: env.ZEPTOMAIL_REPLY_TO_NAME },
              ],
            }
          : {}),
        subject: input.subject,
        htmlbody: input.htmlBody,
        /*
         * Only sent when tracking is on. ZeptoMail's default is off, so omitting
         * the field leaves every untracked template's payload exactly as it was.
         */
        ...(input.trackOpens ? { track_opens: true } : {}),
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
