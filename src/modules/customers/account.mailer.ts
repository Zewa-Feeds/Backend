/**
 * Account email delivery — password reset and password-changed notices.
 *
 * Sent DIRECTLY rather than through the BullMQ email queue, for three reasons:
 *
 *   1. `CustomerEmailJob` is keyed to an order: it carries `orderNo` and an
 *      `orderEmailId` audit row to flip to SENT. Account mail has no order, so
 *      riding that queue would mean inventing a fake one.
 *   2. Redis is not guaranteed. An exhausted cache quota already took the queue
 *      down once, and "you cannot recover your account until the cache is
 *      topped up" is not an acceptable failure mode for password reset.
 *   3. Volume is negligible — one message per human request, not per order.
 *
 * Delivery is fire-and-forget on purpose. The caller must not await it: waiting
 * would make a request for a registered address measurably slower than one for
 * an unknown address, turning response time into an account-enumeration oracle.
 * Failures are logged, never surfaced to the caller.
 */
import { sendEmail } from '@/integrations/zeptomail/zeptomail.client';
import { accountTemplates, type AccountTemplateName } from '@/integrations/zeptomail/templates';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'customer.mail' });

/** Context accepted by each account template, keyed by template name. */
type AccountContext = {
  'password-reset': { firstName: string; resetUrl: string; expiresInMinutes: number };
  'password-changed': { firstName: string };
};

/**
 * Queue-free send. Returns immediately; the promise is handled internally.
 *
 * `void` rather than `Promise<void>` in the signature is the point — it makes
 * awaiting this at a call site a type error, which is what keeps the timing
 * guarantee above from being undone by a well-meaning `await`.
 */
export function sendAccountEmail<T extends AccountTemplateName>(
  to: string,
  template: T,
  context: AccountContext[T],
): void {
  const build = accountTemplates[template] as (ctx: AccountContext[T]) => {
    subject: string;
    html: string;
  };
  const { subject, html } = build(context);

  void sendEmail({ to: [{ email: to }], subject, htmlBody: html, reference: template })
    .then(() => log.info({ template, to: redact(to) }, 'account email sent'))
    .catch((err: unknown) => {
      // Swallowed deliberately: the HTTP response has already been decided, and
      // a mail outage must not tell a caller whether the address exists.
      log.error({ err, template, to: redact(to) }, 'account email failed');
    });
}

/** Log addresses partially — enough to correlate, not enough to harvest. */
function redact(email: string): string {
  const [name, domain] = email.split('@');
  if (!domain || !name) return '***';
  return `${name.slice(0, 2)}***@${domain}`;
}
