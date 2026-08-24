/**
 * Rate limiting — Redis-backed, so limits hold across multiple instances.
 *
 * The login limiter implements §14.1 directly: max 10 failed attempts per IP per
 * 15 minutes, then a 15-minute lockout.
 */
import rateLimit, { type Options } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import type { RequestHandler } from 'express';
import { redis } from '@/lib/redis';
import { ErrorCode } from '@/lib/errors';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'rateLimit' });

/**
 * Shared Redis store factory. A distinct prefix per limiter keeps their counters
 * independent.
 */
const redisStore = (prefix: string) => {
  const store = new RedisStore({
    // rate-limit-redis issues raw Redis commands; ioredis exposes them via `call`.
    // The tuple cast is needed because `call` expects (command, ...args) rather
    // than a single spread array.
    sendCommand: (...args: string[]) =>
      redis.call(...(args as [string, ...string[]])) as Promise<never>,
    prefix: `rl:${prefix}:`,
  });

  /*
   * The constructor kicks off SCRIPT LOAD and stores the pending promises. If
   * Redis is down those reject with nobody awaiting them yet, and an unhandled
   * rejection takes the process down before any request arrives.
   *
   * Attaching a catch marks them handled. The rejection still propagates to
   * whoever awaits the promise later, so a failing store is caught per-request
   * by withFallback — this only stops the crash, it does not hide the error.
   */
  for (const sha of [store.incrementScriptSha, store.getScriptSha]) {
    void Promise.resolve(sha).catch(() => {});
  }

  return store;
};

let degraded = false;

/**
 * FAIL OPEN onto an in-memory store when Redis is unusable.
 *
 * Rate limiting is a protective measure, not a correctness one, so a dead Redis
 * must not take the API down with it. Previously any Redis failure — an
 * exhausted Upstash quota, a network blip — rejected inside express-rate-limit
 * and surfaced as a 500 on EVERY route, the public catalogue included. Losing
 * the whole storefront to protect it from traffic it was not receiving is the
 * wrong trade.
 *
 * Swallowing the error per-command is not enough: rate-limit-redis validates
 * its own SCRIPT LOAD reply and throws "unexpected reply from redis client",
 * which surfaces as an unhandled rejection and kills the process. So instead of
 * feeding it fake replies, the request is retried against express-rate-limit's
 * default memory store.
 *
 * The trade-off of that fallback is real and deliberate: counters live in this
 * process only, so limits are per-instance rather than global and reset on
 * restart. For a protective ceiling during a cache outage that is fine — it is
 * strictly better than no limit at all, and far better than a downed API.
 */
const withFallback = (redisLimiter: RequestHandler, memoryLimiter: RequestHandler): RequestHandler =>
  (req, res, next) =>
    redisLimiter(req, res, (err?: unknown) => {
      if (!err) {
        if (degraded) {
          degraded = false;
          log.info('rate-limit store recovered — limits are global again');
        }
        return next();
      }

      // Log the transition only. A downed Redis would otherwise emit a line per
      // request and bury everything else in the log.
      if (!degraded) {
        degraded = true;
        log.error({ err }, 'rate-limit store unavailable — falling back to in-memory limits');
      }

      memoryLimiter(req, res, next);
    });

const base = (prefix: string, overrides: Partial<Options>): RequestHandler => {
  const common: Partial<Options> = {
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Deliver our error envelope rather than express-rate-limit's default text.
    handler: (_req, res, _next, options) => {
      res.status(options.statusCode).json({
        error: {
          code: ErrorCode.RATE_LIMITED,
          message: typeof options.message === 'string' ? options.message : 'Too many requests.',
        },
      });
    },
    // Skip entirely in tests so suites are not flaky.
    skip: () => env.isTest,
    ...overrides,
  };

  // Omitting `store` leaves express-rate-limit on its built-in MemoryStore.
  return withFallback(rateLimit({ ...common, store: redisStore(prefix) }), rateLimit({ ...common }));
};

/**
 * §14.1 — CMS login. 10 failures per IP per 15 min, then locked out for 15 min.
 *
 * skipSuccessfulRequests means only FAILURES count, so a busy legitimate user is
 * never locked out while a password-guesser is.
 */
export const loginLimiter = base('login', {
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  message: 'Too many failed login attempts. Try again in 15 minutes.',
});

/** 2FA code submission — brute-forcing 6 digits must not be viable. */
export const twofaLimiter = base('twofa', {
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  message: 'Too many verification attempts. Try again in 15 minutes.',
});

/** Password reset / forgot-password — limits enumeration and mail-bombing. */
export const passwordResetLimiter = base('pwreset', {
  windowMs: 60 * 60 * 1000,
  limit: 5,
  message: 'Too many password reset requests. Try again later.',
});

/** Public review submission — spam control (§9). */
export const reviewLimiter = base('review', {
  windowMs: 60 * 60 * 1000,
  limit: 5,
  message: 'You have submitted several reviews recently. Please try again later.',
});

/** Coupon validation — stops brute-force discovery of unpublished codes. */
export const couponLimiter = base('coupon', {
  windowMs: 60 * 1000,
  limit: 20,
  message: 'Too many coupon attempts. Please wait a moment.',
});

/** True when this request is trying a coupon code, rather than just re-pricing. */
export const carriesCouponCode = (req: { body?: unknown }): boolean => {
  const body = req.body as { couponCode?: unknown } | undefined;
  return typeof body?.couponCode === 'string' && body.couponCode.trim().length > 0;
};

/**
 * Cart re-pricing that carries a coupon code.
 *
 * `POST /cart/validate` accepts a coupon code and reports per-code rejection
 * reasons, so it answers the same question `couponLimiter` exists to protect —
 * but it sat behind the 200/min public ceiling, making it a far cheaper way to
 * discover valid codes than the endpoint that was actually guarded.
 *
 * It cannot simply wear the 20/min coupon budget: the storefront re-prices on
 * every cart mutation, so an honest shopper with a coupon applied would be
 * throttled mid-checkout. Instead the counter SKIPS requests carrying no coupon
 * code — quantity edits are never counted — and only code-carrying calls spend
 * budget.
 *
 * 30/min is chosen against the storefront's actual behaviour: re-pricing is
 * debounced at 300ms and fires roughly one call per cart change, so 30 covers
 * sustained interactive editing with a coupon applied, while cutting the
 * enumeration channel to 15% of what the public ceiling allowed. Deliberate
 * coupon entry stays on the tighter 20/min `couponLimiter`.
 */
export const cartCouponLimiter = base('cart-coupon', {
  windowMs: 60 * 1000,
  limit: 30,
  message: 'Too many coupon attempts. Please wait a moment.',
  // `base` sets skip to env.isTest; overriding it means re-stating that.
  skip: (req) => env.isTest || !carriesCouponCode(req),
});

/** Checkout — narrow, because each call touches Razorpay and locks stock rows. */
export const checkoutLimiter = base('checkout', {
  windowMs: 60 * 1000,
  limit: 10,
  message: 'Too many checkout attempts. Please wait a moment.',
});

/** Broad ceiling for the public catalogue/content endpoints. */
export const publicLimiter = base('public', {
  windowMs: 60 * 1000,
  limit: 200,
  message: 'Too many requests. Please slow down.',
});

/** Authenticated CMS traffic — generous; staff are trusted but not unbounded. */
export const adminLimiter = base('admin', {
  windowMs: 60 * 1000,
  limit: 300,
  message: 'Too many requests. Please slow down.',
});
