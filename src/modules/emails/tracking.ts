/**
 * Which emails report opens.
 *
 * ZeptoMail implements open tracking with a 1×1 transparent pixel, so switching it
 * on for a template means putting an invisible image in that mail. That is routine
 * for order and marketing mail and hard to justify on a password reset, which is
 * why this is a per-template decision rather than one global flag.
 *
 * Defaults live in code; the CMS can override any of them without a deployment.
 *
 * WHAT THE DATA CAN AND CANNOT TELL YOU
 *
 * An open is decent evidence of delivery. Its ABSENCE proves nothing: most clients
 * block or proxy remote images, so a genuinely read email can record no open at
 * all, while a proxy prefetch can record one no human saw. Treating "no open" as
 * "never read" is the mistake this comment exists to prevent.
 */

/** Template classes that carry a single-use credential. */
const SECURITY_TEMPLATES = [
  'cms-login-otp',
  'cms-user-invitation',
  'password-reset',
  'password-changed',
  'customer-email-verification',
] as const;

/**
 * Per-template defaults.
 *
 * Security mail is OFF and should stay off: a read receipt on a password reset is
 * hard to justify, delivery rather than readership is what matters there, and open
 * data on security events is a category of record better not accumulated by
 * accident. Everything else is ON, where "did they see it?" is a real support
 * question.
 */
export const TRACKING_DEFAULTS: Record<string, boolean> = {
  'order-placed': true,
  'order-confirmed': true,
  'order-shipped': true,
  'order-delivered': true,
  'order-cancelled': true,
  'refund-processed': true,

  'coins-earned': true,
  'coins-expiring': true,
  'coins-adjusted': true,

  // Internal recipients, so no privacy question.
  'staff-new-order': true,
  'staff-refund-processed': true,
  'staff-order-cancelled': true,
  'staff-stock-zero': true,
  'staff-new-review': true,

  ...Object.fromEntries(SECURITY_TEMPLATES.map((t) => [t, false])),
};

/**
 * Should this template report opens?
 *
 * `overrides` comes from settings, so ops can change any template without a
 * deployment. An unknown template defaults to FALSE — a new template should have to
 * opt in deliberately rather than start tracking because nobody listed it.
 */
export function shouldTrackOpens(
  template: string | null | undefined,
  overrides: Record<string, boolean> = {},
): boolean {
  if (!template) return false;
  if (Object.prototype.hasOwnProperty.call(overrides, template)) return overrides[template]!;
  return TRACKING_DEFAULTS[template] ?? false;
}

/** True for templates carrying a single-use credential. */
export function isSecurityTemplate(template: string | null | undefined): boolean {
  return Boolean(template && (SECURITY_TEMPLATES as readonly string[]).includes(template));
}
