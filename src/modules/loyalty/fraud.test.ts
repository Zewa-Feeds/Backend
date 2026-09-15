/**
 * Fraud and risk controls — ZSOP004 §12.1.
 *
 * Two things are worth testing here.
 *
 * The RTO restriction is the one control in §12.1 that REFUSES a customer
 * action, so both halves need proving: earning off, and COD off. Getting the
 * rolling window wrong in either direction is costly — too strict punishes
 * someone for a refusal a year ago, too loose leaves the abuse open.
 *
 * The large-redemption step-up is BLOCKED (no SMS provider), and the tests
 * assert what that means precisely: the decision is still computed and the
 * exposure still counted, but redemption is NOT refused. A test that asserted a
 * block would be encoding a rule the specification does not contain.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient, PaymentMethod, CoinLotState, CoinSourceType } from '@prisma/client';
import * as fraud from './fraud.service';
import * as account from './account.service';
import * as rules from './rules.service';

const prisma = new PrismaClient();
const TAG = 'zzfraud';
let ruleVersion: Awaited<ReturnType<typeof rules.active>>;

async function sweep() {
  const customers = await prisma.customer.findMany({
    where: { email: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = customers.map((c) => c.id);
  if (!ids.length) return;
  const orders = await prisma.order.findMany({
    where: { customerId: { in: ids } },
    select: { id: true },
  });
  const orderIds = orders.map((o) => o.id);
  const accounts = await prisma.loyaltyAccount.findMany({
    where: { customerId: { in: ids } },
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
  await prisma.customer.deleteMany({ where: { id: { in: ids } } });
}

async function seed(label: string, rto?: { count: number; daysAgo: number }) {
  const customer = await prisma.customer.create({
    data: {
      email: `${TAG}-${label}-${Date.now()}${Math.random().toString(36).slice(2, 5)}@zewafeeds.test`,
      firstName: 'Risk',
      lastName: 'Test',
    },
    select: { id: true },
  });
  const acc = await prisma.$transaction((tx) => account.ensureAccount(tx, customer.id));

  // Opt out of the holdout — ~5% of random ids land in it by design (§13.5).
  const windowAt = rto ? new Date(Date.now() - rto.daysAgo * 86400000) : null;
  await prisma.loyaltyAccount.update({
    where: { id: acc.id },
    data: {
      holdout: false,
      ...(rto ? { rtoCount90d: rto.count, rtoWindowAt: windowAt } : {}),
    },
  });

  return { customerId: customer.id, accountId: acc.id };
}

beforeAll(async () => {
  await sweep();
  ruleVersion = await rules.active(prisma);
});

beforeEach(() => {
  rules.invalidate();
});

afterAll(async () => {
  await sweep();
  await prisma.$disconnect();
});

describe('§12.1 High-RTO abuse — the prepaid-only restriction', () => {
  it('leaves an ordinary account on COD', async () => {
    const { customerId } = await seed('clean');
    expect(await fraud.isPrepaidOnly(customerId)).toBe(false);
    expect(await fraud.codBlockedReason(customerId, PaymentMethod.COD)).toBeNull();
  });

  it('allows COD below the limit', async () => {
    const { customerId } = await seed('under', { count: 2, daysAgo: 10 });
    expect(await fraud.isPrepaidOnly(customerId)).toBe(false);
  });

  it('blocks COD at the limit — 3 RTOs in 90 days', async () => {
    const { customerId } = await seed('atlimit', { count: 3, daysAgo: 10 });
    expect(await fraud.isPrepaidOnly(customerId)).toBe(true);

    const reason = await fraud.codBlockedReason(customerId, PaymentMethod.COD);
    expect(reason).toMatch(/Cash on Delivery is not available/i);
    // The message must not blame the loyalty programme — the restriction is
    // about refused deliveries and applies regardless of coins.
    expect(reason).not.toMatch(/coin/i);
  });

  it('never blocks a prepaid order', async () => {
    const { customerId } = await seed('prepaid', { count: 5, daysAgo: 10 });
    expect(await fraud.codBlockedReason(customerId, PaymentMethod.RAZORPAY)).toBeNull();
  });

  it('the window ROLLS — an old record does not restrict forever', async () => {
    // Three RTOs, but the run started 120 days ago. §12.1 says "3 in 90 days",
    // so this customer is clean again.
    const { customerId } = await seed('stale', { count: 3, daysAgo: 120 });
    expect(await fraud.isPrepaidOnly(customerId)).toBe(false);
  });

  it('applies at the boundary', async () => {
    const inside = await seed('inside', { count: 3, daysAgo: 89 });
    const outside = await seed('outside', { count: 3, daysAgo: 91 });
    expect(await fraud.isPrepaidOnly(inside.customerId)).toBe(true);
    expect(await fraud.isPrepaidOnly(outside.customerId)).toBe(false);
  });

  it('ignores a guest with no account', async () => {
    expect(await fraud.isPrepaidOnly(null)).toBe(false);
    expect(await fraud.codBlockedReason(null, PaymentMethod.COD)).toBeNull();
  });
});

describe('§12.1 Large redemption — decided, recorded, NOT enforced', () => {
  it('flags a redemption at or above the threshold', async () => {
    const { customerId } = await seed('large');
    const risk = await fraud.assessRedemptionRisk({
      customerId,
      coins: ruleVersion.otpThresholdCoins,
    });

    expect(risk.requiresStepUp).toBe(true);
    // The control §12.1 asks for and this build cannot perform — surfaced
    // rather than silently absent.
    expect(risk.stepUpUnavailable).toBe(true);
    expect(risk.signals.join(' ')).toMatch(/Large redemption/i);
  });

  it('does not flag an ordinary redemption', async () => {
    const { customerId } = await seed('small');
    const risk = await fraud.assessRedemptionRisk({ customerId, coins: 50 });
    expect(risk.requiresStepUp).toBe(false);
    expect(risk.stepUpUnavailable).toBe(false);
    expect(risk.signals).toHaveLength(0);
  });

  it('assessment alone never refuses a redemption', async () => {
    /*
     * The important negative. §4 permits redeeming up to 100% of product value,
     * and nothing in ZSOP004 says to refuse when verification is unavailable.
     * Blocking here would invent a rule and break ordinary customers, so the
     * assessment returns a decision and stops.
     */
    const { customerId } = await seed('norefuse');
    const risk = await fraud.assessRedemptionRisk({ customerId, coins: 5000 });
    expect(risk.requiresStepUp).toBe(true);
    expect(risk).not.toHaveProperty('blocked');
  });

  it('flags a new device shipping to a previously unused address', async () => {
    const { customerId } = await seed('newdevice');
    const risk = await fraud.assessRedemptionRisk({
      customerId,
      coins: 20,
      pincode: '999999',
      deviceId: 'device-never-seen',
    });
    expect(risk.newDeviceNewAddress).toBe(true);
  });

  it('does not flag a new address without a device marker', async () => {
    // Either signal alone is ordinary — people ship to friends. §12.1 asks for
    // the COMBINATION.
    const { customerId } = await seed('addressonly');
    const risk = await fraud.assessRedemptionRisk({
      customerId,
      coins: 20,
      pincode: '999998',
    });
    expect(risk.newDeviceNewAddress).toBe(false);
  });

  it('does not flag an address the customer has shipped to before', async () => {
    const { customerId } = await seed('knownaddress');
    await prisma.order.create({
      data: {
        orderNo: `${TAG}-known-${Date.now().toString(36)}`,
        customerId,
        email: `${TAG}-known@zewafeeds.test`,
        phone: '+919000000000',
        paymentMethod: PaymentMethod.COD,
        subtotalPaise: 10000,
        totalPaise: 10000,
        shippingAddress: { name: 'K', line1: 'L', city: 'C', state: 'Kerala', pincode: '682001' },
      },
    });

    const risk = await fraud.assessRedemptionRisk({
      customerId,
      coins: 20,
      pincode: '682001',
      deviceId: 'device-new',
    });
    expect(risk.newDeviceNewAddress).toBe(false);
  });
});

