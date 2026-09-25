/**
 * Unified EmailLog — statuses, and the rules that govern a resend.
 *
 * WHY THIS FILE EXISTS
 *
 * In Sep 2026 a placeholder ZEPTOMAIL_TOKEN in Render made every send answer 401.
 * Order mail was logged and resendable; CMS login OTP, password resets,
 * verification links and the coin emails wrote no row at all — so the one class of
 * mail that actually failed was the only class with no record and nothing to
 * replay. These tests pin the three behaviours that fix that, and the two that
 * must never regress.
 *
 * Mounted as a REAL router over HTTP: the permission guards, the 422 on a security
 * template and the audit write are route-layer behaviour a service test cannot see.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { EmailStatus, PrismaClient, Role } from '@prisma/client';
import { ns, TEST_PREFIX } from '@/test/fixtures';
import { emailsAdminRouter } from './admin.routes';
import { errorHandler } from '@/middleware/errorHandler';
import { permissionsFor } from '@/rbac/permissions';
import * as emailLog from './email-log.service';
import * as ordersService from '@/modules/orders/orders.service';

const prisma = new PrismaClient();

/*
 * The provider is stubbed at the client boundary, not at the service. Every test
 * here is about what gets WRITTEN for a given provider outcome, so the outcome is
 * the input and no real mail is ever sent.
 */
const sendEmail = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/zeptomail/zeptomail.client', () => ({
  sendEmail: (...a: unknown[]) => sendEmail(...a),
}));

let role: Role = Role.ADMIN;
let staffId = '';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as express.Request & { id: string }).id = 'test-request';
  req.user = {
    id: staffId,
    email: `${TEST_PREFIX}-emailactor@zewafeeds.test`,
    name: 'Email Test',
    role,
    permissions: permissionsFor(role),
  };
  next();
});
app.use('/emails', emailsAdminRouter);
app.use(errorHandler);

let server: Server;
const url = (p: string) => `http://127.0.0.1:${(server.address() as AddressInfo).port}${p}`;

async function seedRow(over: Record<string, unknown> = {}) {
  return prisma.emailLog.create({
    data: {
      template: 'order-placed',
      subject: 'Your order',
      toEmail: `${ns('emlog')}@zewafeeds.test`,
      status: EmailStatus.FAILED,
      error: 'ZeptoMail is unavailable.',
      bodyHtml: '<p>original body</p>',
      ...over,
    },
  });
}

beforeAll(async () => {
  const actor = await prisma.cmsUser.create({
    data: {
      email: `${ns('emailactor')}@zewafeeds.test`,
      name: 'Email Test Actor',
      role: Role.ADMIN,
      passwordHash: 'x',
    },
    select: { id: true },
  });
  staffId = actor.id;
  await new Promise<void>((r) => {
    server = app.listen(0, r);
  });
});

afterAll(async () => {
  await prisma.emailLog.deleteMany({ where: { toEmail: { contains: TEST_PREFIX } } });
  /*
   * The actor is deliberately LEFT BEHIND.
   *
   * Resend writes an audit row, and deleting a CmsUser that has audit history
   * fails at the database level: `AuditLog.actorId` is `onDelete: SetNull`, so
   * Postgres issues an UPDATE that the `audit_log_no_update` RULE rewrites to
   * nothing, and the integrity check then errors with XX000. That is a known
   * pre-existing defect outside this module, so this teardown does not fight it —
   * the row is namespaced with TEST_PREFIX and harmless.
   */
  await prisma.auditLog.deleteMany({ where: { actorId: staffId } }).catch(() => undefined);
  await new Promise<void>((r) => server.close(() => r()));
  await prisma.$disconnect();
});

beforeEach(() => {
  role = Role.ADMIN;
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ sent: true, messageId: 'msg-1' });
});

