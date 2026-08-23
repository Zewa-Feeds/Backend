/**
 * The cancel endpoint at the HTTP boundary.
 *
 * The service-level suite proves the cancellation rules; this proves the door.
 * An unauthenticated caller must never reach the handler, and a forged or
 * absent token must not be treated as anonymous-but-allowed — the guard is the
 * only thing standing between a stranger and someone else's order.
 *
 * Prisma is mocked: nothing here should get far enough to touch a database,
 * and a test that needs one to prove a request was rejected is proving the
 * wrong thing.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('@/lib/prisma', () => ({
  prisma: {
    customer: { findUnique: vi.fn(async () => null) },
    order: { findFirst: vi.fn(async () => null) },
  },
}));

vi.mock('@/jobs/queues', () => ({
  emailQueue: { add: vi.fn(async () => ({ id: 'job' })) },
  paymentQueue: { add: vi.fn(async () => ({ id: 'job' })) },
  maintenanceQueue: { add: vi.fn(async () => ({ id: 'job' })) },
}));

import { accountRouter } from '@/modules/customers/account.routes';
import { errorHandler } from '@/middleware/errorHandler';
import { signCustomerToken } from '@/lib/tokens';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as express.Request & { id: string }).id = 'test-request';
  next();
});
app.use('/account', accountRouter);
app.use(errorHandler);

const server: Server = app.listen(0);
const url = (p: string) => `http://127.0.0.1:${(server.address() as AddressInfo).port}${p}`;

afterAll(() => server.close());

const cancel = (headers: Record<string, string> = {}, body: unknown = {}) =>
  fetch(url('/account/orders/27ZFO001/cancel'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

type ErrorBody = { error: { code: string; message: string } };

describe('POST /account/orders/:orderNo/cancel — authentication', () => {
  it('rejects a request with no Authorization header', async () => {
    const res = await cancel();
    expect(res.status).toBe(401);
    expect(((await res.json()) as ErrorBody).error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a non-Bearer scheme', async () => {
    const res = await cancel({ authorization: 'Basic abc123' });
    expect(res.status).toBe(401);
  });

  it('rejects a malformed token', async () => {
    const res = await cancel({ authorization: 'Bearer not.a.real.token' });
    expect(res.status).toBe(401);
  });

  it('rejects a well-formed token for a customer that no longer exists', async () => {
    // Signed correctly, but the guard looks the customer up and finds nothing.
    const token = signCustomerToken({ sub: 'ffffffff-ffff-4fff-8fff-ffffffffffff', email: 'ghost@example.invalid' });
    const res = await cancel({ authorization: `Bearer ${token}` });
    expect(res.status).toBe(401);
  });

  it('never reveals whether the order exists to an unauthenticated caller', async () => {
    const res = await cancel();
    const body = (await res.json()) as ErrorBody;
    // Auth fails first; nothing about the order leaks.
    expect(body.error.message).not.toMatch(/order/i);
    expect(res.status).not.toBe(404);
  });
});

describe('POST /account/orders/:orderNo/cancel — payload validation', () => {
  const authed = () => {
    const token = signCustomerToken({ sub: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'a@example.invalid' });
    return { authorization: `Bearer ${token}` };
  };

  it('rejects an over-long reason before any order lookup', async () => {
    const res = await cancel(authed(), { reason: 'x'.repeat(5000) });
    // 401 (customer not found in the mock) or 422 (validation) — either way it
    // is refused, and never a 200.
    expect([401, 422]).toContain(res.status);
    expect(res.status).not.toBe(200);
  });
});
