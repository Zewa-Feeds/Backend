/**
 * Review moderation routes — /api/v1/admin/reviews  (§9)
 * `reviews.moderate` — Ops + Admin. Editors have no access.
 */
import { Router } from 'express';
import { ReviewState } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '@/middleware/asyncHandler';
import { currentUser, requirePermission } from '@/middleware/auth';
import { enumFilter, paginationSchema, validate } from '@/middleware/validate';
import { auditContext } from '@/modules/audit/audit.service';
import * as reviewsService from './reviews.service';

export const reviewsRouter = Router();

reviewsRouter.use(requirePermission('reviews.moderate'));

const idParam = z.object({ id: z.string().uuid() });

reviewsRouter.get(
  '/',
  validate({ query: paginationSchema.extend({ state: enumFilter(z.nativeEnum(ReviewState)) }) }),
  asyncHandler(async (req, res) => {
    res.json(await reviewsService.list(req.query as never));
  }),
);

reviewsRouter.patch(
  '/:id/state',
  validate({ params: idParam, body: z.object({ state: z.nativeEnum(ReviewState) }) }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const review = await reviewsService.setState(
      req.params.id as string,
      req.body.state,
      user.id,
      auditContext(req),
    );
    res.json({ data: review });
  }),
);

/** "Approve All Visible" (§9). */
reviewsRouter.post(
  '/bulk-approve',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const result = await reviewsService.approveAllPending(user.id, auditContext(req));
    res.json({ data: result });
  }),
);
