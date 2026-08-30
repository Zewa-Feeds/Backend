/**
 * Auth routes — /api/v1/admin/auth/*
 *
 * This is the ONLY admin router mounted above the auth guard, because login must
 * be reachable unauthenticated. Everything here is therefore explicit about what
 * it requires: the pre-session endpoints take a challengeToken, and the
 * post-session ones are individually wrapped in requireAuth.
 *
 * Token placement, and why:
 *   - access token  → response BODY, held in memory by the CMS. Not a cookie, so
 *                     it cannot be sent automatically and CSRF does not apply.
 *   - refresh token → httpOnly + SameSite=strict COOKIE, so JS (and therefore
 *                     XSS) cannot read it. SameSite=strict is the CSRF defence:
 *                     the browser will not attach it to a cross-site request.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '@/middleware/asyncHandler';
import { validate, emailSchema } from '@/middleware/validate';
import { requireAuth } from '@/middleware/auth';
import { currentUser } from '@/middleware/auth';
import { loginLimiter, passwordResetLimiter, twofaLimiter } from '@/middleware/rateLimit';
import { auditContext } from '@/modules/audit/audit.service';
import { verifyAccessToken } from '@/lib/tokens';
import { unauthenticated } from '@/lib/errors';
import { env } from '@/config/env';
import { plainText } from '@/lib/sanitize';
import { PASSWORD_RULES } from './password.policy';
import * as authService from './auth.service';
import { ttlToMs } from './auth.service';

export const authRouter = Router();

/** Name kept generic — it should not advertise what it holds. */
const REFRESH_COOKIE = 'zewa_rt';

/**
 * The refresh cookie, and why it is a CONVENIENCE rather than the session.
 *
 * In production the CMS is `cms.zewafeeds.com` and this API is
 * `zewa-api.onrender.com` — different registrable domains, so `zewa_rt` is a
 * THIRD-PARTY cookie. `SameSite=None; Secure` is the most that can be asked for
 * and it still is not enough: Safari's ITP blocks it outright, Chrome blocks it
 * in Incognito and under its third-party cookie controls, and Firefox partitions
 * it. A session that depends on this cookie is a session that vanishes for a
 * large share of users with no error to show for it.
 *
 * So the cookie is set, and used when the browser allows it, but the CMS treats
 * the refresh token it holds itself as authoritative and sends it in the request
 * body. This is not two competing mechanisms: it is one credential, with the
 * cookie as an additional carrier for it.
 *
 * The durable fix is to serve this API from a sibling subdomain — `api.zewafeeds.com`
 * — which makes `zewa_rt` first-party, at which point the body copy can be
 * dropped and the token can go back to being httpOnly-only.
 */
const refreshCookieOptions = (maxAgeMs?: number) =>
  ({
    httpOnly: true,
    // SameSite=None is only honoured on a Secure cookie.
    secure: env.isProd,
    sameSite: env.isProd ? ('none' as const) : ('lax' as const),
    path: '/api/v1/admin/auth',
    // Omitting maxAge makes this a SESSION cookie, which dies when the browser
    // closes — correct only when "remember me" was not ticked.
    ...(maxAgeMs !== undefined ? { maxAge: maxAgeMs } : {}),
  }) as const;

/**
 * Cookie lifetime for a "stay signed in" session, taken from the same env value
 * that signs the refresh token (REFRESH_TOKEN_TTL_REMEMBER, default 7d) so the
 * cookie can never outlive the token it carries.
 */
const rememberCookieMaxAge = () => ttlToMs(env.REFRESH_TOKEN_TTL_REMEMBER);

// ---- Schemas ---------------------------------------------------------------

const loginSchema = z.object({
  email: emailSchema,
  // Not policy-checked on login: the stored password may predate a policy change,
  // and rejecting it here would leak which passwords are valid shapes.
  password: z.string().min(1, 'Enter your password.').max(200),
  remember: z.boolean().optional().default(false),
});

