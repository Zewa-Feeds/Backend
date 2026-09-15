/**
 * Coin notifications — ZSOP004 §4.3, §10.3, §10.4, §13.5.
 *
 * The behaviour under test is IDEMPOTENCY. §9.1: "Assume every event arrives at
 * least twice." A duplicate payment webhook must not send a second "your coins
 * are ready"; a replayed return event must not tell a customer twice that their
 * balance changed. Mail cannot be un-sent, so this is the one place where a
 * duplicate is permanently visible to the customer.
 *
 * The mailer is stubbed so the assertions are about WHICH messages were
 * attempted, not about the mail provider.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const sent: { to: string; template: string; context: Record<string, unknown> }[] = [];

vi.mock('@/modules/customers/account.mailer', () => ({
  sendAccountEmail: (to: string, template: string, context: Record<string, unknown>) => {
    sent.push({ to, template, context });
  },
}));

import { PrismaClient, CoinLotState, CoinSourceType } from '@prisma/client';
import * as notify from './notify.service';
import * as account from './account.service';
import * as rules from './rules.service';

const prisma = new PrismaClient();
const TAG = 'zznotify';
let ruleVersion: Awaited<ReturnType<typeof rules.active>>;

async function sweep() {
  const customers = await prisma.customer.findMany({
    where: { email: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = customers.map((c) => c.id);
  if (!ids.length) return;
  const accounts = await prisma.loyaltyAccount.findMany({
    where: { customerId: { in: ids } },
    select: { id: true },
  });
  const accIds = accounts.map((a) => a.id);
  if (accIds.length) {
    await prisma.$executeRawUnsafe('ALTER TABLE "CoinLedger" DISABLE TRIGGER coin_ledger_no_delete');
    await prisma.coinLedger.deleteMany({ where: { accountId: { in: accIds } } });
    await prisma.$executeRawUnsafe('ALTER TABLE "CoinLedger" ENABLE TRIGGER coin_ledger_no_delete');
    await prisma.coinLot.deleteMany({ where: { accountId: { in: accIds } } });
    await prisma.loyaltyAccount.deleteMany({ where: { id: { in: accIds } } });
  }
  await prisma.customer.deleteMany({ where: { id: { in: ids } } });
}

async function seed(label: string, opts: { holdout?: boolean } = {}) {
  const customer = await prisma.customer.create({
    data: {
      email: `${TAG}-${label}-${Date.now()}${Math.random().toString(36).slice(2, 5)}@zewafeeds.test`,
      firstName: 'Nina',
      lastName: 'Notify',
    },
    select: { id: true, email: true },
  });
  const acc = await prisma.$transaction((tx) => account.ensureAccount(tx, customer.id));
  /*
   * Opt this fixture OUT of the holdout.
   *
   * `ensureAccount` assigns the holdout deterministically from a hash of the
   * customer id (§13.5), so ~5% of randomly generated UUIDs land in it and
   * correctly earn nothing. Left alone, a couple of fixtures per run silently
   * become control-group accounts and whichever test owns them fails — which is
   * why the failure appeared to move between tests on every run.
   *
   * Holdout behaviour itself is covered explicitly in concurrency.test.ts.
   */
  await prisma.loyaltyAccount.update({ where: { id: acc.id }, data: { holdout: false } });
  if (opts.holdout) {
    await prisma.loyaltyAccount.update({ where: { id: acc.id }, data: { holdout: true } });
  }
  return { customerId: customer.id, accountId: acc.id, email: customer.email };
}

async function makeLot(accountId: string, coins: number, expiresInDays = 365) {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + expiresInDays);
  return prisma.coinLot.create({
    data: {
      accountId,
      coinsGranted: coins,
      coinsRemaining: coins,
      state: CoinLotState.AVAILABLE,
      sourceType: CoinSourceType.MANUAL,
      expiresAt,
      ruleVersionId: ruleVersion.id,
      claimedAt: new Date(),
    },
    select: { id: true, expiresAt: true },
  });
}

beforeAll(async () => {
  await sweep();
  ruleVersion = await rules.active(prisma);
});

/**
 * Messages sent to ONE specific address.
 *
 * Not "messages since this test started": `sendAccountEmail` is fire-and-forget,
 * so a push from a neighbouring test can land at any moment and a positional
 * window is inherently racy. Every seeded customer gets a unique address, so
 * filtering on the recipient is exact regardless of timing.
 */
function to(email: string) {
  return sent.filter((m) => m.to === email);
}

afterAll(async () => {
  await sweep();
  await prisma.$disconnect();
});

