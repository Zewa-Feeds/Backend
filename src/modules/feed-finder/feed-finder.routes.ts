/**
 * Find My Feed run log — /api/v1/feed-finder/*
 *
 * Public and anonymous. The storefront writes one row when a customer reaches
 * a result (match or no-match) and flags it when anything from that result goes
 * into the cart. Nothing here is read back by the storefront; the rows are for
 * the team — which recommendations convert, and which species are missing.
 *
 * The recommendation itself is computed in the storefront from its data
 * tables. This endpoint records what was shown; it does not re-derive it.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '@/middleware/asyncHandler';
import { validate } from '@/middleware/validate';
import { prisma } from '@/lib/prisma';
import { notFound } from '@/lib/errors';

export const feedFinderRouter = Router();

const token = z.string().trim().max(40);
const skuSchema = z.string().trim().toUpperCase().max(40);

const answersSchema = z.object({
  species: token.nullable().optional(),
  size: token.nullable().optional(),
  mates: z.array(token).max(6).optional(),
  home: token.nullable().optional(),
  goal: token.nullable().optional(),
  count: token.nullable().optional(),
});

feedFinderRouter.post(
  '/runs',
  validate({
    body: z.object({
      answers: answersSchema,
      outcome: z.enum(['MATCH', 'NO_MATCH']),
      noMatchCase: token.nullable().optional(),
      resultSku: skuSchema.nullable().optional(),
      addOnSkus: z.array(skuSchema).max(6).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const run = await prisma.feedFinderRun.create({
      data: {
        answers: req.body.answers,
        outcome: req.body.outcome,
        noMatchCase: req.body.noMatchCase ?? null,
        resultSku: req.body.resultSku ?? null,
        addOnSkus: req.body.addOnSkus ?? [],
      },
      select: { id: true },
    });
    res.status(201).json({ data: run });
  }),
);

feedFinderRouter.post(
  '/runs/:id/cart',
  validate({ params: z.object({ id: z.string().uuid() }), body: z.object({ sku: skuSchema }) }),
  asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    const run = await prisma.feedFinderRun.findUnique({ where: { id }, select: { addedSkus: true } });
    if (!run) throw notFound('Run');
    const sku = req.body.sku as string;
    await prisma.feedFinderRun.update({
      where: { id },
      data: {
        addedToCart: true,
        addedSkus: run.addedSkus.includes(sku) ? undefined : { push: sku },
      },
    });
    res.status(204).end();
  }),
);
