/**
 * Marketing email consent: opt-in, unsubscribe, and who a broadcast may reach.
 *
 * THE RULES (agreed Nov 2026, after the close-out review):
 *   - New customers are asked. An unticked "Send me founder's letters and
 *     offers" box at signup and checkout; ticking it stamps
 *     Customer.marketingOptInAt.
 *   - Customers who registered before consent was collected
 *     (MARKETING_CONSENT_FROM) keep receiving broadcasts until they
 *     unsubscribe. They bought from Zewa and were never offered the choice.
 *   - Every broadcast carries a one-click unsubscribe link. Clicking it writes
 *     the email to MarketingOptOut, and every later broadcast skips it,
 *     whichever audience staff pick in the CMS.
 *   - Ticking the box again later is fresh consent and clears the opt-out.
 *
 * Order, account and Seeds emails are transactional and are NOT affected.
 *
 * UNSUBSCRIBE LINKS are `<email>.<HMAC>`, signed with JWT_ACCESS_SECRET under
 * a purpose prefix, so no token table is needed and a link cannot be forged
 * for someone else's address. Rotating JWT_ACCESS_SECRET invalidates links in
 * emails already sent. The unsubscribe page then tells the reader to write
 * to info@zewafeeds.com, and staff can add the address to MarketingOptOut.
 */
import { createHmac } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { safeEqual } from '@/lib/crypto';
import { env } from '@/config/env';

/** Consent collection went live on this date. Anyone registered before it is an existing customer. */
export const MARKETING_CONSENT_FROM = new Date('2026-11-11T00:00:00+05:30');

type Db = Prisma.TransactionClient | typeof prisma;

const norm = (email: string) => email.trim().toLowerCase();

function sign(email: string): string {
  return createHmac('sha256', env.JWT_ACCESS_SECRET).update(`unsubscribe:${norm(email)}`).digest('base64url');
}

/** The token placed in a broadcast's unsubscribe link. */
export function unsubscribeToken(email: string): string {
  return `${Buffer.from(norm(email)).toString('base64url')}.${sign(email)}`;
}

/** The email a token was issued for, or null if it is malformed or forged. */
export function verifyUnsubscribeToken(token: string): string | null {
  const [encoded, mac] = String(token ?? '').split('.');
  if (!encoded || !mac) return null;
  let email: string;
  try {
    email = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!email.includes('@')) return null;
  return safeEqual(mac, sign(email)) ? norm(email) : null;
}

export function unsubscribeUrl(email: string): string {
  return `${env.STOREFRONT_ORIGIN}/unsubscribe?t=${encodeURIComponent(unsubscribeToken(email))}`;
}

/** Record an unsubscribe. Idempotent. */
export async function optOut(email: string, source = 'email-link', db: Db = prisma): Promise<void> {
  const e = norm(email);
  await db.marketingOptOut.upsert({ where: { email: e }, create: { email: e, source }, update: {} });
}

/**
 * Record a ticked consent box. Stamps the customer (first consent wins, so the
 * date stays the original one) and clears any earlier unsubscribe.
 */
export async function recordOptIn(customerId: string, email: string, db: Db = prisma): Promise<void> {
  await db.customer.updateMany({ where: { id: customerId, marketingOptInAt: null }, data: { marketingOptInAt: new Date() } });
  await db.marketingOptOut.deleteMany({ where: { email: norm(email) } });
}

/** Of these addresses, the ones that have unsubscribed (lower-cased). */
export async function optedOutAmong(emails: string[], db: Db = prisma): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const rows = await db.marketingOptOut.findMany({
    where: { email: { in: emails.map(norm) } },
    select: { email: true },
  });
  return new Set(rows.map((r) => r.email));
}

/**
 * The Customer filter for the "all" and "with orders" audiences: consented,
 * or registered before consent was collected.
 */
export const broadcastEligible: Prisma.CustomerWhereInput = {
  OR: [{ marketingOptInAt: { not: null } }, { registeredAt: { lt: MARKETING_CONSENT_FROM } }],
};
