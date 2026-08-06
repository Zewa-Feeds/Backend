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

/**
 * Shared Redis store factory. A distinct prefix per limiter keeps their counters
 * independent.
 */
const store = (prefix: string) =>
  new RedisStore({
    // rate-limit-redis issues raw Redis commands; ioredis exposes them via `call`.
    // The tuple cast is needed because `call` expects (command, ...args) rather
    // than a single spread array.
    sendCommand: (...args: string[]) =>
      redis.call(...(args as [string, ...string[]])) as Promise<never>,
    prefix: `rl:${prefix}:`,
  });

const base = (prefix: string, overrides: Partial<Options>): RequestHandler =>
  rateLimit({
    store: store(prefix),
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
  });

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
