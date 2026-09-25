/**
 * Customer routes — /api/v1/admin/customers  (§7)
 *
 *   customers.view  Ops + Admin
 *   customers.ban   Admin only
 *
 * There is no staff-facing edit endpoint: customer details belong to the customer,
 * and rewriting an email would break order attribution.
 */
import { Router } from 'express';
import { AuditModule, CustomerStatus } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '@/middleware/asyncHandler';
import { requirePermission } from '@/middleware/auth';
import { enumFilter, paginationSchema, validate } from '@/middleware/validate';
import { auditContext, writeAudit } from '@/modules/audit/audit.service';
import { AppError, ErrorCode } from '@/lib/errors';
import * as customersService from './customers.service';
import { issueVerification } from './verification.service';

export const customersRouter = Router();

customersRouter.use(requirePermission('customers.view'));

const idParam = z.object({ id: z.string().uuid() });

customersRouter.get(
  '/',
  validate({
    query: paginationSchema.extend({
      status: enumFilter(z.nativeEnum(CustomerStatus)),
      dir: z.enum(['asc', 'desc']).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json(await customersService.list(req.query as never));
  }),
);

customersRouter.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json({ data: await customersService.byId(req.params.id as string) });
  }),
);

/** Ban / unban (§7.2) — Admin only. */
customersRouter.patch(
  '/:id/status',
  requirePermission('customers.ban'),
  validate({ params: idParam, body: z.object({ status: z.nativeEnum(CustomerStatus) }) }),
  asyncHandler(async (req, res) => {
    const customer = await customersService.setStatus(
      req.params.id as string,
      req.body.status,
      auditContext(req),
    );
    res.json({ data: customer });
  }),
);

const previewEmailSchema = z.object({
  heading: z.string().trim().min(1, 'Heading is required.').max(200),
  message: z.string().trim().min(1, 'Message is required.').max(10000),
  subject: z.string().trim().max(200).optional(),
  ctaText: z.string().trim().max(50).nullable().optional(),
  ctaUrl: z.string().trim().nullable().optional(),
  customerName: z.string().trim().max(100).nullable().optional(),
});

const sendEmailSchema = z.object({
  audience: z.enum(['all', 'with_orders', 'selected', 'custom']),
  customerIds: z.array(z.string().uuid()).optional(),
  customEmails: z.array(z.string().email('Invalid email address.')).optional(),
  subject: z.string().trim().min(1, 'Subject is required.').max(200),
  heading: z.string().trim().min(1, 'Heading is required.').max(200),
  message: z.string().trim().min(1, 'Message is required.').max(10000),
  ctaText: z.string().trim().max(50).nullable().optional(),
  ctaUrl: z.string().trim().nullable().optional(),
});

/** Generate live HTML preview for custom or broadcast email. */
customersRouter.post(
  '/preview-email',
  validate({ body: previewEmailSchema }),
  asyncHandler(async (req, res) => {
    res.json({ data: customersService.previewCustomerEmail(req.body) });
  }),
);

/** Send bulk common or custom emails to customers. */
customersRouter.post(
  '/send-email',
  validate({ body: sendEmailSchema }),
  asyncHandler(async (req, res) => {
    const result = await customersService.sendCustomerEmail(req.body, auditContext(req));
    res.json({ data: result });
  }),
);

/**
 * POST /admin/customers/:id/resend-verification — re-issue a verification link.
 *
 * The CMS already showed "Email Verified: No" and offered nothing to do about it,
 * so support could see a stranded signup and not fix it. That happens whenever
 * mail is down at the moment someone registers.
 *
 * This mints a FRESH token rather than resending the old email: the original
 * token is single-use and 24-hour-bound, so replaying that message would deliver
 * a link that cannot work. Shares `issueVerification` with the public route so
 * the two cannot drift.
 *
 * `customers.ban` is the gate because it is the existing ADMIN-only customer
 * permission, and emailing a customer is an outward-facing action.
 */
customersRouter.post(
  '/:id/resend-verification',
  requirePermission('customers.ban'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const customer = await customersService.byId(req.params.id!);

    const result = await issueVerification(customer.email);

    if (!result.issued) {
      /*
       * Specific, unlike the public route's deliberately vague reply. There is no
       * enumeration concern here — the operator is already authenticated and can
       * see the customer record — and "already verified" vs "banned" are different
       * things for them to act on.
       */
      const message =
        result.reason === 'already-verified'
          ? 'This customer has already verified their email.'
          : result.reason === 'banned'
            ? 'This customer is banned; no verification email was sent.'
            : result.reason === 'guest'
              ? 'This is a guest order record, not a registered account.'
              : 'No account was found for that address.';
      throw new AppError(422, ErrorCode.VALIDATION_FAILED, message);
    }

    await writeAudit(auditContext(req), {
      module: AuditModule.CUSTOMERS,
      action: `Re-sent the email verification link to ${customer.email}`,
      recordId: customer.id,
    });

    res.json({ data: { ok: true } });
  }),
);
