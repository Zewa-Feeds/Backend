/**
 * CMS authentication email delivery — login verification OTP.
 *
 * Sent directly via ZeptoMail rather than BullMQ queue so delivery is immediate
 * on the critical sign-in path.
 */
import { logAndSend } from '@/modules/emails/email-log.service';
import { accountTemplates } from '@/integrations/zeptomail/templates';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'auth.mailer' });

export interface SendCmsOtpInput {
  email: string;
  name: string;
  code: string;
  expiresInMinutes: number;
}

export async function sendCmsLoginOtp(input: SendCmsOtpInput): Promise<{ sent: boolean; skipped?: boolean }> {
  const build = accountTemplates['cms-login-otp'];
  const { subject, html } = build({
    recipientName: input.name,
    otpCode: input.code,
    expiresInMinutes: input.expiresInMinutes,
    requestedAt: new Date(),
  });

  /*
   * Awaited, unlike account mail: the sign-in route reports "we could not send
   * your code" to the operator, so it has to know the outcome. That contract is
   * unchanged — `logAndSend` only adds the EmailLog row around the same call.
   *
   * This is the email that broke in Sep 2026. It had no row, so there was nothing
   * to look at during the outage and nothing to resend afterwards. It has one now
   * — but note it is a SECURITY template: the row exists to make the failure
   * visible, NOT to be replayed. The code inside it expires, so recovery is the
   * operator requesting a new one.
   */
  try {
    const result = await logAndSend({
      to: [{ email: input.email, name: input.name }],
      subject,
      htmlBody: html,
      reference: `cms-otp-${redact(input.email)}`,
      template: 'cms-login-otp',
    });
    log.info({ to: redact(input.email), sent: result.sent }, 'CMS login OTP email dispatched');
    return { sent: result.sent };
  } catch (err) {
    log.error({ err, to: redact(input.email) }, 'failed to send CMS login OTP email');
    return { sent: false };
  }
}

function redact(email: string): string {
  const [name, domain] = email.split('@');
  if (!domain || !name) return '***';
  return `${name.slice(0, 2)}***@${domain}`;
}
