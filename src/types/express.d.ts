/**
 * Express request augmentation.
 *
 * `req.user` is populated by requireAuth (staff) and `req.customer` by the
 * customer guard. They are typed as optional because a handler behind a guard
 * still has to be reachable from an unguarded router at the type level — use the
 * `currentUser(req)` helper in src/middleware/auth.ts to get a non-null value.
 */
import type { Role } from '@prisma/client';
import type { Permission } from '@/rbac/permissions';

/** The authenticated staff member, decoded from the access token. */
export interface StaffPrincipal {
  id: string;
  email: string;
  name: string;
  role: Role;
  permissions: Permission[];
}

/**
 * The authenticated storefront customer.
 *
 * Carries the whole profile, not just the identity, because the guard has to
 * read the row anyway to check the BANNED flag. `/account/me` was issuing a
 * second query for the row the guard had just loaded — same customer, same
 * request, twice — so these fields are now loaded once and reused.
 *
 * `status` is deliberately NOT here: the guard consumes it and nothing
 * downstream should branch on it, least of all a response body.
 */
export interface CustomerPrincipal {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  registeredAt: Date;
}

declare global {
  namespace Express {
    interface Request {
      /** Correlation id — set by requestId middleware, echoed as X-Request-Id. */
      id: string;
      user?: StaffPrincipal;
      customer?: CustomerPrincipal;
    }
  }
}

export {};
