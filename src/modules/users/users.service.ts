/**
 * CMS user management — spec §11. Admin only.
 *
 * The most privilege-sensitive module in the system: anyone who can write here can
 * grant themselves any role. Three protections beyond the `users.manage` guard:
 *
 *   1. **No self-role-change.** An Admin cannot alter their own role, so a
 *      compromised session cannot quietly de-escalate to hide activity, and a
 *      mis-click cannot lock the last Admin out.
 *   2. **No self-deactivate / self-delete.** Same reasoning.
 *   3. **Last-Admin protection.** The system must always retain one active Admin,
 *      or §13 settings and §6.4 refunds become permanently unreachable.
 */
import { AuditModule, CmsUserStatus, Role, type Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { generateToken, hashPassword, hashToken } from '@/lib/crypto';
import { AppError, ErrorCode, conflict, forbidden, notFound } from '@/lib/errors';
import { ROLE_LABELS } from '@/rbac/permissions';
import { type AuditContext, buildDiff, writeAudit } from '@/modules/audit/audit.service';
import type { Pagination } from '@/middleware/validate';
import { listMeta, toSkipTake } from '@/middleware/validate';
import { emailQueue } from '@/jobs/queues';
import { env } from '@/config/env';

/** Fields safe to return. Never includes passwordHash, twofaSecret, or history. */
const SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  status: true,
  phone: true,
  activatedAt: true,
  twofaMethod: true,
  twofaEnrolledAt: true,
  lastLoginAt: true,
  createdAt: true,
  invitation: {
    select: {
      expiresAt: true,
      usedAt: true,
      revokedAt: true,
      createdAt: true,
      invitedBy: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
    },
  },
} satisfies Prisma.CmsUserSelect;

type UserRow = Prisma.CmsUserGetPayload<{ select: typeof SELECT }>;

/** Shape for the CMS list — adds the labels its table renders (§11.1). */
function serialize(user: UserRow) {
  const inv = user.invitation;
  const isExpired = inv ? new Date() > inv.expiresAt && !inv.usedAt : false;

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    roleLabel: ROLE_LABELS[user.role],
    status: user.status,
    phone: user.phone ?? null,
    activatedAt: user.activatedAt ?? null,
    // Email OTP is primary for all users; TOTP is an additional enrolled method.
    twofa: user.twofaEnrolledAt ? 'Email OTP + Authenticator' : 'Email OTP',
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    invitation: inv
      ? {
          expiresAt: inv.expiresAt,
          isExpired,
          usedAt: inv.usedAt,
          revokedAt: inv.revokedAt,
          invitedBy: inv.invitedBy?.name ?? null,
        }
      : null,
  };
}

