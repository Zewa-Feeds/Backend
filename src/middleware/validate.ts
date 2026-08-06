/**
 * Request validation.
 *
 * Every endpoint that accepts input declares a Zod schema. Two reasons beyond
 * correctness:
 *
 *  - **Strip unknown keys.** Zod objects drop unlisted properties, so a client
 *    cannot smuggle `{ role: "ADMIN" }` into a profile update and have it reach
 *    Prisma. This is mass-assignment protection, and it is why every schema uses
 *    plain `z.object` rather than `.passthrough()`.
 *  - **Consistent field errors.** Failures become
 *    `{ error: { fields: { slug: "..." } } }`, which is what §17.3 inline form
 *    errors need.
 *
 * SQL injection is separately handled by Prisma's parameterised queries — no
 * endpoint builds SQL from strings.
 */
import type { RequestHandler } from 'express';
import { z, type ZodTypeAny } from 'zod';

interface Schemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

/**
 * Validate and REPLACE the request parts with parsed output.
 *
 * Replacing matters: handlers then read coerced, stripped values rather than raw
 * strings, so `?page=2` is a number and stray keys are already gone.
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    try {
      if (schemas.params) req.params = schemas.params.parse(req.params);
      if (schemas.query) {
        // req.query has a getter-only descriptor on some Express versions.
        Object.defineProperty(req, 'query', {
          value: schemas.query.parse(req.query),
          writable: true,
          configurable: true,
          enumerable: true,
        });
      }
      if (schemas.body) req.body = schemas.body.parse(req.body);
      next();
    } catch (err) {
      // ZodError is normalised into field errors by the global error handler.
      next(err);
    }
  };
}

// ---- Reusable primitives ---------------------------------------------------

export const uuidParam = z.string().uuid('Not a valid id.');

/** URL slug: lowercase, alphanumeric, hyphen-separated. */
export const slugSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and hyphens only.');

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Enter a valid email address.')
  .max(255);

/** Indian mobile: 10 digits, optionally +91 prefixed. Stored normalised. */
export const phoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .refine((v) => /^(\+91)?[6-9]\d{9}$/.test(v), 'Enter a valid 10-digit mobile number.');

export const pincodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter a valid 6-digit PIN code.');

/** Money accepted as rupees from the CMS, stored as paise. */
export const rupeesToPaise = z
  .number()
  .nonnegative('Cannot be negative.')
  .max(10_000_000, 'That amount looks wrong.')
  .transform((rupees) => Math.round(rupees * 100));

export const paiseSchema = z.number().int().nonnegative().max(1_000_000_000);

/**
 * Enum filter that treats "All" (and "") as "no filter".
 *
 * The CMS dropdowns use "All" as their unset sentinel. Rejecting it with a 422
 * would break an unfiltered list, so it maps to undefined instead. Display labels
 * are also accepted ("Coming Soon" -> COMING_SOON).
 */
export function enumFilter<T extends z.ZodTypeAny>(inner: T) {
  return z.preprocess((v) => {
    if (typeof v !== 'string') return v;
    const norm = v.toUpperCase().replace(/\s+/g, '_');
    return norm === 'ALL' || norm === '' ? undefined : norm;
  }, inner.optional());
}

/** Standard list pagination. */
export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  q: z.string().trim().max(200).optional(),
  sort: z.string().trim().max(60).optional(),
});

export type Pagination = z.infer<typeof paginationSchema>;

/** Offset/limit for Prisma, from validated pagination. */
export const toSkipTake = (p: { page: number; limit: number }) => ({
  skip: (p.page - 1) * p.limit,
  take: p.limit,
});

/** Envelope for list responses. */
export const listMeta = (page: number, limit: number, total: number) => ({
  page,
  limit,
  total,
  pages: Math.max(1, Math.ceil(total / limit)),
});
