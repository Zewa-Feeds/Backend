import { describe, expect, it } from 'vitest';
import { Role } from '@prisma/client';
import { can, permissionsFor, ALL_PERMISSIONS, isEditorOnly } from './permissions';

/**
 * Exact target account specifications
 */
const TARGET_USERS = {
  zewaFeeds: {
    name: 'Zewa Feeds',
    email: 'info@zewafeeds.com',
    role: Role.OPS_MANAGER,
  },
  aromal: {
    name: 'Aromal Santhosh',
    email: 'aromals@zewafeeds.com',
    role: Role.OPS_MANAGER,
  },
  nik: {
    name: 'Nik Mulakkal',
    email: 'nikhildevm@zewafeeds.com',
    role: Role.ADMIN,
  },
  vaishnavi: {
    name: 'Vaishnavi Prabhakar',
    email: 'vaishnavip@zewafeeds.com',
    role: Role.CONTENT_EDITOR,
  },
  it: {
    name: 'Zewa Feeds IT',
    email: 'it@zewafeeds.com',
    role: Role.ADMIN,
  },
};

describe('Target User Profiles & RBAC Authorization Matrix', () => {
  describe('Account 1: Zewa Feeds (info@zewafeeds.com) — Role: OPS_MANAGER', () => {
    const { role } = TARGET_USERS.zewaFeeds;

    it('allows ONLY Listings and Order Management permissions', () => {
      // Allowed Listings
      expect(can(role, 'products.view')).toBe(true);
      expect(can(role, 'products.edit')).toBe(true);
      expect(can(role, 'products.sku')).toBe(true);

      // Allowed Order Management
      expect(can(role, 'orders.view')).toBe(true);
      expect(can(role, 'orders.status')).toBe(true);
      expect(can(role, 'orders.invoice')).toBe(true);
    });

    it('strictly denies all non-required operational and admin permissions', () => {
      expect(can(role, 'reviews.moderate')).toBe(false);
      expect(can(role, 'coupons.edit')).toBe(false);
      expect(can(role, 'coupons.delete')).toBe(false);
      expect(can(role, 'customers.view')).toBe(false);
      expect(can(role, 'customers.ban')).toBe(false);
      expect(can(role, 'articles.create')).toBe(false);
      expect(can(role, 'articles.publish')).toBe(false);
      expect(can(role, 'articles.delete')).toBe(false);
      expect(can(role, 'banners.edit')).toBe(false);
      expect(can(role, 'homepage.edit')).toBe(false);
      expect(can(role, 'orders.refund')).toBe(false);
      expect(can(role, 'orders.export')).toBe(false);
      expect(can(role, 'users.manage')).toBe(false);
      expect(can(role, 'settings.manage')).toBe(false);
      expect(can(role, 'audit.all')).toBe(false);
    });
  });

  describe('Account 2: Aromal Santhosh (aromals@zewafeeds.com) — Role: OPS_MANAGER', () => {
    const { role } = TARGET_USERS.aromal;

    it('allows ONLY Listings and Order Management permissions', () => {
      // Allowed Listings
      expect(can(role, 'products.view')).toBe(true);
      expect(can(role, 'products.edit')).toBe(true);
      expect(can(role, 'products.sku')).toBe(true);

      // Allowed Order Management
      expect(can(role, 'orders.view')).toBe(true);
      expect(can(role, 'orders.status')).toBe(true);
      expect(can(role, 'orders.invoice')).toBe(true);
    });

    it('strictly denies all non-required operational and admin permissions', () => {
      expect(can(role, 'reviews.moderate')).toBe(false);
      expect(can(role, 'coupons.edit')).toBe(false);
      expect(can(role, 'coupons.delete')).toBe(false);
      expect(can(role, 'customers.view')).toBe(false);
      expect(can(role, 'customers.ban')).toBe(false);
      expect(can(role, 'articles.create')).toBe(false);
      expect(can(role, 'articles.publish')).toBe(false);
      expect(can(role, 'articles.delete')).toBe(false);
      expect(can(role, 'banners.edit')).toBe(false);
      expect(can(role, 'homepage.edit')).toBe(false);
      expect(can(role, 'orders.refund')).toBe(false);
      expect(can(role, 'orders.export')).toBe(false);
      expect(can(role, 'users.manage')).toBe(false);
      expect(can(role, 'settings.manage')).toBe(false);
      expect(can(role, 'audit.all')).toBe(false);
    });
  });

  describe('Account 3: Nik Mulakkal (nikhildevm@zewafeeds.com) — Role: ADMIN', () => {
    const { role } = TARGET_USERS.nik;

    it('allows full ADMIN permissions across all modules', () => {
      for (const perm of ALL_PERMISSIONS) {
        expect(can(role, perm)).toBe(true);
      }
      expect(permissionsFor(role)).toHaveLength(ALL_PERMISSIONS.length);
    });
  });

  describe('Account 4: Vaishnavi Prabhakar (vaishnavip@zewafeeds.com) — Role: CONTENT_EDITOR', () => {
    const { role } = TARGET_USERS.vaishnavi;

    it('allows ONLY Content Creator and Listings view permissions', () => {
      expect(can(role, 'articles.create')).toBe(true);
      expect(can(role, 'banners.edit')).toBe(true);
      expect(can(role, 'homepage.edit')).toBe(true);
      expect(can(role, 'products.view')).toBe(true);
      expect(isEditorOnly(role)).toBe(true);
    });

    it('strictly denies all operational, order management, and admin permissions', () => {
      expect(can(role, 'products.edit')).toBe(false);
      expect(can(role, 'products.sku')).toBe(false);
      expect(can(role, 'orders.view')).toBe(false);
      expect(can(role, 'orders.status')).toBe(false);
      expect(can(role, 'orders.invoice')).toBe(false);
      expect(can(role, 'orders.refund')).toBe(false);
      expect(can(role, 'orders.export')).toBe(false);
      expect(can(role, 'customers.view')).toBe(false);
      expect(can(role, 'customers.ban')).toBe(false);
      expect(can(role, 'coupons.edit')).toBe(false);
      expect(can(role, 'coupons.delete')).toBe(false);
      expect(can(role, 'reviews.moderate')).toBe(false);
      expect(can(role, 'articles.publish')).toBe(false);
      expect(can(role, 'articles.delete')).toBe(false);
      expect(can(role, 'users.manage')).toBe(false);
      expect(can(role, 'settings.manage')).toBe(false);
      expect(can(role, 'audit.all')).toBe(false);
    });
  });

  describe('Account 5: Zewa Feeds IT (it@zewafeeds.com) — Role: ADMIN', () => {
    const { role } = TARGET_USERS.it;

    it('allows full ADMIN permissions across all modules', () => {
      for (const perm of ALL_PERMISSIONS) {
        expect(can(role, perm)).toBe(true);
      }
      expect(permissionsFor(role)).toHaveLength(ALL_PERMISSIONS.length);
    });
  });
});
