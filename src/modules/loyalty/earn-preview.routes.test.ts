/**
 * POST /coins/earn-preview — the "You'll earn N Zewa Seeds" line under the
 * checkout total. Real database for the SKU lookup; the rule version is stubbed
 * so the expected numbers don't depend on whatever rules the test DB holds.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { PrismaClient, ProductStatus } from '@prisma/client';
import { ns } from '@/test/fixtures';
import { errorHandler } from '@/middleware/errorHandler';

const rules = vi.hoisted(() => ({
  earningEnabled: true,
  earnGranularityPaise: 10000, // 1 seed per ₹100
  coinsPerStep: 1,
  minEarnBasePaise: 0,
  coinValuePaise: 100,
  minRedemptionCoins: 10,
  maxRedemptionPct: 90,
}));

vi.mock('./rules.service', async (orig) => ({
  ...(await orig<typeof import('./rules.service')>()),
  active: vi.fn(async () => rules),
}));

import { loyaltyPublicRouter } from './loyalty.routes';

const prisma = new PrismaClient();
const slug = ns('earnprev');
const sku = `EP-${Date.now()}`.toUpperCase();

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as express.Request & { id: string }).id = 'test-request';
  next();
});
app.use('/coins', loyaltyPublicRouter);
app.use(errorHandler);

let server: Server;
const preview = async (body: unknown) => {
  const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/coins/earn-preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as { data?: { coins: number } } };
};

beforeAll(async () => {
  await prisma.productFamily.create({
    data: {
      slug,
      name: `ZZ ${slug}`,
      category: 'SLOW_SINKING_PELLETS',
      status: ProductStatus.ACTIVE,
      shortDesc: 'fixture',
      variants: { create: { sku, pack: '45g', pricePaise: 36600, mrpPaise: 36600, stock: 10 } },
    },
  });
  server = app.listen(0);
});

afterAll(async () => {
  server?.close();
  await prisma.productFamily.deleteMany({ where: { slug } });
  await prisma.$disconnect();
});

describe('POST /coins/earn-preview', () => {
  it('estimates seeds on the cart value, no sign-in needed', async () => {
    // 2 × ₹366 = ₹732 → 7 seeds at 1 per ₹100.
    const r = await preview({ lines: [{ sku, qty: 2 }] });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ coins: 7 });
  });

  it('does not earn on seeds being spent', async () => {
    // ₹732 − 300 seeds (₹300) = ₹432 → 4 seeds.
    const r = await preview({ lines: [{ sku, qty: 2 }], coinsApplied: 300 });
    expect(r.body.data).toEqual({ coins: 4 });
  });

  it('reports zero while earning is switched off', async () => {
    rules.earningEnabled = false;
    const r = await preview({ lines: [{ sku, qty: 2 }] });
    rules.earningEnabled = true;
    expect(r.body.data).toEqual({ coins: 0 });
  });

  it('rejects an unknown SKU', async () => {
    const r = await preview({ lines: [{ sku: 'NOPE-404', qty: 1 }] });
    expect(r.status).toBe(400);
  });
});