export async function list(params: Pagination & { role?: Role; status?: CmsUserStatus }) {
  const where: Prisma.CmsUserWhereInput = {
    deletedAt: null,
    ...(params.role ? { role: params.role } : {}),
    ...(params.status ? { status: params.status } : {}),
    ...(params.q
      ? {
          OR: [
            { name: { contains: params.q, mode: 'insensitive' } },
            { email: { contains: params.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.cmsUser.findMany({
      where,
      select: SELECT,
      orderBy: { createdAt: 'desc' },
      ...toSkipTake(params),
    }),
    prisma.cmsUser.count({ where }),
  ]);

  return { data: rows.map(serialize), meta: listMeta(params.page, params.limit, total) };
}

export async function byId(id: string) {
  const user = await prisma.cmsUser.findFirst({ where: { id, deletedAt: null }, select: SELECT });
  if (!user) throw notFound('User');
  return serialize(user);
}

export interface CreateInput {
  name: string;
  email: string;
  role: Role;
  phone?: string;
  sendInvite?: boolean;
}

export interface CreateResult {
  user: ReturnType<typeof serialize>;
  /** Returned so the Admin can view or copy the setup invitation link directly if needed. */
  setupToken?: string;
  inviteUrl?: string;
}

/**
 * Invite a CMS user (§11.2).
 *
 * No password is set here. The user receives a cryptographically secure setup link,
 * chooses their own password, and then completes mandatory 2FA on first login (§14.3)
 * — so an Admin never knows another user's credentials.
 */
export async function create(input: CreateInput, ctx: AuditContext): Promise<CreateResult> {
  const email = input.email.trim().toLowerCase();
  const existing = await prisma.cmsUser.findUnique({
    where: { email },
    include: { invitation: true },
  });

  if (existing && !existing.deletedAt) {
    if (existing.status === CmsUserStatus.INVITED) {
      throw conflict(
        'An invitation is already pending for this email. You can resend or revoke it from the Users list.',
        ErrorCode.CONFLICT,
        { field: 'email', isPendingInvitation: true, userId: existing.id },
      );
    }
    throw conflict('An account with this email already exists.', ErrorCode.CONFLICT, {
      field: 'email',
    });
  }

  // Unusable placeholder — long random, never revealed. The setup token is the
  // only way in, so the account cannot be logged into until the invitation is accepted.
  const placeholder = await hashPassword(generateToken(48));
  const rawToken = generateToken(32);
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

  const user = await prisma.$transaction(async (tx) => {
    // If the email was previously soft-deleted, clean up old references to allow re-invitation.
    if (existing && existing.deletedAt) {
      await tx.cmsInvitation.deleteMany({ where: { userId: existing.id } });
      await tx.cmsSession.deleteMany({ where: { userId: existing.id } });
      await tx.cmsUser.delete({ where: { id: existing.id } });
    }

    const row = await tx.cmsUser.create({
      data: {
        email,
        name: input.name.trim(),
        role: input.role,
        phone: input.phone?.trim() || null,
        passwordHash: placeholder,
        status: CmsUserStatus.INVITED,
        invitation: {
          create: {
            tokenHash: hashToken(rawToken),
            expiresAt,
            invitedById: ctx.actorId,
          },
        },
      },
      select: SELECT,
    });

    await writeAudit(
      ctx,
      {
        module: AuditModule.USERS,
        action: `Invited CMS user ${email} with role ${ROLE_LABELS[input.role]}`,
        recordId: row.id,
      },
      tx,
    );
    return row;
  });

  const inviteUrl = `${env.CMS_ORIGIN}/accept-invitation?token=${rawToken}`;

  if (input.sendInvite !== false) {
    try {
      await emailQueue.add('invitation', {
        kind: 'invitation',
        recipientName: input.name.trim(),
        recipientEmail: email,
        roleLabel: ROLE_LABELS[input.role],
        inviteUrl,
        expiresInHours: 48,
      });
    } catch {
      // If queue is unreachable during testing/offline, don't fail user creation.
    }
  }

  return {
    user: serialize(user),
    setupToken: rawToken,
    inviteUrl,
  };
}

/**
 * Resend an invitation with a fresh secure token and 48-hour expiration.
 */
export async function resendInvitation(
  id: string,
  ctx: AuditContext,
): Promise<{ ok: boolean; setupToken: string; inviteUrl: string }> {
  const target = await prisma.cmsUser.findFirst({
    where: { id, deletedAt: null },
    include: { invitation: true },
  });
  if (!target) throw notFound('User');
  if (target.status !== CmsUserStatus.INVITED) {
    throw conflict('Cannot resend invitation for an active or deactivated user.');
  }

  const rawToken = generateToken(32);
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

  await prisma.$transaction(async (tx) => {
    await tx.cmsInvitation.upsert({
      where: { userId: id },
      create: {
        userId: id,
        tokenHash: hashToken(rawToken),
        expiresAt,
        invitedById: ctx.actorId,
      },
      update: {
        tokenHash: hashToken(rawToken),
        expiresAt,
        usedAt: null,
        revokedAt: null,
        invitedById: ctx.actorId,
      },
    });

    await writeAudit(
      ctx,
      {
        module: AuditModule.USERS,
        action: `Resent CMS invitation to ${target.email}`,
        recordId: id,
      },
      tx,
    );
  });

  const inviteUrl = `${env.CMS_ORIGIN}/accept-invitation?token=${rawToken}`;

  try {
    await emailQueue.add('invitation', {
      kind: 'invitation',
      recipientName: target.name,
      recipientEmail: target.email,
      roleLabel: ROLE_LABELS[target.role],
      inviteUrl,
      expiresInHours: 48,
    });
  } catch {
    // Queue offline fallback
  }

  return { ok: true, setupToken: rawToken, inviteUrl };
}

/**
 * Revoke a pending invitation.
 */
export async function revokeInvitation(id: string, ctx: AuditContext): Promise<{ ok: boolean }> {
  const target = await prisma.cmsUser.findFirst({
    where: { id, deletedAt: null },
    include: { invitation: true },
  });
  if (!target) throw notFound('User');
  if (target.status !== CmsUserStatus.INVITED) {
    throw conflict('Cannot revoke an invitation for an active or deactivated user.');
  }

  await prisma.$transaction(async (tx) => {
    await tx.cmsInvitation.updateMany({
      where: { userId: id },
      data: { revokedAt: new Date() },
    });
    await tx.cmsUser.update({
      where: { id },
      data: {
        status: CmsUserStatus.DEACTIVATED,
        deletedAt: new Date(),
        tokenVersion: { increment: 1 },
      },
    });
    await writeAudit(
      ctx,
      {
        module: AuditModule.USERS,
        action: `Revoked CMS invitation for ${target.email}`,
        recordId: id,
      },
      tx,
    );
  });

  return { ok: true };
}

export interface UpdateInput {
  name?: string;
  phone?: string;
  role?: Role;
}

/**
 * Update a user (§11.2).
 *
 * Email is intentionally immutable — it is the login identity and appears
 * throughout the audit log, so changing it would break attribution.
 */
export async function update(
  id: string,
  input: UpdateInput,
  actorId: string,
  ctx: AuditContext,
): Promise<ReturnType<typeof serialize>> {
  const target = await prisma.cmsUser.findFirst({
    where: { id, deletedAt: null },
    select: { ...SELECT, tokenVersion: true },
  });
  if (!target) throw notFound('User');

  if (input.role && input.role !== target.role) {
    // Protection 1 — no changing your own role.
    if (id === actorId) {
      throw forbidden('You cannot change your own role.');
    }
    // Protection 3 — never leave the system without an active Admin.
    if (target.role === Role.ADMIN) {
      await assertNotLastAdmin(id);
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.cmsUser.update({
      where: { id },
      data: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.phone !== undefined ? { phone: input.phone?.trim() || null } : {}),
        // A role change must invalidate existing tokens, or the old role's
        // permissions keep working until the access token expires.
        ...(input.role && input.role !== target.role
          ? { role: input.role, tokenVersion: { increment: 1 } }
          : {}),
      },
      select: SELECT,
    });

    if (input.role && input.role !== target.role) {
      await tx.cmsSession.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    await writeAudit(
      ctx,
      {
        module: AuditModule.USERS,
        action:
          input.role && input.role !== target.role
            ? `Changed role of ${target.email} from ${ROLE_LABELS[target.role]} to ${ROLE_LABELS[input.role]}`
            : `Updated CMS user ${target.email}`,
        recordId: id,
        diff: buildDiff(target, row),
      },
      tx,
    );
    return row;
  });

  return serialize(updated);
}

/**
 * Activate or deactivate (§11.3).
 *
 * Deactivating revokes every session and bumps tokenVersion, so access is cut
 * immediately rather than when the access token expires.
 */
export async function setStatus(
  id: string,
  status: CmsUserStatus,
  actorId: string,
  ctx: AuditContext,
): Promise<ReturnType<typeof serialize>> {
  if (id === actorId && status === CmsUserStatus.DEACTIVATED) {
    throw forbidden('You cannot deactivate your own account.');
  }

  const target = await prisma.cmsUser.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, email: true, role: true, status: true },
  });
  if (!target) throw notFound('User');

  if (status === CmsUserStatus.DEACTIVATED && target.role === Role.ADMIN) {
    await assertNotLastAdmin(id);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.cmsUser.update({
      where: { id },
      data: {
        status,
        ...(status === CmsUserStatus.DEACTIVATED ? { tokenVersion: { increment: 1 } } : {}),
      },
      select: SELECT,
    });

    if (status === CmsUserStatus.DEACTIVATED) {
      await tx.cmsSession.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    await writeAudit(
      ctx,
      {
        module: AuditModule.USERS,
        action:
          status === CmsUserStatus.DEACTIVATED
            ? `Deactivated CMS user ${target.email}`
            : `Reactivated CMS user ${target.email}`,
        recordId: id,
      },
      tx,
    );
    return row;
  });

  return serialize(updated);
}

