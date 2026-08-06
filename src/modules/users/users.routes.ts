/**
 * CMS user routes — /api/v1/admin/users
 *
 * Admin only (§11). Mounted under the admin router, so requireAuth and
 * requireEnrolled2fa already apply; `users.manage` is added on the router below
 * so every route in this file inherits it.
 */
import { Router } from 'express';
import { CmsUserStatus, Role } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '@/middleware/asyncHandler';
import { currentUser, requirePermission } from '@/middleware/auth';
import { emailSchema, enumFilter, paginationSchema, validate } from '@/middleware/validate';
import { plainText } from '@/lib/sanitize';
import { auditContext } from '@/modules/audit/audit.service';
import * as usersService from './users.service';

export const usersRouter = Router();

// Every route here needs users.manage — applied once rather than per route.
usersRouter.use(requirePermission('users.manage'));

const idParam = z.object({ id: z.string().uuid('Not a valid user id.') });

const createSchema = z.object({
  // stripHtml, not just trim: a name renders in the audit log and the CMS table.
  name: z.string().trim().min(2, 'Enter a full name.').max(120).transform(plainText),
  email: emailSchema,
  role: z.nativeEnum(Role),
  sendInvite: z.boolean().optional().default(true),
});

const updateSchema = z
  .object({
    name: z.string().trim().min(2).max(120).transform(plainText).optional(),
    role: z.nativeEnum(Role).optional(),
  })
  // Reject an empty body rather than performing a no-op write.
  .refine((v) => v.name !== undefined || v.role !== undefined, {
    message: 'Nothing to update.',
  });

const listQuerySchema = paginationSchema.extend({
  role: enumFilter(z.nativeEnum(Role)),
  status: enumFilter(z.nativeEnum(CmsUserStatus)),
});

// ---- Routes ----------------------------------------------------------------

usersRouter.get(
  '/',
  validate({ query: listQuerySchema }),
  asyncHandler(async (req, res) => {
    const result = await usersService.list(req.query as never);
    res.json(result);
  }),
);

usersRouter.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const user = await usersService.byId(req.params.id as string);
    res.json({ data: user });
  }),
);

usersRouter.post(
  '/',
  validate({ body: createSchema }),
  asyncHandler(async (req, res) => {
    const result = await usersService.create(req.body, auditContext(req));
    res.status(201).json({ data: result });
  }),
);

usersRouter.patch(
  '/:id',
  validate({ params: idParam, body: updateSchema }),
  asyncHandler(async (req, res) => {
    const actor = currentUser(req);
    const user = await usersService.update(
      req.params.id as string,
      req.body,
      actor.id,
      auditContext(req),
    );
    res.json({ data: user });
  }),
);

/** Activate / deactivate (§11.3). */
usersRouter.patch(
  '/:id/status',
  validate({ params: idParam, body: z.object({ status: z.nativeEnum(CmsUserStatus) }) }),
  asyncHandler(async (req, res) => {
    const actor = currentUser(req);
    const user = await usersService.setStatus(
      req.params.id as string,
      req.body.status,
      actor.id,
      auditContext(req),
    );
    res.json({ data: user });
  }),
);

usersRouter.post(
  '/:id/reset-password',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const result = await usersService.resetPassword(req.params.id as string, auditContext(req));
    res.json({ data: result });
  }),
);

usersRouter.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const actor = currentUser(req);
    await usersService.remove(req.params.id as string, actor.id, auditContext(req));
    res.json({ data: { ok: true } });
  }),
);
