/**
 * The checkout route must know WHO is checking out.
 *
 * THE DEFECT THIS FILE EXISTS FOR
 *
 * A coin reservation belongs to an account, so `checkout.service` gates its hold
 * lookup on `input.customerId`. Nothing ever set that field: the route spread
 * `req.body` (which has no `customerId`, by design) and never read the session. So
 * `coinHold` was permanently null, every coin order was created at FULL price, and
 * the customer saw ₹0.20 while Razorpay charged ₹376.20.
 *
 * The earlier `payableTotalPaise` fix was necessary but not sufficient — it made
 * the arithmetic consistent, while the discount was being lost one layer earlier.
 *
 * Driven over HTTP through the real router, because the missing piece WAS the
 * middleware: a service-level test passes `customerId` directly and cannot see it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

vi.hoisted(() => {
  process.env.PAYMENT_COD_ENABLED = 'true';
  process.env.RAZORPAY_AUTO_CONFIRM = 'true';
});

vi.mock('@/jobs/queues', () => ({
  emailQueue: { add: vi.fn(async () => ({ id: 'job' })) },
  paymentQueue: { add: vi.fn(async () => ({ id: 'job' })), remove: vi.fn(async () => undefined) },
  maintenanceQueue: { add: vi.fn(async () => ({ id: 'job' })) },
  QUEUE_NAMES: { email: 'email', payment: 'payment', maintenance: 'maintenance' },
  scheduleMaintenance: vi.fn(async () => undefined),
  closeQueues: vi.fn(async () => undefined),
}));

import { CoinLotState, CoinSourceType, PrismaClient } from '@prisma/client';
import { checkoutRouter } from './checkout.routes';
import { errorHandler } from '@/middleware/errorHandler';
import { signCustomerToken } from '@/lib/tokens';
import * as redemption from '@/modules/loyalty/redemption.service';
import * as accountService from '@/modules/loyalty/account.service';
import * as rules from '@/modules/loyalty/rules.service';

const prisma = new PrismaClient();
const TAG = 'zzsess';

let server: Server;
let variantSku = '';
let familyId = '';
let ruleVersion: Awaited<ReturnType<typeof rules.active>>;
let originalRedemption = false;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as express.Request & { id: string }).id = 'test-request';
  next();
});
app.use('/checkout', checkoutRouter);
app.use(errorHandler);

const url = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/checkout`;

async function seedCustomer(label: string, coins: number) {
  const customer = await prisma.customer.create({
    data: {
      email: `${TAG}-${label}-${Date.now()}${Math.random().toString(36).slice(2, 5)}@zewafeeds.test`,
      firstName: 'Sess',
      lastName: 'Test',
      phone: '+919000000009',
    },
    select: { id: true, email: true },
  });
  const acc = await prisma.$transaction((tx) => accountService.ensureAccount(tx, customer.id));

  if (coins > 0) {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 365);
    await prisma.coinLot.create({
      data: {
        accountId: acc.id,
        coinsGranted: coins,
        coinsRemaining: coins,
        state: CoinLotState.AVAILABLE,
        sourceType: CoinSourceType.MANUAL,
        expiresAt,
        ruleVersionId: ruleVersion.id,
        claimedAt: new Date(),
      },
    });
    await prisma.loyaltyAccount.update({
      where: { id: acc.id },
      data: { availableCoins: coins },
    });
  }
  return { ...customer, accountId: acc.id };
}

function hold(customerId: string, coins: number, cartKey: string) {
  return redemption.reserve({
    customerId,
    coins,
    cartKey,
    lines: [
      {
        id: 'x',
        lineTotalPaise: 120000,
        taxRatePct: 0,
        earnEligible: true,
        coinRedeemable: true,
        couponDiscountPaise: 0,
      },
    ],
  });
}

/** POST /checkout, optionally as a signed-in customer. */
async function place(body: Record<string, unknown>, token?: string) {
  const res = await fetch(url(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      lines: [{ sku: variantSku, qty: 1 }],
      email: `${TAG}-buyer@zewafeeds.test`,
      phone: '+919000000009',
      shippingAddress: {
        name: 'Sess Test',
        phone: '+919000000009',
        line1: 'Line 1',
        city: 'Kochi',
        state: 'Kerala',
        pincode: '682001',
      },
      paymentMethod: 'RAZORPAY',
      ...body,
    }),
  });
  /*
   * The subset these tests read. `Record<string, never>` would type every field as
   * `never`, which is why the arithmetic below did not typecheck.
   */
  type PlaceResponse = {
    data: {
      orderNo: string;
      totalPaise: number;
      payment: { amountPaise?: number };
    };
  };
  return { status: res.status, body: (await res.json()) as PlaceResponse };
}

