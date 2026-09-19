/**
 * Customer-facing Z-Coin API — ZSOP004 §10.
 *
 * Mounted under `/api/v1/account/coins`, inside the customer-session guard that
 * `accountRouter` already applies.
 *
 * TWO RULES SHAPE EVERY RESPONSE HERE
 *
 *   Pending is never summed into the headline (§10.1). It is returned as its own
 *   field with its unlock date, because a balance that includes coins the
 *   customer cannot spend generates exactly the support contact the unlock date
 *   is there to prevent.
 *
 *   A negative balance is never shown (§6.7). The account page reports 0 with a
 *   neutral explanation and the redemption surface disappears — "the widget is
 *   hidden, not greyed out with a negative number, which reads as a bug".
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '@/middleware/asyncHandler';
import { validate } from '@/middleware/validate';
import { prisma } from '@/lib/prisma';
import { AppError, ErrorCode } from '@/lib/errors';
import * as accountService from './account.service';
import * as redemption from './redemption.service';
import * as rulesService from './rules.service';
import * as guestClaim from './guest-claim.service';
import { withCouponDiscount, type CoinLine } from './coin-math';
import { priceCart } from '@/modules/checkout/pricing.service';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'loyalty.routes' });

export const loyaltyRouter = Router();

/**
 * Resolve cart SKUs to the line shape the coin engine consumes.
 *
 * SKUs are uppercased to match `pricing.service`, which is the convention the
 * rest of checkout already follows — the catalogue stores them uppercase.
 *
 * An unrecognised SKU RAISES rather than being skipped. Skipping was the
 * original behaviour and it produced a genuinely confusing bug: `quote` reported
 * the customer's full balance as `available` while silently computing a ceiling
 * of zero from an empty line set, so the box rendered and then `apply` refused
 * with NOTHING_REDEEMABLE. Two endpoints disagreeing about the same cart is far
 * harder to diagnose than one clear 400.
 *
 * COUPON DISCOUNTS ARE PRICED, NOT ASSUMED. `couponDiscountPaise` used to be
 * hard-coded to 0, so the redemption ceiling was computed on the UNDISCOUNTED
 * cart: a ₹229 cart with 10% off offered 229 redeemable coins against ₹206.10
 * of actual value. §4.1 fixes the order of operations — coupon first, then
 * coins — so the discount has to be real here. The cart is priced through the
 * same engine checkout uses, and the total discount is spread across redeemable
 * lines pro rata by value, which is the same basis allocateCoins() uses.
 */
async function resolveCoinLines(
  lines: { sku: string; qty: number }[],
  couponCodes?: string[],
): Promise<CoinLine[]> {
  const wanted = lines.map((l) => l.sku.toUpperCase().trim());
  const variants = await prisma.productVariant.findMany({
    where: { sku: { in: wanted } },
    select: { id: true, sku: true, pricePaise: true, earnEligible: true, coinRedeemable: true },
  });
  const bySku = new Map(variants.map((v) => [v.sku, v]));

  const missing = wanted.filter((sku) => !bySku.has(sku));
  if (missing.length > 0) {
    throw new AppError(400, ErrorCode.VALIDATION_FAILED, 'Some items are no longer available.', {
      details: { skus: missing },
    });
  }

  const resolved = lines.map((l) => {
    const v = bySku.get(l.sku.toUpperCase().trim())!;
    return {
      id: v.id,
      lineTotalPaise: v.pricePaise * l.qty,
      // Zewa's catalogue is 0% GST; the rate is snapshotted per line at order
      // time so a future rated catalogue needs no change here (§7.4).
      taxRatePct: 0,
      earnEligible: v.earnEligible,
      coinRedeemable: v.coinRedeemable,
      couponDiscountPaise: 0,
    };
  });

  if (!couponCodes?.length) return resolved;

  /*
   * Price the cart to learn what the coupons are actually worth.
   *
   * A pricing failure must not break the coins box: §8.1 #11 requires the
   * loyalty path to fail invisibly, and a zero discount here is the
   * CONSERVATIVE direction only for the customer's balance, never for ours —
   * it can only offer a ceiling that `reserve` will then refuse. Logging it
   * keeps the silence from being total.
   */
  let discountPaise = 0;
  try {
    const priced = await priceCart({ lines, couponCodes });
    discountPaise = priced.discountPaise;
  } catch (err) {
    log.warn({ err }, 'could not price cart for coin ceiling — treating discount as zero');
    return resolved;
  }
  if (discountPaise <= 0) return resolved;

  return withCouponDiscount(resolved, discountPaise);
}


