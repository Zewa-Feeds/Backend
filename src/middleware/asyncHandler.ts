/**
 * Wraps an async route handler so a rejected promise reaches Express's error
 * handler instead of becoming an unhandled rejection.
 *
 * Express 4 does not await handlers, so without this every async route needs its
 * own try/catch. Wrap once, then throw freely:
 *
 *   router.get('/:slug', asyncHandler(async (req, res) => {
 *     const product = await service.bySlug(req.params.slug);
 *     if (!product) throw notFound('Product');
 *     res.json({ data: product });
 *   }));
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

type AsyncRequestHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

export function asyncHandler(fn: AsyncRequestHandler): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/** Alias — reads better on some call sites. */
export const ah = asyncHandler;
