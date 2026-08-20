/**
 * Product routes — /api/v1/admin/products
 *
 * Permissions follow §2.1 exactly, and the split matters:
 *   products.view  all roles — an Editor sees the catalogue, without pricing
 *                  (enforced in the serializer, not here)
 *   products.edit  Ops + Admin
 *   products.sku   Ops + Admin — stock and variant changes
 *   delete         Admin only, and requires typing the product name (§17.1)
 */
import { Router } from 'express';
import { ProductStatus } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '@/middleware/asyncHandler';
import { currentUser, requirePermission } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { auditContext } from '@/modules/audit/audit.service';
import { signPreviewToken } from '@/lib/tokens';
import { forbidden } from '@/lib/errors';
import { env } from '@/config/env';
import {
  mediaImpactSchema,
  mediaPreviewSchema,
  productBodySchema,
  productListQuerySchema,
  slugParamSchema,
  stockUpdateSchema,
} from './products.schemas';
import * as productsService from './products.service';

export const productsRouter = Router();

// Reading the catalogue is available to every role (§2.1).
productsRouter.use(requirePermission('products.view'));

// ---- Reads -----------------------------------------------------------------

productsRouter.get(
  '/',
  validate({ query: productListQuerySchema }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const result = await productsService.list(req.query as never, user.role);
    res.json(result);
  }),
);

productsRouter.get(
  '/:slug',
  validate({ params: slugParamSchema }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const product = await productsService.bySlug(req.params.slug as string, user.role);
    res.json({ data: product });
  }),
);

// ---- Writes: Ops + Admin ---------------------------------------------------

/**
 * Resolved galleries for the CMS media manager.
 *
 * POST rather than GET because the editor previews UNSAVED work: the gallery on
 * screen is sent up, resolved server-side, and returned per pack. Resolution
 * therefore has exactly one implementation, shared with the storefront — the CMS
 * never recreates the rules, which is how they drifted apart before.
 *
 * Read-only. Nothing here writes.
 */
productsRouter.post(
  '/:slug/media-preview',
  validate({ params: slugParamSchema, body: mediaPreviewSchema }),
  asyncHandler(async (req, res) => {
    const data = await productsService.previewMedia(req.params.slug as string, req.body);
    res.json({ data });
  }),
);

/**
 * What removing one asset would do. Read-only; nothing is removed here.
 */
productsRouter.post(
  '/:slug/media-impact',
  validate({ params: slugParamSchema, body: mediaImpactSchema }),
  asyncHandler(async (req, res) => {
    const data = await productsService.mediaRemovalImpact(req.params.slug as string, req.body);
    res.json({ data });
  }),
);

productsRouter.post(
  '/',
  requirePermission('products.edit'),
  validate({ body: productBodySchema }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const product = await productsService.create(
      req.body,
      user.id,
      auditContext(req),
      user.role,
    );
    res.status(201).json({ data: product });
  }),
);

/** Save — writes a draft overlay when the product is already live (§5.2). */
productsRouter.patch(
  '/:slug',
  requirePermission('products.edit'),
  validate({ params: slugParamSchema, body: productBodySchema }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const product = await productsService.saveDraft(
      req.params.slug as string,
      req.body,
      user.id,
      auditContext(req),
      user.role,
    );
    res.json({ data: product });
  }),
);

productsRouter.post(
  '/:slug/publish',
  requirePermission('products.edit'),
  validate({ params: slugParamSchema }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const product = await productsService.publish(
      req.params.slug as string,
      user.id,
      auditContext(req),
      user.role,
    );
    res.json({ data: product });
  }),
);

productsRouter.post(
  '/:slug/discard-draft',
  requirePermission('products.edit'),
  validate({ params: slugParamSchema }),
  asyncHandler(async (req, res) => {
    await productsService.discardDraft(req.params.slug as string, auditContext(req));
    res.json({ data: { ok: true } });
  }),
);

productsRouter.patch(
  '/:slug/status',
  requirePermission('products.edit'),
  validate({
    params: slugParamSchema,
    body: z.object({ status: z.nativeEnum(ProductStatus) }),
  }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const product = await productsService.setStatus(
      req.params.slug as string,
      req.body.status,
      user.id,
      auditContext(req),
      user.role,
    );
    res.json({ data: product });
  }),
);

/** §5.3 stock quick-update — every SKU in the family, one call. */
productsRouter.patch(
  '/:slug/stock',
  requirePermission('products.sku'),
  validate({ params: slugParamSchema, body: stockUpdateSchema }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const product = await productsService.updateStock(
      req.params.slug as string,
      req.body.updates,
      user.id,
      auditContext(req),
      user.role,
    );
    res.json({ data: product });
  }),
);

/**
 * Mint a preview token (§5.2).
 *
 * Short-lived and scoped to one slug, so a leaked token exposes one unpublished
 * product for 15 minutes rather than the whole draft catalogue.
 */
productsRouter.post(
  '/:slug/preview-token',
  requirePermission('products.edit'),
  validate({ params: slugParamSchema }),
  asyncHandler(async (req, res) => {
    const slug = req.params.slug as string;
    const token = signPreviewToken({ sub: currentUser(req).id, kind: 'product', slug });

    res.json({
      data: {
        token,
        url: `${env.STOREFRONT_ORIGIN}/preview/products/${slug}?token=${token}`,
        expiresIn: env.PREVIEW_TOKEN_TTL,
      },
    });
  }),
);

/**
 * Delete — Admin only (§2.1), with typed-name confirmation (§17.1).
 *
 * The confirmation is re-checked server-side: a client-side-only check is
 * decoration, since anyone can call the endpoint directly.
 */
productsRouter.delete(
  '/:slug',
  requirePermission('products.edit'),
  validate({
    params: slugParamSchema,
    body: z.object({ confirmName: z.string().trim().min(1, 'Type the product name to confirm.') }),
  }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    // §2.1 gives products.edit to Ops, but deletion to Admin alone.
    if (user.role !== 'ADMIN') {
      throw forbidden('Only an Admin can delete a product.');
    }

    const slug = req.params.slug as string;
    const product = await productsService.bySlug(slug, user.role);
    if (product.name !== req.body.confirmName.trim()) {
      throw forbidden('The name you typed does not match this product.');
    }

    await productsService.remove(slug, auditContext(req));
    res.json({ data: { ok: true } });
  }),
);