describe('a send records its own outcome', () => {
  it('writes the row BEFORE calling the provider, so a mid-flight death leaves evidence', async () => {
    let rowExistedDuringSend = false;
    sendEmail.mockImplementation(async () => {
      rowExistedDuringSend =
        (await prisma.emailLog.count({ where: { template: 'probe-ordering' } })) > 0;
      return { sent: true, messageId: 'msg-order' };
    });

    await emailLog.logAndSend({
      to: [{ email: `${ns('ordering')}@zewafeeds.test` }],
      subject: 'Ordering probe',
      htmlBody: '<p>x</p>',
      template: 'probe-ordering',
    });

    expect(rowExistedDuringSend).toBe(true);
  });

  it('marks a delivered email SENT with the provider message id', async () => {
    const { id } = await emailLog.logAndSend({
      to: [{ email: `${ns('sent')}@zewafeeds.test` }],
      subject: 'Delivered',
      htmlBody: '<p>x</p>',
      template: 'order-placed',
    });

    const row = await prisma.emailLog.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe(EmailStatus.SENT);
    expect(row.providerMessageId).toBe('msg-1');
    expect(row.sentAt).not.toBeNull();
  });

  /*
   * The regression that motivated SKIPPED. A skipped send used to be left at
   * QUEUED with the reason pushed into `error`, so it was indistinguishable from
   * mail still in flight — during the outage every OTP read as merely slow.
   */
  it('marks an unconfigured provider SKIPPED, not FAILED and not QUEUED', async () => {
    sendEmail.mockResolvedValue({ sent: false, messageId: null, skipped: true });

    const { id } = await emailLog.logAndSend({
      to: [{ email: `${ns('skip')}@zewafeeds.test` }],
      subject: 'Skipped',
      htmlBody: '<p>x</p>',
      template: 'cms-login-otp',
    });

    const row = await prisma.emailLog.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe(EmailStatus.SKIPPED);
    expect(row.status).not.toBe(EmailStatus.FAILED);
    expect(row.sentAt).toBeNull();
  });

  it('marks a rejected send FAILED and keeps the provider message', async () => {
    sendEmail.mockRejectedValue(new Error('ZeptoMail is unavailable. Please try again.'));

    const { id, sent } = await emailLog.logAndSend({
      to: [{ email: `${ns('failed')}@zewafeeds.test` }],
      subject: 'Failed',
      htmlBody: '<p>x</p>',
      template: 'order-placed',
    });

    expect(sent).toBe(false);
    const row = await prisma.emailLog.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe(EmailStatus.FAILED);
    expect(row.error).toMatch(/unavailable/i);
  });

  /* Fire-and-forget callers must never see a mail failure as a thrown error. */
  it('never throws out of logAndSend, whatever the provider does', async () => {
    sendEmail.mockRejectedValue(new Error('boom'));
    await expect(
      emailLog.logAndSend({
        to: [{ email: `${ns('nothrow')}@zewafeeds.test` }],
        subject: 'No throw',
        htmlBody: '<p>x</p>',
        template: 'password-changed',
      }),
    ).resolves.toMatchObject({ sent: false });
  });
});

