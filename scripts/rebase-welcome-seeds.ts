/**
 * Recalculate the 14 Oct 2026 "Welcome to Zewa Seeds" credits at the standard rate.
 *
 * WHY. That one-off credit was not computed from the earn rule: it topped every
 * customer up to at least 25 Seeds whatever they had spent (₹99 → 25), paid
 * larger spenders about 5% instead of 2%, and was inconsistent between them
 * (₹3,528 → 85, ₹2,431 → 92 on top of 48 already earned). 2,111 Seeds in all,
 * where the earn rule gives 557.
 *
 * THE RULE APPLIED. Every order placed before the welcome credit earns exactly
 * what it would earn at checkout today — computeEarn() on its own lines, the
 * same function earn.service uses, 1 Seed per ₹50 of pre-tax value — unless it
 * already earned Seeds through the program. The welcome credit becomes the sum
 * of those. Orders that took no money (unpaid, cancelled and refunded) earn
 * nothing, matching customers/spend.ts.
 *
 * HOW. The correction is made on the welcome LOT itself — its remainder is
 * reduced (or a new GOODWILL lot is granted when the rule says more is owed) —
 * with a matching ADJUSTMENT ledger row. Balances are derived from lot
 * remainders, so a ledger-only debit (the CMS "adjust" button) would drift and
 * be undone by nightly reconciliation.
 *
 * Seeds already SPENT from a welcome lot are never taken back: a reduction is
 * capped at what is still unspent, and the shortfall is reported. Accounts with
 * Seeds held in a cart are skipped and reported, so a checkout in progress
 * cannot be broken. Customers are NOT emailed.
 *
 * Idempotent: each account's correction carries a fixed ledger key, so a second
 * --apply run is a no-op.
 *
 *   npx tsx scripts/rebase-welcome-seeds.ts                 # dry run, writes the report
 *   npx tsx scripts/rebase-welcome-seeds.ts --apply --actor parthk@zewafeeds.com
 */
import { writeFileSync } from 'node:fs';
import { CoinLotState, CoinReason, CoinSourceType, PrismaClient } from '@prisma/client';
import { computeEarn } from '../src/modules/loyalty/coin-math';
import { linesFromOrderItems } from '../src/modules/loyalty/earn.service';
import { SPEND_ORDER_SELECT, orderSpendPaise } from '../src/modules/customers/spend';
import * as rulesService from '../src/modules/loyalty/rules.service';
import * as ledger from '../src/modules/loyalty/ledger.service';
import * as accountService from '../src/modules/loyalty/account.service';

const WELCOME_NOTE = 'Welcome to Zewa Seeds — thank-you for previous purchases';
const KEY = 'welcome-rebase-v1';

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const actorEmail = args[args.indexOf('--actor') + 1];
const out = args.includes('--out') ? args[args.indexOf('--out') + 1]! : 'welcome-rebase-report.json';

interface Row {
  customer: string;
  email: string;
  welcomeWas: number;
  welcomeShouldBe: number;
  change: number;
  applied: number;
  balanceBefore: number;
  balanceAfter: number;
  orders: { orderNo: string; source: string; paid: number; seeds: number }[];
  note?: string;
}

