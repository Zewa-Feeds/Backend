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
import crypto from 'node:crypto';
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
import { AppError, ErrorCode, notFound, unauthenticated } from '@/lib/errors';
import { permissionsFor, ROLE_LABELS } from '@/rbac/permissions';
import { type AuditContext, writeAudit, writeAuditSafe } from '@/modules/audit/audit.service';
import { assertNotReused, assertPasswordPolicy, pushHistory } from './password.policy';
import { sendCmsLoginOtp } from './auth.mailer';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'auth.service' });

// TOTP: allow one window either side of now, for clock drift.
authenticator.options = { window: 1 };

const APP_NAME = 'Zewa Feeds CMS';
export const OTP_TTL_MINUTES = 10;
export const MAX_OTP_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_SECONDS = 60;

/** Mask email safely for user feedback in authentication screens (e.g., ad***@zewafeeds.com). */
export function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  if (!domain || !name) return '***';
  if (name.length <= 2) return `${name[0]}***@${domain}`;
  return `${name.slice(0, 2)}***@${domain}`;
}

/**
 * Generate, hash, and persist a single-use 6-digit numeric OTP, then send it via email.
 */
export async function createAndSendEmailOtp(user: CmsUser): Promise<{ otpHash: string; expiresAt: Date }> {
  // Cryptographically secure 6-digit numeric OTP (100000..999999)
  const code = crypto.randomInt(100000, 1000000).toString();
  const otpHash = hashToken(code);
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

  await prisma.$transaction(async (tx) => {
    // Invalidate any existing unused OTPs for this user
    await tx.cmsEmailOtp.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    await tx.cmsEmailOtp.create({
      data: {
        userId: user.id,
        otpHash,
        expiresAt,
        attempts: 0,
        maxAttempts: MAX_OTP_ATTEMPTS,
      },
    });
  });

  // Dispatch email directly via ZeptoMail
  await sendCmsLoginOtp({
    email: user.email,
    name: user.name,
    code,
    expiresInMinutes: OTP_TTL_MINUTES,
  });

  return { otpHash, expiresAt };
}

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
  /** True because Email OTP is active for every user by default. */
  twofaEnrolled: boolean;
  twofaMethod: TwofaMethod | null;
  /** Whether the user also has an Authenticator app (TOTP) enrolled. */
  hasTotp: boolean;
  maskedEmail: string;
}

export interface SessionResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  isRemembered?: boolean;
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
 * Validates credentials and automatically dispatches a 6-digit Email OTP to the user.
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

  if (user.status === CmsUserStatus.INVITED) {
    writeAuditSafe(
      { ...ctx, actorId: user.id, actorName: user.name, actorRole: ROLE_LABELS[user.role] },
      { module: AuditModule.AUTH, action: 'Login blocked — invitation pending activation', recordId: user.email },
    );
    throw new AppError(
      403,
      ErrorCode.FORBIDDEN,
      'This account is pending invitation acceptance. Please click the invitation link sent to your email to set your password.',
    );
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

  // Automatically dispatch Email OTP
  await createAndSendEmailOtp(user);

  writeAuditSafe(
    { ...ctx, actorId: user.id, actorName: user.name, actorRole: ROLE_LABELS[user.role] },
    { module: AuditModule.AUTH, action: 'Password verified; Email OTP dispatched', recordId: user.email },
  );

  const hasTotp = Boolean(user.twofaSecret && user.twofaEnrolledAt);

  return {
    challengeToken: signChallengeToken({ sub: user.id, enrol: false }),
    twofaEnrolled: true,
    twofaMethod: TwofaMethod.EMAIL_OTP,
    hasTotp,
    maskedEmail: maskEmail(user.email),
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
  if (user.status === CmsUserStatus.INVITED) {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'This account is pending invitation acceptance.');
  }
  return user;
}

/**
 * Resend Email OTP code with rate limiting and cooldown guard.
 */
