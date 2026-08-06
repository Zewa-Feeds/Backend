/**
 * Authentication and authorization guards.
 *
 * `requireAuth` and `requireEnrolled2fa` are mounted on the ADMIN ROUTER (see
 * routes.ts), not on individual routes. A new admin endpoint is therefore
 * protected because of where it lives — forgetting a guard is not possible.
 *
 * `requirePermission` then narrows further, per route, against the §2.1 matrix.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { CmsUserStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { verifyAccessToken } from '@/lib/tokens';
import { AppError, ErrorCode, forbidden, unauthenticated } from '@/lib/errors';
import { type Permission, can, permissionsFor } from '@/rbac/permissions';
import { logger } from '@/lib/logger';
import type { StaffPrincipal } from '@/types/express';

const log = logger.child({ module: 'auth' });

/** Extract a bearer token. Header only — never a query string, which gets logged. */
function bearerToken(req: Request): string | null {
  const header = req.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * Verify the access token and load the principal.
 *
 * The token carries role and permissions, but we still hit the database on each
 * request to check `status` and `tokenVersion`. That is a deliberate trade: it
 * costs one indexed primary-key lookup, and it is what makes §11.3 true —
 * deactivating a user kills their sessions *immediately* rather than whenever
 * their 15-minute access token happens to expire.
 */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  try {
    const token = bearerToken(req);
    if (!token) {
      /*
       * No token means no session — in EVERY environment.
       *
       * There was previously a dev-only branch here that, when the header was
       * absent, looked up the first ACTIVE user and attached them as req.user.
       * It made every admin endpoint serve full data (orders, customers, users,
       * settings) to a completely anonymous request whenever NODE_ENV was not
       * exactly "production" — which includes `npm run dev` and any container
       * that forgets to set it. It also hid real bugs, because a CMS page that
       * failed to send its token still appeared to work.
       */
      throw unauthenticated('Sign in to continue.');
    }

    const claims = verifyAccessToken(token);

    const user = await prisma.cmsUser.findUnique({
      where: { id: claims.sub },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        status: true,
        tokenVersion: true,
        twofaEnrolledAt: true,
        deletedAt: true,
      },
    });

    if (!user || user.deletedAt) {
      throw unauthenticated('Account no longer exists.', ErrorCode.TOKEN_INVALID);
    }
    if (user.status === CmsUserStatus.DEACTIVATED) {
      throw new AppError(
        403,
        ErrorCode.ACCOUNT_DEACTIVATED,
        'This account has been deactivated.',
      );
    }
    // Bumped by deactivate / password change / terminate-all-sessions.
    if (user.tokenVersion !== claims.ver) {
      throw unauthenticated('Session is no longer valid. Please sign in again.', ErrorCode.TOKEN_INVALID);
    }

    // The session row is the revocation point for a single device.
    const session = await prisma.cmsSession.findUnique({
      where: { id: claims.sid },
      select: { id: true, revokedAt: true, expiresAt: true },
    });
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      throw unauthenticated('Session expired. Please sign in again.', ErrorCode.TOKEN_EXPIRED);
    }

    // Role comes from the DATABASE, not the token — a role change takes effect
    // immediately, and a forged role claim is worthless.
    const principal: StaffPrincipal = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      permissions: permissionsFor(user.role),
    };
    req.user = principal;

    // Best-effort liveness for the §14.4 session list. Never blocks the request.
    void prisma.cmsSession
      .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);

    next();
  } catch (err) {
    next(err);
  }
};

/**
 * §14.3 — 2FA is mandatory for every role.
 *
 * A user who has not finished enrolment holds a valid session but must not reach
 * any module. Only the enrolment endpoints are reachable, and those live above
 * this guard in routes.ts.
 */
export const requireEnrolled2fa: RequestHandler = async (req, _res, next) => {
  try {
    const user = req.user;
    if (!user) throw unauthenticated();

    /*
     * Enforced in every environment. This used to return early outside
     * production, which meant the "2FA is mandatory" rule (§14.3) was never
     * actually exercised in development — the one place it could be tested
     * safely.
     */

    const row = await prisma.cmsUser.findUnique({
      where: { id: user.id },
      select: { twofaEnrolledAt: true },
    });

    if (!row?.twofaEnrolledAt) {
      throw new AppError(
        403,
        ErrorCode.TWOFA_NOT_ENROLLED,
        'Two-factor authentication setup is required before you can continue.',
      );
    }
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Narrow access to holders of a specific permission (§2.1).
 *
 * Denials are logged at warn: a legitimate user does not routinely hit these, so
 * a cluster of them is a signal worth seeing.
 */
export function requirePermission(permission: Permission): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) return next(unauthenticated());

    if (!can(user.role, permission)) {
      log.warn(
        { userId: user.id, role: user.role, permission, path: req.originalUrl },
        'permission denied',
      );
      return next(forbidden('You do not have permission to do that.'));
    }
    next();
  };
}

/** Require ALL of several permissions. */
export function requireAllPermissions(...permissions: Permission[]): RequestHandler {
  return (req, _res, next) => {
    const user = req.user;
    if (!user) return next(unauthenticated());
    const missing = permissions.filter((p) => !can(user.role, p));
    if (missing.length > 0) {
      log.warn({ userId: user.id, missing, path: req.originalUrl }, 'permission denied');
      return next(forbidden('You do not have permission to do that.'));
    }
    next();
  };
}

/**
 * Non-null accessor for handlers behind requireAuth.
 *
 * `req.user` is optional at the type level because the same Request type is used
 * on unguarded routers. This narrows it without scattering non-null assertions.
 */
export function currentUser(req: Request): StaffPrincipal {
  const user = req.user;
  if (!user) {
    // Reaching here means a handler was mounted outside requireAuth — a wiring
    // bug, not a client error.
    throw new AppError(500, ErrorCode.INTERNAL, 'Handler requires authentication.', {
      isExpected: false,
    });
  }
  return user;
}
