/**
 * Cryptographic helpers.
 *
 * Three distinct jobs, deliberately not interchangeable:
 *   - hashPassword / verifyPassword   bcrypt, slow by design (§14.1 cost 12)
 *   - encryptSecret / decryptSecret   AES-256-GCM, reversible — TOTP secrets must
 *                                     be recoverable to verify a code
 *   - hashToken                       SHA-256, fast — refresh tokens are already
 *                                     high-entropy, so stretching adds nothing
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import bcrypt from 'bcryptjs';
import { env } from '@/config/env';

// ---- Passwords -------------------------------------------------------------

export const hashPassword = (plain: string): Promise<string> =>
  bcrypt.hash(plain, env.BCRYPT_COST);

export const verifyPassword = (plain: string, hash: string): Promise<boolean> =>
  bcrypt.compare(plain, hash);

/**
 * Constant-work comparison against a dummy hash.
 *
 * Called when the email does not exist, so a failed login costs the same time
 * whether or not the account is real. Without this, response timing leaks which
 * emails have CMS accounts.
 */
const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEe.PjA4kJ.5Hh2LxMd8/1XZcAo3lKHYMHy';
export const fakeVerify = (): Promise<boolean> => bcrypt.compare('dummy', DUMMY_HASH);

// ---- Reversible encryption for TOTP secrets ---------------------------------

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM standard
const key = () => Buffer.from(env.TWOFA_ENCRYPTION_KEY, 'hex');

/**
 * Encrypt at rest. Output is `iv:authTag:ciphertext`, all base64.
 *
 * A stolen database dump must not yield working TOTP secrets — with them, an
 * attacker could generate valid 2FA codes indefinitely.
 */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(
    ':',
  );
}

export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(':');
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('malformed encrypted payload');
  }
  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(ivB64, 'base64'));
  // Throws if the ciphertext was tampered with — that is the point of GCM.
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

// ---- Opaque tokens ---------------------------------------------------------

/** 256 bits of entropy, URL-safe. Used for refresh tokens. */
export const generateToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/**
 * SHA-256, for storing high-entropy tokens.
 *
 * bcrypt would be wrong here: it is slow on purpose to defend weak human-chosen
 * passwords, but a 256-bit random token is not brute-forceable regardless. Using
 * bcrypt would just make every authenticated request slow.
 */
export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** Length-safe constant-time comparison. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ---- Backup codes (§14.3) --------------------------------------------------

/**
 * 8 single-use codes, formatted `XXXX-XXXX`.
 *
 * Crockford-style alphabet with I/O/0/1/U removed — these get written down and
 * retyped, so ambiguous glyphs cause real support pain.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTVWXYZ23456789';

export function generateBackupCodes(count = 8): string[] {
  return Array.from({ length: count }, () => {
    const chars = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]);
    return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
  });
}

/** Normalise user input before comparison — people add spaces and lowercase. */
export const normaliseBackupCode = (input: string): string =>
  input.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Numeric OTP for the SMS path (§14.3). */
export const generateNumericOtp = (digits = 6): string =>
  String(randomInt(0, 10 ** digits)).padStart(digits, '0');
