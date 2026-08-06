/**
 * Global error handler + 404 handler.
 *
 * Mounted last. Every route can throw freely — including from async handlers,
 * thanks to asyncHandler — and the response shape stays consistent:
 *
 *   { error: { code, message, fields?, details? } }
 */
import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { AppError, ErrorCode, notFound } from '@/lib/errors';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'error' });

/** Anything unmatched by a router lands here. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(notFound(`Route ${req.method} ${req.path}`));
}

/** Turn a ZodError into { field: message } for §17.3 inline errors. */
function zodToFields(err: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '_root';
    // First error per field wins — showing one message per input is the UX we want.
    fields[key] ??= issue.message;
  }
  return fields;
}

/** Map Prisma's error codes onto ours so callers get something actionable. */
function fromPrisma(err: Prisma.PrismaClientKnownRequestError): AppError {
  switch (err.code) {
    case 'P2002': {
      // Unique constraint violation.
      const target = err.meta?.target;
      const field = Array.isArray(target) ? String(target[0]) : String(target ?? 'value');
      return new AppError(409, ErrorCode.CONFLICT, `That ${field} is already taken.`, {
        fields: { [field]: 'Already in use.' },
      });
    }
    case 'P2025':
      return new AppError(404, ErrorCode.NOT_FOUND, 'Record not found.');
    case 'P2003':
      return new AppError(409, ErrorCode.CONFLICT, 'Related record is missing or still in use.');
    default:
      return new AppError(500, ErrorCode.INTERNAL, 'Database error.', { isExpected: false });
  }
}

function normalise(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    return new AppError(422, ErrorCode.VALIDATION_FAILED, 'Some fields need attention.', {
      fields: zodToFields(err),
    });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) return fromPrisma(err);
  if (err instanceof Prisma.PrismaClientValidationError) {
    return new AppError(400, ErrorCode.VALIDATION_FAILED, 'Malformed request.', {
      isExpected: false,
    });
  }

  // Body-parser payload overflow.
  if (
    err instanceof Error &&
    'type' in err &&
    (err as { type?: string }).type === 'entity.too.large'
  ) {
    return new AppError(413, ErrorCode.PAYLOAD_TOO_LARGE, 'Request body is too large.');
  }

  return new AppError(500, ErrorCode.INTERNAL, 'Something went wrong.', { isExpected: false });
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const appErr = normalise(err);

  // Expected errors (a 404, a failed validation) are request-level noise at info.
  // Unexpected ones are bugs — log the original error with its stack.
  const payload = {
    err: appErr.isExpected ? undefined : err,
    code: appErr.code,
    status: appErr.status,
    method: req.method,
    path: req.originalUrl,
    requestId: req.id,
  };

  if (appErr.isExpected) {
    log.info(payload, appErr.message);
  } else {
    log.error(payload, appErr.message);
  }

  // Headers already flushed (e.g. a stream failed mid-send) — just end it.
  if (res.headersSent) {
    res.end();
    return;
  }

  res.status(appErr.status).json({
    error: {
      code: appErr.code,
      message: appErr.message,
      ...(appErr.fields ? { fields: appErr.fields } : {}),
      ...(appErr.details ? { details: appErr.details } : {}),
      // Stacks in development only — never leak internals to a client.
      ...(env.isProd || appErr.isExpected
        ? {}
        : { stack: err instanceof Error ? err.stack : undefined }),
    },
  });
};
