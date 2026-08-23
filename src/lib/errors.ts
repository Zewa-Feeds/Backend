/**
 * Application errors.
 *
 * Every error carries a stable machine-readable `code`. Frontends branch on the
 * code, never on the message — messages are for humans and will get reworded.
 *
 * Throw these from anywhere; the global error handler (middleware/errorHandler.ts)
 * turns them into the response envelope.
 */

/** Stable error codes. Additive only — never rename one that has shipped. */
export const ErrorCode = {
  // Auth / access
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  EMAIL_UNVERIFIED: 'EMAIL_UNVERIFIED',
  TWOFA_REQUIRED: 'TWOFA_REQUIRED',
  TWOFA_INVALID: 'TWOFA_INVALID',
  TWOFA_NOT_ENROLLED: 'TWOFA_NOT_ENROLLED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  FORBIDDEN: 'FORBIDDEN',
  ACCOUNT_DEACTIVATED: 'ACCOUNT_DEACTIVATED',
  ACCOUNT_BANNED: 'ACCOUNT_BANNED',
  PASSWORD_POLICY: 'PASSWORD_POLICY',
  PASSWORD_REUSED: 'PASSWORD_REUSED',

  // Request shape
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',

  // Catalogue / commerce
  OUT_OF_STOCK: 'OUT_OF_STOCK',
  PRICE_CHANGED: 'PRICE_CHANGED',
  CART_EMPTY: 'CART_EMPTY',
  COUPON_NOT_FOUND: 'COUPON_NOT_FOUND',
  COUPON_EXPIRED: 'COUPON_EXPIRED',
  COUPON_INACTIVE: 'COUPON_INACTIVE',
  COUPON_MIN_ORDER: 'COUPON_MIN_ORDER',
  COUPON_LIMIT_REACHED: 'COUPON_LIMIT_REACHED',
  COUPON_ALREADY_USED: 'COUPON_ALREADY_USED',

  // Orders
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  MISSING_TRANSITION_FIELD: 'MISSING_TRANSITION_FIELD',
  INVOICE_REQUIRED: 'INVOICE_REQUIRED',
  REFUND_NOT_ALLOWED: 'REFUND_NOT_ALLOWED',
  PAYMENT_VERIFICATION_FAILED: 'PAYMENT_VERIFICATION_FAILED',

  // Content
  SLUG_TAKEN: 'SLUG_TAKEN',
  SLUG_IMMUTABLE: 'SLUG_IMMUTABLE',
  NOTHING_TO_PUBLISH: 'NOTHING_TO_PUBLISH',

  // Infrastructure
  INTEGRATION_NOT_CONFIGURED: 'INTEGRATION_NOT_CONFIGURED',
  UPSTREAM_FAILED: 'UPSTREAM_FAILED',
  INTERNAL: 'INTERNAL',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  MAINTENANCE_MODE: 'MAINTENANCE_MODE',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Per-field messages, keyed by field name — drives §17.3 inline form errors. */
export type FieldErrors = Record<string, string>;

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCodeValue;
  readonly fields?: FieldErrors;
  /** Extra context for the client, e.g. { sku } on OUT_OF_STOCK. */
  readonly details?: Record<string, unknown>;
  /** False for genuine bugs — the handler logs those at error level. */
  readonly isExpected: boolean;

  constructor(
    status: number,
    code: ErrorCodeValue,
    message: string,
    opts: { fields?: FieldErrors; details?: Record<string, unknown>; isExpected?: boolean } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.fields = opts.fields;
    this.details = opts.details;
    this.isExpected = opts.isExpected ?? true;
    Error.captureStackTrace?.(this, AppError);
  }
}

// ---- Constructors for the common cases ------------------------------------

export const badRequest = (
  message: string,
  code: ErrorCodeValue = ErrorCode.VALIDATION_FAILED,
  fields?: FieldErrors,
) => new AppError(400, code, message, { fields });

export const unauthenticated = (
  message = 'Authentication required.',
  code: ErrorCodeValue = ErrorCode.UNAUTHENTICATED,
) => new AppError(401, code, message);

export const forbidden = (
  message = 'You do not have permission to do that.',
  code: ErrorCodeValue = ErrorCode.FORBIDDEN,
) => new AppError(403, code, message);

export const notFound = (what = 'Resource') =>
  new AppError(404, ErrorCode.NOT_FOUND, `${what} not found.`);

export const conflict = (
  message: string,
  code: ErrorCodeValue = ErrorCode.CONFLICT,
  details?: Record<string, unknown>,
) => new AppError(409, code, message, { details });

export const unprocessable = (message: string, fields?: FieldErrors) =>
  new AppError(422, ErrorCode.VALIDATION_FAILED, message, { fields });

export const rateLimited = (message = 'Too many requests. Please try again later.') =>
  new AppError(429, ErrorCode.RATE_LIMITED, message);

export const internal = (message = 'Something went wrong.') =>
  new AppError(500, ErrorCode.INTERNAL, message, { isExpected: false });

export const upstreamFailed = (service: string) =>
  new AppError(502, ErrorCode.UPSTREAM_FAILED, `${service} is unavailable. Please try again.`, {
    isExpected: false,
  });

/**
 * A third-party integration has no credentials on this environment.
 *
 * Expected, not a bug: Phases 0–2 deliberately run without Razorpay, Cloudinary
 * or ZeptoMail accounts. Marked expected so the handler logs it at info and does
 * not attach a stack trace.
 */
export const notConfigured = (service: string) =>
  new AppError(
    503,
    ErrorCode.INTEGRATION_NOT_CONFIGURED,
    `${service} is not configured on this environment.`,
  );
