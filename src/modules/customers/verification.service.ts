/**
 * Issuing a customer email-verification link.
 *
 * Extracted so the public "resend verification" route and the CMS operator button
 * share one implementation. They must not drift: both have to invalidate the
 * customer's previous unused tokens and mint a fresh one, because the token is
 * single-use and short-lived.
 *
 * This is the correct answer to "the verification email failed, now what?" — the
 * old email cannot simply be resent, since its token either expired or was already
 * spent. A new token is the only thing that can work.
 */
import { CustomerStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { env } from '@/config/env';
import { generateToken, hashToken } from '@/lib/crypto';
import { sendAccountEmail } from './account.mailer';

export const VERIFICATION_TTL_HOURS = 24;

export interface IssueResult {
  /** False when the customer does not qualify — unknown, banned, or already verified. */
  issued: boolean;
  reason?: 'not-found' | 'banned' | 'already-verified' | 'guest';
}

/**
 * Mint a verification token for this customer and email it.
 *
 * Every previously unused token is marked spent first, so an older link in an
 * older inbox cannot still be used after a new one is issued.
 */
export async function issueVerification(email: string): Promise<IssueResult> {
  const customer = await prisma.customer.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      firstName: true,
      passwordHash: true,
      status: true,
      emailVerifiedAt: true,
    },
  });

  if (!customer) return { issued: false, reason: 'not-found' };
  // No password means a guest order record, not a registered account.
  if (!customer.passwordHash) return { issued: false, reason: 'guest' };
  if (customer.status === CustomerStatus.BANNED) return { issued: false, reason: 'banned' };
  if (customer.emailVerifiedAt) return { issued: false, reason: 'already-verified' };

  await prisma.customerEmailVerification.updateMany({
    where: { customerId: customer.id, usedAt: null },
    data: { usedAt: new Date() },
  });

  const verifyToken = generateToken(32);
  await prisma.customerEmailVerification.create({
    data: {
      customerId: customer.id,
      tokenHash: hashToken(verifyToken),
      expiresAt: new Date(Date.now() + VERIFICATION_TTL_HOURS * 3600 * 1000),
    },
  });

  sendAccountEmail(
    customer.email,
    'customer-email-verification',
    {
      firstName: customer.firstName,
      verifyUrl: `${env.STOREFRONT_ORIGIN}/verify-email?token=${encodeURIComponent(verifyToken)}`,
      expiresInHours: VERIFICATION_TTL_HOURS,
    },
    customer.id,
  );

  return { issued: true };
}
