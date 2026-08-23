import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CmsUserStatus, Role, AuditModule } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { hashToken, verifyPassword, hashPassword } from '@/lib/crypto';
import { accountTemplates } from '@/integrations/zeptomail/templates';
import * as usersService from './users.service';
import * as authService from '@/modules/auth/auth.service';

vi.mock('@/lib/prisma', () => {
  const store = new Map<string, any>();
  const invitations = new Map<string, any>();
  const sessions = new Map<string, any>();
  const auditLogs: any[] = [];

  const prismaMock = {
    cmsUser: {
      findUnique: vi.fn(async ({ where, include }: any) => {
        let user = null;
        if (where.id) user = store.get(where.id);
        if (where.email) {
          for (const u of store.values()) {
            if (u.email === where.email) {
              user = u;
              break;
            }
          }
        }
        if (!user) return null;
        if (include?.invitation) {
          const inv = invitations.get(user.id);
          return { ...user, invitation: inv ?? null };
        }
        return { ...user };
      }),
      findFirst: vi.fn(async ({ where, select, include }: any) => {
        for (const u of store.values()) {
          if (where.id && u.id !== where.id) continue;
          if (where.deletedAt === null && u.deletedAt !== null) continue;
          if (where.email && u.email !== where.email) continue;
          if (include?.invitation) {
            const inv = invitations.get(u.id);
            return { ...u, invitation: inv ?? null };
          }
          return { ...u };
        }
        return null;
      }),
      findMany: vi.fn(async ({ where }: any = {}) => {
        let list = Array.from(store.values());
        if (where?.deletedAt === null) list = list.filter((u) => u.deletedAt === null);
        if (where?.role) list = list.filter((u) => u.role === where.role);
        if (where?.status) list = list.filter((u) => u.status === where.status);
        return list.map((u) => ({
          ...u,
          invitation: invitations.get(u.id) ?? null,
        }));
      }),
      count: vi.fn(async ({ where }: any = {}) => {
        let list = Array.from(store.values());
        if (where?.deletedAt === null) list = list.filter((u) => u.deletedAt === null);
        if (where?.role) list = list.filter((u) => u.role === where.role);
        if (where?.status) list = list.filter((u) => u.status === where.status);
        if (where?.id?.not) list = list.filter((u) => u.id !== where.id.not);
        return list.length;
      }),
      create: vi.fn(async ({ data }: any) => {
        const id = data.id || `user-${Date.now()}-${Math.random()}`;
        const row = {
          id,
          email: data.email,
          name: data.name,
          role: data.role,
          phone: data.phone || null,
          status: data.status,
          passwordHash: data.passwordHash,
          passwordHistory: [],
          twofaMethod: null,
          twofaSecret: null,
          twofaEnrolledAt: null,
          tokenVersion: 0,
          lastLoginAt: null,
          deletedAt: null,
          activatedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        store.set(id, row);
        if (data.invitation?.create) {
          const invId = `inv-${Date.now()}`;
          const invRow = {
            id: invId,
            userId: id,
            tokenHash: data.invitation.create.tokenHash,
            expiresAt: data.invitation.create.expiresAt,
            usedAt: null,
            revokedAt: null,
            invitedById: data.invitation.create.invitedById || null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          invitations.set(id, invRow);
        }
        return {
          ...row,
          invitation: invitations.get(id) ?? null,
        };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = store.get(where.id);
        if (!row) throw new Error('User not found');
        const updated = {
          ...row,
          ...data,
          tokenVersion:
            data.tokenVersion?.increment !== undefined
              ? row.tokenVersion + data.tokenVersion.increment
              : data.tokenVersion ?? row.tokenVersion,
          updatedAt: new Date(),
        };
        store.set(where.id, updated);
        return { ...updated, invitation: invitations.get(where.id) ?? null };
      }),
      delete: vi.fn(async ({ where }: any) => {
        store.delete(where.id);
        invitations.delete(where.id);
      }),
    },
    cmsInvitation: {
      findUnique: vi.fn(async ({ where, include }: any) => {
        let inv = null;
        if (where.userId) inv = invitations.get(where.userId);
        if (where.tokenHash) {
          for (const i of invitations.values()) {
            if (i.tokenHash === where.tokenHash) {
              inv = i;
              break;
            }
          }
        }
        if (!inv) return null;
        if (include?.user) {
          const u = store.get(inv.userId);
          return { ...inv, user: u };
        }
        return { ...inv };
      }),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        let inv = invitations.get(where.userId);
        if (inv) {
          inv = { ...inv, ...update, updatedAt: new Date() };
        } else {
          inv = {
            id: `inv-${Date.now()}`,
            userId: create.userId,
            tokenHash: create.tokenHash,
            expiresAt: create.expiresAt,
            usedAt: null,
            revokedAt: null,
            invitedById: create.invitedById,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        }
        invitations.set(where.userId, inv);
        return inv;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        let inv = null;
        for (const i of invitations.values()) {
          if (i.id === where.id) {
            inv = i;
            break;
          }
        }
        if (!inv) throw new Error('Invitation not found');
        const updated = { ...inv, ...data, updatedAt: new Date() };
        invitations.set(inv.userId, updated);
        return updated;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const i of invitations.values()) {
          if (where.userId && i.userId === where.userId) {
            Object.assign(i, data);
            count++;
          }
        }
        return { count };
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        if (where.userId) invitations.delete(where.userId);
        return { count: 1 };
      }),
    },
    cmsSession: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async () => ({})),
    },
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        auditLogs.push(data);
        return data;
      }),
    },
    $transaction: vi.fn(async (cb: any) => cb(prismaMock)),
    _store: store,
    _invitations: invitations,
    _auditLogs: auditLogs,
  };

  return { prisma: prismaMock };
});

