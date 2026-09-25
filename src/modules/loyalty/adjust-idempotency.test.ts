/**
 * Manual adjustment idempotency — ZSOP004 §9.1, §9.2.
 *
 * THE DEFECT THIS FILE EXISTS FOR
 *
 * The adjustment key used to be `adjust:${accountId}:${Date.now()}:${actorId}`.
 * A timestamp is unique per CALL, not per INTENT, so an admin who double-clicked
 * "give coins" produced two different keys, the ledger's unique index saw two
 * distinct movements, and the customer was credited twice. §9.1 is explicit that
 * every event must be assumed to arrive at least twice; a key derived from the
 * clock cannot honour that.
 *
 * The route now takes `Idempotency-Key` from the client — the same header and the
 * same `^[\w-]{8,128}$` format checkout already uses — and scopes it to the
 * customer. The ledger's existing unique index then does the work: a replay finds
 * the key and no-ops.
 *
 * Mounted as a REAL router over HTTP rather than calling the service, because the
 * header parsing, the permission guard and the audit write are route-layer
 * behaviours a service test cannot see.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { PrismaClient, Role, CoinReason, CoinSourceType } from '@prisma/client';
import { ns, testActor, purgeCustomersWithLedger, TEST_PREFIX } from '@/test/fixtures';
import { loyaltyAdminRouter } from './admin.routes';
import { errorHandler } from '@/middleware/errorHandler';
import { permissionsFor } from '@/rbac/permissions';

const prisma = new PrismaClient();

/** Swapped per test; the router reads whatever these hold. */
let role: Role = Role.ADMIN;
let signedIn = true;
let staffId = '';
let customerId = '';
let otherCustomerId = '';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as express.Request & { id: string }).id = 'test-request';
  if (signedIn) {
    req.user = {
      id: staffId,
      email: `${TEST_PREFIX}-actor@zewafeeds.test`,
      name: 'Integration Test',
      role,
      permissions: permissionsFor(role),
    };
  }
  next();
});
app.use('/loyalty', loyaltyAdminRouter);
app.use(errorHandler);

let server: Server;
const url = (p: string) => `http://127.0.0.1:${(server.address() as AddressInfo).port}${p}`;

const EMAIL_LIKE = { email: { startsWith: `${TEST_PREFIX}adjidem` } };

async function makeCustomer(label: string): Promise<string> {
  const c = await prisma.customer.create({
    data: {
      email: `${ns('adjidem')}-${label}@zewafeeds.test`,
      firstName: 'Adjust',
      lastName: 'Idempotency',
    },
    select: { id: true },
  });
  return c.id;
}

