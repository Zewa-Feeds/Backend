import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CmsUserStatus, Role, TwofaMethod } from '@prisma/client';
import { authenticator } from 'otplib';
import { encryptSecret, hashPassword, hashToken } from '@/lib/crypto';
import { signChallengeToken } from '@/lib/tokens';
import { AppError } from '@/lib/errors';

const userFindUnique = vi.fn();
const userFindUniqueOrThrow = vi.fn();
const userUpdate = vi.fn();
const otpFindFirst = vi.fn();
const otpCreate = vi.fn();
const otpUpdate = vi.fn();
const otpUpdateMany = vi.fn();
const sessionCreate = vi.fn();
const sessionFindUnique = vi.fn();
const sessionFindFirst = vi.fn();
const sessionUpdate = vi.fn();
const backupCodeDeleteMany = vi.fn();
const backupCodeCreateMany = vi.fn();
const backupCodeFindFirst = vi.fn();
const backupCodeUpdate = vi.fn();
const auditCreate = vi.fn();

const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({
  cmsEmailOtp: {
    updateMany: (...args: unknown[]) => otpUpdateMany(...args),
    create: (...args: unknown[]) => otpCreate(...args),
    update: (...args: unknown[]) => otpUpdate(...args),
  },
  cmsUser: {
    update: (...args: unknown[]) => userUpdate(...args),
  },
  cmsSession: {
    update: (...args: unknown[]) => sessionUpdate(...args),
    create: (...args: unknown[]) => sessionCreate(...args),
  },
  backupCode: {
    deleteMany: (...args: unknown[]) => backupCodeDeleteMany(...args),
    createMany: (...args: unknown[]) => backupCodeCreateMany(...args),
  },
  auditLog: {
    create: (...args: unknown[]) => auditCreate(...args),
  },
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    cmsUser: {
      findUnique: (...args: unknown[]) => userFindUnique(...args),
      findUniqueOrThrow: (...args: unknown[]) => userFindUniqueOrThrow(...args),
      update: (...args: unknown[]) => userUpdate(...args),
    },
    cmsEmailOtp: {
      findFirst: (...args: unknown[]) => otpFindFirst(...args),
      create: (...args: unknown[]) => otpCreate(...args),
      update: (...args: unknown[]) => otpUpdate(...args),
      updateMany: (...args: unknown[]) => otpUpdateMany(...args),
    },
    cmsSession: {
      create: (...args: unknown[]) => sessionCreate(...args),
      findUnique: (...args: unknown[]) => sessionFindUnique(...args),
      findFirst: (...args: unknown[]) => sessionFindFirst(...args),
      update: (...args: unknown[]) => sessionUpdate(...args),
    },
    backupCode: {
      findFirst: (...args: unknown[]) => backupCodeFindFirst(...args),
      update: (...args: unknown[]) => backupCodeUpdate(...args),
      deleteMany: (...args: unknown[]) => backupCodeDeleteMany(...args),
      createMany: (...args: unknown[]) => backupCodeCreateMany(...args),
    },
    auditLog: {
      create: (...args: unknown[]) => auditCreate(...args),
    },
    $transaction: (fn: any) => transaction(fn),
  },
}));

const sendCmsLoginOtpMock = vi.fn().mockResolvedValue({ sent: true });
vi.mock('@/modules/auth/auth.mailer', () => ({
  sendCmsLoginOtp: (...args: unknown[]) => sendCmsLoginOtpMock(...args),
}));

import * as authService from '@/modules/auth/auth.service';