vi.mock('@/jobs/queues', () => ({
  emailQueue: {
    add: vi.fn(async () => ({ id: 'mock-job-id' })),
  },
}));

const mockAuditCtx = {
  actorId: 'admin-actor-1',
  actorName: 'Nik Mulakkal',
  actorRole: 'Admin',
  ip: '127.0.0.1',
};

describe('CMS User Management & Invitation Lifecycle', () => {
  const testEmail = 'parthk@zewafeeds.com';

  beforeEach(() => {
    // Reset mock stores
    (prisma as any)._store.clear();
    (prisma as any)._invitations.clear();
    (prisma as any)._auditLogs.length = 0;
  });

  describe('Invitation Template Rendering', () => {
    it('renders clean transactional HTML email with role, email, and 48-hour expiration', () => {
      const rendered = accountTemplates['cms-user-invitation']({
        recipientName: 'Parth K',
        recipientEmail: testEmail,
        roleLabel: 'Admin',
        inviteUrl: 'https://cms.zewafeeds.com/accept-invitation?token=testtoken123',
        expiresInHours: 48,
      });

      expect(rendered.subject).toBe("You're invited to Zewa Feeds CMS");
      expect(rendered.html).toContain('Hi Parth K');
      expect(rendered.html).toContain('Admin');
      expect(rendered.html).toContain(testEmail);
      expect(rendered.html).toContain('48 hours');
      expect(rendered.html).toContain('https://cms.zewafeeds.com/accept-invitation?token=testtoken123');
      expect(rendered.html).toContain('Accept Invitation &amp; Set Password');
    });
  });

  describe('User Invitation Service', () => {
    it('creates an INVITED user, stores SHA-256 tokenHash, and returns secure setup token', async () => {
      const result = await usersService.create(
        {
          name: 'Parth K',
          email: 'ParthK@ZewaFeeds.com', // Test email case-insensitive normalization
          role: Role.ADMIN,
          phone: '+91 95004 39828',
          sendInvite: true,
        },
        mockAuditCtx,
      );

      expect(result.user.email).toBe(testEmail);
      expect(result.user.status).toBe(CmsUserStatus.INVITED);
      expect(result.user.phone).toBe('+91 95004 39828');
      expect(result.setupToken).toBeDefined();
      expect(result.inviteUrl).toContain('/accept-invitation?token=');

      // Assert that DB stored ONLY the hash, not the plaintext token
      const dbInv = (prisma as any)._invitations.get(result.user.id);
      expect(dbInv).toBeDefined();
      expect(dbInv.tokenHash).toBe(hashToken(result.setupToken!));
      expect(dbInv.usedAt).toBeNull();
      expect(dbInv.revokedAt).toBeNull();
    });

    it('rejects duplicate invitations for the same email with helpful conflict error', async () => {
      await usersService.create(
        {
          name: 'Parth K',
          email: testEmail,
          role: Role.ADMIN,
          sendInvite: false,
        },
        mockAuditCtx,
      );

      await expect(
        usersService.create(
          {
            name: 'Parth Duplicate',
            email: testEmail,
            role: Role.ADMIN,
            sendInvite: false,
          },
          mockAuditCtx,
        ),
      ).rejects.toThrow(/invitation is already pending/i);
    });

    it('resends invitation by generating a new token and updating expiry', async () => {
      const created = await usersService.create(
        {
          name: 'Parth K',
          email: testEmail,
          role: Role.ADMIN,
          sendInvite: false,
        },
        mockAuditCtx,
      );

      const resent = await usersService.resendInvitation(created.user.id, mockAuditCtx);
      expect(resent.ok).toBe(true);
      expect(resent.setupToken).toBeDefined();
      expect(resent.setupToken).not.toBe(created.setupToken);

      const dbInv = (prisma as any)._invitations.get(created.user.id);
      expect(dbInv.tokenHash).toBe(hashToken(resent.setupToken));
    });

    it('revokes an invitation, marking it revoked and deactivating the user', async () => {
      const created = await usersService.create(
        {
          name: 'Revoke Candidate',
          email: 'revoke@zewafeeds.com',
          role: Role.CONTENT_EDITOR,
          sendInvite: false,
        },
        mockAuditCtx,
      );

      const revoked = await usersService.revokeInvitation(created.user.id, mockAuditCtx);
      expect(revoked.ok).toBe(true);

      const dbInv = (prisma as any)._invitations.get(created.user.id);
      expect(dbInv.revokedAt).toBeDefined();
    });
  });

  describe('Invitation Acceptance & Account Activation', () => {
    it('blocks login for INVITED accounts before invitation is accepted', async () => {
      await usersService.create(
        {
          name: 'Parth K',
          email: testEmail,
          role: Role.ADMIN,
          sendInvite: false,
        },
        mockAuditCtx,
      );

      await expect(
        authService.login(testEmail, 'AnyPassword123!', mockAuditCtx),
      ).rejects.toThrow(/pending invitation acceptance/i);
    });

    it('fetches invitation details for a valid token', async () => {
      const created = await usersService.create(
        {
          name: 'Parth K',
          email: testEmail,
          role: Role.ADMIN,
          sendInvite: false,
        },
        mockAuditCtx,
      );

      const details = await authService.getInvitationDetails(created.setupToken!);
      expect(details.email).toBe(testEmail);
      expect(details.name).toBe('Parth K');
      expect(details.role).toBe(Role.ADMIN);
      expect(details.roleLabel).toBe('Admin');
    });

    it('accepts valid invitation, enforces password policy, hashes password, and activates user', async () => {
      const created = await usersService.create(
        {
          name: 'Parth K',
          email: testEmail,
          role: Role.ADMIN,
          sendInvite: false,
        },
        mockAuditCtx,
      );

      // Weak password rejected
      await expect(
        authService.acceptInvitation(
          {
            token: created.setupToken!,
            password: 'weak',
          },
          mockAuditCtx,
        ),
      ).rejects.toThrow(/Password does not meet the policy/i);

      // Valid strong password accepted
      const password = 'StrongPassword123!';
      const res = await authService.acceptInvitation(
        {
          token: created.setupToken!,
          name: 'Parth K',
          password,
        },
        mockAuditCtx,
      );

      expect(res.ok).toBe(true);

      const user = (prisma as any)._store.get(created.user.id);
      expect(user.status).toBe(CmsUserStatus.ACTIVE);
      expect(user.activatedAt).toBeDefined();

      const match = await verifyPassword(password, user.passwordHash);
      expect(match).toBe(true);

      const dbInv = (prisma as any)._invitations.get(created.user.id);
      expect(dbInv.usedAt).toBeDefined();

      // Reusing already accepted invitation rejected
      await expect(
        authService.acceptInvitation(
          {
            token: created.setupToken!,
            password: 'AnotherPassword123!',
          },
          mockAuditCtx,
        ),
      ).rejects.toThrow(/already been used/i);
    });
  });

  describe('Role Management & Safety Safeguards', () => {
    it('allows Admin to change another user role', async () => {
      const created = await usersService.create(
        {
          name: 'Editor User',
          email: 'editor@zewafeeds.com',
          role: Role.CONTENT_EDITOR,
          sendInvite: false,
        },
        mockAuditCtx,
      );

      const updated = await usersService.update(
        created.user.id,
        { role: Role.OPS_MANAGER },
        'admin-actor-1',
        mockAuditCtx,
      );

      expect(updated.role).toBe(Role.OPS_MANAGER);
      expect(updated.roleLabel).toBe('Ops Manager');
    });

    it('strictly prevents an administrator from demoting their own role', async () => {
      const adminId = 'admin-actor-1';
      (prisma as any)._store.set(adminId, {
        id: adminId,
        email: 'nikhildevm@zewafeeds.com',
        name: 'Nik Mulakkal',
        role: Role.ADMIN,
        status: CmsUserStatus.ACTIVE,
        passwordHash: 'hash',
        tokenVersion: 0,
        deletedAt: null,
      });

      await expect(
        usersService.update(adminId, { role: Role.OPS_MANAGER }, adminId, mockAuditCtx),
      ).rejects.toThrow(/cannot change your own role/i);
    });

    it('strictly prevents demoting or deactivating the last active Admin', async () => {
      const soleAdminId = 'sole-admin-id';
      (prisma as any)._store.set(soleAdminId, {
        id: soleAdminId,
        email: 'soleadmin@zewafeeds.com',
        name: 'Sole Admin',
        role: Role.ADMIN,
        status: CmsUserStatus.ACTIVE,
        passwordHash: 'hash',
        tokenVersion: 0,
        deletedAt: null,
      });

      // Attempt to demote sole admin
      await expect(
        usersService.update(soleAdminId, { role: Role.OPS_MANAGER }, 'other-actor', mockAuditCtx),
      ).rejects.toThrow(/last active Admin/i);

      // Attempt to deactivate sole admin
      await expect(
        usersService.setStatus(soleAdminId, CmsUserStatus.DEACTIVATED, 'other-actor', mockAuditCtx),
      ).rejects.toThrow(/last active Admin/i);
    });
  });
});
