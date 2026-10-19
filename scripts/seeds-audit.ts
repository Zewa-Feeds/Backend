/**
 * Zewa Seeds audit — every account checked against the earn rule and the ledger.
 *
 * Read-only by default. Writes a JSON report (--out) and prints a summary.
 *
 *   REDIS_URL=redis://127.0.0.1:1 npx tsx scripts/seeds-audit.ts --out audit.json
 *   ... --fix --actor parthk@zewafeeds.com     # also apply welcome-credit corrections
 *
 * THE RULE (published terms, /zewa-seeds-terms): 1 Seed per full ₹50 of what the
 * customer actually paid for the products — excluding GST, AFTER any coupon or
 * promotional discount and after Seeds used on the order; shipping never earns.
 *
 * CHECKS
 *   A. drift        — cached balances agree with the lots they are derived from
 *   B. order earn   — each order's grant equals computeEarn() on its own lines
 *   C. welcome      — the 14 Oct welcome credit equals the rule applied to the
 *                     customer's pre-programme orders, coupon INCLUDED. Those
 *                     orders predate per-line discount allocation, so the order's
 *                     discount is spread across its lines here (pro rata, as
 *                     checkout does) — the first correction missed this and
 *                     credited before-coupon value.
 *   D. stuck pending — PENDING lots whose unlock date has passed
 *   E. holds        — Seeds locked with no live cart reservation behind them
 *   F. state        — negative balances, deficits, frozen accounts
 *   G. above rule   — credited Seeds above what lifetime spend could earn, with
 *                     every manual grant listed so a deliberate one is obvious
 *
 * --fix only ever corrects C, the same way rebase-welcome-seeds.ts did: the
 * welcome lot's remainder moves with a matching ADJUSTMENT row (or a GOODWILL lot
 * for a shortfall), drift must be unchanged, Seeds already spent are never taken
 * back, accounts with Seeds held in a cart are skipped, nobody is emailed.
 * Everything else is reported for a decision.
 */
import { writeFileSync } from 'node:fs';
import { CoinLotState, CoinReason, CoinSourceType, PrismaClient } from '@prisma/client';
import { computeEarn, type CoinLine } from '../src/modules/loyalty/coin-math';
import { linesFromOrderItems } from '../src/modules/loyalty/earn.service';
import { SPEND_ORDER_SELECT, orderSpendPaise, totalSpendPaise } from '../src/modules/customers/spend';
import * as rulesService from '../src/modules/loyalty/rules.service';
import * as ledger from '../src/modules/loyalty/ledger.service';
import * as accountService from '../src/modules/loyalty/account.service';

const WELCOME_NOTE = 'Welcome to Zewa Seeds — thank-you for previous purchases';
const FIX_KEY = 'welcome-rebase-v2';
const CREDIT_REASONS: CoinReason[] = [
  CoinReason.EARN, CoinReason.VOID, CoinReason.CLAWBACK, CoinReason.GUEST_CLAIM,
  CoinReason.LAUNCH_BACKFILL, CoinReason.GOODWILL, CoinReason.ADJUSTMENT, CoinReason.MERGE,
];

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const fix = args.includes('--fix');
const actorEmail = args.includes('--actor') ? args[args.indexOf('--actor') + 1] : undefined;
const out = args.includes('--out') ? args[args.indexOf('--out') + 1]! : 'seeds-audit.json';

const ITEM_SELECT = {
  id: true, lineTotalPaise: true, taxRatePct: true, earnEligible: true,
  coinRedeemable: true, allocatedCouponDiscountPaise: true,
} as const;

/**
 * Lines with the order's discount spread across them when the order predates
 * per-line allocation (every line 0 but the order has a discount). Pro rata by
 * line value; the rounding remainder goes to the largest line, as checkout does.
 */
function linesWithDiscount(
  items: Parameters<typeof linesFromOrderItems>[0],
  orderDiscountPaise: number,
): CoinLine[] {
  const lines = linesFromOrderItems(items);
  const allocated = lines.reduce((s, l) => s + l.couponDiscountPaise, 0);
  if (allocated > 0 || orderDiscountPaise <= 0) return lines;
  const total = lines.reduce((s, l) => s + l.lineTotalPaise, 0);
  if (total <= 0) return lines;
  let given = 0;
  const outLines = lines.map((l) => {
    const share = Math.floor((orderDiscountPaise * l.lineTotalPaise) / total);
    given += share;
    return { ...l, couponDiscountPaise: share };
  });
  const largest = outLines.reduce((a, b) => (b.lineTotalPaise > a.lineTotalPaise ? b : a));
  largest.couponDiscountPaise += Math.min(orderDiscountPaise, total) - given;
  return outLines;
}