describe('resend', () => {
  it('writes a NEW row linked by resentFromId and leaves the original FAILED', async () => {
    const original = await seedRow();

    const res = await fetch(url(`/emails/${original.id}/resend`), { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; resentFromId: string } };

    expect(body.data.id).not.toBe(original.id);
    expect(body.data.resentFromId).toBe(original.id);

    /*
     * The point of the whole rule: after recovery, "what failed during the
     * outage" is still answerable. Mutating the original would erase it.
     */
    const before = await prisma.emailLog.findUniqueOrThrow({ where: { id: original.id } });
    expect(before.status).toBe(EmailStatus.FAILED);
    expect(before.error).toMatch(/unavailable/i);

    const after = await prisma.emailLog.findUniqueOrThrow({ where: { id: body.data.id } });
    expect(after.resentFromId).toBe(original.id);
    expect(after.status).toBe(EmailStatus.SENT);
  });

  /*
   * These bodies carry single-use, time-limited tokens. Replaying one delivers a
   * code that is already spent or expired — worse than sending nothing, because
   * the recipient gets mail that cannot work.
   */
  it.each([
    'cms-login-otp',
    'password-reset',
    'customer-email-verification',
    'cms-user-invitation',
  ])('refuses to replay %s, and does not call the provider', async (template) => {
    const row = await seedRow({ template, subject: 'Your code' });

    const res = await fetch(url(`/emails/${row.id}/resend`), { method: 'POST' });

    expect(res.status).toBe(422);
    expect(sendEmail).not.toHaveBeenCalled();
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/single-use|request a new one/i);
  });

  it('tells the list which rows are resendable, so the CMS cannot disagree', async () => {
    await seedRow({ template: 'password-reset', toEmail: `${ns('sec')}@zewafeeds.test` });

    const res = await fetch(url('/emails?perPage=100'));
    const body = (await res.json()) as {
      data: { template: string; resendable: boolean; resendBlockedReason: string | null }[];
    };

    const secure = body.data.find((r) => r.template === 'password-reset');
    expect(secure?.resendable).toBe(false);
    expect(secure?.resendBlockedReason).toMatch(/single-use/i);

    const ordinary = body.data.find((r) => r.template === 'order-placed');
    expect(ordinary?.resendable).toBe(true);
  });

  it('404s an unknown id rather than inventing a row', async () => {
    const res = await fetch(url('/emails/3f1a5bfe-0000-4000-8000-000000000000/resend'), {
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });
});

describe('bulk resend', () => {
  it('de-duplicates ids so one row cannot be sent twice in a request', async () => {
    const row = await seedRow();

    const res = await fetch(url('/emails/resend'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [row.id, row.id, row.id] }),
    });

    const body = (await res.json()) as { data: { requested: number; sent: number } };
    expect(body.data.requested).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('reports per-row outcomes instead of failing the whole batch', async () => {
    const ok = await seedRow();
    const blocked = await seedRow({ template: 'cms-login-otp' });

    const res = await fetch(url('/emails/resend'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [ok.id, blocked.id] }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { sent: number; failed: number; results: { id: string; ok: boolean }[] };
    };
    expect(body.data.sent).toBe(1);
    expect(body.data.failed).toBe(1);
    expect(body.data.results.find((r) => r.id === blocked.id)?.ok).toBe(false);
  });

  it('refuses a batch above the cap, so a stray select-all cannot fan out', async () => {
    const ids = Array.from(
      { length: 201 },
      (_, i) => `3f1a5bfe-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    const res = await fetch(url('/emails/resend'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    expect(res.status).toBe(422);
  });
});

describe('permissions', () => {
  it('lets OPS read the log', async () => {
    role = Role.OPS_MANAGER;
    const res = await fetch(url('/emails'));
    expect(res.status).toBe(200);
  });

  /* Sending mail to a customer is outward-facing, so it stays ADMIN. */
  it('refuses a resend to OPS', async () => {
    const row = await seedRow();
    role = Role.OPS_MANAGER;

    const res = await fetch(url(`/emails/${row.id}/resend`), { method: 'POST' });

    expect(res.status).toBe(403);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('refuses both to a content editor', async () => {
    role = Role.CONTENT_EDITOR;
    expect((await fetch(url('/emails'))).status).toBe(403);
  });
});

describe('the incident view', () => {
  it('groups FAILED, SKIPPED and QUEUED under one "did not arrive" filter', async () => {
    const tag = ns('incident');
    await seedRow({ status: EmailStatus.FAILED, toEmail: `${tag}-f@zewafeeds.test` });
    await seedRow({ status: EmailStatus.SKIPPED, toEmail: `${tag}-s@zewafeeds.test` });
    await seedRow({ status: EmailStatus.QUEUED, toEmail: `${tag}-q@zewafeeds.test` });
    await seedRow({ status: EmailStatus.SENT, toEmail: `${tag}-ok@zewafeeds.test` });

    const res = await fetch(url(`/emails?unsentOnly=true&search=${tag}&perPage=100`));
    const body = (await res.json()) as { data: { status: EmailStatus }[] };

    const statuses = body.data.map((r) => r.status).sort();
    expect(statuses).toEqual([EmailStatus.FAILED, EmailStatus.QUEUED, EmailStatus.SKIPPED].sort());
    expect(statuses).not.toContain(EmailStatus.SENT);
  });
});

/*
 * The ORDER page has its own resend button, on a different route. It used to run a
 * separate implementation that UPDATED the row in place, so whether an outage
 * stayed reconstructible depended on which of the two buttons an operator pressed.
 * It now delegates here. These tests pin that, because the two paths drifting is
 * exactly the asymmetry this whole feature exists to remove.
 */
/** A valid AuditContext — `ip` is required and non-null. */
function auditCtx() {
  return {
    actorId: staffId,
    actorName: 'Email Test',
    actorRole: Role.ADMIN,
    ip: '127.0.0.1',
    userAgent: 'vitest',
  };
}

describe('the order page resend shares this path', () => {
  it('creates a new row and leaves the original FAILED', async () => {
    const order = await prisma.order.findFirst({ select: { id: true, orderNo: true } });
    if (!order) return;

    const original = await seedRow({ orderId: order.id });
    const before = await prisma.emailLog.count({ where: { orderId: order.id } });

    await ordersService.resendEmail(order.orderNo, original.id, auditCtx());

    const after = await prisma.emailLog.count({ where: { orderId: order.id } });
    expect(after).toBe(before + 1);

    const orig = await prisma.emailLog.findUniqueOrThrow({ where: { id: original.id } });
    expect(orig.status).toBe(EmailStatus.FAILED);
    expect(orig.error).toMatch(/unavailable/i);

    const fresh = await prisma.emailLog.findFirst({ where: { resentFromId: original.id } });
    expect(fresh?.toEmail).toBe(original.toEmail);
  });

  /* A hand-edited URL must not resend another order's mail. */
  it('refuses an email id that belongs to a different order', async () => {
    const [a, b] = await prisma.order.findMany({ take: 2, select: { id: true, orderNo: true } });
    if (!a || !b) return;

    const row = await seedRow({ orderId: a.id });

    await expect(
      ordersService.resendEmail(b.orderNo, row.id, auditCtx()),
    ).rejects.toThrow();
  });

  /* The security rule has to hold on BOTH routes, or it holds on neither. */
  it('refuses a security template through the order route as well', async () => {
    const order = await prisma.order.findFirst({ select: { id: true, orderNo: true } });
    if (!order) return;

    const otp = await seedRow({ orderId: order.id, template: 'cms-login-otp' });

    await expect(
      ordersService.resendEmail(order.orderNo, otp.id, auditCtx()),
    ).rejects.toThrow(/single-use|cannot be resent/i);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

/*
 * Phase 2 wiring, checked at the seam where the config meets the database. The
 * stored column and the flag sent to the provider come from ONE decision, so a
 * template switched off next week cannot make last week's genuine open look like a
 * row that was never tracked.
 */
describe('tracking is decided once, then both stored and sent', () => {
  it('stores trackOpens true and asks the provider to track, for order mail', async () => {
    const { id } = await emailLog.logAndSend({
      to: [{ email: `${ns('trk-on')}@zewafeeds.test` }],
      subject: 'Your order',
      htmlBody: '<p>x</p>',
      template: 'order-placed',
    });

    const row = await prisma.emailLog.findUniqueOrThrow({ where: { id } });
    expect(row.trackOpens).toBe(true);
    expect(sendEmail.mock.calls[0]![0]).toMatchObject({ trackOpens: true });
  });

  /* The rule that matters: no tracking pixel in a security email. */
  it.each(['cms-login-otp', 'password-reset', 'customer-email-verification'])(
    'stores trackOpens false and does not ask the provider to track, for %s',
    async (template) => {
      const { id } = await emailLog.logAndSend({
        to: [{ email: `${ns('trk-off')}@zewafeeds.test` }],
        subject: 'Your code',
        htmlBody: '<p>x</p>',
        template,
      });

      const row = await prisma.emailLog.findUniqueOrThrow({ where: { id } });
      expect(row.trackOpens).toBe(false);
      expect(sendEmail.mock.calls[0]![0]).toMatchObject({ trackOpens: false });
    },
  );

  it('starts every row unopened', async () => {
    const { id } = await emailLog.logAndSend({
      to: [{ email: `${ns('trk-new')}@zewafeeds.test` }],
      subject: 'Your order',
      htmlBody: '<p>x</p>',
      template: 'order-placed',
    });

    const row = await prisma.emailLog.findUniqueOrThrow({ where: { id } });
    expect(row.openedAt).toBeNull();
    expect(row.openCount).toBe(0);
  });
});