describe('The ONE coins-earned email', () => {
  /**
   * Build the notice `onDelivered` hands back, with a maturity date the caller
   * would have computed from the order's own rule version.
   */
  function notice(accountId: string, coins: number, holdDays: number) {
    const deliveredAt = new Date();
    const maturesAt = new Date(deliveredAt);
    maturesAt.setDate(maturesAt.getDate() + holdDays);
    return {
      accountId,
      orderId: `order-${Math.random().toString(36).slice(2, 9)}`,
      orderNo: 'ZW-TEST-1',
      coins,
      maturesAt,
      deliveredAt,
    };
  }

  it('names the coins earned, the spendable balance, and when the new coins land', async () => {
    const { accountId, email } = await seed('earned');
    // 40 coins already spendable from an earlier order.
    await makeLot(accountId, 40);
    await prisma.loyaltyAccount.update({
      where: { id: accountId },
      data: { availableCoins: 40 },
    });

    await notify.notifyEarned(notice(accountId, 24, 7));

    const msgs = to(email);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.template).toBe('coins-earned');
    expect(msgs[0]!.context.coins).toBe(24);
    /*
     * The balance EXCLUDES the 24 just earned — they are still pending. Showing
     * 64 would tell the customer they can spend money they cannot, and is the
     * "two rewards" confusion in numeric form.
     */
    expect(msgs[0]!.context.availableCoins).toBe(40);
    expect(String(msgs[0]!.context.coinsUrl)).toMatch(/\/account\/coins$/);
  });

  it('uses the ORDINARY 7-day window on a normal order', async () => {
    const { accountId, email } = await seed('earned-normal');
    await notify.notifyEarned(notice(accountId, 20, 7));
    expect(to(email)[0]!.context.unlockDays).toBe(7);
  });

  it('uses the LONGER window when a large-order hold applies (§3.5)', async () => {
    /*
     * The timing is derived from `maturesAt`, which `onDelivered` computes from
     * the order's frozen rule version — so an order above the large-order
     * threshold reports 21 days here without this function knowing the
     * threshold, the hold, or the order value.
     */
    const { accountId, email } = await seed('earned-large');
    await notify.notifyEarned(notice(accountId, 400, 21));
    expect(to(email)[0]!.context.unlockDays).toBe(21);
  });

  it('a replayed delivery event does not send twice (§9.1)', async () => {
    const { accountId, email } = await seed('earned-dup');
    const n = notice(accountId, 24, 7);

    await notify.notifyEarned(n);
    await notify.notifyEarned(n);
    await notify.notifyEarned(n);

    expect(to(email)).toHaveLength(1);
  });

  it('concurrent deliveries of the same event send once', async () => {
    const { accountId, email } = await seed('earned-race');
    const n = notice(accountId, 50, 7);

    await Promise.all([
      notify.notifyEarned(n),
      notify.notifyEarned(n),
      notify.notifyEarned(n),
    ]);

    /*
     * Assert on the CLAIM, not the mock: `sendAccountEmail` is fire-and-forget,
     * so a push can land after `Promise.all` resolves. The claim row is what
     * actually decides whether a message may be sent.
     */
    const claims = await prisma.coinLedger.count({
      where: { idempotencyKey: `notify-earned:${n.orderId}` },
    });
    expect(claims).toBe(1);
    expect(to(email).length).toBeLessThanOrEqual(1);
  });

  it('sends nothing for a holdout customer (§13.5)', async () => {
    const { accountId, email } = await seed('earned-holdout', { holdout: true });
    await notify.notifyEarned(notice(accountId, 40, 7));
    expect(to(email)).toHaveLength(0);
  });

  it('sends nothing when the order earned no coins', async () => {
    const { accountId, email } = await seed('earned-zero');
    await notify.notifyEarned(notice(accountId, 0, 7));
    expect(to(email)).toHaveLength(0);
  });

  it('never says "wallet" — §10.3 forbids it (§12.2 legal boundary)', async () => {
    /*
     * "wallet" implies stored value the customer owns and could withdraw. §12.2
     * rests the RBI prepaid-instrument analysis on coins NOT reading that way,
     * so this is a legal constraint on copy, not a style preference.
     *
     * Asserted on the rendered HTML rather than the context, because the phrase
     * lives in the template and would not show up in the arguments.
     */
    const { accountId, email } = await seed('earned-copy');
    await notify.notifyEarned(notice(accountId, 24, 7));

    const msgs = to(email);
    expect(msgs).toHaveLength(1);
    const { accountTemplates } = await import('@/integrations/zeptomail/templates');
    const rendered = accountTemplates['coins-earned'](
      msgs[0]!.context as Parameters<typeof accountTemplates['coins-earned']>[0],
    );
    expect(rendered.html.toLowerCase()).not.toContain('wallet');
    expect(rendered.html).toContain('Zewa Coins balance');
  });

  it('there is NO separate unlocked email', () => {
    // The whole point of the change: one message per grant, not two. A second
    // email when the coins actually unlock would read as a second reward.
    expect('notifyUnlocked' in notify).toBe(false);
  });
});