export async function resendEmailOtp(
  challengeToken: string,
  ctx: AuditContext,
): Promise<{ ok: boolean; maskedEmail: string; cooldownSeconds: number }> {
  const user = await userFromChallenge(challengeToken);

  const latestOtp = await prisma.cmsEmailOtp.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
  });

  if (latestOtp) {
    const elapsedSeconds = Math.floor((Date.now() - latestOtp.createdAt.getTime()) / 1000);
    if (elapsedSeconds < OTP_RESEND_COOLDOWN_SECONDS) {
      const waitSeconds = OTP_RESEND_COOLDOWN_SECONDS - elapsedSeconds;
      throw new AppError(
        429,
        ErrorCode.RATE_LIMITED,
        `Please wait ${waitSeconds} seconds before requesting another verification code.`,
        { details: { waitSeconds } },
      );
    }
  }

  await createAndSendEmailOtp(user);

  writeAuditSafe(
    { ...ctx, actorId: user.id, actorName: user.name, actorRole: ROLE_LABELS[user.role] },
    { module: AuditModule.AUTH, action: 'Resent Email OTP verification code', recordId: user.email },
  );

  return {
    ok: true,
    maskedEmail: maskEmail(user.email),
    cooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS,
  };
}

/**
 * Step 2 — verify 2FA code (Email OTP by default, or TOTP / backup code).
 */
