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
import { CustomerStatus } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '@/middleware/asyncHandler';
import { requirePermission } from '@/middleware/auth';
import { enumFilter, paginationSchema, validate } from '@/middleware/validate';
import { auditContext } from '@/modules/audit/audit.service';
import * as customersService from './customers.service';

export const customersRouter = Router();

customersRouter.use(requirePermission('customers.view'));

const idParam = z.object({ id: z.string().uuid() });

customersRouter.get(
  '/',
  validate({ query: paginationSchema.extend({ status: enumFilter(z.nativeEnum(CustomerStatus)) }) }),
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
