import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { hashPassword } from '@/lib/crypto';

const customerFindUnique = vi.fn();
const customerCreate = vi.fn();
const customerUpdate = vi.fn();
const verificationFindUnique = vi.fn();
const verificationCreate = vi.fn();
const verificationUpdate = vi.fn();
const verificationUpdateMany = vi.fn();
const transaction = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    customer: {
      findUnique: (...args: unknown[]) => customerFindUnique(...args),
      create: (...args: unknown[]) => customerCreate(...args),
      update: (...args: unknown[]) => customerUpdate(...args),
    },
    customerEmailVerification: {
      findUnique: (...args: unknown[]) => verificationFindUnique(...args),
      create: (...args: unknown[]) => verificationCreate(...args),
      update: (...args: unknown[]) => verificationUpdate(...args),
      updateMany: (...args: unknown[]) => verificationUpdateMany(...args),
    },
    $transaction: (...args: unknown[]) => transaction(...args),
  },
}));

vi.mock('@/middleware/rateLimit', () => ({
  loginLimiter: (_r: unknown, _s: unknown, next: () => void) => next(),
  passwordResetLimiter: (_r: unknown, _s: unknown, next: () => void) => next(),
  couponLimiter: (_r: unknown, _s: unknown, next: () => void) => next(),
  reviewLimiter: (_r: unknown, _s: unknown, next: () => void) => next(),
}));

const sendAccountEmailMock = vi.fn();
vi.mock('@/modules/customers/account.mailer', () => ({
  sendAccountEmail: (...args: unknown[]) => sendAccountEmailMock(...args),
}));

import { customerAuthRouter } from '@/modules/customers/account.routes';
import { errorHandler } from '@/middleware/errorHandler';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as express.Request & { id: string }).id = 'test-request';
  next();
});
app.use('/auth/customer', customerAuthRouter);
app.use(errorHandler);

const server: Server = app.listen(0);
const port = () => (server.address() as AddressInfo).port;
const url = (path: string) => `http://127.0.0.1:${port()}${path}`;

afterAll(() => {
  server.close();
});

beforeEach(() => {
  customerFindUnique.mockReset();
  customerCreate.mockReset();
  customerUpdate.mockReset();
  verificationFindUnique.mockReset();
  verificationCreate.mockReset();
  verificationUpdate.mockReset();
  verificationUpdateMany.mockReset();
  transaction.mockReset();
  sendAccountEmailMock.mockReset();
});

