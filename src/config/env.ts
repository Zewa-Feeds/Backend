/**
 * Environment configuration — validated once, at boot.
 *
 * The app refuses to start if anything required is missing or malformed. This is
 * deliberate: discovering a missing RAZORPAY_WEBHOOK_SECRET during a live payment
 * is far worse than failing to boot.
 *
 * Import `env` from here. Never read `process.env` directly elsewhere.
 */
import 'dotenv/config';
import { z } from 'zod';

/** Comma-separated string -> trimmed non-empty array. */
const csv = z
  .string()
  .transform((s) => s.split(',').map((v) => v.trim()).filter(Boolean));

/** Secrets must be long enough to be worth having. */
const secret = (name: string) =>
  z.string().min(32, `${name} must be at least 32 characters (use: openssl rand -base64 48)`);

/**
 * Treat an empty string as absent.
 *
 * A commented-out or blank line in .env (`SENTRY_DSN=`) arrives as '' rather than
 * undefined, which would otherwise fail a `.url()` check on an optional field.
 * Placeholder keys in .env.example must behave as "not set".
 */
const blankToUndefined = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), inner);

/** Optional string that is absent when blank. */
const optionalStr = blankToUndefined(z.string().optional());
/** Optional URL that is absent when blank. */
const optionalUrl = blankToUndefined(z.string().url().optional());
/** Optional email that is absent when blank. */
const optionalEmail = blankToUndefined(z.string().email().optional());

const schema = z.object({
  // ---- Core ---------------------------------------------------------------
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // ---- Data ---------------------------------------------------------------
  DATABASE_URL: z.string().url().startsWith('postgres', 'DATABASE_URL must be a postgres:// URL'),
  REDIS_URL: z.string().url(),

  // ---- Auth (§14) ---------------------------------------------------------
  JWT_ACCESS_SECRET: secret('JWT_ACCESS_SECRET'),
  JWT_REFRESH_SECRET: secret('JWT_REFRESH_SECRET'),
  JWT_PREVIEW_SECRET: secret('JWT_PREVIEW_SECRET'),
  /** Encrypts CmsUser.twofaSecret at rest. Exactly 32 bytes for AES-256-GCM. */
  TWOFA_ENCRYPTION_KEY: z.string().length(64, 'TWOFA_ENCRYPTION_KEY must be 64 hex chars (32 bytes)'),

  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL: z.string().default('8h'),
  /** "Stay signed in" lifetime. Also sizes the refresh cookie's maxAge. */
  REFRESH_TOKEN_TTL_REMEMBER: z.string().default('7d'),
  PREVIEW_TOKEN_TTL: z.string().default('15m'),
  BCRYPT_COST: z.coerce.number().int().min(10).max(15).default(12), // §14.1 cost 12

  // ---- CORS ---------------------------------------------------------------
  STOREFRONT_ORIGIN: z.string().url(),
  CMS_ORIGIN: z.string().url(),
  /** Extra allowed origins (local dev ports, preview deploys). Optional. */
  EXTRA_CORS_ORIGINS: csv.optional().default(''),

  // ---- Integrations -------------------------------------------------------
  // Optional at boot so Phase 0/1 can run without third-party accounts.
  // Each integration asserts its own presence when first used.
  RAZORPAY_KEY_ID: optionalStr,
  RAZORPAY_KEY_SECRET: optionalStr,
  RAZORPAY_WEBHOOK_SECRET: optionalStr,

  /**
   * TEMPORARY — development only.
   * TODO: Replace with production Razorpay verification.
   *
   * When true, payments auto-confirm 30s after creation with no real money.
   * Rejected outright when NODE_ENV=production (see productionChecks below).
   */
  RAZORPAY_AUTO_CONFIRM: z
    .preprocess((v) => v === 'true' || v === true, z.boolean())
    .default(false),

  /**
   * Run the BullMQ workers inside the API process instead of separately.
   *
   * Off by default: a dedicated worker process is the right shape, because a
   * slow PDF render or mail send cannot then block an HTTP request, and a job
   * handler crash cannot take the API down.
   *
   * Set true only where a second always-on process is not available — a free
   * hosting tier, for instance. Without it, nothing consumes the payment and
   * email queues, so orders are taken but never confirmed.
   */
  RUN_WORKERS_IN_API: z
    .preprocess((v) => v === 'true' || v === true, z.boolean())
    .default(false),

  /** Payment methods can be switched off per deployment without code changes. */
  PAYMENT_RAZORPAY_ENABLED: z
    .preprocess((v) => v !== 'false' && v !== false, z.boolean())
    .default(true),
  PAYMENT_COD_ENABLED: z
    .preprocess((v) => v !== 'false' && v !== false, z.boolean())
    .default(true),

  /** Minutes an unpaid online order holds its stock before release. */
  UNPAID_ORDER_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),

  CLOUDINARY_CLOUD_NAME: optionalStr,
  CLOUDINARY_API_KEY: optionalStr,
  CLOUDINARY_API_SECRET: optionalStr,

  ZEPTOMAIL_TOKEN: optionalStr,
  ZEPTOMAIL_FROM: optionalEmail,
  ZEPTOMAIL_FROM_NAME: z.string().default('Zewa Feeds'),

  SENTRY_DSN: optionalUrl,

  // ---- Company (invoices, §6.5) -------------------------------------------
  COMPANY_NAME: z.string().default('Zewa Ecosystems Pvt. Ltd'),
  /** As issued on the GST registration certificate. */
  COMPANY_GSTIN: z.string().default('32AABCZ8255E1ZC'),
  /**
   * Place of supply — decides CGST+SGST (intra-state) vs IGST (inter-state).
   *
   * This defaulted to Maharashtra, which is not where the company is
   * registered: every Kerala order — the home state, and so the most common
   * intra-state case — was being split as IGST on the invoice.
   */
  COMPANY_STATE: z.string().default('Kerala'),
  /** GST state code for Kerala; printed beside the state name on invoices. */
  COMPANY_STATE_CODE: z.string().default('32'),
  COMPANY_ADDRESS: z
    .string()
    .default(
      '17/31A, TR Nair Rd, Elamthuruthy-Kalady, Kuttanellur PO, Thrissur, Kerala 680014, India',
    ),
  COMPANY_EMAIL: z.string().email().default('orders@zewafeeds.com'),
  COMPANY_PHONE: z.string().default('+91-94966 42259'),
});