describe('§12.1 Monitoring', () => {
  it('counts the exceptions the daily report needs', async () => {
    const negative = await seed('negative');
    await prisma.loyaltyAccount.update({
      where: { id: negative.accountId },
      data: { availableCoins: -30, flaggedDeficit: 200 },
    });

    const report = await fraud.riskReport();
    expect(report.negativeBalances).toBeGreaterThanOrEqual(1);
    expect(report.flaggedDeficits).toBeGreaterThanOrEqual(1);
  });

  it('lists high-return accounts that still hold a balance (§12.1 weekly review)', async () => {
    const { customerId, accountId } = await seed('highreturn', { count: 2, daysAgo: 5 });
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 365);
    await prisma.coinLot.create({
      data: {
        accountId,
        coinsGranted: 500,
        coinsRemaining: 500,
        state: CoinLotState.AVAILABLE,
        sourceType: CoinSourceType.MANUAL,
        expiresAt,
        ruleVersionId: ruleVersion.id,
        claimedAt: new Date(),
      },
    });
    await prisma.loyaltyAccount.update({
      where: { id: accountId },
      data: { availableCoins: 500 },
    });

    const report = await fraud.riskReport();
    // The combination is the signal: returns often AND holds value.
    expect(report.highReturnAccounts.some((a) => a.customerId === customerId)).toBe(true);
  });

  it('compares daily volume against the trailing average without alerting on noise', async () => {
    const volume = await fraud.dailyVolumeCheck();
    expect(volume).toHaveProperty('issuedToday');
    expect(volume).toHaveProperty('issuedAvg7d');
    // A quiet or empty programme must not alert — the floor exists so a
    // programme issuing single digits does not trip on ordinary variation.
    expect(volume.anomalous).toBe(false);
  });
});