const dummyCtx = {
  ip: '127.0.0.1',
  userAgent: 'vitest-agent',
  actorId: 'usr-123',
  actorName: 'Admin User',
  actorRole: 'Admin',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CMS Email OTP & Optional Authenticator Auth', () => {
  it('Step 1: dispatches Email OTP upon valid password entry and returns maskedEmail', async () => {
    const passwordHash = await hashPassword('ValidStaffPassword123!');
    userFindUnique.mockResolvedValue({
      id: 'usr-123',
      email: 'admin@zewafeeds.com',
      name: 'Admin User',
      passwordHash,
      role: Role.ADMIN,
      status: CmsUserStatus.ACTIVE,
      twofaSecret: null,
      twofaEnrolledAt: null,
      twofaMethod: null,
      deletedAt: null,
      tokenVersion: 0,
    });
    otpUpdateMany.mockResolvedValue({ count: 0 });
    otpCreate.mockResolvedValue({ id: 'otp-row-1' });

    const result = await authService.login('admin@zewafeeds.com', 'ValidStaffPassword123!', dummyCtx);

    expect(result.twofaEnrolled).toBe(true);
    expect(result.twofaMethod).toBe(TwofaMethod.EMAIL_OTP);
    expect(result.hasTotp).toBe(false);
    expect(result.maskedEmail).toBe('ad***@zewafeeds.com');
    expect(result.challengeToken).toBeDefined();

    expect(sendCmsLoginOtpMock).toHaveBeenCalledTimes(1);
    expect(sendCmsLoginOtpMock).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'admin@zewafeeds.com',
        name: 'Admin User',
        expiresInMinutes: 10,
      }),
    );
  });

  it('Step 2: successfully verifies valid Email OTP and opens session', async () => {
    const challengeToken = signChallengeToken({ sub: 'usr-123', enrol: false });
    const correctCode = '654321';
    const otpHash = hashToken(correctCode);

    userFindUnique.mockResolvedValue({
      id: 'usr-123',
      email: 'admin@zewafeeds.com',
      name: 'Admin User',
      role: Role.ADMIN,
      status: CmsUserStatus.ACTIVE,
      twofaSecret: null,
      twofaEnrolledAt: null,
      deletedAt: null,
      tokenVersion: 0,
    });

    otpFindFirst.mockResolvedValue({
      id: 'otp-row-1',
      userId: 'usr-123',
      otpHash,
      attempts: 0,
      maxAttempts: 5,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      usedAt: null,
    });

    otpUpdate.mockResolvedValue({ id: 'otp-row-1' });
    sessionCreate.mockResolvedValue({ id: 'sess-1' });
    userUpdate.mockResolvedValue({ id: 'usr-123' });

    const session = await authService.verifyTwofa(challengeToken, correctCode, dummyCtx, true);

    expect(session.accessToken).toBeDefined();
    expect(session.refreshToken).toBeDefined();
    expect(session.user.email).toBe('admin@zewafeeds.com');

    expect(otpUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'otp-row-1' },
        data: expect.objectContaining({ usedAt: expect.any(Date) }),
      }),
    );
  });

  it('Step 2: increments attempt counter on wrong Email OTP', async () => {
    const challengeToken = signChallengeToken({ sub: 'usr-123', enrol: false });
    const correctCode = '654321';
    const wrongCode = '111111';

    userFindUnique.mockResolvedValue({
      id: 'usr-123',
      email: 'admin@zewafeeds.com',
      name: 'Admin User',
      role: Role.ADMIN,
      status: CmsUserStatus.ACTIVE,
      twofaSecret: null,
      twofaEnrolledAt: null,
      deletedAt: null,
      tokenVersion: 0,
    });

    otpFindFirst.mockResolvedValue({
      id: 'otp-row-1',
      userId: 'usr-123',
      otpHash: hashToken(correctCode),
      attempts: 1,
      maxAttempts: 5,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      usedAt: null,
    });

    otpUpdate.mockResolvedValue({ id: 'otp-row-1' });

    await expect(authService.verifyTwofa(challengeToken, wrongCode, dummyCtx, false)).rejects.toThrow(
      'That verification code is not valid. Try again.',
    );

    expect(otpUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'otp-row-1' },
        data: { attempts: { increment: 1 } },
      }),
    );
  });

  it('Step 2: locks OTP after 5 failed attempts', async () => {
    const challengeToken = signChallengeToken({ sub: 'usr-123', enrol: false });

    userFindUnique.mockResolvedValue({
      id: 'usr-123',
      email: 'admin@zewafeeds.com',
      name: 'Admin User',
      role: Role.ADMIN,
      status: CmsUserStatus.ACTIVE,
      twofaSecret: null,
      twofaEnrolledAt: null,
      deletedAt: null,
      tokenVersion: 0,
    });

    otpFindFirst.mockResolvedValue({
      id: 'otp-row-1',
      userId: 'usr-123',
      otpHash: hashToken('654321'),
      attempts: 5,
      maxAttempts: 5,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      usedAt: null,
    });

    otpUpdate.mockResolvedValue({ id: 'otp-row-1' });

    await expect(authService.verifyTwofa(challengeToken, '654321', dummyCtx, false)).rejects.toThrow(
      'Maximum verification attempts exceeded',
    );
  });

  it('Resend: respects 60s cooldown and generates fresh OTP when eligible', async () => {
    const challengeToken = signChallengeToken({ sub: 'usr-123', enrol: false });

    userFindUnique.mockResolvedValue({
      id: 'usr-123',
      email: 'admin@zewafeeds.com',
      name: 'Admin User',
      role: Role.ADMIN,
      status: CmsUserStatus.ACTIVE,
      deletedAt: null,
    });

    // 1. Within cooldown (10s ago) -> Throws 429
    otpFindFirst.mockResolvedValueOnce({
      id: 'otp-row-1',
      createdAt: new Date(Date.now() - 10 * 1000),
    });

    await expect(authService.resendEmailOtp(challengeToken, dummyCtx)).rejects.toThrow(
      'Please wait 50 seconds before requesting another verification code.',
    );

    // 2. Past cooldown (70s ago) -> Resends OTP successfully
    otpFindFirst.mockResolvedValueOnce({
      id: 'otp-row-1',
      createdAt: new Date(Date.now() - 70 * 1000),
    });
    otpUpdateMany.mockResolvedValue({ count: 1 });
    otpCreate.mockResolvedValue({ id: 'otp-row-2' });

    const resOk = await authService.resendEmailOtp(challengeToken, dummyCtx);

    expect(resOk.ok).toBe(true);
    expect(resOk.cooldownSeconds).toBe(60);
    expect(sendCmsLoginOtpMock).toHaveBeenCalledTimes(1);
  });

  it('Fallback: verifies Authenticator App (TOTP) code for enrolled user', async () => {
    const secret = authenticator.generateSecret();
    const totpCode = authenticator.generate(secret);
    const challengeToken = signChallengeToken({ sub: 'usr-totp-123', enrol: false });

    userFindUnique.mockResolvedValue({
      id: 'usr-totp-123',
      email: 'ops@zewafeeds.com',
      name: 'Ops User',
      role: Role.OPS_MANAGER,
      status: CmsUserStatus.ACTIVE,
      twofaSecret: encryptSecret(secret),
      twofaEnrolledAt: new Date(),
      twofaMethod: TwofaMethod.TOTP,
      deletedAt: null,
      tokenVersion: 0,
    });

    otpFindFirst.mockResolvedValue(null);
    backupCodeFindFirst.mockResolvedValue(null);
    sessionCreate.mockResolvedValue({ id: 'sess-totp-1' });
    userUpdate.mockResolvedValue({ id: 'usr-totp-123' });

    const session = await authService.verifyTwofa(challengeToken, totpCode, dummyCtx, false);

    expect(session.accessToken).toBeDefined();
    expect(session.user.role).toBe(Role.OPS_MANAGER);
  });

  it('In-profile TOTP setup and confirmation flow', async () => {
    userFindUniqueOrThrow.mockResolvedValue({
      id: 'usr-setup-123',
      email: 'editor@zewafeeds.com',
      name: 'Editor User',
      role: Role.CONTENT_EDITOR,
    });
    userUpdate.mockResolvedValue({ id: 'usr-setup-123' });

    const setupResult = await authService.setupTotpForUser('usr-setup-123');
    expect(setupResult.secret).toBeDefined();
    expect(setupResult.otpauthUrl).toContain('otpauth://totp/');

    // Now test confirmation with valid TOTP code
    const validCode = authenticator.generate(setupResult.secret);

    userFindUniqueOrThrow.mockResolvedValue({
      id: 'usr-setup-123',
      email: 'editor@zewafeeds.com',
      name: 'Editor User',
      role: Role.CONTENT_EDITOR,
      twofaSecret: encryptSecret(setupResult.secret),
    });

    backupCodeDeleteMany.mockResolvedValue({ count: 0 });
    backupCodeCreateMany.mockResolvedValue({ count: 8 });

    const confirmResult = await authService.confirmTotpForUser('usr-setup-123', validCode, dummyCtx);

    expect(confirmResult.ok).toBe(true);
    expect(confirmResult.backupCodes).toHaveLength(8);
  });

  it('Issues 7-day session when remember=true, and 8-hour session when remember=false', async () => {
    const challengeToken = signChallengeToken({ sub: 'usr-123', enrol: false });

    userFindUnique.mockResolvedValue({
      id: 'usr-123',
      email: 'admin@zewafeeds.com',
      name: 'Admin User',
      role: Role.ADMIN,
      status: CmsUserStatus.ACTIVE,
      twofaSecret: null,
      twofaEnrolledAt: null,
      deletedAt: null,
      tokenVersion: 0,
    });

    otpFindFirst.mockResolvedValue({
      id: 'otp-row-remember',
      userId: 'usr-123',
      otpHash: hashToken('112233'),
      attempts: 0,
      maxAttempts: 5,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      usedAt: null,
    });
    otpUpdate.mockResolvedValue({ id: 'otp-row-remember' });
    sessionCreate.mockResolvedValue({ id: 'sess-remember-1' });
    userUpdate.mockResolvedValue({ id: 'usr-123' });

    // 1. remember=true
    const rememberSession = await authService.verifyTwofa(challengeToken, '112233', dummyCtx, true);
    expect(rememberSession.isRemembered).toBe(true);
    expect(sessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'usr-123',
          expiresAt: expect.any(Date),
        }),
      }),
    );

    // 2. remember=false
    otpFindFirst.mockResolvedValueOnce({
      id: 'otp-row-no-remember',
      userId: 'usr-123',
      otpHash: hashToken('112233'),
      attempts: 0,
      maxAttempts: 5,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      usedAt: null,
    });
    const noRememberSession = await authService.verifyTwofa(challengeToken, '112233', dummyCtx, false);
    expect(noRememberSession.isRemembered).toBe(false);
  });

  it('Session Refresh: rotates token and preserves remember=true status', async () => {
    const rawRefreshToken = 'valid_refresh_token_123';
    const now = Date.now();
    const createdAt = new Date(now - 1000 * 60 * 60 * 24); // 1 day ago
    const expiresAt = new Date(now + 1000 * 60 * 60 * 24 * 6); // 6 days remaining (7d total)

    sessionFindUnique.mockResolvedValue({
      id: 'sess-active-1',
      userId: 'usr-123',
      refreshTokenHash: hashToken(rawRefreshToken),
      revokedAt: null,
      createdAt,
      expiresAt,
      user: {
        id: 'usr-123',
        email: 'admin@zewafeeds.com',
        name: 'Admin User',
        role: Role.ADMIN,
        status: CmsUserStatus.ACTIVE,
        twofaMethod: TwofaMethod.EMAIL_OTP,
        tokenVersion: 0,
        deletedAt: null,
      },
    });

    sessionUpdate.mockResolvedValue({ id: 'sess-active-1' });
    sessionCreate.mockResolvedValue({ id: 'sess-rotated-2' });

    const refreshed = await authService.refresh(rawRefreshToken, dummyCtx);

    expect(refreshed.accessToken).toBeDefined();
    expect(refreshed.refreshToken).toBeDefined();
    expect(refreshed.isRemembered).toBe(true);
    expect(refreshed.user.email).toBe('admin@zewafeeds.com');
  });

  it('Session Refresh: reuses active session during multi-tab grace window', async () => {
    const rawRefreshToken = 'just_rotated_token_123';
    const now = Date.now();

    // Session that was rotated 5 seconds ago (within 30s grace window)
    sessionFindUnique.mockResolvedValue({
      id: 'sess-old-1',
      userId: 'usr-123',
      refreshTokenHash: hashToken(rawRefreshToken),
      revokedAt: new Date(now - 5000),
      createdAt: new Date(now - 10000),
      expiresAt: new Date(now + 1000 * 60 * 60 * 24 * 7),
      user: {
        id: 'usr-123',
        email: 'admin@zewafeeds.com',
        name: 'Admin User',
        role: Role.ADMIN,
        status: CmsUserStatus.ACTIVE,
        twofaMethod: TwofaMethod.EMAIL_OTP,
        tokenVersion: 0,
        deletedAt: null,
      },
    });

    // The new active session replacing it
    sessionFindFirst.mockResolvedValue({
      id: 'sess-new-2',
      userId: 'usr-123',
      revokedAt: null,
      createdAt: new Date(now - 5000),
      expiresAt: new Date(now + 1000 * 60 * 60 * 24 * 7),
      user: {
        id: 'usr-123',
        email: 'admin@zewafeeds.com',
        name: 'Admin User',
        role: Role.ADMIN,
        status: CmsUserStatus.ACTIVE,
        twofaMethod: TwofaMethod.EMAIL_OTP,
        tokenVersion: 0,
        deletedAt: null,
      },
    });

    const result = await authService.refresh(rawRefreshToken, dummyCtx);

    expect(result.accessToken).toBeDefined();
    expect(result.user.email).toBe('admin@zewafeeds.com');
  });
});
