/**
 * Authentication service — spec §14.
 *
 * The login flow is two-step by design (§14.3: 2FA is mandatory for every role):
 *
 *   1. POST /login       email + password  → challengeToken (5 min, no authority)
 *   2. POST /2fa/verify  challengeToken + code → accessToken + refreshToken
 *
 * The challenge token exists so step 1 never issues a usable session. A correct
 * password alone gets you nothing.
 */
import { AuditModule, CmsUserStatus, type CmsUser, type Role, TwofaMethod } from '@prisma/client';
import { authenticator } from 'otplib';
import { prisma } from '@/lib/prisma';
import {
  decryptSecret,
  encryptSecret,
  fakeVerify,
  generateBackupCodes,
  generateToken,
  hashPassword,
  hashToken,
  normaliseBackupCode,
  verifyPassword,
} from '@/lib/crypto';
import {
  signAccessToken,
  signChallengeToken,
  verifyChallengeToken,
} from '@/lib/tokens';
import { AppError, ErrorCode, unauthenticated } from '@/lib/errors';
import { permissionsFor, ROLE_LABELS } from '@/rbac/permissions';
import { type AuditContext, writeAudit, writeAuditSafe } from '@/modules/audit/audit.service';
import { assertNotReused, assertPasswordPolicy, pushHistory } from './password.policy';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'auth.service' });

// TOTP: allow one window either side of now, for clock drift.
authenticator.options = { window: 1 };

const APP_NAME = 'Zewa Feeds CMS';

/**
 * Parse a TTL like "8h" / "7d" into milliseconds.
 *
 * Exported so the route layer can size the refresh COOKIE from the same config
 * value used to sign the refresh TOKEN. If the two are set independently they
 * drift, and a cookie that outlives its token leaves the user with a session the
 * browser still sends but the server always rejects.
 */
export function ttlToMs(ttl: string): number {
  const match = /^(\d+)([smhd])$/.exec(ttl);
  if (!match) return 8 * 60 * 60 * 1000;
  const value = Number(match[1]);
  const unit = match[2];
  const factor = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit as 's'] ?? 3_600_000;
  return value * factor;
}

export interface LoginResult {
  challengeToken: string;
  /** False when the user has never completed 2FA setup — forces enrolment (§14.3). */
  twofaEnrolled: boolean;
  twofaMethod: TwofaMethod | null;
}

export interface SessionResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: {
    id: string;
    email: string;
    name: string;
    role: Role;
    roleLabel: string;
    permissions: string[];
    twofaMethod: TwofaMethod | null;
  };
}

/**
 * Step 1 — email + password.
 *
 * Every failure returns the same message and takes comparable time, so the
 * response cannot be used to enumerate which emails have CMS accounts.
 * §14.4 requires logging every attempt, successful or not.
 */
export async function login(
  email: string,
  password: string,
  ctx: AuditContext,
): Promise<LoginResult> {
  const user = await prisma.cmsUser.findUnique({ where: { email } });

  if (!user || user.deletedAt) {
    // Burn equivalent CPU so timing does not reveal that the account is absent.
    await fakeVerify();
    writeAuditSafe(
      { ...ctx, actorName: email, actorRole: '—' },
      { module: AuditModule.AUTH, action: 'Failed login attempt (unknown account)', recordId: email },
    );
    throw new AppError(401, ErrorCode.INVALID_CREDENTIALS, 'Incorrect email or password.');
  }

  const passwordOk = await verifyPassword(password, user.passwordHash);
  if (!passwordOk) {
    writeAuditSafe(
      { ...ctx, actorId: user.id, actorName: user.name, actorRole: ROLE_LABELS[user.role] },
      { module: AuditModule.AUTH, action: 'Failed login attempt (wrong password)', recordId: user.email },
    );
    throw new AppError(401, ErrorCode.INVALID_CREDENTIALS, 'Incorrect email or password.');
  }

  // Checked AFTER the password so a deactivated account is not distinguishable
  // to someone who does not already know the password.
  if (user.status === CmsUserStatus.DEACTIVATED) {
    writeAuditSafe(
      { ...ctx, actorId: user.id, actorName: user.name, actorRole: ROLE_LABELS[user.role] },
      { module: AuditModule.AUTH, action: 'Login blocked — account deactivated', recordId: user.email },
    );
    throw new AppError(403, ErrorCode.ACCOUNT_DEACTIVATED, 'This account has been deactivated.');
  }

  const enrolled = Boolean(user.twofaEnrolledAt);

  return {
    challengeToken: signChallengeToken({ sub: user.id, enrol: !enrolled }),
    twofaEnrolled: enrolled,
    twofaMethod: user.twofaMethod,
  };
}

