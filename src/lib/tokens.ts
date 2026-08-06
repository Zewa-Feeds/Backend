/**
 * JWT issuing and verification.
 *
 * Four token types, each with its OWN secret and an explicit `typ` claim:
 *
 *   access    15m   staff API calls
 *   challenge 5m    issued after password, before 2FA — carries no authority
 *   preview   15m   scoped to one draft resource, for storefront Preview
 *   customer  —     storefront account sessions
 *
 * Both defences matter. Separate secrets mean a preview token cannot be verified
 * as an access token even if the algorithm matches. The `typ` claim catches the
 * same class of confusion if a secret is ever reused by mistake.
 *
 * Refresh tokens are deliberately NOT JWTs — they are opaque random strings
 * stored hashed in CmsSession, so they can be revoked server-side. A stateless
 * refresh JWT cannot be revoked, which breaks §11.3.
 */
import jwt, { type SignOptions } from 'jsonwebtoken';
import type { Role } from '@prisma/client';
import { env } from '@/config/env';
import { AppError, ErrorCode } from '@/lib/errors';

const ISSUER = 'zewa-api';

type TokenType = 'access' | 'challenge' | 'preview' | 'customer';

interface BaseClaims {
  typ: TokenType;
  sub: string;
}

export interface AccessClaims extends BaseClaims {
  typ: 'access';
  email: string;
  role: Role;
  /**
   * Session id — lets a single session be revoked without invalidating the user's
   * other devices.
   */
  sid: string;
  /**
   * Token version. Bumped on deactivate / password change / terminate-all, so
   * existing access tokens stop working without a DB lookup per request (§11.3).
   */
  ver: number;
}

export interface ChallengeClaims extends BaseClaims {
  typ: 'challenge';
  /** Whether this user still needs to enrol in 2FA (§14.3 forced first login). */
  enrol: boolean;
}

export interface PreviewClaims extends BaseClaims {
  typ: 'preview';
  /** Resource kind + slug this token is scoped to. */
  kind: 'product' | 'article' | 'homepage';
  slug: string;
}

export interface CustomerClaims extends BaseClaims {
  typ: 'customer';
  email: string;
}

const SECRETS: Record<TokenType, string> = {
  access: env.JWT_ACCESS_SECRET,
  // The challenge token is mid-login and grants nothing but the right to submit a
  // 2FA code, so it rides the access secret. Its `typ` keeps the two distinct.
  challenge: env.JWT_ACCESS_SECRET,
  preview: env.JWT_PREVIEW_SECRET,
  customer: env.JWT_REFRESH_SECRET,
};

const TTLS: Record<TokenType, string> = {
  access: env.ACCESS_TOKEN_TTL,
  challenge: '5m',
  preview: env.PREVIEW_TOKEN_TTL,
  customer: env.REFRESH_TOKEN_TTL,
};

function sign(claims: BaseClaims & Record<string, unknown>): string {
  const { typ } = claims;
  const options: SignOptions = {
    expiresIn: TTLS[typ] as SignOptions['expiresIn'],
    issuer: ISSUER,
    algorithm: 'HS256',
  };
  return jwt.sign(claims, SECRETS[typ], options);
}

/**
 * Verify and narrow to the expected type.
 *
 * Rejecting on a `typ` mismatch is what stops token confusion: a valid preview
 * token presented as a bearer credential fails here rather than being trusted.
 */
function verify<T extends BaseClaims>(token: string, expected: TokenType): T {
  try {
    const decoded = jwt.verify(token, SECRETS[expected], {
      issuer: ISSUER,
      // Pin the algorithm. Without this, a token could claim `alg: none`.
      algorithms: ['HS256'],
    }) as T;

    if (decoded.typ !== expected) {
      throw new AppError(401, ErrorCode.TOKEN_INVALID, 'Invalid token.');
    }
    return decoded;
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof jwt.TokenExpiredError) {
      throw new AppError(401, ErrorCode.TOKEN_EXPIRED, 'Session expired. Please sign in again.');
    }
    throw new AppError(401, ErrorCode.TOKEN_INVALID, 'Invalid token.');
  }
}

// ---- Access ----------------------------------------------------------------

export const signAccessToken = (c: Omit<AccessClaims, 'typ'>): string =>
  sign({ ...c, typ: 'access' });

export const verifyAccessToken = (token: string): AccessClaims =>
  verify<AccessClaims>(token, 'access');

// ---- Challenge (post-password, pre-2FA) ------------------------------------

export const signChallengeToken = (c: Omit<ChallengeClaims, 'typ'>): string =>
  sign({ ...c, typ: 'challenge' });

export const verifyChallengeToken = (token: string): ChallengeClaims =>
  verify<ChallengeClaims>(token, 'challenge');

// ---- Preview (§5.2, §8.3) --------------------------------------------------

export const signPreviewToken = (c: Omit<PreviewClaims, 'typ'>): string =>
  sign({ ...c, typ: 'preview' });

export const verifyPreviewToken = (token: string): PreviewClaims =>
  verify<PreviewClaims>(token, 'preview');

// ---- Customer --------------------------------------------------------------

export const signCustomerToken = (c: Omit<CustomerClaims, 'typ'>): string =>
  sign({ ...c, typ: 'customer' });

export const verifyCustomerToken = (token: string): CustomerClaims =>
  verify<CustomerClaims>(token, 'customer');

/** Seconds until a JWT expires — used to set cookie maxAge coherently. */
export function ttlSeconds(token: string): number {
  const decoded = jwt.decode(token) as { exp?: number } | null;
  if (!decoded?.exp) return 0;
  return Math.max(0, decoded.exp - Math.floor(Date.now() / 1000));
}
