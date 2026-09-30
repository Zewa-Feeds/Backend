/**
 * A staff alert must reach every operator it is addressed to.
 *
 * A new-order alert addressed to info@, an admin and an ops manager arrived at
 * ONE of the three. All of them were ACTIVE and eligible, and the recipient
 * query was correct — the send was the problem. Every recipient went into a
 * single ZeptoMail request, and that API validates a transactional send as a
 * whole: one rejected address (unverified, bounced, suppressed) fails the
 * entire call, so nobody receives anything.
 *
 * Staff mail writes no EmailLog row, so such a failure left no trace at all.
 * These pin the isolation that replaced it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` is hoisted above every const, so the spy is created in a hoisted
// block of its own — otherwise the factory closes over an uninitialised binding.
const { sendEmail } = vi.hoisted(() => ({ sendEmail: vi.fn() }));
vi.mock('@/integrations/zeptomail/zeptomail.client', () => ({ sendEmail }));

// `import` (not top-level await) so the mock above is in place first, and so
// this file does not need a different module target from the rest of the suite.
import { sendToEachRecipient } from './email.worker';

const RECIPIENTS = [
  { email: 'info@zewafeeds.com', name: 'Zewa Feeds Orders' },
  { email: 'nikhildevm@zewafeeds.com', name: 'Nikhil' },
  { email: 'parthk@zewafeeds.com', name: 'Parth' },
];
const MESSAGE = { subject: 'New Order Placed — #27ZFO124', htmlBody: '<p>x</p>', reference: 'staff-27ZFO124' };
const ok = { sent: true, messageId: 'm1', skipped: false };

beforeEach(() => {
  sendEmail.mockReset();
  sendEmail.mockResolvedValue(ok);
});

const addressed = () => sendEmail.mock.calls.map((c) => c[0].to[0].email).sort();

describe('staff alert fan-out', () => {
  it('sends one request PER recipient, not one shared request', async () => {
    await sendToEachRecipient(RECIPIENTS, MESSAGE);

    expect(sendEmail).toHaveBeenCalledTimes(3);
    // The bug: a single call carrying all three addresses.
    for (const call of sendEmail.mock.calls) {
      expect(call[0].to).toHaveLength(1);
    }
  });

  it('reaches info@ and every eligible operator', async () => {
    await sendToEachRecipient(RECIPIENTS, MESSAGE);

    expect(addressed()).toEqual([
      'info@zewafeeds.com',
      'nikhildevm@zewafeeds.com',
      'parthk@zewafeeds.com',
    ]);
  });

  it('still delivers to the others when ONE address is rejected', async () => {
    sendEmail.mockImplementation(({ to }: { to: { email: string }[] }) =>
      to[0]!.email === 'info@zewafeeds.com'
        ? Promise.reject(new Error('Invalid recipient'))
        : Promise.resolve(ok),
    );

    await expect(sendToEachRecipient(RECIPIENTS, MESSAGE)).resolves.toBeUndefined();
    expect(addressed()).toContain('nikhildevm@zewafeeds.com');
    expect(addressed()).toContain('parthk@zewafeeds.com');
  });

  it('gives each recipient its own reference, so a retry stays idempotent per address', async () => {
    await sendToEachRecipient(RECIPIENTS, MESSAGE);

    const refs = sendEmail.mock.calls.map((c) => c[0].reference);
    expect(new Set(refs).size).toBe(3);
    expect(refs).toContain('staff-27ZFO124-info@zewafeeds.com');
  });

  it('throws only when EVERY recipient fails, so a retry cannot double-send', async () => {
    sendEmail.mockRejectedValue(new Error('provider down'));
    await expect(sendToEachRecipient(RECIPIENTS, MESSAGE)).rejects.toThrow(/every recipient/);
  });

  it('does not throw on an empty recipient list', async () => {
    await expect(sendToEachRecipient([], MESSAGE)).resolves.toBeUndefined();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