/**
 * Production-only invariants that a per-field schema cannot express.
 *
 * The worst failure mode here is a production deploy silently booting with dev
 * values — reused JWT secrets, or a localhost CORS origin. Catch it at boot.
 */
function productionChecks(cfg: z.infer<typeof schema>): string[] {
  if (cfg.NODE_ENV !== 'production') return [];
  const problems: string[] = [];

  // Reusing one secret across token types means a preview token could be
  // replayed as an access token.
  const secrets = [cfg.JWT_ACCESS_SECRET, cfg.JWT_REFRESH_SECRET, cfg.JWT_PREVIEW_SECRET];
  if (new Set(secrets).size !== secrets.length) {
    problems.push('JWT_ACCESS_SECRET, JWT_REFRESH_SECRET and JWT_PREVIEW_SECRET must all differ');
  }

  // The single most dangerous misconfiguration: production accepting simulated
  // payments. Refuse to boot rather than take fake orders.
  if (cfg.RAZORPAY_AUTO_CONFIRM) {
    problems.push(
      'RAZORPAY_AUTO_CONFIRM must be false in production — it auto-confirms payments without charging',
    );
  }
  if (cfg.PAYMENT_RAZORPAY_ENABLED && !(cfg.RAZORPAY_KEY_ID && cfg.RAZORPAY_KEY_SECRET)) {
    problems.push(
      'PAYMENT_RAZORPAY_ENABLED is true but RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET are missing',
    );
  }
  if (cfg.PAYMENT_RAZORPAY_ENABLED && !cfg.RAZORPAY_WEBHOOK_SECRET) {
    problems.push(
      'RAZORPAY_WEBHOOK_SECRET is required in production — webhooks are the authoritative payment signal',
    );
  }
  if (!cfg.PAYMENT_RAZORPAY_ENABLED && !cfg.PAYMENT_COD_ENABLED) {
    problems.push('At least one payment method must be enabled');
  }
  if (!cfg.ZEPTOMAIL_TOKEN) {
    problems.push('ZEPTOMAIL_TOKEN is required in production — order emails would silently fail');
  }

  for (const [name, origin] of [
    ['STOREFRONT_ORIGIN', cfg.STOREFRONT_ORIGIN],
    ['CMS_ORIGIN', cfg.CMS_ORIGIN],
  ] as const) {
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
      problems.push(`${name} points at localhost — set the real origin in production`);
    }
    if (origin.startsWith('http://')) {
      problems.push(`${name} must use HTTPS in production (§14.4)`);
    }
  }

  return problems;
}

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Do not use the logger here — it depends on this module.
  console.error('\n✖ Invalid environment configuration:\n');
  for (const issue of parsed.error.issues) {
    console.error(`  • ${issue.path.join('.')}: ${issue.message}`);
  }
  console.error('\nCopy .env.example to .env and fill in the values.\n');
  process.exit(1);
}

const productionProblems = productionChecks(parsed.data);
if (productionProblems.length > 0) {
  console.error('\n✖ Unsafe production configuration:\n');
  for (const problem of productionProblems) console.error(`  • ${problem}`);
  console.error('');
  process.exit(1);
}

const raw = parsed.data;

export const env = {
  ...raw,
  isProd: raw.NODE_ENV === 'production',
  isDev: raw.NODE_ENV === 'development',
  isTest: raw.NODE_ENV === 'test',

  /**
   * Every origin allowed by CORS, normalised.
   *
   * A trailing slash is stripped because the CORS check is an exact string
   * match and browsers ALWAYS send Origin without one. Pasting
   * "https://example.com/" into a dashboard — which is what you get by copying
   * from the address bar — therefore blocked every request from that site,
   * with no error anywhere on the server to explain it. Normalising here means
   * the value works whichever way it was entered.
   */
  corsOrigins: [raw.STOREFRONT_ORIGIN, raw.CMS_ORIGIN, ...raw.EXTRA_CORS_ORIGINS]
    .filter(Boolean)
    .map((origin) => origin.replace(/\/+$/, '')),
} as const;

export type Env = typeof env;
