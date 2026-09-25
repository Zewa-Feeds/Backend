/**
 * The write path for `EmailLog` — one place that records every send attempt.
 *
 * Exists because of the Sep 2026 ZeptoMail outage. Order mail was logged and had
 * a working resend button; CMS login OTP, password resets, verification links and
 * the coin emails were fire-and-forget, so the one class of mail that actually
 * broke was the only class with no record and no way to replay it.
 *
 * Two things this module deliberately does NOT do:
 *
 *   1. **It does not retry.** The BullMQ email worker already owns retries and
 *      the final FAILED transition, with backoff and an attempt cap. A second
 *      retry mechanism here would mean two things racing to mark the same row.
 *   2. **It does not make callers wait.** `logAndSend` returns a promise, but
 *      `account.mailer.ts` calls it without awaiting, exactly as it called
 *      `sendEmail` before. That is load-bearing: awaiting mail would make a
 *      request for a registered address measurably slower than one for an
 *      unknown address, turning response time into an enumeration oracle.
 */
import { EmailStatus, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { sendEmail, type SendEmailInput } from '@/integrations/zeptomail/zeptomail.client';

const log = logger.child({ module: 'email.log' });

/** Error text is truncated to fit the column and keep logs readable. */
const ERROR_MAX = 500;

/**
 * Derive `customerId` from the order when the caller did not supply it.
 *
 * Order mail is created in several places, most of which select only what they
 * need and do not carry the customer id. Resolving it here rather than widening
 * four `select`s keeps the attribution in one place and means it cannot be
 * forgotten at a new call site — the CMS customer page shows a person's mail
 * because of this, so a missed one would look like missing history.
 *
 * Guest orders have no customer, which is why this stays nullable.
 */
async function resolveCustomerId(
  orderId: string | null | undefined,
  customerId: string | null | undefined,
): Promise<string | null> {
  if (customerId) return customerId;
  if (!orderId) return null;
  const order = await prisma.order
    .findUnique({ where: { id: orderId }, select: { customerId: true } })
    .catch(() => null);
  return order?.customerId ?? null;
}

export interface LogAndSendInput extends SendEmailInput {
  /**
   * Template name, so the CMS can filter and a resend can re-render.
   *
   * Nullable because legacy rows predate the column. A resend of one must keep the
   * null rather than substituting a placeholder — a made-up name like "unknown"
   * would show up in the CMS template filter as though it were a real template.
   */
  template: string | null;
  /** Set when the mail belongs to an order. */
  orderId?: string | null;
  /** Set when the recipient is a known customer. */
  customerId?: string | null;
  /** Present when this send replaces an earlier row (§ resend). */
  resentFromId?: string | null;
}

/**
 * Write a QUEUED row, attempt the send, then record the outcome.
 *
 * The row is created BEFORE the provider is called, so an attempt that dies
 * mid-flight still leaves evidence. A row stuck at QUEUED is itself the signal
 * that something died between the write and the outcome.
 */
export async function logAndSend(input: LogAndSendInput): Promise<{ id: string; sent: boolean }> {
  const to = input.to[0]?.email ?? '';

  const row = await prisma.emailLog.create({
    data: {
      template: input.template,
      subject: input.subject,
      toEmail: to,
      bodyHtml: input.htmlBody,
      status: EmailStatus.QUEUED,
      orderId: input.orderId ?? null,
      customerId: await resolveCustomerId(input.orderId, input.customerId),
      resentFromId: input.resentFromId ?? null,
    },
    select: { id: true },
  });

  try {
    const result = await sendEmail(input);
    await finish(row.id, result);
    return { id: row.id, sent: result.sent };
  } catch (err) {
    /*
     * FAILED, not a rethrow.
     *
     * This path serves direct sends (account mail), which have no queue behind
     * them — there is nothing to retry, so the row is terminal. Queue-driven mail
     * goes through `markSent`/`markFailed` from the worker instead, where BullMQ
     * decides when a failure is final.
     */
    const message = err instanceof Error ? err.message : 'Email send failed';
    await prisma.emailLog
      .update({
        where: { id: row.id },
        data: {
          status: EmailStatus.FAILED,
          error: message.slice(0, ERROR_MAX),
          lastAttemptAt: new Date(),
        },
      })
      .catch((e: unknown) => log.error({ err: e, id: row.id }, 'could not mark email FAILED'));
    log.error({ err, template: input.template }, 'email send failed');
    return { id: row.id, sent: false };
  }
}

/** Record a completed provider call against an existing row. */
export async function finish(
  id: string,
  result: { sent: boolean; messageId: string | null; skipped?: boolean },
): Promise<void> {
  /*
   * SKIPPED is its own state.
   *
   * Previously a skipped send left the row at QUEUED with the reason pushed into
   * `error`, so it was indistinguishable from mail still in flight — and during
   * the outage every OTP looked merely slow. "There was no provider" and "the
   * provider refused" need different responses: the first is a config fix, the
   * second is an investigation.
   */
  const status = result.skipped
    ? EmailStatus.SKIPPED
    : result.sent
      ? EmailStatus.SENT
      : EmailStatus.QUEUED;

  await prisma.emailLog.update({
    where: { id },
    data: {
      status,
      providerMessageId: result.messageId,
      sentAt: result.sent ? new Date() : null,
      lastAttemptAt: new Date(),
      error: result.skipped ? 'ZeptoMail not configured — send skipped' : null,
    },
  });
}

/** Terminal failure, called by the worker once BullMQ has exhausted its attempts. */
export async function markFailed(id: string, message: string): Promise<void> {
  await prisma.emailLog
    .update({
      where: { id },
      data: {
        status: EmailStatus.FAILED,
        error: message.slice(0, ERROR_MAX),
        lastAttemptAt: new Date(),
      },
    })
    .catch((err: unknown) => log.error({ err, id }, 'could not mark email FAILED'));
}

/**
 * Open a row for a send the caller will perform itself.
 *
 * Used by the queue path, which renders and sends inside the worker and needs the
 * row id up front so a later attempt can find it again.
 */
export async function open(data: {
  template: string;
  subject: string;
  toEmail: string;
  orderId?: string | null;
  customerId?: string | null;
  resentFromId?: string | null;
  bodyHtml?: string | null;
}): Promise<string> {
  const row = await prisma.emailLog.create({
    data: {
      template: data.template,
      subject: data.subject,
      toEmail: data.toEmail,
      bodyHtml: data.bodyHtml ?? null,
      status: EmailStatus.QUEUED,
      orderId: data.orderId ?? null,
      customerId: await resolveCustomerId(data.orderId, data.customerId),
      resentFromId: data.resentFromId ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

/** Templates whose body must never be replayed. */
const SECURITY_TEMPLATES = new Set([
  'cms-login-otp',
  'cms-user-invitation',
  'password-reset',
  'password-changed',
  'customer-email-verification',
]);

/**
 * True when a template carries a single-use, time-limited token.
 *
 * Resending the stored body of one of these delivers a code that has already
 * expired or been spent — worse than not resending, because the recipient gets
 * mail that cannot work and reads it as the system being broken. The customer
 * flow that mints a fresh token is the correct path, and it already exists.
 */
export function isSecurityTemplate(template: string | null | undefined): boolean {
  return Boolean(template && SECURITY_TEMPLATES.has(template));
}

export type EmailLogRow = Prisma.EmailLogGetPayload<object>;
