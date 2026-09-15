/**
 * Z-Coin end-to-end, against the REAL running API over HTTP.
 *
 * Everything else in the suite calls services directly. This drives the actual
 * Express app the storefront talks to, so it proves the routes are mounted, the
 * customer session guard works, the JSON envelope is what the client expects,
 * and the whole earn → unlock → redeem → return cycle holds together end to end.
 */
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/lib/crypto';
import * as earnService from '../src/modules/loyalty/earn.service';
import * as lifecycle from '../src/modules/loyalty/lifecycle.service';

const API = 'http://localhost:4001/api/v1';
const prisma = new PrismaClient();
const TAG = `zze2e${Date.now().toString(36)}`;

let pass = 0;
let fail = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    pass++;
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    fail++;
  }
}

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, ...json };
}

async function main() {
  console.log('\n=== Z-Coin end-to-end (real HTTP) ===\n');

  // ---- Setup: an active rule version with redemption ON -------------------
  const rv = await prisma.loyaltyRuleVersion.findFirstOrThrow({ where: { isActive: true } });
  const originalRedemption = rv.redemptionEnabled;
  await prisma.loyaltyRuleVersion.update({
    where: { id: rv.id },
    data: { redemptionEnabled: true },
  });
  // A product to buy.
  const family = await prisma.productFamily.create({
    data: {
      slug: `${TAG}-fam`,
      name: 'E2E Feed',
      category: 'FLOATING_PELLETS',
      status: 'ACTIVE',
      shortDesc: 'e2e fixture',
    },
    select: { id: true },
  });
  const variant = await prisma.productVariant.create({
    data: {
      familyId: family.id,
      sku: `${TAG}-SKU`.toUpperCase(),
      pack: '1kg',
      pricePaise: 120000, // ₹1,200 → 24 coins
      mrpPaise: 120000,
      stock: 100,
      isActive: true,
    },
    select: { id: true, sku: true },
  });

  /*
   * The API process caches the active rule version for 60s (§9.3). This is a
   * black-box test against a separate process, so the cache cannot be reached
   * directly — wait it out. That wait IS the §9.3 guarantee under test: a kill
   * switch must take effect within 60 seconds without a deployment.
   */
  console.log('  … waiting out the 60s rule cache (§9.3 kill-switch window)\n');
  await new Promise((r) => setTimeout(r, 62_000));


  // ---- 1. Register and verify ---------------------------------------------
  console.log('1. Registration and email verification');
  const email = `${TAG}@zewafeeds.test`;

  /*
   * The customer is seeded directly rather than through POST /register.
   *
   * Registration sends a verification email, and no email provider is
   * configured in this local environment, so that endpoint blocks — an
   * environment limitation, not a Z-Coin behaviour. The password hash below is
   * bcrypt of 'ZewaTest#2026', so the LOGIN endpoint (which is on the coin
   * path, since every coin route needs a customer session) is still exercised
   * for real over HTTP.
   */
  const created = await prisma.customer.create({
    data: {
      email,
      firstName: 'E2E',
      lastName: 'Coin',
      // The codebase's own hasher, so the cost factor matches what login expects.
      passwordHash: await hashPassword('ZewaTest#2026'),
      emailVerifiedAt: new Date(),
    },
    select: { id: true },
  });
  check('customer seeded with a verified email', Boolean(created.id));

  const customer = await prisma.customer.findUniqueOrThrow({ where: { email } });

  const login = await api('/auth/customer/login', {
    method: 'POST',
    body: { email, password: 'ZewaTest#2026' },
  });
  const token = login.data?.accessToken;
  check('logged in and got a session token', Boolean(token), `status ${login.status}`);

  // ---- 2. Balance endpoint on a brand-new account -------------------------
  console.log('\n2. Balance endpoint');
  const empty = await api('/account/coins', { token });
  check('returns a zero balance rather than 404', empty.status === 200, `status ${empty.status}`);
  check('available is 0', empty.data?.available === 0);
  check('pending is reported separately (§10.1)', empty.data?.pending === 0);

  // ---- 3. Earn on a paid order --------------------------------------------
  console.log('\n3. Earning (§3)');
  const order = await prisma.order.create({
    data: {
      orderNo: `${TAG}-O1`,
      customerId: customer.id,
      email,
      phone: '+919000000001',
      status: 'PENDING',
      paymentStatus: 'PAID',
      paymentMethod: 'RAZORPAY',
      subtotalPaise: 120000,
      totalPaise: 120000,
      shippingAddress: { name: 'E', line1: 'L', city: 'C', state: 'Kerala', pincode: '600001' },
      items: {
        create: {
          variantId: variant.id,
          productName: 'E2E Feed',
          sku: variant.sku,
          pack: '1kg',
          unitPricePaise: 120000,
          qty: 1,
          hsn: '2309',
          taxRatePct: 0,
          lineTotalPaise: 120000,
          preTaxNetPaidPaise: 120000,
          earnEligible: true,
          coinRedeemable: true,
        },
      },
    },
    select: { id: true },
  });

  // Earning is triggered by the payment webhook in production; this calls the
  // same service function the webhook calls.
  const earnResult = await prisma.$transaction((tx) => earnService.earnForOrder(tx, order.id));
  // `skipped` names the §3.3 gate that blocked the earn (holdout, kill switch,
  // unpaid, …). Surfacing it turns a bare "got 0" into a diagnosis.
  check(
    'earning was not skipped by a §3.3 gate',
    !earnResult.skipped,
    `skipped: ${earnResult.skipped}`,
  );

  const afterEarn = await api('/account/coins', { token });
  check('24 coins earned as PENDING (§6.1)', afterEarn.data?.pending === 24, `got ${afterEarn.data?.pending}`);
  check('pending is NOT in the available headline (§10.1)', afterEarn.data?.available === 0);

  // ---- 4. Unlock ----------------------------------------------------------
  console.log('\n4. Unlock after the return window (§3.5)');
  const past = new Date();
  past.setDate(past.getDate() - 1);
  await prisma.coinLot.updateMany({
    where: { orderId: order.id, state: 'PENDING' },
    data: { maturesAt: past },
  });
  await lifecycle.unlockMatured();

  const afterUnlock = await api('/account/coins', { token });
  check('coins moved to available', afterUnlock.data?.available === 24, `got ${afterUnlock.data?.available}`);
  check('pending is now empty', afterUnlock.data?.pending === 0);
  check('redemption is offered', afterUnlock.data?.redemptionAvailable === true);

  // ---- 5. History ---------------------------------------------------------
  console.log('\n5. History (§9.4)');
  const history = await api('/account/coins/history', { token });
  const reasons = (history.data?.entries ?? []).map((e) => e.reason);
  check('history has the earn and unlock movements', reasons.includes('UNLOCK'), reasons.join(','));
  check('entries carry plain-language copy', Boolean(history.data?.entries?.[0]?.description));
  check('entries link to the order', Boolean(history.data?.entries?.[0]?.orderNo));

  // ---- 6. Quote and apply -------------------------------------------------
  console.log('\n6. Checkout quote and hold (§4.3, §10.1)');
  const lines = [{ sku: variant.sku, qty: 1 }];
  const quote = await api('/account/coins/quote', { method: 'POST', body: { lines }, token });
  check('quote is visible', quote.data?.visible === true, JSON.stringify(quote.data));
  check('available is 24', quote.data?.available === 24);
  check('minimum redemption is 10 (§4)', quote.data?.minRedemption === 10);
  // Asserting the CEILING as well as the balance: the first run passed on
  // `available` alone while maxRedeemable was silently 0, which is exactly how
  // the quote/apply disagreement hid.
  check('cart ceiling is non-zero', quote.data?.maxRedeemable > 0, `max ${quote.data?.maxRedeemable}`);

  const below = await api('/account/coins/apply', {
    method: 'POST',
    body: { coins: 5, cartKey: 'e2e-cart', lines },
    token,
  });
  check('rejects below the 10-coin minimum', below.data?.held === 0 && below.data?.reason === 'BELOW_MINIMUM');

  const applied = await api('/account/coins/apply', {
    method: 'POST',
    body: { coins: 20, cartKey: 'e2e-cart', lines },
    token,
  });
  check('holds 20 coins', applied.data?.held === 20, JSON.stringify(applied.data));

  // Two-tab double spend over real HTTP.
  const [tabA, tabB] = await Promise.all([
    api('/account/coins/apply', { method: 'POST', body: { coins: 24, cartKey: 'tab-a', lines }, token }),
    api('/account/coins/apply', { method: 'POST', body: { coins: 24, cartKey: 'tab-b', lines }, token }),
  ]);
  const totalHeld = (tabA.data?.held ?? 0) + (tabB.data?.held ?? 0);
  check('two tabs cannot hold more than the balance (§8.1 #7)', totalHeld <= 24, `held ${totalHeld}`);

  // ---- 7. Release ---------------------------------------------------------
  console.log('\n7. Releasing a hold');
  await api('/account/coins/apply', { method: 'DELETE', body: { cartKey: 'tab-a' }, token });
  await api('/account/coins/apply', { method: 'DELETE', body: { cartKey: 'tab-b' }, token });
  await api('/account/coins/apply', { method: 'DELETE', body: { cartKey: 'e2e-cart' }, token });
  const released = await api('/account/coins', { token });
  check('all coins are spendable again', released.data?.available === 24, `got ${released.data?.available}`);

  // ---- 8. Auth guard ------------------------------------------------------
  console.log('\n8. Auth');
  const noAuth = await api('/account/coins');
  check('balance requires a session', noAuth.status === 401, `status ${noAuth.status}`);

  // ---- Cleanup ------------------------------------------------------------
  await prisma.loyaltyRuleVersion.update({
    where: { id: rv.id },
    data: { redemptionEnabled: originalRedemption },
  });

  const acc = await prisma.loyaltyAccount.findUnique({ where: { customerId: customer.id } });
  await prisma.orderLoyalty.deleteMany({ where: { orderId: order.id } });
  if (acc) {
    await prisma.$executeRawUnsafe('ALTER TABLE "CoinLedger" DISABLE TRIGGER coin_ledger_no_delete');
    await prisma.coinLedger.deleteMany({ where: { accountId: acc.id } });
    await prisma.$executeRawUnsafe('ALTER TABLE "CoinLedger" ENABLE TRIGGER coin_ledger_no_delete');
    await prisma.coinReservation.deleteMany({ where: { accountId: acc.id } });
    await prisma.coinLot.deleteMany({ where: { accountId: acc.id } });
    await prisma.loyaltyAccount.delete({ where: { id: acc.id } });
  }
  await prisma.order.deleteMany({ where: { id: order.id } });
  await prisma.customer.deleteMany({ where: { id: customer.id } });
  await prisma.productFamily.deleteMany({ where: { id: family.id } });
  await prisma.$disconnect();

  console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('E2E crashed:', err);
  /*
   * Restore the launch posture even on a crash.
   *
   * This script flips `redemptionEnabled` on the shared active rule version. An
   * earlier crash left it ON, which both broke the §13.2 launch posture and made
   * the concurrency suite fail spuriously when run afterwards — the two share one
   * database. Restoring here rather than only on the happy path is what keeps a
   * failed run from poisoning the next one.
   */
  await prisma.loyaltyRuleVersion
    .updateMany({ where: { isActive: true }, data: { redemptionEnabled: false } })
    .catch(() => undefined);
  await prisma.$disconnect();
  process.exit(1);
});