async function main() {
  const rv = await rulesService.active();
  const rules = rulesService.toCoinRules(rv);

  let actorId: string | null = null;
  if (apply) {
    if (!actorEmail) throw new Error('--apply needs --actor <cms email>, so every change is attributed.');
    const actor = await prisma.cmsUser.findFirst({ where: { email: actorEmail.toLowerCase() }, select: { id: true } });
    if (!actor) throw new Error(`No CMS user ${actorEmail}`);
    actorId = actor.id;
  }

  const grants = await prisma.coinLedger.findMany({
    where: { reason: CoinReason.GOODWILL, note: WELCOME_NOTE },
    select: { accountId: true, coinsDelta: true, lotId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  const rows: Row[] = [];
  for (const g of grants) {
    const account = await prisma.loyaltyAccount.findUniqueOrThrow({
      where: { id: g.accountId },
      select: {
        id: true,
        availableCoins: true,
        lockedCoins: true,
        customer: { select: { firstName: true, lastName: true, email: true } },
      },
    });
    const customerId = (await prisma.loyaltyAccount.findUniqueOrThrow({ where: { id: g.accountId }, select: { customerId: true } })).customerId;

    const earnedOrders = new Set(
      (
        await prisma.coinLedger.findMany({
          where: { accountId: g.accountId, reason: CoinReason.EARN, orderId: { not: null } },
          select: { orderId: true },
        })
      ).map((e) => e.orderId!),
    );

    const orders = await prisma.order.findMany({
      where: { customerId, placedAt: { lt: g.createdAt } },
      orderBy: { placedAt: 'asc' },
      select: {
        ...SPEND_ORDER_SELECT,
        id: true,
        orderNo: true,
        externalSource: true,
        items: {
          select: {
            id: true,
            lineTotalPaise: true,
            taxRatePct: true,
            earnEligible: true,
            coinRedeemable: true,
            allocatedCouponDiscountPaise: true,
          },
        },
      },
    });

    const owed: Row['orders'] = [];
    for (const o of orders) {
      if (earnedOrders.has(o.id)) continue; // already earned through the program
      const paid = orderSpendPaise(o);
      if (paid <= 0) continue;
      const seeds = computeEarn(linesFromOrderItems(o.items), 0, rules).coins;
      owed.push({ orderNo: o.orderNo, source: o.externalSource ?? 'site', paid: paid / 100, seeds });
    }
    const shouldBe = owed.reduce((s, o) => s + o.seeds, 0);
    const change = shouldBe - g.coinsDelta;

    const row: Row = {
      customer: `${account.customer.firstName} ${account.customer.lastName}`.trim(),
      email: account.customer.email,
      welcomeWas: g.coinsDelta,
      welcomeShouldBe: shouldBe,
      change,
      applied: 0,
      balanceBefore: account.availableCoins,
      balanceAfter: account.availableCoins,
      orders: owed,
    };

    if (change === 0) {
      rows.push(row);
      continue;
    }
    if (account.lockedCoins > 0) {
      row.note = 'Skipped: Seeds are held in a cart right now. Re-run later.';
      rows.push(row);
      continue;
    }

    const lot = g.lotId ? await prisma.coinLot.findUnique({ where: { id: g.lotId } }) : null;
    let applied = change;
    if (change < 0) {
      const unspent = lot && lot.state === CoinLotState.AVAILABLE ? lot.coinsRemaining : 0;
      applied = -Math.min(-change, unspent);
      if (applied !== change) {
        row.note = `${-change + applied} of the excess was already spent and is not taken back.`;
      }
    }
    row.applied = applied;
    row.balanceAfter = account.availableCoins + applied;

    if (apply && applied !== 0) {
      const ledgerNote = `Welcome Seeds recalculated at the standard rate (1 Seed per ₹50 of past orders): ${g.coinsDelta} → ${g.coinsDelta + applied}`;
      await prisma.$transaction(async (tx) => {
        await ledger.lockAccount(tx, account.id);
        const key = `${KEY}:${account.id}`;
        if (await tx.coinLedger.findUnique({ where: { idempotencyKey: key }, select: { id: true } })) return;
        const driftBefore = (await ledger.auditAccount(tx, account.id)).drift;

        if (applied < 0) {
          const fresh = await tx.coinLot.findUniqueOrThrow({ where: { id: lot!.id } });
          const remaining = fresh.coinsRemaining + applied;
          if (remaining < 0) throw new Error(`Lot ${fresh.id} changed underneath us`);
          await tx.coinLot.update({
            where: { id: fresh.id },
            data: { coinsRemaining: remaining, state: remaining === 0 ? CoinLotState.REVERSED : fresh.state },
          });
          await ledger.post(
            tx,
            { accountId: account.id, coinsDelta: applied, reason: CoinReason.ADJUSTMENT, idempotencyKey: key, lotId: fresh.id, note: ledgerNote, actorId },
            { coinValuePaise: rv.coinValuePaise },
          );
        } else {
          await accountService.grantLot(tx, {
            accountId: account.id,
            coins: applied,
            ruleVersion: rv,
            sourceType: CoinSourceType.MANUAL,
            reason: CoinReason.GOODWILL,
            idempotencyKey: key,
            note: ledgerNote,
            actorId,
          });
        }
        // Lots and cached balance must move together: the drift after the change
        // must equal the drift before it (zero, for a healthy account), or the
        // whole account's correction rolls back.
        const after = await ledger.auditAccount(tx, account.id);
        if (after.drift.available !== driftBefore.available || after.drift.pending !== driftBefore.pending) {
          throw new Error(`Correction would change drift on ${account.id}: ${JSON.stringify({ driftBefore, after: after.drift })}`);
        }
        // Run from a laptop the database is ~1s a round trip away, so the
        // default 5s interactive-transaction limit is too tight.
      }, { timeout: 60_000, maxWait: 20_000 });
    }
    rows.push(row);
  }

  const totals = {
    customers: rows.length,
    welcomeWas: rows.reduce((s, r) => s + r.welcomeWas, 0),
    welcomeShouldBe: rows.reduce((s, r) => s + r.welcomeShouldBe, 0),
    applied: rows.reduce((s, r) => s + r.applied, 0),
    reduced: rows.filter((r) => r.applied < 0).length,
    increased: rows.filter((r) => r.applied > 0).length,
    unchanged: rows.filter((r) => r.applied === 0 && r.change === 0).length,
    skippedOrCapped: rows.filter((r) => r.note).length,
  };
  writeFileSync(out, JSON.stringify({ mode: apply ? 'APPLIED' : 'DRY RUN', rule: '1 Seed per ₹50 of pre-tax value, per order, for past orders that had not earned Seeds', totals, rows }, null, 2));
  console.log(apply ? 'APPLIED' : 'DRY RUN', JSON.stringify(totals));
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