const codeSchema = z.object({
  challengeToken: z.string().min(10),
  code: z.string().trim().min(6).max(20),
  remember: z.boolean().optional().default(false),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});

const invitationDetailsSchema = z.object({
  token: z.string().min(10, 'Invalid invitation token.'),
});

const acceptInvitationSchema = z.object({
  token: z.string().min(10, 'Invalid invitation token.'),
  name: z.string().trim().min(2, 'Enter a full name.').max(120).transform(plainText).optional(),
  password: z.string().min(1, 'Enter a password.').max(200),
});

// ============================================================================
// PRE-SESSION — no auth, rate limited
// ============================================================================

/** Fetch invited user details to display on the acceptance page. */
authRouter.get(
  '/invitation-details',
  validate({ query: invitationDetailsSchema }),
  asyncHandler(async (req, res) => {
    const details = await authService.getInvitationDetails(req.query.token as string);
    res.json({ data: details });
  }),
);

/** Accept invitation, create password, and activate account. */
authRouter.post(
  '/accept-invitation',
  loginLimiter,
  validate({ body: acceptInvitationSchema }),
  asyncHandler(async (req, res) => {
    const result = await authService.acceptInvitation(req.body, auditContext(req));
    res.json({ data: result });
  }),
);

/** Step 1 — password. Returns a challenge token, never a session. */
authRouter.post(
  '/login',
  loginLimiter,
  validate({ body: loginSchema }),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const result = await authService.login(email, password, auditContext(req));
    res.json({ data: result });
  }),
);

/** Resend Email OTP verification code. Rate-limited with 60s cooldown. */
authRouter.post(
  '/otp/resend',
  twofaLimiter,
  validate({ body: z.object({ challengeToken: z.string().min(10) }) }),
  asyncHandler(async (req, res) => {
    const result = await authService.resendEmailOtp(req.body.challengeToken, auditContext(req));
    res.json({ data: result });
  }),
);

/** Step 2 — 2FA code. Returns the session. */
authRouter.post(
  '/2fa/verify',
  twofaLimiter,
  validate({ body: codeSchema }),
  asyncHandler(async (req, res) => {
    const { challengeToken, code, remember } = req.body;
    const session = await authService.verifyTwofa(
      challengeToken,
      code,
      auditContext(req),
      remember,
    );

    const cookieMaxAge = remember ? rememberCookieMaxAge() : undefined;
    res.cookie(REFRESH_COOKIE, session.refreshToken, refreshCookieOptions(cookieMaxAge));
    res.json({ data: session });
  }),
);

/** Begin forced 2FA enrolment (§14.3 first login). */
authRouter.post(
  '/2fa/setup',
  twofaLimiter,
  validate({ body: z.object({ challengeToken: z.string().min(10) }) }),
  asyncHandler(async (req, res) => {
    const result = await authService.startTwofaEnrolment(req.body.challengeToken);
    res.json({ data: result });
  }),
);

/** Confirm enrolment; returns the session plus one-time backup codes. */
authRouter.post(
  '/2fa/enroll',
  twofaLimiter,
  validate({ body: codeSchema }),
  asyncHandler(async (req, res) => {
    const { challengeToken, code, remember } = req.body;
    const result = await authService.completeTwofaEnrolment(
      challengeToken,
      code,
      auditContext(req),
      remember,
    );

    const cookieMaxAge = remember ? rememberCookieMaxAge() : undefined;
    res.cookie(REFRESH_COOKIE, result.refreshToken, refreshCookieOptions(cookieMaxAge));
    res.json({ data: result });
  }),
);

/** Rotate the refresh token. Reads from body, header, or cookie. */
authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const token =
      req.body?.refreshToken ||
      (req.headers['x-refresh-token'] as string | undefined) ||
      req.cookies?.[REFRESH_COOKIE];
    if (!token) throw unauthenticated('No session. Please sign in.');

    const session = await authService.refresh(token, auditContext(req));

    const cookieMaxAge = session.isRemembered ? rememberCookieMaxAge() : undefined;
    res.cookie(REFRESH_COOKIE, session.refreshToken, refreshCookieOptions(cookieMaxAge));
    res.json({ data: session });
  }),
);

