/**
 * RBAC — spec §2 and §2.1.
 *
 * Ported from CMS/lib/rbac.js. The permission KEYS are identical on purpose: the
 * CMS already gates its UI on these strings, so keeping them in sync means the
 * button a user can see is exactly the endpoint they can call.
 *
 * The CMS is UI gating only. THIS FILE IS THE AUTHORITY — never trust the client.
 */
import { Role } from '@prisma/client';

/** Roles low to high. Higher roles inherit everything below them (§2). */
export const ROLE_ORDER: readonly Role[] = [
  Role.CONTENT_EDITOR,
  Role.OPS_MANAGER,
  Role.ADMIN,
] as const;

/** Display names, matching the CMS. */
export const ROLE_LABELS: Record<Role, string> = {
  [Role.CONTENT_EDITOR]: 'Content Editor',
  [Role.OPS_MANAGER]: 'Ops Manager',
  [Role.ADMIN]: 'Admin',
};

const EDITOR = Role.CONTENT_EDITOR;
const OPS = Role.OPS_MANAGER;
const ADMIN = Role.ADMIN;

/**
 * Permission -> roles that hold it. The §2.1 matrix, verbatim.
 *
 * Note `articles.create` is held by all three roles while `articles.publish` is
 * Ops+ and `articles.delete` is Admin only — an Editor can write but not ship,
 * and cannot destroy. Same shape for products, coupons, and orders.
 */
export const CAN = {
  // Content Creator (Editor + Admin)
  'articles.create': [EDITOR, ADMIN],
  'articles.publish': [ADMIN],
  'articles.delete': [ADMIN],
  'banners.edit': [EDITOR, ADMIN],
  'homepage.edit': [EDITOR, ADMIN],

  // Listings (Editor gets read-only view; Ops & Admin get full management)
  'products.view': [EDITOR, OPS, ADMIN],
  'products.edit': [OPS, ADMIN],
  'products.sku': [OPS, ADMIN],

  // Order Management (Ops & Admin get view, status transitions, invoices)
  'orders.view': [OPS, ADMIN],
  'orders.status': [OPS, ADMIN],
  'orders.invoice': [OPS, ADMIN],

  // Admin Only
  'orders.refund': [ADMIN],
  'orders.export': [ADMIN],
  'customers.view': [ADMIN],
  'customers.ban': [ADMIN],
  'reviews.moderate': [ADMIN],
  'coupons.edit': [ADMIN],
  'coupons.delete': [ADMIN],
  'users.manage': [ADMIN],
  'settings.manage': [ADMIN],
  'audit.all': [ADMIN],
  'audit.own': [OPS, ADMIN],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof CAN;

/** All permission keys — useful for tests and for the /admin/auth/me payload. */
export const ALL_PERMISSIONS = Object.keys(CAN) as Permission[];

/** Does `role` hold `permission`? */
export function can(role: Role, permission: Permission): boolean {
  const allowed = CAN[permission] as readonly Role[] | undefined;
  return allowed?.includes(role) ?? false;
}

/**
 * Every permission a role holds. Sent to the CMS on login so it can gate nav and
 * buttons without hardcoding the matrix a second time.
 */
export function permissionsFor(role: Role): Permission[] {
  return ALL_PERMISSIONS.filter((p) => can(role, p));
}

/**
 * Products are the one module with an asymmetry worth calling out: a Content
 * Editor holds `products.view` but must not see cost or margin data. Route guards
 * cannot express that — it is enforced in the product serializer.
 */
export function isEditorOnly(role: Role): boolean {
  return role === EDITOR;
}
