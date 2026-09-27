/**
 * A failed payment must free its holds at once, not in half an hour.
 *
 * THE DEFECT. `payment.failed` arrived from Razorpay and the webhook discarded
 * it — the code said so outright: "payment.failed and others need no action —
 * the release sweep handles abandonment". So the order stayed PENDING until the
 * 30-minute unpaid sweep, and everything it held stayed held with it.
 *
 * The customer meets that on their very next attempt. A coupon with
 * `perCustomerLimit: 1` is still attached to the order that just failed, so the
 * retry is refused with "You have already used ZEWA1" — naming an order they
 * never paid for and cannot see. Their coins are locked the same way.
 *
 * A declined card is a NORMAL event; retrying is the normal response to it.
 * Half an hour is an eternity at that moment, and the storefront cannot fix it:
 * a closed tab, a dead battery or a dropped connection runs no client code. The
 * webhook is the only signal that always arrives, so it is where this belongs.
 *
 * The release job itself is unchanged and already safe to run early: it re-reads
 * the order, skips anything no longer PENDING+UNPAID, and queries the gateway
 * before cancelling — so a payment that actually succeeded is CONFIRMED rather
 * than cancelled, even if `payment.failed` fired first.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const queueAdd = vi.fn().mockResolvedValue({});

vi.mock('@/jobs/queues', async () => {
  const actual = await vi.importActual<typeof import('@/jobs/queues')>('@/jobs/queues');
  return { ...actual, paymentQueue: { add: (...a: unknown[]) => queueAdd(...a) } };
});

describe('payment.failed webhook', () => {
  beforeEach(() => queueAdd.mockClear());

  it('is handled, not ignored', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('src/modules/checkout/webhook.routes.ts', 'utf8'),
    );
    expect(src).toMatch(/payment\.failed/);
    // The old comment declared the event deliberately unhandled.
    expect(src).not.toMatch(/payment\.failed and others need no action/);
  });

  it('enqueues the release immediately rather than after the unpaid TTL', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('src/modules/checkout/webhook.routes.ts', 'utf8'),
    );
    const branch = src.slice(src.indexOf("'payment.failed'"));
    // Reuses the existing job, with no delay — the 30-minute wait is the bug.
    expect(branch).toMatch(/release-unpaid/);
    expect(branch).not.toMatch(/UNPAID_ORDER_TTL_MINUTES/);
  });

  it('removes the delayed sweep before adding the immediate one', async () => {
    /*
     * BullMQ treats a duplicate jobId as a no-op, not a reschedule. Checkout
     * has already queued `release-<orderNo>` with the unpaid TTL as its delay,
     * so adding the immediate job on top of it would silently do nothing —
     * the fix would appear to work and the customer would still wait.
     */
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('src/modules/checkout/webhook.routes.ts', 'utf8'),
    );
    const branch = src.slice(src.indexOf("'payment.failed'"));
    const removeAt = branch.indexOf('paymentQueue.remove');
    const addAt = branch.indexOf('paymentQueue.add');
    expect(removeAt).toBeGreaterThan(-1);
    expect(addAt).toBeGreaterThan(-1);
    expect(removeAt).toBeLessThan(addAt);
    expect(branch).toMatch(/release-\$\{/);
  });
});