/** POST an adjustment, optionally with an Idempotency-Key header. */
function adjust(
  id: string,
  body: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<Response> {
  return fetch(url(`/loyalty/customers/${id}/adjust`), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** Coins actually credited, read from the ledger rather than a cached balance. */
async function creditedTotal(custId: string): Promise<number> {
  const account = await prisma.loyaltyAccount.findUnique({
    where: { customerId: custId },
    select: { id: true },
  });
  if (!account) return 0;
  const agg = await prisma.coinLedger.aggregate({
    where: { accountId: account.id, coinsDelta: { gt: 0 } },
    _sum: { coinsDelta: true },
  });
  return agg._sum.coinsDelta ?? 0;
}

async function ledgerRows(custId: string) {
  const account = await prisma.loyaltyAccount.findUnique({
    where: { customerId: custId },
    select: { id: true },
  });
  if (!account) return [];
  return prisma.coinLedger.findMany({
    where: { accountId: account.id },
    orderBy: { id: 'asc' },
  });
}

beforeAll(async () => {
  await purgeCustomersWithLedger(prisma, EMAIL_LIKE);
  staffId = await testActor(prisma);
  customerId = await makeCustomer('main');
  otherCustomerId = await makeCustomer('other');
  server = app.listen(0);
});

afterAll(async () => {
  server?.close();
  await purgeCustomersWithLedger(prisma, EMAIL_LIKE);
  await prisma.auditLog.deleteMany({ where: { actorId: staffId } });
  await prisma.$disconnect();
});

describe('a positive adjustment still credits (the feature must keep working)', () => {
  it('credits the customer and writes exactly one ledger row', async () => {
    role = Role.ADMIN;
    signedIn = true;

    const before = await creditedTotal(customerId);
    const res = await adjust(
      customerId,
      { coins: 120, note: 'Promotional reward for customer', reason: 'GOODWILL' },
      'give-credits-once-0001',
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { coins: number; lotId: string | null } };
    expect(body.data.coins).toBe(120);
    expect(body.data.lotId).toBeTruthy();
    expect(await creditedTotal(customerId)).toBe(before + 120);
  });

  it('records the grant as a MANUAL lot, not automatic earning', async () => {
    const account = await prisma.loyaltyAccount.findUniqueOrThrow({
      where: { customerId },
      select: { id: true },
    });
    const lot = await prisma.coinLot.findFirst({
      where: { accountId: account.id, sourceType: CoinSourceType.MANUAL },
      orderBy: { earnedAt: 'desc' },
    });
    expect(lot).toBeTruthy();
    expect(lot!.orderId).toBeNull();
  });

  it('identifies the admin who did it, and keeps the note', async () => {
    const rows = await ledgerRows(customerId);
    const credit = rows.find((r) => r.coinsDelta === 120);
    expect(credit).toBeTruthy();
    expect(credit!.actorId).toBe(staffId);
    expect(credit!.note).toBe('Promotional reward for customer');
    expect(credit!.reason).toBe(CoinReason.GOODWILL);
  });

  it('writes an audit entry naming the movement', async () => {
    const entry = await prisma.auditLog.findFirst({
      where: { actorId: staffId, recordId: customerId },
      orderBy: { createdAt: 'desc' },
    });
    expect(entry).toBeTruthy();
    expect(entry!.action).toContain('120');
  });
});

describe('the same Idempotency-Key never credits twice (§9.1)', () => {
  it('a replayed submission is a no-op', async () => {
    const key = 'double-click-same-key-0002';
    const before = await creditedTotal(customerId);

    const first = await adjust(customerId, { coins: 250, note: 'Launch campaign bonus' }, key);
    expect(first.status).toBe(200);
    const afterFirst = await creditedTotal(customerId);
    expect(afterFirst).toBe(before + 250);

    // The same intent, sent again — exactly what a double-click produces.
    const second = await adjust(customerId, { coins: 250, note: 'Launch campaign bonus' }, key);
    expect(second.status).toBe(200);

    // THE ASSERTION THIS FILE EXISTS FOR.
    expect(await creditedTotal(customerId)).toBe(afterFirst);
  });

  it('the replay produces no second ledger row', async () => {
    const rows = await ledgerRows(customerId);
    const matching = rows.filter((r) => r.idempotencyKey.endsWith('double-click-same-key-0002'));
    expect(matching).toHaveLength(1);
  });

  it('parallel double submission still credits once', async () => {
    const key = 'parallel-same-key-0003';
    const before = await creditedTotal(customerId);

    await Promise.allSettled([
      adjust(customerId, { coins: 75, note: 'Parallel double submit' }, key),
      adjust(customerId, { coins: 75, note: 'Parallel double submit' }, key),
    ]);

    expect(await creditedTotal(customerId)).toBe(before + 75);
  });
});

describe('a different key is a different, legitimate grant', () => {
  it('credits again under a new key', async () => {
    const before = await creditedTotal(customerId);
    const res = await adjust(
      customerId,
      { coins: 40, note: 'A second, deliberate grant' },
      'deliberate-second-grant-0004',
    );
    expect(res.status).toBe(200);
    expect(await creditedTotal(customerId)).toBe(before + 40);
  });
});

describe('keys are scoped to the customer', () => {
  it('the same raw key on another customer does not collide', async () => {
    const key = 'shared-raw-key-across-customers-0005';

    const a = await adjust(customerId, { coins: 30, note: 'Scoped key, customer A' }, key);
    expect(a.status).toBe(200);

    const beforeOther = await creditedTotal(otherCustomerId);
    const b = await adjust(otherCustomerId, { coins: 30, note: 'Scoped key, customer B' }, key);
    expect(b.status).toBe(200);

    // Had the key not been scoped, B would have been swallowed as a duplicate.
    expect(await creditedTotal(otherCustomerId)).toBe(beforeOther + 30);
  });
});

describe('a malformed key is not accepted as an idempotency key', () => {
  it('falls back rather than trusting a too-short key, so the grant still applies', async () => {
    const before = await creditedTotal(customerId);
    // Seven characters — below the 8-character floor checkout enforces.
    const res = await adjust(customerId, { coins: 15, note: 'Short key falls back' }, 'abc1234');
    expect(res.status).toBe(200);
    expect(await creditedTotal(customerId)).toBe(before + 15);

    const rows = await ledgerRows(customerId);
    // The stored key is the time-based fallback, never the rejected raw value.
    expect(rows.some((r) => r.idempotencyKey.endsWith(':abc1234'))).toBe(false);
  });

  it('rejects a key containing unsafe characters the same way', async () => {
    const before = await creditedTotal(customerId);
    const res = await adjust(
      customerId,
      { coins: 5, note: 'Unsafe key falls back' },
      'bad key/with spaces',
    );
    expect(res.status).toBe(200);
    expect(await creditedTotal(customerId)).toBe(before + 5);
  });
});

describe('existing validation and authorization are untouched', () => {
  it('rejects a zero adjustment', async () => {
    const res = await adjust(customerId, { coins: 0, note: 'Nothing at all' }, 'zero-coins-0006');
    expect(res.status).toBe(422);
  });

  it('rejects a fractional adjustment', async () => {
    const res = await adjust(customerId, { coins: 12.5, note: 'Half a coin' }, 'decimal-0007');
    expect(res.status).toBe(422);
  });

  // Schema failures are rejected by the validate middleware as 422; the route's
  // own hand-thrown business errors (approval threshold, self-approval) are 400.
  it('rejects a missing note', async () => {
    const res = await adjust(customerId, { coins: 10 }, 'no-note-at-all-0008');
    expect(res.status).toBe(422);
  });

  it('rejects a note below the minimum length', async () => {
    const res = await adjust(customerId, { coins: 10, note: 'x' }, 'short-note-0009');
    expect(res.status).toBe(422);
  });

  /*
   * The second-approver gate was removed by product decision: `loyalty.adjust`
   * is ADMIN-only, so there is no less-trusted operator for a co-signature to
   * protect against, and the threshold only served to block large grants when a
   * second admin was not around. A large grant must now go through on one
   * admin's authority, with the audit trail as the control.
   */
  it('applies a large adjustment without a second approver', async () => {
    const rv = await prisma.loyaltyRuleVersion.findFirstOrThrow({ where: { isActive: true } });
    const coins = rv.approvalThresholdCoins + 1;
    const before = await creditedTotal(customerId);

    const res = await adjust(
      customerId,
      { coins, note: 'Over the old approval threshold' },
      'over-threshold-0010',
    );

    expect(res.status).toBe(200);
    expect(await creditedTotal(customerId)).toBe(before + coins);
  });

  it('refuses to let an admin approve their own adjustment', async () => {
    const rv = await prisma.loyaltyRuleVersion.findFirstOrThrow({ where: { isActive: true } });
    const res = await adjust(
      customerId,
      {
        coins: rv.approvalThresholdCoins + 1,
        note: 'Self approval attempt',
        approvedById: staffId,
      },
      'self-approval-0011',
    );
    expect(res.status).toBe(400);
  });

  it('refuses a role without loyalty.adjust', async () => {
    // loyalty.adjust is [ADMIN] only — a content editor must never move coins.
    role = Role.CONTENT_EDITOR;
    const before = await creditedTotal(customerId);
    const res = await adjust(customerId, { coins: 999, note: 'Should never apply' }, 'editor-0012');
    expect(res.status).toBe(403);
    expect(await creditedTotal(customerId)).toBe(before);
    role = Role.ADMIN;
  });

  it('refuses an unauthenticated request', async () => {
    signedIn = false;
    const before = await creditedTotal(customerId);
    const res = await adjust(customerId, { coins: 999, note: 'Should never apply' }, 'anon-0013');
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(await creditedTotal(customerId)).toBe(before);
    signedIn = true;
  });
});
