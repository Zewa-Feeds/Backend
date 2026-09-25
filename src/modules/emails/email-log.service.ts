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
import { shouldTrackOpens } from './tracking';
import * as settingsService from '@/modules/settings/settings.service';

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
 * Per-template tracking overrides from settings.
 *
 * Returns `{}` on any failure, so the code defaults apply. Tracking is an
 * enhancement — a settings outage must never prevent an email being sent.
 */
async function trackingOverrides(): Promise<Record<string, boolean>> {
  try {
    const s = await settingsService.get('emailTracking');
    return s?.templates ?? {};
  } catch {
    return {};
  }
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

  /*
   * Decided ONCE, then both stored and sent.
   *
   * The column has to record what was actually asked of the provider, not what the
   * config says now: a template switched off next week must not make last week's
   * genuine open look like a row that was never tracked.
   *
   * A settings read that fails falls back to the code defaults rather than throwing
   * — tracking is an enhancement, and losing it must never stop an email.
   */
  const trackOpens = shouldTrackOpens(input.template, await trackingOverrides());

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
      trackOpens,
    },
    select: { id: true },
  });

  try {
    const result = await sendEmail({ ...input, trackOpens });
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

/**
 * Record an open against whichever rows carry these provider message ids.
 *
 * Returns how many rows were touched, so the route can log a notification that
 * matched nothing — the likeliest symptom of a misconfigured Mail Agent.
 *
 * Three decisions worth stating:
 *
 *   - `openedAt` is set ONLY on the first open (§ZeptoMail fires the opens webhook
 *     on first open, but retries mean the same one can arrive twice). `openCount`
 *     still increments, so a retry is visible as a count without corrupting "when
 *     did they first read it".
 *   - Rows with `trackOpens: false` are SKIPPED. If tracking was never requested
 *     for a template, an open event for it is either a stale row from before the
 *     setting changed or something forged, and neither should write.
 *   - An unknown message id is not an error. The Mail Agent may carry mail from
 *     another system, and a notification for a row we do not have is ignored.
 */
export async function recordOpens(messageIds: string[]): Promise<number> {
  const ids = [...new Set(messageIds.filter((m) => typeof m === 'string' && m.trim()))];
  if (ids.length === 0) return 0;

  const rows = await prisma.emailLog.findMany({
    where: { providerMessageId: { in: ids }, trackOpens: true },
    select: { id: true, openedAt: true },
  });
  if (rows.length === 0) return 0;

  /*
   * Two statements, not one updateMany: the first open must stamp `openedAt` while
   * a repeat must leave it alone, and `updateMany` cannot express a per-row
   * conditional. Grouping keeps it to two queries regardless of batch size.
   */
  const firstTime = rows.filter((r) => r.openedAt === null).map((r) => r.id);
  const repeat = rows.filter((r) => r.openedAt !== null).map((r) => r.id);
  const now = new Date();

  if (firstTime.length > 0) {
    await prisma.emailLog.updateMany({
      where: { id: { in: firstTime } },
      data: { openedAt: now, openCount: { increment: 1 } },
    });
  }
  if (repeat.length > 0) {
    await prisma.emailLog.updateMany({
      where: { id: { in: repeat } },
      data: { openCount: { increment: 1 } },
    });
  }

  return rows.length;
}

/*
 * Re-exported, not redefined.
 *
 * The same list governs two rules — never replay this body, and never put a
 * tracking pixel in it — and they must not drift. A template that is too sensitive
 * to track is exactly one that is too sensitive to replay.
 */
export { isSecurityTemplate } from './tracking';

export type EmailLogRow = Prisma.EmailLogGetPayload<object>;