/**
 * GET /account/coins — the balance widget and account page (§10.2).
 *
 * Returns `null`-ish state rather than a 404 when the customer has no account
 * yet: a customer who has never earned is not an error, and the storefront
 * renders the same "earn your first coins" state either way.
 */
loyaltyRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const summary = await accountService.summary(req.customer!.id);
    const rv = await rulesService.active();

    res.json({
      data: {
        ...summary,
        // The programme's own terms, so the storefront never hardcodes them.
        coinValuePaise: rv.coinValuePaise,
        minRedemption: rv.minRedemptionCoins,
        expiryDays: rv.expiryDays,
        // §10.1: hide the box entirely for negative-balance customers, and
        // whenever the kill switch is off.
        redemptionAvailable: rv.redemptionEnabled && summary.canRedeem,
      },
    });
  }),
);

/**
 * GET /account/coins/history — plain-language ledger (§9.4, §10.2).
 *
 * "Plain-language history linking to orders." The reason code is mapped to a
 * sentence here rather than in the client, so the CMS, the app and the website
 * all describe the same movement the same way — §10.3 requires support macros to
 * use the same vocabulary as the interface.
 */
const REASON_COPY: Record<string, string> = {
  EARN: 'Earned on your order',
  UNLOCK: 'Coins unlocked and ready to use',
  REDEEM: 'Used on your order',
  RELEASE: 'Returned to your balance — payment was not completed',
  EXPIRE: 'Expired',
  RESTORE: 'Returned to your account after a return',
  CLAWBACK: 'Adjusted following a return',
  VOID: 'Removed — the order was not delivered',
  GUEST_CLAIM: 'Claimed from an earlier order',
  LAUNCH_BACKFILL: 'Added for your earlier orders',
  ADJUSTMENT: 'Adjusted by our team',
  GOODWILL: 'Added by our team',
  MERGE: 'Moved from another account',
  RECONCILE: 'Balance corrected',
};

loyaltyRouter.get(
  '/history',
  validate({
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).default(25),
      cursor: z.string().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { limit, cursor } = req.query as unknown as { limit: number; cursor?: string };

    const account = await prisma.loyaltyAccount.findUnique({
      where: { customerId: req.customer!.id },
      select: { id: true },
    });
    if (!account) {
      res.json({ data: { entries: [], nextCursor: null } });
      return;
    }

    const rows = await prisma.coinLedger.findMany({
      where: {
        accountId: account.id,
        // A zero-delta row is an internal note (a reconciliation, a void
        // restore). It explains nothing to a customer and only makes the
        // history look like it is malfunctioning.
        coinsDelta: { not: 0 },
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: BigInt(cursor) }, skip: 1 } : {}),
      select: {
        id: true,
        coinsDelta: true,
        reason: true,
        createdAt: true,
        orderId: true,
      },
    });

    const page = rows.slice(0, limit);
    // Resolve order numbers by lookup — the ledger holds plain ids with no
    // foreign key, so an order that has since been purged simply has no link.
    const orderIds = page.map((r) => r.orderId).filter((x): x is string => Boolean(x));
    const orders = orderIds.length
      ? await prisma.order.findMany({
          where: { id: { in: orderIds } },
          select: { id: true, orderNo: true },
        })
      : [];
    const orderNoById = new Map(orders.map((o) => [o.id, o.orderNo]));

    res.json({
      data: {
        entries: page.map((r) => ({
          id: r.id.toString(),
          coins: r.coinsDelta,
          reason: r.reason,
          description: REASON_COPY[r.reason] ?? 'Balance updated',
          at: r.createdAt,
          orderNo: r.orderId ? (orderNoById.get(r.orderId) ?? null) : null,
        })),
        nextCursor: rows.length > limit ? page[page.length - 1]!.id.toString() : null,
      },
    });
  }),
);

/**
 * POST /account/coins/quote — what the checkout box should show (§10.1).
 *
 * The cart is priced server-side; the client sends only SKUs and quantities, as
 * everywhere else in this codebase. Returns `null` when the box must not render
 * at all, which the storefront treats as "no coins UI" rather than an error.
 */
