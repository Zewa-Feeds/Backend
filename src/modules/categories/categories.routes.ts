/**
 * Product category routes — /api/v1/admin/categories
 *
 * Reading is open to every role that can see the catalogue, since the product
 * form needs the list. Creating, renaming, reordering and hiding are
 * merchandising, behind the same `products.edit` as editing a product.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '@/middleware/asyncHandler';
import { requirePermission } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { plainText } from '@/lib/sanitize';
import { auditContext } from '@/modules/audit/audit.service';
import * as service from './categories.service';

export const categoriesRouter = Router();

categoriesRouter.use(requirePermission('products.view'));

const labelSchema = z
  .string()
  .trim()
  .min(2, 'Enter a name.')
  .max(60)
  .transform((v) => plainText(v));

const codeParam = z.object({ code: z.string().trim().min(1).max(64) });

const createSchema = z.object({ label: labelSchema, isActive: z.boolean().optional() });
const updateSchema = z
  .object({ label: labelSchema.optional(), isActive: z.boolean().optional() })
  .refine((v) => v.label !== undefined || v.isActive !== undefined, 'Nothing to update.');
const reorderSchema = z.object({ order: z.array(z.string().trim().min(1).max(64)).min(1).max(200) });

categoriesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ data: await service.list() });
  }),
);

categoriesRouter.post(
  '/',
  requirePermission('products.edit'),
  validate({ body: createSchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json({ data: await service.create(req.body, auditContext(req)) });
  }),
);

// Declared before '/:code' so "order" is never read as a category code.
categoriesRouter.put(
  '/order',
  requirePermission('products.edit'),
  validate({ body: reorderSchema }),
  asyncHandler(async (req, res) => {
    res.json({ data: await service.reorder(req.body.order, auditContext(req)) });
  }),
);

categoriesRouter.patch(
  '/:code',
  requirePermission('products.edit'),
  validate({ params: codeParam, body: updateSchema }),
  asyncHandler(async (req, res) => {
    res.json({ data: await service.update(req.params.code!, req.body, auditContext(req)) });
  }),
);

categoriesRouter.delete(
  '/:code',
  requirePermission('products.edit'),
  validate({ params: codeParam }),
  asyncHandler(async (req, res) => {
    await service.remove(req.params.code!, auditContext(req));
    res.status(204).end();
  }),
);