describe('§4.3 The single expiry reminder', () => {
  it('warns 7 days out and names the date', async () => {
    const { accountId, email } = await seed('expiry');
    const lot = await makeLot(accountId, 200, 7);

    await notify.sendExpiryReminders();

    const msgs = to(email);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.template).toBe('coins-expiring');
    expect(String(msgs[0]!.context.expiresOn)).toMatch(/\d/);
    expect(lot.expiresAt).toBeInstanceOf(Date);
  });

  it('does not remind twice about the same lot', async () => {
    const { accountId, email } = await seed('expiry-dup');
    await makeLot(accountId, 321, 7);

    await notify.sendExpiryReminders();
    await notify.sendExpiryReminders();

    expect(to(email)).toHaveLength(1);
  });

  it('stays silent about a lot with no coins left (§4.3)', async () => {
    // "reminding someone about coins they cannot use is worse than silence"
    const { accountId, email } = await seed('expiry-empty');
    const lot = await makeLot(accountId, 100, 7);
    await prisma.coinLot.update({
      where: { id: lot.id },
      data: { coinsRemaining: 0, state: CoinLotState.REDEEMED },
    });

    await notify.sendExpiryReminders();
    expect(to(email)).toHaveLength(0);
  });

  it('does not warn about a lot expiring far in the future', async () => {
    const { accountId, email } = await seed('expiry-far');
    await makeLot(accountId, 777, 90);

    await notify.sendExpiryReminders();
    expect(to(email)).toHaveLength(0);
  });

  it('there is no 30-day reminder — it was removed in review (§4.3)', async () => {
    const { accountId, email } = await seed('expiry-30');
    await makeLot(accountId, 555, 30);

    await notify.sendExpiryReminders();
    expect(to(email)).toHaveLength(0);
  });
});

describe('§10.4 Post-return adjustment', () => {
  it('reports the two movements separately, never netted (§7.2)', async () => {
    const { accountId, email } = await seed('adjusted');

    await notify.notifyAdjusted(accountId, `${TAG}-evt-1`, {
      orderNo: 'ZW-TEST-1',
      orderId: 'order-1',
      restored: 84,
      clawedBack: 15,
    });

    const msgs = to(email);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.template).toBe('coins-adjusted');
    // §6.5's worked example: +84 back, −15 adjusted. Reported as two figures
    // because they are computed independently — netting to +69 is exactly the
    // confusion §7.2 warns about.
    expect(msgs[0]!.context.restored).toBe(84);
    expect(msgs[0]!.context.clawedBack).toBe(15);
  });

  it('a replayed return event does not send twice (§7.7)', async () => {
    const { accountId, email } = await seed('adjusted-dup');
    const evt = `${TAG}-evt-dup`;

    await notify.notifyAdjusted(accountId, evt, {
      orderNo: 'ZW-TEST-2',
      orderId: 'order-2',
      restored: 50,
      clawedBack: 10,
    });
    await notify.notifyAdjusted(accountId, evt, {
      orderNo: 'ZW-TEST-2',
      orderId: 'order-2',
      restored: 50,
      clawedBack: 10,
    });

    expect(to(email)).toHaveLength(1);
  });

  it('separate return events on one order each get their own message (§8.2 #19)', async () => {
    const { accountId, email } = await seed('adjusted-multi');

    await notify.notifyAdjusted(accountId, `${TAG}-ret-a`, {
      orderNo: 'ZW-TEST-3',
      orderId: 'order-3',
      restored: 20,
      clawedBack: 5,
    });
    await notify.notifyAdjusted(accountId, `${TAG}-ret-b`, {
      orderNo: 'ZW-TEST-3',
      orderId: 'order-3',
      restored: 30,
      clawedBack: 8,
    });

    // Keyed on the EVENT, not the order — multiple sequential partial returns
    // each deserve a message.
    expect(to(email)).toHaveLength(2);
  });

  it('sends nothing when neither figure moved', async () => {
    const { accountId, email } = await seed('adjusted-noop');
    await notify.notifyAdjusted(accountId, `${TAG}-evt-noop`, {
      orderNo: 'ZW-TEST-4',
      orderId: 'order-4',
      restored: 0,
      clawedBack: 0,
    });
    expect(to(email)).toHaveLength(0);
  });
});

describe('§10.3 Language rules', () => {
  it('the claim row records what was sent, in the ledger', async () => {
    const { accountId } = await seed('audit');
    const orderId = `order-audit-${Math.random().toString(36).slice(2, 9)}`;
    const deliveredAt = new Date();
    const maturesAt = new Date(deliveredAt);
    maturesAt.setDate(maturesAt.getDate() + 7);

    await notify.notifyEarned({
      accountId,
      orderId,
      orderNo: 'ZW-TEST-AUDIT',
      coins: 12,
      maturesAt,
      deliveredAt,
    });

    const row = await prisma.coinLedger.findUniqueOrThrow({
      where: { idempotencyKey: `notify-earned:${orderId}` },
    });
    // A zero delta: this records that a MESSAGE was sent, not that coins moved,
    // so it must never change a balance.
    expect(row.coinsDelta).toBe(0);
    expect(row.note).toMatch(/Notification sent/i);
  });
});
