/**
 * Guest claiming — ZSOP004 §3.4, §8.4 #27, §12.1.
 *
 * The abuse vectors §12.1 names are the point of this file: a claim must be
 * atomic (so it can never happen twice), and the 30-day window must hold (so a
 * customer cannot register two years later and claim a long tail of history).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { PrismaClient, OrderStatus, PaymentMethod, PaymentStatus } from '@prisma/client';
import * as guestClaim from './guest-claim.service';
import * as rules from './rules.service';

const prisma = new PrismaClient();
const TAG = 'zz-guest';

async function sweep() {
  const orders = await prisma.order.findMany({
    where: { email: { startsWith: TAG } },
    select: { id: true },
  });
  const orderIds = orders.map((o) => o.id);
  const customers = await prisma.customer.findMany({
    where: { email: { startsWith: TAG } },
    select: { id: true },
  });
  const custIds = customers.map((c) => c.id);
  const accounts = await prisma.loyaltyAccount.findMany({
    where: { customerId: { in: custIds } },
    select: { id: true },
  });
  const accIds = accounts.map((a) => a.id);

  if (orderIds.length) await prisma.orderLoyalty.deleteMany({ where: { orderId: { in: orderIds } } });
  if (accIds.length) {
    await prisma.$executeRawUnsafe('ALTER TABLE "CoinLedger" DISABLE TRIGGER coin_ledger_no_delete');
    await prisma.coinLedger.deleteMany({ where: { accountId: { in: accIds } } });
    await prisma.$executeRawUnsafe('ALTER TABLE "CoinLedger" ENABLE TRIGGER coin_ledger_no_delete');
    await prisma.coinLot.deleteMany({ where: { accountId: { in: accIds } } });
    await prisma.loyaltyAccount.deleteMany({ where: { id: { in: accIds } } });
  }
  if (orderIds.length) await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  if (custIds.length) await prisma.customer.deleteMany({ where: { id: { in: custIds } } });
}

/** A guest order: no customerId, keyed only by email. */
async function makeGuestOrder(email: string, pricePaise: number, placedAt = new Date()) {
  const order = await prisma.order.create({
    data: {
      orderNo: `${TAG}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      customerId: null, // the defining property of a guest order
      email: email.toLowerCase(),
      phone: '+919000000000',
      status: OrderStatus.DELIVERED,
      paymentStatus: PaymentStatus.PAID,
      paymentMethod: PaymentMethod.RAZORPAY,
      subtotalPaise: pricePaise,
      totalPaise: pricePaise,
      placedAt,
      deliveredAt: placedAt,
      shippingAddress: { name: 'G', line1: 'L', city: 'C', state: 'Kerala', pincode: '600001' },
      items: {
        create: {
          productName: 'Guest Item',
          sku: `${TAG}-SKU-${Date.now()}${Math.random().toString(36).slice(2, 5)}`,
          pack: '1kg',
          unitPricePaise: pricePaise,
          qty: 1,
          hsn: '2309',
          taxRatePct: 0,
          lineTotalPaise: pricePaise,
        },
      },
    },
    select: { id: true },
  });
  return order.id;
}

async function makeCustomer(label: string, opts: { verified: boolean }) {
  const customer = await prisma.customer.create({
    data: {
      email: `${TAG}-${label}-${Date.now()}${Math.random().toString(36).slice(2, 5)}@zewafeeds.test`,
      firstName: 'Guest',
      lastName: 'Claim',
      emailVerifiedAt: opts.verified ? new Date() : null,
    },
    select: { id: true, email: true },
  });

  /*
   * Opt this fixture OUT of the holdout.
   *
   * The claim service calls `ensureAccount`, which assigns the holdout
   * deterministically from a hash of the customer id (§13.5). ~5% of randomly
   * generated UUIDs land in it and correctly earn nothing, so without this a
   * couple of fixtures per run silently become control-group accounts and
   * whichever test owns them fails — which is why the failure appeared to move
   * between tests on every run.
   *
   * Pre-creating the account is safe: `ensureAccount` returns the existing row.
   */
  await prisma.loyaltyAccount.create({
    data: { customerId: customer.id, holdout: false },
  });

  return customer;
}

beforeAll(async () => {
  await sweep();
  await rules.active(prisma);
});

beforeEach(() => {
  /*
   * Drop the rule-version cache before every test.
   *
   * `rules.active()` caches for 60s (§9.3) in module-level state, and the
   * loyalty suites share a process. A neighbouring file that toggles the
   * redemption kill switch leaves this file reading a stale row, which changes
   * `guestClaimDays` and silently makes eligible orders unclaimable.
   */
  rules.invalidate();
});

afterAll(async () => {
  await sweep();
  await prisma.$disconnect();
});

describe('§3.4 Claiming a guest order', () => {
  it('retro-credits a guest order placed on the same verified email', async () => {
    const customer = await makeCustomer('happy', { verified: true });
    await makeGuestOrder(customer.email, 120000); // ₹1,200 → 24 coins

    const claimable = await guestClaim.claimableOrders(customer.id);
    expect(claimable).toHaveLength(1);
    expect(claimable[0]!.coins).toBe(24);

    const result = await guestClaim.claimGuestOrders(customer.id);
    expect(result.claimed).toBe(1);
    expect(result.coins).toBe(24);

    const account = await prisma.loyaltyAccount.findUniqueOrThrow({
      where: { customerId: customer.id },
    });
    // Claimed coins land AVAILABLE — the order is long delivered, so the
    // deferred-unlock control has nothing left to protect against.
    expect(account.availableCoins).toBe(24);
  });

  it('attaches the claimed order to the account so it appears in order history', async () => {
    const customer = await makeCustomer('attach', { verified: true });
    const orderId = await makeGuestOrder(customer.email, 100000);

    await guestClaim.claimGuestOrders(customer.id);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.customerId).toBe(customer.id);
  });

  it('refuses to claim for an unverified email', async () => {
    // The gate: someone who merely guesses an address cannot take the coins.
    const customer = await makeCustomer('unverified', { verified: false });
    await makeGuestOrder(customer.email, 120000);

    expect(await guestClaim.claimableOrders(customer.id)).toHaveLength(0);
    expect(await guestClaim.claimGuestOrders(customer.id)).toEqual({ claimed: 0, coins: 0 });
  });
});

describe('§8.4 #27 / §12.1 Duplicate claim abuse', () => {
  it('claims once and only once, however many times it is called', async () => {
    const customer = await makeCustomer('dup', { verified: true });
    await makeGuestOrder(customer.email, 120000);

    const first = await guestClaim.claimGuestOrders(customer.id);
    const second = await guestClaim.claimGuestOrders(customer.id);
    const third = await guestClaim.claimGuestOrders(customer.id);

    expect(first.coins).toBe(24);
    expect(second.coins).toBe(0);
    expect(third.coins).toBe(0);

    const account = await prisma.loyaltyAccount.findUniqueOrThrow({
      where: { customerId: customer.id },
    });
    expect(account.availableCoins).toBe(24); // not 48, not 72
  });

  it('grants once even when two claims race', async () => {
    const customer = await makeCustomer('race', { verified: true });
    await makeGuestOrder(customer.email, 200000); // ₹2,000 → 40 coins

    // Concurrent claims — the OrderLoyalty unique index is what settles this.
    const results = await Promise.all([
      guestClaim.claimGuestOrders(customer.id).catch(() => ({ claimed: 0, coins: 0 })),
      guestClaim.claimGuestOrders(customer.id).catch(() => ({ claimed: 0, coins: 0 })),
      guestClaim.claimGuestOrders(customer.id).catch(() => ({ claimed: 0, coins: 0 })),
    ]);

    const total = results.reduce((s, r) => s + r.coins, 0);
    expect(total).toBe(40);

    const account = await prisma.loyaltyAccount.findUniqueOrThrow({
      where: { customerId: customer.id },
    });
    expect(account.availableCoins).toBe(40);

    const lots = await prisma.coinLot.count({ where: { accountId: account.id } });
    expect(lots).toBe(1);
  });
});

describe('§3.4 The 30-day window', () => {
  it('does not offer an order older than the claim window', async () => {
    // "Beyond 30 days the order is not claimable — otherwise a customer could
    // register two years later and claim a long tail of historical orders,
    // which is both a cost surprise and a fraud vector."
    const customer = await makeCustomer('stale', { verified: true });
    const old = new Date();
    old.setDate(old.getDate() - 45);
    await makeGuestOrder(customer.email, 120000, old);

    expect(await guestClaim.claimableOrders(customer.id)).toHaveLength(0);
    expect((await guestClaim.claimGuestOrders(customer.id)).coins).toBe(0);
  });

  it('offers an order just inside the window', async () => {
    const customer = await makeCustomer('fresh', { verified: true });
    const recent = new Date();
    recent.setDate(recent.getDate() - 29);
    await makeGuestOrder(customer.email, 120000, recent);

    expect(await guestClaim.claimableOrders(customer.id)).toHaveLength(1);
  });

  it('reports the claim deadline so the prompt can state it (§3.4)', async () => {
    const customer = await makeCustomer('deadline', { verified: true });
    await makeGuestOrder(customer.email, 120000);

    const [order] = await guestClaim.claimableOrders(customer.id);
    const days = Math.round((order!.claimableUntil.getTime() - Date.now()) / 86400000);
    expect(days).toBeGreaterThanOrEqual(29);
    expect(days).toBeLessThanOrEqual(30);
  });
});

describe('§3.4 Eligibility edges', () => {
  it('ignores a cancelled guest order', async () => {
    const customer = await makeCustomer('cancelled', { verified: true });
    const orderId = await makeGuestOrder(customer.email, 120000);
    await prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.CANCELLED },
    });

    expect(await guestClaim.claimableOrders(customer.id)).toHaveLength(0);
  });

  it('ignores an unpaid prepaid order', async () => {
    const customer = await makeCustomer('unpaid', { verified: true });
    const orderId = await makeGuestOrder(customer.email, 120000);
    await prisma.order.update({
      where: { id: orderId },
      data: { paymentStatus: PaymentStatus.UNPAID },
    });

    expect(await guestClaim.claimableOrders(customer.id)).toHaveLength(0);
  });

  it('ignores an order below the ₹50 minimum earn base (§3.3)', async () => {
    const customer = await makeCustomer('tiny', { verified: true });
    await makeGuestOrder(customer.email, 4000); // ₹40 → 0 coins

    expect(await guestClaim.claimableOrders(customer.id)).toHaveLength(0);
  });

  it('claims several eligible orders in one pass', async () => {
    const customer = await makeCustomer('multi', { verified: true });
    await makeGuestOrder(customer.email, 120000); // 24
    await makeGuestOrder(customer.email, 100000); // 20

    const result = await guestClaim.claimGuestOrders(customer.id);
    expect(result.claimed).toBe(2);
    expect(result.coins).toBe(44);
  });

  it('never claims another customer’s order', async () => {
    const mine = await makeCustomer('mine', { verified: true });
    const theirs = await makeCustomer('theirs', { verified: true });
    await makeGuestOrder(theirs.email, 120000);

    expect(await guestClaim.claimableOrders(mine.id)).toHaveLength(0);
  });
});

describe('§3.4 The checkout prompt', () => {
  it('previews the coins a guest would earn, to name the figure', async () => {
    // "Create a free profile and earn 24 Zewa Coins on this order."
    const coins = await guestClaim.previewGuestEarn([
      { lineTotalPaise: 120000, earnEligible: true },
    ]);
    expect(coins).toBe(24);
  });

  it('excludes non-earning SKUs from the preview', async () => {
    const coins = await guestClaim.previewGuestEarn([
      { lineTotalPaise: 120000, earnEligible: true },
      { lineTotalPaise: 60000, earnEligible: false },
    ]);
    expect(coins).toBe(24); // the clearance line adds nothing
  });
});