loyaltyRouter.post(
  '/quote',
  validate({
    body: z.object({
      lines: z
        .array(z.object({ sku: z.string().trim().min(1), qty: z.number().int().min(1) }))
        .min(1),
      /** Codes applied to this cart — a coupon may forbid coins (§4). */
      couponCodes: z.array(z.string().trim().max(30)).max(10).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { lines, couponCodes } = req.body as {
      lines: { sku: string; qty: number }[];
      couponCodes?: string[];
    };
    const coinLines = await resolveCoinLines(lines, couponCodes);
    const quote = await redemption.quote(req.customer!.id, coinLines, couponCodes);
    res.json({ data: quote });
  }),
);

/**
 * POST /account/coins/apply — hold coins for this cart (§4.3).
 *
 * Reserving at APPLY time rather than payment time is the double-spend defence:
 * "the gap between applying and paying is exactly where double-spend happens".
 * The hold is account-anchored, so a second tab cannot duplicate it.
 *
 * Responds with what was actually held, which may be less than requested when
 * the cart shrank — §4.1 requires a silent reduction with a non-blocking notice
 * rather than a failure at payment.
 */
loyaltyRouter.post(
  '/apply',
  validate({
    body: z.object({
      coins: z.number().int().min(0),
      cartKey: z.string().trim().min(1).max(128),
      lines: z
        .array(z.object({ sku: z.string().trim().min(1), qty: z.number().int().min(1) }))
        .min(1),
      /** Codes applied to this cart — a coupon may forbid coins (§4). */
      couponCodes: z.array(z.string().trim().max(30)).max(10).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { coins, cartKey, lines, couponCodes } = req.body as {
      coins: number;
      cartKey: string;
      lines: { sku: string; qty: number }[];
      couponCodes?: string[];
    };

    const coinLines = await resolveCoinLines(lines, couponCodes);

    const result = await redemption.reserve({
      customerId: req.customer!.id,
      coins,
      lines: coinLines,
      cartKey,
      couponCodes,
    });

    res.json({ data: result });
  }),
);

/**
 * DELETE /account/coins/apply — drop the hold (§10.1).
 *
 * Removing coins from the cart must return them immediately, not wait for the
 * 30-minute sweep; a customer who changes their mind should see the balance come
 * back at once.
 */
loyaltyRouter.delete(
  '/apply',
  validate({ body: z.object({ cartKey: z.string().trim().min(1).max(128) }) }),
  asyncHandler(async (req, res) => {
    const { cartKey } = req.body as { cartKey: string };
    const account = await prisma.loyaltyAccount.findUnique({
      where: { customerId: req.customer!.id },
      select: { id: true },
    });
    if (!account) {
      res.json({ data: { released: 0 } });
      return;
    }

    const released = await prisma.$transaction((tx) =>
      redemption.releaseByCartKey(tx, account.id, cartKey),
    );
    res.json({ data: { released } });
  }),
);

/**
 * GET /account/coins/claimable — unclaimed guest orders (§3.4).
 *
 * Powers the account-page prompt. Returns the exact coin figure per order,
 * because §3.4 requires the prompt to name what is at stake rather than say
 * "you have unclaimed rewards".
 */
loyaltyRouter.get(
  '/claimable',
  asyncHandler(async (req, res) => {
    const orders = await guestClaim.claimableOrders(req.customer!.id);
    res.json({
      data: {
        orders,
        totalCoins: orders.reduce((s, o) => s + o.coins, 0),
      },
    });
  }),
);

/**
 * POST /account/coins/claim — retro-credit eligible guest orders (§3.4).
 *
 * Normally unnecessary: claiming happens automatically the moment the email is
 * verified. This exists for the customer who registered, verified, and only
 * later placed an order as a guest with the same address — and for support to
 * re-run without a database session.
 *
 * Safe to call repeatedly: each order is marked claimed atomically, so a repeat
 * returns zero rather than granting twice (§8.4 #27).
 */
loyaltyRouter.post(
  '/claim',
  asyncHandler(async (req, res) => {
    const result = await guestClaim.claimGuestOrders(req.customer!.id);
    res.json({ data: result });
  }),
);