/** Resolve a challenge token to its user, rejecting invalid states. */
async function userFromChallenge(challengeToken: string): Promise<CmsUser> {
  const claims = verifyChallengeToken(challengeToken);
  const user = await prisma.cmsUser.findUnique({ where: { id: claims.sub } });

  if (!user || user.deletedAt) throw unauthenticated('Sign in again.', ErrorCode.TOKEN_INVALID);
  if (user.status === CmsUserStatus.DEACTIVATED) {
    throw new AppError(403, ErrorCode.ACCOUNT_DEACTIVATED, 'This account has been deactivated.');
  }
  return user;
}

/**
 * Step 2 — verify the 2FA code and open a session.
 *
 * Accepts a TOTP code or a single-use backup code (§14.3).
 */
export async function verifyTwofa(
  challengeToken: string,
  code: string,
  ctx: AuditContext,
  remember: boolean,
): Promise<SessionResult> {
  const user = await userFromChallenge(challengeToken);

  if (!user.twofaEnrolledAt || !user.twofaSecret) {
    throw new AppError(
      403,
      ErrorCode.TWOFA_NOT_ENROLLED,
      'Two-factor authentication setup is required.',
    );
  }

  const ok = await consumeTwofaCode(user, code);
  if (!ok) {
    writeAuditSafe(
      { ...ctx, actorId: user.id, actorName: user.name, actorRole: ROLE_LABELS[user.role] },
      { module: AuditModule.AUTH, action: 'Failed 2FA verification', recordId: user.email },
    );
    throw new AppError(401, ErrorCode.TWOFA_INVALID, 'That code is not valid. Try again.');
  }

  return openSession(user, ctx, remember, 'Signed in');
}

/**
 * Check a TOTP code, falling back to backup codes.
 *
 * A matched backup code is marked used inside the same statement, so it cannot be
 * replayed even under concurrent requests.
 */
