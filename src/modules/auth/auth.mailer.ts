/**
 * CMS authentication email delivery — login verification OTP.
 *
 * Sent directly via ZeptoMail rather than BullMQ queue so delivery is immediate
 * on the critical sign-in path.
 */
import { sendEmail } from '@/integrations/zeptomail/zeptomail.client';
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

  try {
    const result = await sendEmail({
      to: [{ email: input.email, name: input.name }],
      subject,
      htmlBody: html,
      reference: `cms-otp-${redact(input.email)}`,
    });
    log.info({ to: redact(input.email), sent: result.sent, skipped: result.skipped }, 'CMS login OTP email dispatched');
    return result;
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
