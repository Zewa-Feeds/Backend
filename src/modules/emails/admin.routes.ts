/**
 * Email log administration.
 *
 * Mounted at `/api/v1/admin/emails`, inheriting the staff JWT + enrolled-2FA
 * guard that `adminRouter` applies.
 *
 * Built after the Sep 2026 ZeptoMail outage, where a placeholder token in Render
 * made every send fail with a 401 that read as a bad credential. Nothing recorded
 * the non-order mail, so during the incident there was no way to see what had
 * failed and afterwards no way to replay it.
 */
import { Router } from 'express';
import { z } from 'zod';
import { AuditModule, EmailStatus, Prisma } from '@prisma/client';
import { asyncHandler } from '@/middleware/asyncHandler';
import { validate } from '@/middleware/validate';
import { requirePermission } from '@/middleware/auth';
import { prisma } from '@/lib/prisma';
import { AppError, ErrorCode, notFound } from '@/lib/errors';
import { writeAudit, auditContext } from '@/modules/audit/audit.service';
import * as emailsService from './emails.service';

export const emailsAdminRouter = Router();

/** Cap on a single bulk resend — see `emails.service` for the reasoning. */
export const BULK_RESEND_MAX = 200;

/**
 * GET /admin/emails — the log, newest first.
 *
 * Filters exist for the questions asked during an incident: which sends failed,
 * which template, to whom, in what window.
 */
emailsAdminRouter.get(
  '/',
  requirePermission('emails.view'),
  validate({
    query: z.object({
      page: z.coerce.number().int().min(1).default(1),
      perPage: z.coerce.number().int().min(1).max(100).default(25),
      status: z.nativeEnum(EmailStatus).optional(),
      template: z.string().trim().max(80).optional(),
      /** Substring match on the recipient. */
      search: z.string().trim().max(200).optional(),
      customerId: z.string().uuid().optional(),
      orderId: z.string().uuid().optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      /** The incident view: everything that did not reach the provider. */
      unsentOnly: z.coerce.boolean().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as {
      page: number;
      perPage: number;
      status?: EmailStatus;
      template?: string;
      search?: string;
      customerId?: string;
      orderId?: string;
      from?: Date;
      to?: Date;
      unsentOnly?: boolean;
    };

    const where: Prisma.EmailLogWhereInput = {};
    if (q.status) where.status = q.status;
    /*
     * `unsentOnly` spans FAILED and SKIPPED — and QUEUED, which during an outage
     * means "died between the row and the outcome". One filter for "did not
     * arrive", because that is the question, not the enum value.
     */
    if (q.unsentOnly && !q.status) {
      where.status = { in: [EmailStatus.FAILED, EmailStatus.SKIPPED, EmailStatus.QUEUED] };
    }
    if (q.template) where.template = q.template;
    if (q.search) where.toEmail = { contains: q.search, mode: 'insensitive' };
    if (q.customerId) where.customerId = q.customerId;
    if (q.orderId) where.orderId = q.orderId;
    if (q.from || q.to) {
      where.queuedAt = {
        ...(q.from ? { gte: q.from } : {}),
        ...(q.to ? { lte: q.to } : {}),
      };
    }

    const [total, rows] = await Promise.all([
      prisma.emailLog.count({ where }),
      prisma.emailLog.findMany({
        where,
        orderBy: { queuedAt: 'desc' },
        skip: (q.page - 1) * q.perPage,
        take: q.perPage,
        /*
         * `bodyHtml` is deliberately NOT selected. A list of 25 order emails would
         * otherwise ship a few hundred KB of markup nobody looks at; the detail
         * route serves it on demand.
         */
        select: {
          id: true,
          template: true,
          subject: true,
          toEmail: true,
          status: true,
          error: true,
          providerMessageId: true,
          queuedAt: true,
          sentAt: true,
          lastAttemptAt: true,
          resentFromId: true,
          orderId: true,
          customerId: true,
          order: { select: { orderNo: true } },
          customer: { select: { firstName: true, lastName: true } },
        },
      }),
    ]);

    res.json({
      data: rows.map(emailsService.serialize),
      meta: { page: q.page, perPage: q.perPage, total, totalPages: Math.ceil(total / q.perPage) },
    });
  }),
);

/** GET /admin/emails/templates — the distinct template names, for the filter. */
emailsAdminRouter.get(
  '/templates',
  requirePermission('emails.view'),
  asyncHandler(async (_req, res) => {
    const rows = await prisma.emailLog.findMany({
      where: { template: { not: null } },
      distinct: ['template'],
      select: { template: true },
      orderBy: { template: 'asc' },
    });
    res.json({ data: rows.map((r) => r.template).filter(Boolean) });
  }),
);

/** GET /admin/emails/:id — one row, including the stored body. */
emailsAdminRouter.get(
  '/:id',
  requirePermission('emails.view'),
  asyncHandler(async (req, res) => {
    const row = await prisma.emailLog.findUnique({
      where: { id: req.params.id! },
      include: {
        order: { select: { orderNo: true } },
        customer: { select: { firstName: true, lastName: true, email: true } },
      },
    });
    if (!row) throw notFound('Email record');
    res.json({ data: { ...emailsService.serialize(row), bodyHtml: row.bodyHtml } });
  }),
);

/**
 * POST /admin/emails/:id/resend — send this email again.
 *
 * ADMIN only: this puts a message in someone's inbox.
 */
emailsAdminRouter.post(
  '/:id/resend',
  requirePermission('emails.resend'),
  asyncHandler(async (req, res) => {
    const result = await emailsService.resend(req.params.id!, auditContext(req));
    res.json({ data: result });
  }),
);

/**
 * POST /admin/emails/resend — bulk resend.
 *
 * The incident shape is "200 emails failed in a 40-minute window", and
 * one-at-a-time recovery for that is not recovery.
 */
emailsAdminRouter.post(
  '/resend',
  requirePermission('emails.resend'),
  validate({
    body: z.object({
      ids: z.array(z.string().uuid()).min(1).max(BULK_RESEND_MAX),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { ids } = req.body as { ids: string[] };

    /*
     * De-duplicated before anything is sent. The same id twice in one request
     * would otherwise be two messages to the same person — the failure mode a
     * "select all" on a filtered list makes easy.
     */
    const unique = [...new Set(ids)];
    if (unique.length > BULK_RESEND_MAX) {
      throw new AppError(
        400,
        ErrorCode.VALIDATION_FAILED,
        `At most ${BULK_RESEND_MAX} emails can be resent at once.`,
      );
    }

    const ctx = auditContext(req);
    const results: { id: string; ok: boolean; newId?: string; reason?: string }[] = [];

    /*
     * Sequential, not Promise.all. ZeptoMail rate-limits, and the existing worker
     * already runs at a modest concurrency for the same reason; firing 200 sends
     * at once is how a recovery turns into a second incident.
     */
    for (const id of unique) {
      try {
        const r = await emailsService.resend(id, ctx);
        results.push({ id, ok: true, newId: r.id });
      } catch (err) {
        results.push({
          id,
          ok: false,
          reason: err instanceof Error ? err.message : 'Resend failed',
        });
      }
    }

    await writeAudit(ctx, {
      module: AuditModule.ORDERS,
      action: `Bulk resent ${results.filter((r) => r.ok).length}/${unique.length} emails`,
    });

    res.json({
      data: {
        requested: unique.length,
        sent: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        results,
      },
    });
  }),
);