beforeAll(async () => {
  const current = await rules.active(prisma);
  originalRedemption = current.redemptionEnabled;
  await prisma.loyaltyRuleVersion.update({
    where: { id: current.id },
    data: { redemptionEnabled: true },
  });
  rules.invalidate();
  ruleVersion = await rules.active(prisma);

  const family = await prisma.productFamily.create({
    data: {
      slug: `${TAG}-fam-${Date.now()}`,
      name: 'Session Test Feed',
      category: 'FLOATING_PELLETS',
      status: 'ACTIVE',
      shortDesc: 'fixture',
    },
    select: { id: true },
  });
  familyId = family.id;
  const variant = await prisma.productVariant.create({
    data: {
      familyId: family.id,
      sku: `${TAG}-SKU-${Date.now()}`.toUpperCase(),
      pack: '1kg',
      pricePaise: 120000,
      mrpPaise: 120000,
      stock: 10_000,
      isActive: true,
    },
    select: { sku: true },
  });
  variantSku = variant.sku;

  await new Promise<void>((r) => {
    server = app.listen(0, r);
  });
});

afterAll(async () => {
  await prisma.order.deleteMany({ where: { email: { contains: TAG } } });
  await prisma.productVariant.deleteMany({ where: { familyId } });
  await prisma.productFamily.deleteMany({ where: { id: familyId } });
  await prisma.customer.deleteMany({ where: { email: { contains: TAG } } });
  const current = await rules.active(prisma);
  await prisma.loyaltyRuleVersion.update({
    where: { id: current.id },
    data: { redemptionEnabled: originalRedemption },
  });
  rules.invalidate();
  await new Promise<void>((r) => server.close(() => r()));
  await prisma.$disconnect();
});

describe('a signed-in checkout resolves the coin hold', () => {
  /*
   * THE regression. With no session on the route this returned the FULL price,
   * because `input.customerId` was undefined and the hold was never looked up.
   */
  it('applies the discount when the request carries a customer token', async () => {
    const customer = await seedCustomer('signedin', 500);
    const cartKey = `${TAG}-key-${Date.now()}`;
    const held = await hold(customer.id, 200, cartKey);
    expect(held.held).toBe(200);

    const token = signCustomerToken({ sub: customer.id, email: customer.email });
    const withCoins = await place({ coinCartKey: cartKey }, token);
    const guest = await place({});

    expect(withCoins.status).toBe(201);
    expect(withCoins.body.data.totalPaise).toBe(guest.body.data.totalPaise - 200 * 100);
  });

  it('charges the gateway exactly what the order says', async () => {
    const customer = await seedCustomer('gw', 500);
    const cartKey = `${TAG}-gw-${Date.now()}`;
    await hold(customer.id, 150, cartKey);

    const token = signCustomerToken({ sub: customer.id, email: customer.email });
    const res = await place({ coinCartKey: cartKey }, token);

    const order = await prisma.order.findFirstOrThrow({
      where: { orderNo: res.body.data.orderNo },
      select: { totalPaise: true },
    });
    expect(res.body.data.payment.amountPaise).toBe(order.totalPaise);
    expect(res.body.data.totalPaise).toBe(order.totalPaise);
  });
});

describe('checkout stays open to guests', () => {
  it('places an order with no token at all', async () => {
    const res = await place({});
    expect(res.status).toBe(201);
  });

  it('places an order with a malformed token rather than rejecting it', async () => {
    const res = await place({}, 'not-a-real-token');
    expect(res.status).toBe(201);
  });

  /* A guest naming someone else's cart key must get no discount. */
  it('gives a guest no discount even with a valid cart key', async () => {
    const customer = await seedCustomer('guestkey', 500);
    const cartKey = `${TAG}-guest-${Date.now()}`;
    await hold(customer.id, 200, cartKey);

    const guestWithKey = await place({ coinCartKey: cartKey });
    const plain = await place({});

    expect(guestWithKey.body.data.totalPaise).toBe(plain.body.data.totalPaise);
  });
});

describe('the session identifies the customer, not the body', () => {
  /*
   * The spread of `req.body` is why this matters: if `customerId` were readable
   * from the body, naming another account would spend their coins.
   */
  it('ignores a customerId supplied in the request body', async () => {
    const victim = await seedCustomer('victim', 500);
    const cartKey = `${TAG}-victim-${Date.now()}`;
    await hold(victim.id, 200, cartKey);

    // No token; the body claims to be the victim.
    const attacker = await place({ customerId: victim.id, coinCartKey: cartKey });
    const plain = await place({});

    expect(attacker.body.data.totalPaise).toBe(plain.body.data.totalPaise);
  });
});
