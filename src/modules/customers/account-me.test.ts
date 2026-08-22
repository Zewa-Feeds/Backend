/**
 * `/account/me` and the guard that feeds it.
 *
 * The guard has to load the customer row on every request anyway — it is how a
 * ban takes effect immediately — and `/account/me` used to load the very same
 * row a second time. Against a database roughly 180ms away that doubled the
 * cost of the first request every account screen makes.
 *
 * These are unit tests with Prisma mocked, deliberately: the thing under test
 * is HOW MANY TIMES the database is asked and WHAT the handler returns, and a
 * spy answers both exactly. Token signing and verification are NOT mocked —
 * they are the security boundary, so the real signer and verifier run.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/** The one call the guard makes. Every test asserts on its call count. */
const findUnique = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: { customer: { findUnique: (...args: unknown[]) => findUnique(...args) } },
}));

// Rate limiting is Redis-backed; nothing here is testing it, and constructing a
// client would make the suite depend on a running container.
vi.mock('@/middleware/rateLimit', () => ({
  loginLimiter: (_r: unknown, _s: unknown, next: () => void) => next(),
  passwordResetLimiter: (_r: unknown, _s: unknown, next: () => void) => next(),
  couponLimiter: (_r: unknown, _s: unknown, next: () => void) => next(),
  reviewLimiter: (_r: unknown, _s: unknown, next: () => void) => next(),
}));

vi.mock('@/modules/customers/account.mailer', () => ({ sendAccountEmail: vi.fn() }));

const { accountRouter } = await import('@/modules/customers/account.routes');
const { errorHandler } = await import('@/middleware/errorHandler');
const { signCustomerToken } = await import('@/lib/tokens');

/** The row the guard's SELECT returns for a healthy customer. */
const ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'it@zewafeeds.com',
  status: 'ACTIVE',
  firstName: 'Ida',
  lastName: 'Tester',
  phone: '+919000000000',
  registeredAt: new Date('2026-01-15T09:30:00.000Z'),
};

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  // requestId middleware is not mounted here; the error handler reads req.id.
  (req as express.Request & { id: string }).id = 'test-request';
  next();
});
app.use('/account', accountRouter);
app.use(errorHandler);

const server: Server = app.listen(0);
const port = () => (server.address() as AddressInfo).port;
const url = (path: string) => `http://127.0.0.1:${port()}${path}`;

afterAll(() => {
  server.close();
});

const tokenFor = (id: string, email: string) => signCustomerToken({ sub: id, email });

const getMe = (token?: string) =>
  fetch(url('/account/me'), {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

beforeEach(() => {
  findUnique.mockReset();
});

describe('requireCustomer rejects anything without a valid session', () => {
  it('401s with no Authorization header, without touching the database', async () => {
    const res = await getMe();
    expect(res.status).toBe(401);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('401s on a non-Bearer scheme', async () => {
    const res = await fetch(url('/account/me'), { headers: { authorization: 'Basic abc' } });
    expect(res.status).toBe(401);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('401s on a forged token — the real verifier rejects it', async () => {
    const res = await getMe('not.a.real.token');
    expect(res.status).toBe(401);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('401s when the token is valid but the customer no longer exists', async () => {
    findUnique.mockResolvedValue(null);
    const res = await getMe(tokenFor(ROW.id, ROW.email));
    expect(res.status).toBe(401);
    expect(findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('authorization is unchanged', () => {
  it('403s a BANNED customer rather than serving the profile', async () => {
    findUnique.mockResolvedValue({ ...ROW, status: 'BANNED' });
    const res = await getMe(tokenFor(ROW.id, ROW.email));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('ACCOUNT_BANNED');
  });

  it('looks the customer up by the token subject, not by anything client-supplied', async () => {
    findUnique.mockResolvedValue(ROW);
    await getMe(tokenFor(ROW.id, ROW.email));
    expect(findUnique.mock.calls[0][0]).toMatchObject({ where: { id: ROW.id } });
  });
});

describe('/account/me', () => {
  it('returns exactly the six fields it always has', async () => {
    findUnique.mockResolvedValue(ROW);
    const res = await getMe(tokenFor(ROW.id, ROW.email));

    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toEqual({
      id: ROW.id,
      email: ROW.email,
      firstName: ROW.firstName,
      lastName: ROW.lastName,
      phone: ROW.phone,
      registeredAt: ROW.registeredAt.toISOString(),
    });
  });

  it('does not leak the account status the guard reads', async () => {
    findUnique.mockResolvedValue(ROW);
    const { data } = await (await getMe(tokenFor(ROW.id, ROW.email))).json();
    expect(data).not.toHaveProperty('status');
    expect(Object.keys(data).sort()).toEqual(
      ['email', 'firstName', 'id', 'lastName', 'phone', 'registeredAt'],
    );
  });

  it('performs ONE customer lookup, not two', async () => {
    findUnique.mockResolvedValue(ROW);
    await getMe(tokenFor(ROW.id, ROW.email));
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('selects the profile columns in that single lookup', async () => {
    findUnique.mockResolvedValue(ROW);
    await getMe(tokenFor(ROW.id, ROW.email));

    const { select } = findUnique.mock.calls[0][0] as { select: Record<string, boolean> };
    // Everything /account/me answers with, plus the flag the ban check needs.
    for (const field of ['id', 'email', 'status', 'firstName', 'lastName', 'phone', 'registeredAt']) {
      expect(select[field]).toBe(true);
    }
  });

  it('carries a null phone through unchanged', async () => {
    findUnique.mockResolvedValue({ ...ROW, phone: null });
    const { data } = await (await getMe(tokenFor(ROW.id, ROW.email))).json();
    expect(data.phone).toBeNull();
  });
});
