// READ-ONLY verification of the welcome rebase.
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import * as ledger from '../src/modules/loyalty/ledger.service';
const p = new PrismaClient();
(async () => {
  const plan = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
  const should = new Map<string, number>(plan.rows.map((r: any) => [r.email.toLowerCase(), r.welcomeShouldBe]));
  const grants = await p.coinLedger.findMany({ where: { reason: 'GOODWILL', note: 'Welcome to Zewa Seeds — thank-you for previous purchases' }, select: { accountId: true, lotId: true, coinsDelta: true } });
  let ok = 0, bad: string[] = [], adjSum = 0, adjCount = 0, driftBad: string[] = [];
  for (const g of grants) {
    const acc = await p.loyaltyAccount.findUniqueOrThrow({ where: { id: g.accountId }, select: { customer: { select: { email: true } } } });
    const lot = await p.coinLot.findUniqueOrThrow({ where: { id: g.lotId! }, select: { coinsRemaining: true, coinsGranted: true, state: true } });
    const adj = await p.coinLedger.findUnique({ where: { idempotencyKey: `welcome-rebase-v1:${g.accountId}` }, select: { coinsDelta: true } });
    if (adj) { adjSum += adj.coinsDelta; adjCount++; }
    const want = should.get(acc.customer.email.toLowerCase());
    if (lot.coinsRemaining === want) ok++; else bad.push(`${acc.customer.email}: lot ${lot.coinsRemaining} want ${want}`);
    const a = await p.$transaction((tx) => ledger.auditAccount(tx, g.accountId), { timeout: 60000, maxWait: 20000 });
    if (!a.clean) driftBad.push(`${acc.customer.email} ${JSON.stringify(a.drift)}`);
  }
  console.log({ grants: grants.length, lotsAtTarget: ok, adjustments: adjCount, adjustmentSum: adjSum, mismatches: bad, drift: driftBad });
  await p.$disconnect();
})();
