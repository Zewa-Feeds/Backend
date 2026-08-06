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

/** The authenticated storefront customer. */
export interface CustomerPrincipal {
  id: string;
  email: string;
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