/** Sign out. Idempotent — always 200, even without a valid session. */
authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const token =
      req.cookies?.[REFRESH_COOKIE] ||
      req.body?.refreshToken ||
      (req.headers['x-refresh-token'] as string | undefined);
    await authService.logout(token);
    /*
     * Clearing MUST repeat the attributes the cookie was set with.
     *
     * A browser matches a deletion against name + domain + path, and it will not
     * accept a SameSite=None cookie delivered without Secure. Passing only
     * `path` here — as this did — produced
     *   `zewa_rt=; Path=/api/v1/admin/auth; Expires=Thu, 01 Jan 1970 …`
     * with no Secure and no SameSite, which a cross-site browser is entitled to
     * ignore. Sign-out revoked the session server-side but could leave the dead
     * cookie sitting in the browser.
     */
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
    res.json({ data: { ok: true } });
  }),
);

/** The §14.2 rules, so the CMS checklist stays in sync with the server. */
authRouter.get('/password-policy', (_req, res) => {
  res.json({
    data: { rules: PASSWORD_RULES.map(({ key, label }) => ({ key, label })) },
  });
});

// ============================================================================
// POST-SESSION — each explicitly guarded, since this router sits above the
// admin router's blanket requireAuth.
// ============================================================================

/** Session restore on page reload. */
authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json({ data: { user } });
  }),
);

authRouter.post(
  '/change-password',
  requireAuth,
  passwordResetLimiter,
  validate({ body: changePasswordSchema }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const { currentPassword, newPassword } = req.body;

    // The caller's own session id, so the re-issued session keeps their
    // "remember me" choice instead of silently dropping to the short TTL.
    const claims = verifyAccessToken(req.get('authorization')?.slice(7) ?? '');

    const session = await authService.changePassword(
      user.id,
      currentPassword,
      newPassword,
      auditContext(req),
      claims.sid,
    );

    res.cookie(
      REFRESH_COOKIE,
      session.refreshToken,
      refreshCookieOptions(session.isRemembered ? rememberCookieMaxAge() : undefined),
    );
    res.json({ data: session });
  }),
);

/** Begin in-profile Authenticator (TOTP) setup. */
authRouter.post(
  '/totp/setup',
  requireAuth,
  twofaLimiter,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const result = await authService.setupTotpForUser(user.id);
    res.json({ data: result });
  }),
);

/** Confirm in-profile Authenticator (TOTP) setup with code. */
authRouter.post(
  '/totp/enroll',
  requireAuth,
  twofaLimiter,
  validate({ body: z.object({ code: z.string().trim().min(6).max(20) }) }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const result = await authService.confirmTotpForUser(user.id, req.body.code, auditContext(req));
    res.json({ data: result });
  }),
);

/** Fresh backup codes. Shown once. */
authRouter.post(
  '/2fa/backup-codes',
  requireAuth,
  twofaLimiter,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const codes = await authService.regenerateBackupCodes(user.id, auditContext(req));
    res.json({ data: { backupCodes: codes } });
  }),
);

authRouter.get(
  '/sessions',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    // Identify the caller's own session so the UI can label it "this device".
    const token = req.get('authorization')?.slice(7) ?? '';
    const claims = verifyAccessToken(token);

    const sessions = await authService.listSessions(user.id, claims.sid);
    res.json({ data: sessions });
  }),
);

authRouter.delete(
  '/sessions/:id',
  requireAuth,
  validate({ params: z.object({ id: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    // Scoped to the caller's own sessions inside the service — see revokeSession.
    await authService.revokeSession(user.id, req.params.id as string, auditContext(req));
    res.json({ data: { ok: true } });
  }),
);