describe('Customer Signup Email Verification', () => {
  it('registers an unverified customer, issues a verification token, and sends an email', async () => {
    customerFindUnique.mockResolvedValue(null);
    customerCreate.mockResolvedValue({
      id: 'cust-123',
      email: 'newuser@example.com',
      firstName: 'Aarav',
      lastName: 'Sharma',
    });
    verificationUpdateMany.mockResolvedValue({ count: 0 });
    verificationCreate.mockResolvedValue({ id: 'verif-123' });

    const res = await fetch(url('/auth/customer/register'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        firstName: 'Aarav',
        lastName: 'Sharma',
        email: 'newuser@example.com',
        password: 'ValidPassword123!',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { pendingVerification: boolean; email: string } };
    expect(body.data.pendingVerification).toBe(true);
    expect(body.data.email).toBe('newuser@example.com');

    // Customer created with emailVerifiedAt: null
    expect(customerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'newuser@example.com',
          emailVerifiedAt: null,
        }),
      }),
    );

    // Verification token stored and email sent
    expect(verificationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          customerId: 'cust-123',
        }),
      }),
    );
    expect(sendAccountEmailMock).toHaveBeenCalledWith(
      'newuser@example.com',
      'customer-email-verification',
      expect.objectContaining({
        firstName: 'Aarav',
        verifyUrl: expect.stringContaining('/verify-email?token='),
        expiresInHours: 24,
      }),
    );
  });

  it('blocks login when customer email is unverified', async () => {
    const passwordHash = await hashPassword('ValidPassword123!');
    customerFindUnique.mockResolvedValue({
      id: 'cust-123',
      email: 'unverified@example.com',
      firstName: 'Aarav',
      lastName: 'Sharma',
      passwordHash,
      status: 'ACTIVE',
      emailVerifiedAt: null,
    });

    const res = await fetch(url('/auth/customer/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'unverified@example.com',
        password: 'ValidPassword123!',
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('EMAIL_UNVERIFIED');
    expect(body.error.message).toContain('Please verify your email');
  });

  it('allows login when customer email is verified', async () => {
    const passwordHash = await hashPassword('ValidPassword123!');
    customerFindUnique.mockResolvedValue({
      id: 'cust-123',
      email: 'verified@example.com',
      firstName: 'Aarav',
      lastName: 'Sharma',
      passwordHash,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    });

    const res = await fetch(url('/auth/customer/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'verified@example.com',
        password: 'ValidPassword123!',
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { accessToken: string; customer: { email: string } } };
    expect(body.data.accessToken).toBeDefined();
    expect(body.data.customer.email).toBe('verified@example.com');
  });

  it('verifies account with valid token and issues access token', async () => {
    const plainToken = 'valid_secret_token_123';
    verificationFindUnique.mockResolvedValue({
      id: 'verif-123',
      usedAt: null,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      customer: {
        id: 'cust-123',
        email: 'user@example.com',
        firstName: 'Aarav',
        lastName: 'Sharma',
        status: 'ACTIVE',
        emailVerifiedAt: null,
      },
    });
    transaction.mockResolvedValue([{}, {}, {}]);

    const res = await fetch(url('/auth/customer/verify-email'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: plainToken }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { verified: boolean; accessToken: string } };
    expect(body.data.verified).toBe(true);
    expect(body.data.accessToken).toBeDefined();
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('handles already verified customer token safely', async () => {
    verificationFindUnique.mockResolvedValue({
      id: 'verif-123',
      usedAt: new Date(),
      expiresAt: new Date(Date.now() + 3600 * 1000),
      customer: {
        id: 'cust-123',
        email: 'user@example.com',
        firstName: 'Aarav',
        lastName: 'Sharma',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });

    const res = await fetch(url('/auth/customer/verify-email'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'spent_token' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { alreadyVerified: boolean } };
    expect(body.data.alreadyVerified).toBe(true);
  });

  it('rejects expired verification token', async () => {
    verificationFindUnique.mockResolvedValue({
      id: 'verif-123',
      usedAt: null,
      expiresAt: new Date(Date.now() - 3600 * 1000), // Expired
      customer: {
        id: 'cust-123',
        email: 'user@example.com',
        firstName: 'Aarav',
        lastName: 'Sharma',
        status: 'ACTIVE',
        emailVerifiedAt: null,
      },
    });

    const res = await fetch(url('/auth/customer/verify-email'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'expired_token' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('resends verification email with token invalidation', async () => {
    customerFindUnique.mockResolvedValue({
      id: 'cust-123',
      email: 'unverified@example.com',
      firstName: 'Aarav',
      passwordHash: 'hash',
      status: 'ACTIVE',
      emailVerifiedAt: null,
    });
    verificationUpdateMany.mockResolvedValue({ count: 1 });
    verificationCreate.mockResolvedValue({ id: 'verif-new' });

    const res = await fetch(url('/auth/customer/resend-verification'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'unverified@example.com' }),
    });

    expect(res.status).toBe(200);
    expect(verificationUpdateMany).toHaveBeenCalledWith({
      where: { customerId: 'cust-123', usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
    expect(verificationCreate).toHaveBeenCalledTimes(1);
    expect(sendAccountEmailMock).toHaveBeenCalledWith(
      'unverified@example.com',
      'customer-email-verification',
      expect.anything(),
    );
  });
});