async function consumeTwofaCode(user: CmsUser, code: string): Promise<boolean> {
  const trimmed = code.trim();

  // TOTP first — the common path.
  if (user.twofaSecret) {
    try {
      const secret = decryptSecret(user.twofaSecret);
      if (authenticator.check(trimmed.replace(/\s/g, ''), secret)) return true;
    } catch (err) {
      log.error({ err, userId: user.id }, 'failed to decrypt 2FA secret');
    }
  }

  // Backup codes are hashed, so every unused code must be compared.
  const normalised = normaliseBackupCode(trimmed);
  if (normalised.length !== 8) return false;

  const unused = await prisma.backupCode.findMany({
    where: { userId: user.id, usedAt: null },
    select: { id: true, codeHash: true },
  });

  const target = hashToken(normalised);
  const match = unused.find((row) => row.codeHash === target);
  if (!match) return false;

  // Conditional update: if another request consumed it first, count is 0.
  const consumed = await prisma.backupCode.updateMany({
    where: { id: match.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  return consumed.count === 1;
}

/** Issue tokens and persist the session row. */
async function openSession(
  user: CmsUser,
  ctx: AuditContext,
  remember: boolean,
  auditAction: string,
): Promise<SessionResult> {
  const refreshToken = generateToken();
  const ttl = ttlToMs(remember ? env.REFRESH_TOKEN_TTL_REMEMBER : env.REFRESH_TOKEN_TTL);

  const session = await prisma.cmsSession.create({
    data: {
      userId: user.id,
      refreshTokenHash: hashToken(refreshToken),
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      expiresAt: new Date(Date.now() + ttl),
    },
    select: { id: true },
  });

  await prisma.cmsUser.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  writeAuditSafe(
    { ...ctx, actorId: user.id, actorName: user.name, actorRole: ROLE_LABELS[user.role] },
    { module: AuditModule.AUTH, action: auditAction, recordId: user.email },
  );

  const accessToken = signAccessToken({
    sub: user.id,
    email: user.email,
    role: user.role,
    sid: session.id,
    ver: user.tokenVersion,
  });

  return {
    accessToken,
    refreshToken,
    expiresIn: ttlToMs(env.ACCESS_TOKEN_TTL) / 1000,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      roleLabel: ROLE_LABELS[user.role],
      permissions: permissionsFor(user.role),
      twofaMethod: user.twofaMethod,
    },
  };
}

// ---- 2FA enrolment (§14.3) -------------------------------------------------

export interface EnrolStart {
  secret: string;
  /** otpauth:// URI for the authenticator QR code. */
  otpauthUrl: string;
}

/**
 * Begin enrolment. Returns a secret to display as a QR code.
 *
 * The secret is stored encrypted but `twofaEnrolledAt` stays null until a code is
 * confirmed — so an abandoned setup does not lock the user out.
 */
export async function startTwofaEnrolment(challengeToken: string): Promise<EnrolStart> {
  const user = await userFromChallenge(challengeToken);

  const secret = authenticator.generateSecret();
  await prisma.cmsUser.update({
    where: { id: user.id },
    data: { twofaSecret: encryptSecret(secret), twofaMethod: TwofaMethod.TOTP },
  });

  return {
    secret,
    otpauthUrl: authenticator.keyuri(user.email, APP_NAME, secret),
  };
}

export interface EnrolComplete extends SessionResult {
  /** Shown ONCE — §14.3 requires them downloadable at setup. */
  backupCodes: string[];
}

/**
 * Confirm enrolment with a code from the authenticator, then open a session.
 *
 * Backup codes are returned in plaintext here and only here; the database keeps
 * hashes.
 */
export async function completeTwofaEnrolment(
  challengeToken: string,
  code: string,
  ctx: AuditContext,
  remember: boolean,
): Promise<EnrolComplete> {
  const user = await userFromChallenge(challengeToken);

  if (!user.twofaSecret) {
    throw new AppError(400, ErrorCode.TWOFA_INVALID, 'Start 2FA setup first.');
  }

  const secret = decryptSecret(user.twofaSecret);
  if (!authenticator.check(code.trim().replace(/\s/g, ''), secret)) {
    throw new AppError(401, ErrorCode.TWOFA_INVALID, 'That code is not valid. Try again.');
  }

  const codes = generateBackupCodes();

  await prisma.$transaction(async (tx) => {
    await tx.cmsUser.update({
      where: { id: user.id },
      data: { twofaEnrolledAt: new Date(), twofaMethod: TwofaMethod.TOTP },
    });
    await tx.backupCode.deleteMany({ where: { userId: user.id } });
    await tx.backupCode.createMany({
      data: codes.map((c) => ({ userId: user.id, codeHash: hashToken(normaliseBackupCode(c)) })),
    });
    await writeAudit(
      { ...ctx, actorId: user.id, actorName: user.name, actorRole: ROLE_LABELS[user.role] },
      { module: AuditModule.AUTH, action: 'Completed 2FA enrolment', recordId: user.email },
      tx,
    );
  });

  const session = await openSession(user, ctx, remember, 'Signed in (first login)');
  return { ...session, backupCodes: codes };
}

/** Regenerate backup codes for an already-enrolled user (§14.3). */
export async function regenerateBackupCodes(
  userId: string,
  ctx: AuditContext,
): Promise<string[]> {
  const codes = generateBackupCodes();

  await prisma.$transaction(async (tx) => {
    await tx.backupCode.deleteMany({ where: { userId } });
    await tx.backupCode.createMany({
      data: codes.map((c) => ({ userId, codeHash: hashToken(normaliseBackupCode(c)) })),
    });
    await writeAudit(
      ctx,
      { module: AuditModule.AUTH, action: 'Regenerated 2FA backup codes', recordId: userId },
      tx,
    );
  });

  return codes;
}

// ---- Refresh / logout ------------------------------------------------------

/**
 * Rotate a refresh token.
 *
 * The old token is revoked and a new one issued on every refresh. If a stolen
 * token is used after the legitimate client has refreshed, it is already revoked
 * and fails — which both blocks the attacker and surfaces the theft.
 */
export async function refresh(refreshToken: string, ctx: AuditContext): Promise<SessionResult> {
  const session = await prisma.cmsSession.findUnique({
    where: { refreshTokenHash: hashToken(refreshToken) },
    include: { user: true },
  });

  if (!session || session.revokedAt || session.expiresAt < new Date()) {
    throw unauthenticated('Session expired. Please sign in again.', ErrorCode.TOKEN_EXPIRED);
  }
  if (session.user.deletedAt || session.user.status === CmsUserStatus.DEACTIVATED) {
    throw new AppError(403, ErrorCode.ACCOUNT_DEACTIVATED, 'This account has been deactivated.');
  }

  const newToken = generateToken();
  const remainingMs = session.expiresAt.getTime() - Date.now();

  const rotated = await prisma.$transaction(async (tx) => {
    await tx.cmsSession.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });
    return tx.cmsSession.create({
      data: {
        userId: session.userId,
        refreshTokenHash: hashToken(newToken),
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        // Sliding window is capped by the original expiry — refreshing forever
        // must not extend a session indefinitely.
        expiresAt: new Date(Date.now() + remainingMs),
      },
      select: { id: true },
    });
  });

  const user = session.user;
  return {
    accessToken: signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      sid: rotated.id,
      ver: user.tokenVersion,
    }),
    refreshToken: newToken,
    expiresIn: ttlToMs(env.ACCESS_TOKEN_TTL) / 1000,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      roleLabel: ROLE_LABELS[user.role],
      permissions: permissionsFor(user.role),
      twofaMethod: user.twofaMethod,
    },
  };
}