async function main() {
  const rv = await rulesService.active();
  const rules = rulesService.toCoinRules(rv);
  const now = new Date();

  let actorId: string | null = null;
  if (fix) {
    if (!actorEmail) throw new Error('--fix needs --actor <cms email>');
    const actor = await prisma.cmsUser.findFirst({ where: { email: actorEmail.toLowerCase() }, select: { id: true } });
    if (!actor) throw new Error(`No CMS user ${actorEmail}`);
    actorId = actor.id;
  }

  // Bulk loads — one round trip each, not one per account.
  const accounts = await prisma.loyaltyAccount.findMany({
    select: {
      id: true, customerId: true, availableCoins: true, pendingCoins: true, lockedCoins: true,
      lifetimeEarned: true, flaggedDeficit: true, status: true,
      customer: { select: { firstName: true, lastName: true, email: true } },
    },
  });
  const ledgerRows = await prisma.coinLedger.findMany({
    select: { accountId: true, reason: true, coinsDelta: true, note: true, orderId: true, lotId: true, idempotencyKey: true, createdAt: true },
  });
  const lots = await prisma.coinLot.findMany({
    select: { id: true, accountId: true, state: true, coinsGranted: true, coinsRemaining: true, maturesAt: true, sourceType: true, orderId: true },
  });
  const orderLoyalty = await prisma.orderLoyalty.findMany({
    select: { orderId: true, accountId: true, coinsGrantedCurrent: true, coinsRedeemed: true, grantState: true },
  });
  const reservations = await prisma.coinReservation.groupBy({
    by: ['accountId'], where: { status: 'PENDING' }, _sum: { coins: true },
  });
  const orders = await prisma.order.findMany({
    where: { customerId: { in: accounts.map((a) => a.customerId) } },
    select: { ...SPEND_ORDER_SELECT, id: true, orderNo: true, customerId: true, placedAt: true, discountPaise: true, items: { select: ITEM_SELECT } },
  });

  const byAccount = <T extends { accountId: string | null }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) if (r.accountId) (m.get(r.accountId) ?? m.set(r.accountId, []).get(r.accountId)!).push(r);
    return m;
  };
  const ledgerBy = byAccount(ledgerRows);
  const lotsBy = byAccount(lots);
  const olBy = byAccount(orderLoyalty);
  const heldBy = new Map(reservations.map((r) => [r.accountId, r._sum.coins ?? 0]));
  const ordersBy = new Map<string, typeof orders>();
  for (const o of orders) if (o.customerId) (ordersBy.get(o.customerId) ?? ordersBy.set(o.customerId, []).get(o.customerId)!).push(o);
  const orderById = new Map(orders.map((o) => [o.id, o]));

  const findings: Record<string, unknown[]> = { drift: [], orderEarn: [], welcome: [], stuckPending: [], holds: [], state: [], aboveRule: [] };
  const fixes: unknown[] = [];

  for (const a of accounts) {
    const who = `${`${a.customer.firstName} ${a.customer.lastName}`.trim()} <${a.customer.email}>`;
    const led = ledgerBy.get(a.id) ?? [];
    const myLots = lotsBy.get(a.id) ?? [];
    const myOrders = ordersBy.get(a.customerId) ?? [];

    // A. drift — derived from lots, compared with the cache.
    let avail = 0, pend = 0;
    for (const l of myLots) {
      if (l.state === CoinLotState.AVAILABLE) avail += l.coinsRemaining;
      else if (l.state === CoinLotState.PENDING) pend += l.coinsRemaining;
    }
    const held = heldBy.get(a.id) ?? 0;
    if (avail - held !== a.availableCoins || pend !== a.pendingCoins) {
      findings.drift!.push({ who, cached: { available: a.availableCoins, pending: a.pendingCoins }, fromLots: { available: avail - held, pending: pend } });
    }

    // B. each programme order's grant.
    for (const ol of olBy.get(a.id) ?? []) {
      const o = orderById.get(ol.orderId);
      if (!o) continue;
      const expected = computeEarn(linesFromOrderItems(o.items), ol.coinsRedeemed, rules).coins;
      const voided = ol.grantState === CoinLotState.VOID || ol.grantState === CoinLotState.REVERSED;
      if (!voided && expected !== ol.coinsGrantedCurrent) {
        findings.orderEarn!.push({ who, order: o.orderNo, granted: ol.coinsGrantedCurrent, expected, status: o.status });
      }
    }

    // C. welcome credit, coupon-aware.
    const grant = led.find((l) => l.reason === CoinReason.GOODWILL && l.note === WELCOME_NOTE);
    if (grant) {
      const earnedOrders = new Set(led.filter((l) => l.reason === CoinReason.EARN && l.orderId).map((l) => l.orderId!));
      const breakdown = myOrders
        .filter((o) => o.placedAt < grant.createdAt && !earnedOrders.has(o.id) && orderSpendPaise(o) > 0)
        .map((o) => ({ orderNo: o.orderNo, seeds: computeEarn(linesWithDiscount(o.items, o.discountPaise), 0, rules).coins }));
      const shouldBe = breakdown.reduce((s, b) => s + b.seeds, 0);
      const corrections = led.filter((l) => l.idempotencyKey.startsWith(`welcome-rebase-v1:`) || l.idempotencyKey.startsWith(`${FIX_KEY}:`));
      const now_ = grant.coinsDelta + corrections.reduce((s, c) => s + c.coinsDelta, 0);
      if (now_ !== shouldBe) {
        const row = { who, welcomeNow: now_, shouldBe, change: shouldBe - now_, breakdown, applied: 0, note: '' };
        findings.welcome!.push(row);

        if (fix) {
          const lot = myLots.find((l) => l.id === grant.lotId);
          const key = `${FIX_KEY}:${a.id}`;
          if (a.lockedCoins > 0 || held > 0) row.note = 'skipped: Seeds held in a cart';
          else if (led.some((l) => l.idempotencyKey === key)) row.note = 'already corrected';
          else {
            let applied = row.change;
            if (applied < 0) {
              const unspent = lot && lot.state === CoinLotState.AVAILABLE ? lot.coinsRemaining : 0;
              applied = -Math.min(-applied, unspent);
              if (applied !== row.change) row.note = `${applied - row.change} already spent, not taken back`;
            }
            const ledgerNote = `Welcome Seeds recalculated after coupon discounts (1 Seed per ₹50 actually paid): ${now_} → ${now_ + applied}`;
            if (applied !== 0) {
              await prisma.$transaction(async (tx) => {
                await ledger.lockAccount(tx, a.id);
                const before = (await ledger.auditAccount(tx, a.id)).drift;
                if (applied < 0) {
                  const fresh = await tx.coinLot.findUniqueOrThrow({ where: { id: lot!.id } });
                  const remaining = fresh.coinsRemaining + applied;
                  if (remaining < 0) throw new Error(`lot ${fresh.id} changed underneath`);
                  await tx.coinLot.update({ where: { id: fresh.id }, data: { coinsRemaining: remaining, state: remaining === 0 ? CoinLotState.REVERSED : fresh.state } });
                  await ledger.post(tx, { accountId: a.id, coinsDelta: applied, reason: CoinReason.ADJUSTMENT, idempotencyKey: key, lotId: fresh.id, note: ledgerNote, actorId }, { coinValuePaise: rv.coinValuePaise });
                } else {
                  await accountService.grantLot(tx, { accountId: a.id, coins: applied, ruleVersion: rv, sourceType: CoinSourceType.MANUAL, reason: CoinReason.GOODWILL, idempotencyKey: key, note: ledgerNote, actorId });
                }
                const after = (await ledger.auditAccount(tx, a.id)).drift;
                if (after.available !== before.available || after.pending !== before.pending) throw new Error(`drift changed on ${a.id}`);
              }, { timeout: 60_000, maxWait: 20_000 });
            }
            row.applied = applied;
            fixes.push({ who, from: now_, to: now_ + applied });
          }
        }
      }
    }

    // D. pending lots past their unlock date.
    for (const l of myLots) {
      if (l.state === CoinLotState.PENDING && l.maturesAt && l.maturesAt < now) {
        findings.stuckPending!.push({ who, lotCoins: l.coinsRemaining, maturedAt: l.maturesAt, order: l.orderId ? orderById.get(l.orderId)?.orderNo : null });
      }
    }

    // E. holds with no reservation behind them.
    if (a.lockedCoins !== held) findings.holds!.push({ who, lockedCoins: a.lockedCoins, liveReservations: held });

    // F. account state.
    if (a.availableCoins < 0 || a.flaggedDeficit > 0 || a.status !== 'ACTIVE') {
      findings.state!.push({ who, available: a.availableCoins, deficit: a.flaggedDeficit, status: a.status });
    }

    // G. credited vs what lifetime spend could earn.
    const credited = led.filter((l) => CREDIT_REASONS.includes(l.reason)).reduce((s, l) => s + l.coinsDelta, 0);
    const spent = totalSpendPaise(myOrders);
    const ruleMax = Math.floor(spent / 5000);
    if (credited > ruleMax + 2) {
      const manual = led
        .filter((l) => (l.reason === CoinReason.GOODWILL || l.reason === CoinReason.ADJUSTMENT) && l.note !== WELCOME_NOTE && !l.idempotencyKey.startsWith('welcome-rebase'))
        .map((l) => `${l.coinsDelta > 0 ? '+' : ''}${l.coinsDelta} "${l.note ?? ''}"`);
      findings.aboveRule!.push({ who, spent: spent / 100, ruleMax, credited, manualGrants: manual });
    }
  }

  const summary = Object.fromEntries(Object.entries(findings).map(([k, v]) => [k, v.length]));
  writeFileSync(out, JSON.stringify({ at: now.toISOString(), mode: fix ? 'FIX' : 'AUDIT', accounts: accounts.length, summary, fixes, findings }, null, 2));
  console.log(fix ? 'FIX' : 'AUDIT', JSON.stringify({ accounts: accounts.length, ...summary, fixesApplied: fixes.length }));
}

main()
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
