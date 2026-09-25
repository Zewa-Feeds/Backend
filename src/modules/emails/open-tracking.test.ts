/**
 * Open tracking, end to end: per-template config, the signed webhook, and the
 * columns it writes.
 *
 * Driven over HTTP through the real router with `express.raw`, because the HMAC is
 * computed over exact bytes — a test that posts parsed JSON would verify a
 * different string than production does and prove nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { EmailStatus, PrismaClient } from '@prisma/client';
import { ns, TEST_PREFIX } from '@/test/fixtures';
import { errorHandler } from '@/middleware/errorHandler';

/*
 * `vi.hoisted`, because `vi.mock` is lifted above ordinary top-level consts — a
 * plain `const KEY` here dies with "Cannot access 'KEY' before initialization".
 */
const KEY = vi.hoisted(() => 'zepto-webhook-key-for-tests');

vi.mock('@/config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/env')>();
  return { ...actual, env: { ...actual.env, ZEPTOMAIL_WEBHOOK_KEY: KEY } };
});

const prisma = new PrismaClient();
/*
 * Both modules are loaded in `beforeAll`, not at the top.
 *
 * A top-level `await import` is a tsc error here (TS1378 — this project compiles as
 * CommonJS), and a static import would evaluate the router before the env mock that
 * supplies the webhook key is in place. The router is therefore mounted inside
 * `beforeAll` too, behind a thin wrapper so `app` itself can be built eagerly.
 */
type Tracking = typeof import('./tracking');
let shouldTrackOpens: Tracking['shouldTrackOpens'];
let TRACKING_DEFAULTS: Tracking['TRACKING_DEFAULTS'];

const app = express();
// Exactly as app.ts mounts it: raw bytes, because the HMAC covers them.
app.use('/webhooks/zeptomail', express.raw({ type: '*/*', limit: '256kb' }));
app.use((req, _res, next) => {
  (req as express.Request & { id: string }).id = 'test-request';
  next();
});

