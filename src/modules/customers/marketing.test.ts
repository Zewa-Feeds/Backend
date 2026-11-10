/**
 * Marketing consent: who a CMS broadcast reaches, and the unsubscribe link.
 *
 * Driven against the test database through the real sendCustomerEmail(), with
 * only the mail transport mocked, so the audience filtering is what is proved.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const sendEmail = vi.hoisted(() => vi.fn(async () => ({ sent: true })));
vi.mock('@/integrations/zeptomail/zeptomail.client', () => ({ sendEmail }));

import { PrismaClient } from '@prisma/client';
import { sendCustomerEmail } from './customers.service';
import {
  MARKETING_CONSENT_FROM,
  optOut,
  recordOptIn,
  unsubscribeToken,
  verifyUnsubscribeToken,
} from './marketing';
import { testActor, testCtx } from '@/test/fixtures';

const prisma = new PrismaClient();
const TAG = 'zzmkt';
let ctx: ReturnType<typeof testCtx>;

const before = new Date(MARKETING_CONSENT_FROM.getTime() - 86_400_000);
const after = new Date(MARKETING_CONSENT_FROM.getTime() + 86_400_000);

async function sweep() {
  await prisma.marketingOptOut.deleteMany({ where: { email: { startsWith: TAG } } });
  await prisma.customer.deleteMany({ where: { email: { startsWith: TAG } } });
}

async function customer(label: string, registeredAt: Date) {
  return prisma.customer.create({
    data: { email: `${TAG}-${label}@zewafeeds.test`, firstName: label, lastName: 'Test', registeredAt },
    select: { id: true, email: true },
  });
}

const recipients = () =>
  sendEmail.mock.calls
    .map((c) => ((c as unknown[])[0] as { to: { email: string }[] }).to[0]?.email ?? '')
    .filter((e) => e.startsWith(TAG))
    .sort();

beforeAll(async () => {
  await sweep();
  ctx = testCtx(await testActor(prisma));
  await customer('existing', before);
  const consented = await customer('consented', after);
  await recordOptIn(consented.id, consented.email);
  await customer('silent', after);
  const leaver = await customer('leaver', before);
  await optOut(leaver.email);
});

beforeEach(() => sendEmail.mockClear());

afterAll(async () => {
  await sweep();
  await prisma.$disconnect();
});

const msg = { heading: 'Hello', message: 'A founder letter.', subject: 'Letter' };

describe('who a broadcast reaches', () => {
  it('"all customers": existing customers and new ones who opted in, never an unsubscriber', async () => {
    const res = await sendCustomerEmail({ ...msg, audience: 'all' } as never, ctx as never);
    expect(recipients()).toEqual([`${TAG}-consented@zewafeeds.test`, `${TAG}-existing@zewafeeds.test`]);
    expect(res.message).toMatch(/skipped: unsubscribed/);
  });

  it('a hand-picked send still skips an address that unsubscribed', async () => {
    await sendCustomerEmail(
      { ...msg, audience: 'custom', customEmails: [`${TAG}-leaver@zewafeeds.test`, `${TAG}-other@zewafeeds.test`] } as never,
      ctx as never,
    );
    expect(recipients()).toEqual([`${TAG}-other@zewafeeds.test`]);
  });

  it('every broadcast carries a working unsubscribe link for its recipient', async () => {
    await sendCustomerEmail({ ...msg, audience: 'custom', customEmails: [`${TAG}-other@zewafeeds.test`] } as never, ctx as never);
    const html = ((sendEmail.mock.calls[0] as unknown[])[0] as { htmlBody: string }).htmlBody;
    const token = decodeURIComponent(html.match(/unsubscribe\?t=([^"&]+)/)?.[1] ?? "");
    expect(verifyUnsubscribeToken(token)).toBe(`${TAG}-other@zewafeeds.test`);
  });

  it('ticking the box again clears an earlier unsubscribe', async () => {
    const leaver = await prisma.customer.findUniqueOrThrow({ where: { email: `${TAG}-leaver@zewafeeds.test` } });
    await recordOptIn(leaver.id, leaver.email);
    expect(await prisma.marketingOptOut.count({ where: { email: leaver.email } })).toBe(0);
  });
});

describe('unsubscribe tokens', () => {
  it('round-trips, case-insensitively', () => {
    expect(verifyUnsubscribeToken(unsubscribeToken('Priya@Example.com'))).toBe('priya@example.com');
  });

  it('rejects a token re-pointed at someone else', () => {
    const mac = unsubscribeToken('a@example.com').split('.')[1] ?? '';
    const forged = `${Buffer.from('b@example.com').toString('base64url')}.${mac}`;
    expect(verifyUnsubscribeToken(forged)).toBeNull();
    expect(verifyUnsubscribeToken('garbage')).toBeNull();
  });
});
