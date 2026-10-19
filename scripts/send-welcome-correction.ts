/**
 * Email customers about the welcome-Seeds correction (scripts/rebase-welcome-seeds.ts).
 *
 * Every figure comes from the ledger, not from a report: the balance before is
 * today's available balance with the correction added back, the welcome Seeds
 * now are the corrected lot, and the per-order breakdown is recomputed with the
 * same rule the correction used. A customer whose correction has not been
 * applied is skipped, never emailed.
 *
 * Dry run by default — prints what each customer would be told.
 *
 *   npx tsx scripts/send-welcome-correction.ts                       # dry run, everyone
 *   npx tsx scripts/send-welcome-correction.ts --only a@b.com --send # one customer
 *   npx tsx scripts/send-welcome-correction.ts --send                # everyone
 *
 * Sent through logAndSend, so each email is in the CMS email log against the
 * customer, and resendable from there. Re-running sends again: use --only.
 */
import { CoinReason, PrismaClient } from '@prisma/client';
import { computeEarn } from '../src/modules/loyalty/coin-math';
import { linesFromOrderItems } from '../src/modules/loyalty/earn.service';
import { SPEND_ORDER_SELECT, orderSpendPaise } from '../src/modules/customers/spend';
import * as rulesService from '../src/modules/loyalty/rules.service';
import { accountTemplates } from '../src/integrations/zeptomail/templates';
import { logAndSend } from '../src/modules/emails/email-log.service';
import { env } from '../src/config/env';

const WELCOME_NOTE = 'Welcome to Zewa Seeds — thank-you for previous purchases';
const prisma = new PrismaClient();
const args = process.argv.slice(2);
const send = args.includes('--send');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1]!.toLowerCase() : null;
const inr = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

async function main() {
  const rules = rulesService.toCoinRules(await rulesService.active());
  const coinsUrl = `${env.STOREFRONT_ORIGIN.replace(/\/$/, '')}/account/seeds`;
  const grants = await prisma.coinLedger.findMany({
    where: { reason: CoinReason.GOODWILL, note: WELCOME_NOTE },
    select: { accountId: true, createdAt: true },
  });

  for (const g of grants) {
    const account = await prisma.loyaltyAccount.findUniqueOrThrow({
      where: { id: g.accountId },
      select: { availableCoins: true, customerId: true, customer: { select: { firstName: true, email: true } } },
    });
    if (only && account.customer.email.toLowerCase() !== only) continue;

    const adj = await prisma.coinLedger.findUnique({
      where: { idempotencyKey: `welcome-rebase-v1:${g.accountId}` },
      select: { coinsDelta: true },
    });
    if (!adj) {
      console.log(`SKIP ${account.customer.email}: correction not applied`);
      continue;
    }

    const earned = new Set(
      (
        await prisma.coinLedger.findMany({
          where: { accountId: g.accountId, reason: CoinReason.EARN, orderId: { not: null } },
          select: { orderId: true },
        })
      ).map((e) => e.orderId!),
    );
    const orders = await prisma.order.findMany({
      where: { customerId: account.customerId, placedAt: { lt: g.createdAt } },
      orderBy: { placedAt: 'asc' },
      select: {
        ...SPEND_ORDER_SELECT,
        id: true,
        orderNo: true,
        items: { select: { id: true, lineTotalPaise: true, taxRatePct: true, earnEligible: true, coinRedeemable: true, allocatedCouponDiscountPaise: true } },
      },
    });
    const breakdown = orders
      .filter((o) => !earned.has(o.id) && orderSpendPaise(o) > 0)
      .map((o) => ({ orderNo: o.orderNo, paid: inr(orderSpendPaise(o)), seeds: computeEarn(linesFromOrderItems(o.items), 0, rules).coins }));

    const ctx = {
      firstName: account.customer.firstName || 'there',
      balanceBefore: account.availableCoins - adj.coinsDelta,
      balanceAfter: account.availableCoins,
      orders: breakdown,
      coinsUrl,
    };
    const { subject, html } = accountTemplates['seeds-welcome-corrected'](ctx);
    console.log(`${send ? 'SEND' : 'DRY '} ${account.customer.email}: ${ctx.balanceBefore} → ${ctx.balanceAfter}; ${breakdown.map((b) => `${b.orderNo}=${b.seeds}`).join(', ') || 'no past orders'}`);

    if (send) {
      const r = await logAndSend({
        to: [{ email: account.customer.email, name: account.customer.firstName }],
        subject,
        htmlBody: html,
        reference: `seeds-welcome-corrected-${g.accountId}`,
        template: 'seeds-welcome-corrected',
        customerId: account.customerId,
      });
      console.log(`  → ${r.sent ? 'sent' : 'NOT sent'} (email log ${r.id})`);
    }
  }
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
