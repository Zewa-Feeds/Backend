/**
 * PATCH /coupons/:id must not invent values.
 *
 * These lock in the fix for three reported bugs that shared one cause: the
 * update route validated against the CREATE schema, whose `.default()`s turn
 * an omitted field into a written value.
 *
 *   - the per-customer limit kept reverting (omitted -> default)
 *   - edits appeared not to save (fields reset to their defaults)
 *   - the active toggle's `{ isActive }` body was rejected for missing `code`
 *
 * The schema is not exported, so it is exercised through the router — which is
 * also what actually runs in production. A PATCH is expected to reach the
 * service with ONLY the keys the client sent.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateMock = vi.fn(async (_id: string, input: unknown) => ({ id: _id, ...(input as object) }));

vi.mock('./coupons.service', () => ({
  update: (id: string, input: unknown, _ctx: unknown) => updateMock(id, input),
  create: vi.fn(),
  list: vi.fn(),
  byId: vi.fn(),
  redemptions: vi.fn(),
  analytics: vi.fn(),
}));

// The router gates on a permission and writes audit rows; neither is under test.
vi.mock('@/middleware/auth', () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@/modules/audit/audit.service', () => ({
  auditContext: () => ({ actorId: 'test', actorName: 'test', ip: '::1' }),
  writeAudit: vi.fn(),
}));

const COUPON_ID = '11111111-1111-4111-8111-111111111111';

/** Sends a real PATCH at the real router and returns the status. */
async function patch(body: unknown): Promise<{ status: number }> {
  const { couponsRouter } = await import('./coupons.routes');
  const app = express();
  app.use(express.json());
  app.use('/coupons', couponsRouter);
  // The error handler the app mounts in production, so a validation failure
  // surfaces as the real 422 here rather than Express's default 500.
  const { errorHandler } = await import('@/middleware/errorHandler');
  app.use(errorHandler);

  const server = createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/coupons/${COUPON_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

describe('PATCH coupon body', () => {
  beforeEach(() => updateMock.mockClear());

  it('accepts a lone isActive toggle', async () => {
    const res = await patch({ isActive: false });

    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledOnce();
    expect(updateMock.mock.calls[0]![1]).toEqual({ isActive: false });
  });

  it('does not resurrect omitted fields as defaults', async () => {
    const res = await patch({ showAtCheckout: true });

    expect(res.status).toBe(200);
    const sent = updateMock.mock.calls[0]![1] as Record<string, unknown>;
    // The bug: these arrived as null/defaults and overwrote stored values.
    expect(sent).not.toHaveProperty('perCustomerLimit');
    expect(sent).not.toHaveProperty('totalUsageLimit');
    expect(sent).not.toHaveProperty('stackingMode');
    expect(sent).toEqual({ showAtCheckout: true });
  });

  it('preserves an explicit per-customer limit', async () => {
    await patch({ perCustomerLimit: 3 });
    expect(updateMock.mock.calls[0]![1]).toEqual({ perCustomerLimit: 3 });
  });

  it('passes an explicit null through as unlimited', async () => {
    await patch({ perCustomerLimit: null });
    expect(updateMock.mock.calls[0]![1]).toEqual({ perCustomerLimit: null });
  });

  it('converts minOrder rupees to paise', async () => {
    await patch({ minOrder: 499 });
    expect(updateMock.mock.calls[0]![1]).toEqual({ minOrderPaise: 49900 });
  });

  it('converts a flat discount to paise, and a percentage as-is', async () => {
    await patch({ discountValue: 50, discountType: 'FLAT' });
    expect(updateMock.mock.calls[0]![1]).toMatchObject({ discountValue: 5000 });

    updateMock.mockClear();
    await patch({ discountValue: 10, discountType: 'PERCENTAGE' });
    expect(updateMock.mock.calls[0]![1]).toMatchObject({ discountValue: 10 });
  });

  it('refuses a discount value without its type, rather than guessing the unit', async () => {
    const res = await patch({ discountValue: 50 });

    expect(res.status).toBe(422);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('still enforces the percentage ceiling', async () => {
    const res = await patch({ discountValue: 120, discountType: 'PERCENTAGE' });

    expect(res.status).toBe(422);
    expect(updateMock).not.toHaveBeenCalled();
  });
});