export async function logout(refreshToken: string | undefined, sessionId?: string): Promise<void> {
  if (refreshToken) {
    await prisma.cmsSession.updateMany({
      where: { refreshTokenHash: hashToken(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return;
  }
  if (sessionId) {
    await prisma.cmsSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}

// ---- Password change (§14.2) -----------------------------------------------

/**
 * Change your own password.
 *
 * Bumps `tokenVersion`, which invalidates every existing access token — a
 * password change should end sessions elsewhere. The current session is then
 * re-opened so the user is not logged out of the tab they are using.
 */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  ctx: AuditContext,
): Promise<SessionResult> {
  const user = await prisma.cmsUser.findUniqueOrThrow({ where: { id: userId } });

  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new AppError(400, ErrorCode.INVALID_CREDENTIALS, 'Current password is incorrect.', {
      fields: { currentPassword: 'Incorrect password.' },
    });
  }

  assertPasswordPolicy(newPassword);
  await assertNotReused(newPassword, user.passwordHistory, user.passwordHash);

  const newHash = await hashPassword(newPassword);

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.cmsUser.update({
      where: { id: userId },
      data: {
        passwordHash: newHash,
        passwordHistory: pushHistory(user.passwordHistory, user.passwordHash),
        tokenVersion: { increment: 1 },
      },
    });
    // Every device must re-authenticate.
    await tx.cmsSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await writeAudit(
      ctx,
      { module: AuditModule.AUTH, action: 'Changed their own password', recordId: user.email },
      tx,
    );
    return row;
  });

  return openSession(updated, ctx, false, 'Re-authenticated after password change');
}

// ---- Sessions (§14.4) ------------------------------------------------------

export async function listSessions(userId: string, currentSessionId: string) {
  const sessions = await prisma.cmsSession.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: 'desc' },
    select: { id: true, ip: true, userAgent: true, createdAt: true, lastSeenAt: true },
  });

  return sessions.map((s) => ({ ...s, current: s.id === currentSessionId }));
}

/**
 * Revoke one session.
 *
 * `userId` is part of the WHERE clause, not just checked beforehand — that is what
 * stops one user revoking another user's session by guessing an id (IDOR).
 */
export async function revokeSession(
  userId: string,
  sessionId: string,
  ctx: AuditContext,
): Promise<void> {
  const result = await prisma.cmsSession.updateMany({
    where: { id: sessionId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  if (result.count === 0) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Session not found.');
  }

  writeAuditSafe(ctx, {
    module: AuditModule.AUTH,
    action: 'Terminated an active session',
    recordId: sessionId,
  });
}