let server: Server;
const url = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks/zeptomail`;

function openEvent(messageId: string, event = 'email_open') {
  return JSON.stringify({
    event_name: event,
    webhook_request_id: `req-${messageId}`,
    event_message: [{ email_info: { message_id: messageId } }],
  });
}

/** POST a body with a valid (or deliberately invalid) signature. */
async function post(body: string, opts: { key?: string; ts?: number; header?: string } = {}) {
  const ts = opts.ts ?? Date.now();
  const mac = createHmac('sha256', opts.key ?? KEY).update(body).digest('base64');
  const header = opts.header ?? `ts=${ts};s=${encodeURIComponent(mac)};s-algorithm=HmacSHA256`;
  return fetch(url(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'producer-signature': header },
    body,
  });
}

async function seedTracked(messageId: string, over: Record<string, unknown> = {}) {
  return prisma.emailLog.create({
    data: {
      template: 'order-placed',
      subject: 'Your order',
      toEmail: `${ns('opens')}@zewafeeds.test`,
      status: EmailStatus.SENT,
      providerMessageId: messageId,
      trackOpens: true,
      ...over,
    },
  });
}

beforeAll(async () => {
  const routes = await import('./webhook.routes');
  const tracking = await import('./tracking');
  shouldTrackOpens = tracking.shouldTrackOpens;
  TRACKING_DEFAULTS = tracking.TRACKING_DEFAULTS;

  app.use('/webhooks/zeptomail', routes.zeptomailWebhookRouter);
  app.use(errorHandler);

  await new Promise<void>((r) => {
    server = app.listen(0, r);
  });
});

afterAll(async () => {
  await prisma.emailLog.deleteMany({ where: { toEmail: { contains: TEST_PREFIX } } });
  await new Promise<void>((r) => server.close(() => r()));
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.emailLog.deleteMany({ where: { toEmail: { contains: TEST_PREFIX } } });
});

describe('which templates report opens', () => {
  /*
   * The decision that matters. ZeptoMail tracks opens with a 1x1 pixel, so these
   * templates must never carry one: a read receipt on a password reset is hard to
   * justify, and delivery rather than readership is what matters there.
   */
  it.each([
    'cms-login-otp',
    'cms-user-invitation',
    'password-reset',
    'password-changed',
    'customer-email-verification',
  ])('leaves %s untracked by default', (t) => {
    expect(TRACKING_DEFAULTS[t]).toBe(false);
    expect(shouldTrackOpens(t)).toBe(false);
  });

  it.each(['order-placed', 'order-shipped', 'coins-earned', 'staff-new-order'])(
    'tracks %s by default',
    (t) => {
      expect(shouldTrackOpens(t)).toBe(true);
    },
  );

  it('lets a settings override win in both directions', () => {
    expect(shouldTrackOpens('order-placed', { 'order-placed': false })).toBe(false);
    expect(shouldTrackOpens('password-reset', { 'password-reset': true })).toBe(true);
  });

  /* A new template should opt in deliberately, not start tracking unnoticed. */
  it('leaves an unknown template untracked', () => {
    expect(shouldTrackOpens('brand-new-template')).toBe(false);
    expect(shouldTrackOpens(null)).toBe(false);
  });
});

describe('the webhook endpoint', () => {
  it('records the first open with a timestamp and a count', async () => {
    const row = await seedTracked('msg-first');

    const res = await post(openEvent('msg-first'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { handled: true, matched: 1 } });

    const after = await prisma.emailLog.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.openedAt).not.toBeNull();
    expect(after.openCount).toBe(1);
  });

  /*
   * ZeptoMail fires the opens webhook on the FIRST open, but retries mean the same
   * notification can arrive twice. The count must move; `openedAt` must not, or
   * "when did they first read it" is corrupted by delivery noise.
   */
  it('keeps the original openedAt on a repeat, while counting it', async () => {
    const row = await seedTracked('msg-repeat');

    await post(openEvent('msg-repeat'));
    const first = await prisma.emailLog.findUniqueOrThrow({ where: { id: row.id } });

    await post(openEvent('msg-repeat'));
    const second = await prisma.emailLog.findUniqueOrThrow({ where: { id: row.id } });

    expect(second.openedAt?.getTime()).toBe(first.openedAt?.getTime());
    expect(second.openCount).toBe(2);
  });

  /*
   * An open for a row that never asked to be tracked is either stale (the setting
   * changed after the send) or forged. Either way it must not write.
   */
  it('ignores an open for a row with trackOpens false', async () => {
    const row = await seedTracked('msg-untracked', { trackOpens: false });

    const res = await post(openEvent('msg-untracked'));
    expect(await res.json()).toMatchObject({ data: { matched: 0 } });

    const after = await prisma.emailLog.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.openedAt).toBeNull();
    expect(after.openCount).toBe(0);
  });

  it('acknowledges an unknown message id without erroring', async () => {
    const res = await post(openEvent('msg-does-not-exist'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { handled: true, matched: 0 } });
  });

  it.each(['hardbounce', 'email_click'])('acknowledges but ignores %s', async (event) => {
    const row = await seedTracked(`msg-${event}`);

    const res = await post(openEvent(`msg-${event}`, event));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { handled: false } });

    const after = await prisma.emailLog.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.openCount).toBe(0);
  });
});

describe('the endpoint refuses anything it cannot verify', () => {
  it('401s a wrong signature, and writes nothing', async () => {
    const row = await seedTracked('msg-forged');

    const res = await post(openEvent('msg-forged'), { key: 'attacker-key' });

    expect(res.status).toBe(401);
    const after = await prisma.emailLog.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.openCount).toBe(0);
    expect(after.openedAt).toBeNull();
  });

  /*
   * An UNSIGNED request is ZeptoMail's reachability probe, not an event.
   *
   * Their Add Webhook form will not save unless the URL answers 200, and it probes
   * unsigned — so a signature-verifying endpoint could never be registered. It is
   * acknowledged, but it must not be PROCESSED: that distinction is the whole point,
   * so the assertion is on the database, not just the status code.
   */
  it('200s an unsigned probe without recording anything', async () => {
    const row = await seedTracked('msg-probe');

    const res = await fetch(url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: openEvent('msg-probe'),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { handled: false } });

    const after = await prisma.emailLog.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.openedAt).toBeNull();
    expect(after.openCount).toBe(0);
  });

  /*
   * The line that matters: acknowledging an UNSIGNED request must not soften a
   * request that DOES carry a signature. Forging an event is exactly as hard as
   * before — an attacker cannot simply omit the header to get their body processed,
   * because an omitted header means the body is never read at all.
   */
  it('still 401s a request carrying a bad signature, and writes nothing', async () => {
    const row = await seedTracked('msg-still-guarded');

    const res = await post(openEvent('msg-still-guarded'), { key: 'attacker-key' });

    expect(res.status).toBe(401);
    const after = await prisma.emailLog.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.openCount).toBe(0);
  });

  it('401s a malformed signature header rather than treating it as a probe', async () => {
    const row = await seedTracked('msg-malformed');

    const res = await post(openEvent('msg-malformed'), { header: 'not-a-signature-header' });

    expect(res.status).toBe(401);
    const after = await prisma.emailLog.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.openCount).toBe(0);
  });

  /* Replay bound: an old capture must not be replayable to inflate counts. */
  it('401s a stale notification', async () => {
    const row = await seedTracked('msg-stale');

    const res = await post(openEvent('msg-stale'), { ts: Date.now() - 3 * 60 * 60 * 1000 });

    expect(res.status).toBe(401);
    const after = await prisma.emailLog.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.openCount).toBe(0);
  });

  /*
   * A body altered after signing is the whole point of the HMAC: without this an
   * attacker could take one genuine notification and rewrite the message id to
   * mark any email opened.
   */
  it('401s a body tampered with after signing, so ids cannot be swapped', async () => {
    const victim = await seedTracked('msg-victim');
    const honest = openEvent('msg-other');
    const mac = createHmac('sha256', KEY).update(honest).digest('base64');

    const res = await fetch(url(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'producer-signature': `ts=${Date.now()};s=${encodeURIComponent(mac)};s-algorithm=HmacSHA256`,
      },
      body: openEvent('msg-victim'),
    });

    expect(res.status).toBe(401);
    const after = await prisma.emailLog.findUniqueOrThrow({ where: { id: victim.id } });
    expect(after.openCount).toBe(0);
  });

  it('200s a signed but unparseable body rather than retrying forever', async () => {
    const res = await post('not json at all');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { handled: false } });
  });
});