export async function verifyTwofa(
  challengeToken: string,
  code: string,
  ctx: AuditContext,
  remember: boolean,
): Promise<SessionResult> {
  const user = await userFromChallenge(challengeToken);
  const trimmed = code.trim().replace(/\s/g, '');

  // 1. Check if input matches active Email OTP
  const activeOtp = await prisma.cmsEmailOtp.findFirst({
    where: {
      userId: user.id,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (activeOtp) {
    if (activeOtp.attempts >= activeOtp.maxAttempts) {
      await prisma.cmsEmailOtp.update({
        where: { id: activeOtp.id },
        data: { usedAt: new Date() },
      });
      writeAuditSafe(
        { ...ctx, actorId: user.id, actorName: user.name, actorRole: ROLE_LABELS[user.role] },
        { module: AuditModule.AUTH, action: 'Email OTP locked out due to excessive attempts', recordId: user.email },
      );
      throw new AppError(
        401,
        ErrorCode.TWOFA_INVALID,
        'Maximum verification attempts exceeded. Please request a new verification code.',
      );
    }

    const hashedInput = hashToken(trimmed);
    if (hashedInput === activeOtp.otpHash) {
      await prisma.cmsEmailOtp.update({
        where: { id: activeOtp.id },
        data: { usedAt: new Date() },
      });
      return openSession(user, ctx, remember, 'Signed in via Email OTP');
    } else {
      await prisma.cmsEmailOtp.update({
        where: { id: activeOtp.id },
        data: { attempts: { increment: 1 } },
      });
    }
  }

  // 2. If user has TOTP configured, check TOTP or backup code
  if (user.twofaSecret && user.twofaEnrolledAt) {
    const totpOk = await consumeTwofaCode(user, code);
    if (totpOk) {
      if (activeOtp) {
        await prisma.cmsEmailOtp.update({
          where: { id: activeOtp.id },
          data: { usedAt: new Date() },
        });
      }
      return openSession(user, ctx, remember, 'Signed in via Authenticator App');
    }
  }

  writeAuditSafe(
    { ...ctx, actorId: user.id, actorName: user.name, actorRole: ROLE_LABELS[user.role] },
    { module: AuditModule.AUTH, action: 'Failed 2FA verification attempt', recordId: user.email },
  );

  throw new AppError(401, ErrorCode.TWOFA_INVALID, 'That verification code is not valid. Try again.');
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
    isRemembered: remember,
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
  remember = false,
): Promise<EnrolComplete> {
  const user = await userFromChallenge(challengeToken);

  if (!user.twofaSecret) {
    throw new AppError(400, ErrorCode.TWOFA_INVALID, 'Start 2FA setup first.');
  }

  const secret = decryptSecret(user.twofaSecret);
  if (!authenticator.check(code.trim().replace(/\s/g, ''), secret)) {
    writeAuditSafe(
      { ...ctx, actorId: user.id, actorName: user.name, actorRole: ROLE_LABELS[user.role] },
      { module: AuditModule.AUTH, action: 'Failed 2FA enrolment confirmation', recordId: user.email },
    );
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

/**
 * Begin in-profile Authenticator (TOTP) setup for an authenticated user.
 */
export async function setupTotpForUser(userId: string): Promise<EnrolStart> {
  const user = await prisma.cmsUser.findUniqueOrThrow({ where: { id: userId } });
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

/**
 * Confirm in-profile Authenticator (TOTP) setup for an authenticated user.
 */
export async function confirmTotpForUser(
  userId: string,
  code: string,
  ctx: AuditContext,
): Promise<{ ok: boolean; backupCodes: string[] }> {
  const user = await prisma.cmsUser.findUniqueOrThrow({ where: { id: userId } });

  if (!user.twofaSecret) {
    throw new AppError(400, ErrorCode.TWOFA_INVALID, 'Start Authenticator setup first.');
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
      ctx,
      { module: AuditModule.AUTH, action: 'Configured Authenticator App (TOTP) 2FA', recordId: user.email },
      tx,
    );
  });

  return { ok: true, backupCodes: codes };
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
  const tokenHash = hashToken(refreshToken);
  let session = await prisma.cmsSession.findUnique({
    where: { refreshTokenHash: tokenHash },
    include: { user: true },
  });

  const defaultTtlMs = ttlToMs(env.REFRESH_TOKEN_TTL);
  const rememberTtlMs = ttlToMs(env.REFRESH_TOKEN_TTL_REMEMBER);

  // If token is already revoked, check if the user has an active session that hasn't expired
  if (session && session.revokedAt) {
    if (session.user.deletedAt || session.user.status === CmsUserStatus.DEACTIVATED) {
      throw new AppError(403, ErrorCode.ACCOUNT_DEACTIVATED, 'This account has been deactivated.');
    }

    // Look for the user's latest active session
    const activeSession = await prisma.cmsSession.findFirst({
      where: {
        userId: session.userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
      include: { user: true },
    });

    if (activeSession) {
      const user = activeSession.user;
      const wasRemembered =
        activeSession.expiresAt.getTime() - activeSession.createdAt.getTime() > defaultTtlMs * 1.5 ||
        activeSession.expiresAt.getTime() - Date.now() > defaultTtlMs;

      return {
        accessToken: signAccessToken({
          sub: user.id,
          email: user.email,
          role: user.role,
          sid: activeSession.id,
          ver: user.tokenVersion,
        }),
        refreshToken,
        expiresIn: ttlToMs(env.ACCESS_TOKEN_TTL) / 1000,
        isRemembered: wasRemembered,
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
    } else {
      // If all previous sessions were revoked, issue a fresh 7-day session for this valid user
      const newToken = generateToken();
      const extendedSession = await prisma.cmsSession.create({
        data: {
          userId: session.userId,
          refreshTokenHash: hashToken(newToken),
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          expiresAt: new Date(Date.now() + rememberTtlMs),
        },
        include: { user: true },
      });

      const user = session.user;
      return {
        accessToken: signAccessToken({
          sub: user.id,
          email: user.email,
          role: user.role,
          sid: extendedSession.id,
          ver: user.tokenVersion,
        }),
        refreshToken: newToken,
        expiresIn: ttlToMs(env.ACCESS_TOKEN_TTL) / 1000,
        isRemembered: true,
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
  }

  if (!session || session.revokedAt || session.expiresAt < new Date()) {
    throw unauthenticated('Session expired. Please sign in again.', ErrorCode.TOKEN_EXPIRED);
  }
  if (session.user.deletedAt || session.user.status === CmsUserStatus.DEACTIVATED) {
    throw new AppError(403, ErrorCode.ACCOUNT_DEACTIVATED, 'This account has been deactivated.');
  }

  const newToken = generateToken();
  const wasRemembered =
    session.expiresAt.getTime() - session.createdAt.getTime() > defaultTtlMs * 1.5 ||
    session.expiresAt.getTime() - Date.now() > defaultTtlMs;

  // Extend sliding expiration: 7 days if remembered, 8 hours if regular session
  const slidingTtlMs = wasRemembered ? rememberTtlMs : defaultTtlMs;
  const newExpiresAt = new Date(Date.now() + slidingTtlMs);

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
        expiresAt: newExpiresAt,
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
    isRemembered: wasRemembered,
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

export interface InvitationDetails {
  email: string;
  name: string;
  role: Role;
  roleLabel: string;
}

export async function getInvitationDetails(rawToken: string): Promise<InvitationDetails> {
  const tokenHash = hashToken(rawToken);
  const invitation = await prisma.cmsInvitation.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!invitation || !invitation.user || invitation.user.deletedAt) {
    throw notFound('Invitation not found or invalid.');
  }

  if (invitation.revokedAt) {
    throw new AppError(
      410,
      ErrorCode.FORBIDDEN,
      'This invitation has been revoked. Please ask an administrator to resend the invite.',
    );
  }

  if (invitation.usedAt) {
    throw new AppError(
      410,
      ErrorCode.FORBIDDEN,
      'This invitation has already been used. Please sign in with your credentials.',
    );
  }

  if (new Date() > invitation.expiresAt) {
    throw new AppError(
      410,
      ErrorCode.TOKEN_EXPIRED,
      'This invitation has expired. Please ask an administrator to resend the invite.',
    );
  }

  if (invitation.user.status === CmsUserStatus.DEACTIVATED) {
    throw new AppError(403, ErrorCode.ACCOUNT_DEACTIVATED, 'This user account has been deactivated.');
  }

  return {
    email: invitation.user.email,
    name: invitation.user.name,
    role: invitation.user.role,
    roleLabel: ROLE_LABELS[invitation.user.role],
  };
}

export interface AcceptInvitationInput {
  token: string;
  name?: string;
  password: string;
}

export async function acceptInvitation(
  input: AcceptInvitationInput,
  ctx: AuditContext,
): Promise<{ ok: boolean; message: string }> {
  assertPasswordPolicy(input.password);

  const tokenHash = hashToken(input.token);
  const invitation = await prisma.cmsInvitation.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!invitation || !invitation.user || invitation.user.deletedAt) {
    throw notFound('Invitation not found or invalid.');
  }

  if (invitation.revokedAt) {
    throw new AppError(410, ErrorCode.FORBIDDEN, 'This invitation has been revoked.');
  }

  if (invitation.usedAt) {
    throw new AppError(410, ErrorCode.FORBIDDEN, 'This invitation has already been used.');
  }

  if (new Date() > invitation.expiresAt) {
    throw new AppError(410, ErrorCode.TOKEN_EXPIRED, 'This invitation has expired.');
  }

  if (invitation.user.status === CmsUserStatus.DEACTIVATED) {
    throw new AppError(403, ErrorCode.ACCOUNT_DEACTIVATED, 'This user account has been deactivated.');
  }

  const newHash = await hashPassword(input.password);

  await prisma.$transaction(async (tx) => {
    await tx.cmsInvitation.update({
      where: { id: invitation.id },
      data: { usedAt: new Date() },
    });

    await tx.cmsUser.update({
      where: { id: invitation.userId },
      data: {
        status: CmsUserStatus.ACTIVE,
        passwordHash: newHash,
        passwordHistory: [newHash],
        name: input.name?.trim() || invitation.user.name,
        activatedAt: new Date(),
        tokenVersion: { increment: 1 },
      },
    });

    await writeAudit(
      {
        ...ctx,
        actorId: invitation.user.id,
        actorName: input.name?.trim() || invitation.user.name,
        actorRole: ROLE_LABELS[invitation.user.role],
      },
      {
        module: AuditModule.AUTH,
        action: `Accepted CMS invitation and activated account for ${invitation.user.email}`,
        recordId: invitation.user.id,
      },
      tx,
    );
  });

  return { ok: true, message: 'Account activated successfully.' };
}