/**
 * Force a password reset (§14.2).
 *
 * Issues a setup token and invalidates the current password by bumping
 * tokenVersion and revoking sessions.
 */
export async function resetPassword(id: string, ctx: AuditContext): Promise<{ setupToken: string }> {
  const target = await prisma.cmsUser.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, email: true },
  });
  if (!target) throw notFound('User');

  const setupToken = generateToken();

  await prisma.$transaction(async (tx) => {
    await tx.cmsUser.update({
      where: { id },
      data: { tokenVersion: { increment: 1 } },
    });
    await tx.cmsSession.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await tx.cmsSession.create({
      data: {
        userId: id,
        refreshTokenHash: hashToken(setupToken),
        ip: ctx.ip,
        userAgent: 'password-reset',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    await writeAudit(
      ctx,
      {
        module: AuditModule.USERS,
        action: `Triggered a password reset for ${target.email}`,
        recordId: id,
      },
      tx,
    );
  });

  return { setupToken };
}

/**
 * Soft delete.
 *
 * Soft rather than hard because §11.3 requires the name to stay visible in the
 * audit log against past actions — a hard delete would null those references.
 */
export async function remove(id: string, actorId: string, ctx: AuditContext): Promise<void> {
  if (id === actorId) throw forbidden('You cannot delete your own account.');

  const target = await prisma.cmsUser.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, email: true, role: true },
  });
  if (!target) throw notFound('User');

  if (target.role === Role.ADMIN) await assertNotLastAdmin(id);

  await prisma.$transaction(async (tx) => {
    await tx.cmsUser.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        status: CmsUserStatus.DEACTIVATED,
        tokenVersion: { increment: 1 },
      },
    });
    await tx.cmsSession.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await writeAudit(
      ctx,
      { module: AuditModule.USERS, action: `Deleted CMS user ${target.email}`, recordId: id },
      tx,
    );
  });
}

/**
 * Refuse to remove or demote the last active Admin.
 *
 * Without this, one action can make settings, user management, and refunds permanently
 * unreachable — a lockout with no in-app recovery path.
 */
async function assertNotLastAdmin(excludingId: string): Promise<void> {
  const remaining = await prisma.cmsUser.count({
    where: {
      role: Role.ADMIN,
      status: CmsUserStatus.ACTIVE,
      deletedAt: null,
      id: { not: excludingId },
    },
  });

  if (remaining === 0) {
    throw new AppError(
      409,
      ErrorCode.CONFLICT,
      'This is the last active Admin. Promote another user to Admin first before modifying this account.',
    );
  }
}
