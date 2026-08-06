/**
 * Password policy — spec §14.2.
 *
 *   - minimum 10 characters
 *   - at least one uppercase letter, one number, one special character
 *   - cannot reuse the last 5 passwords
 *
 * The CMS's ChangePasswordModal already renders a live checklist against these
 * rules; the same rule set is enforced here so a client bypassing the UI gains
 * nothing.
 */
import { verifyPassword } from '@/lib/crypto';
import { AppError, ErrorCode } from '@/lib/errors';

export interface PolicyRule {
  key: string;
  label: string;
  test: (password: string) => boolean;
}

export const PASSWORD_RULES: PolicyRule[] = [
  {
    key: 'length',
    label: 'At least 10 characters',
    test: (p) => p.length >= 10,
  },
  {
    key: 'uppercase',
    label: 'One uppercase letter',
    test: (p) => /[A-Z]/.test(p),
  },
  {
    key: 'number',
    label: 'One number',
    test: (p) => /\d/.test(p),
  },
  {
    key: 'special',
    label: 'One special character',
    test: (p) => /[^A-Za-z0-9]/.test(p),
  },
];

/** Upper bound — bcrypt silently truncates past 72 bytes, so reject beyond it. */
const MAX_LENGTH = 72;

/** Which rules a candidate password fails. */
export function failedRules(password: string): PolicyRule[] {
  return PASSWORD_RULES.filter((rule) => !rule.test(password));
}

/**
 * Throw unless the password satisfies every rule.
 * The message lists what is missing, for §17.3 inline display.
 */
export function assertPasswordPolicy(password: string): void {
  if (password.length > MAX_LENGTH) {
    throw new AppError(
      422,
      ErrorCode.PASSWORD_POLICY,
      `Password must be ${MAX_LENGTH} characters or fewer.`,
      { fields: { newPassword: `Must be ${MAX_LENGTH} characters or fewer.` } },
    );
  }

  const failed = failedRules(password);
  if (failed.length > 0) {
    throw new AppError(422, ErrorCode.PASSWORD_POLICY, 'Password does not meet the policy.', {
      fields: { newPassword: `Needs: ${failed.map((r) => r.label.toLowerCase()).join(', ')}.` },
      details: { failed: failed.map((r) => r.key) },
    });
  }
}

/** How many previous hashes §14.2 requires us to keep. */
export const PASSWORD_HISTORY_LENGTH = 5;

/**
 * Reject reuse of any of the last 5 passwords.
 *
 * Necessarily O(5) bcrypt comparisons — hashes are salted, so there is no way to
 * look one up. Only runs on password change, never on login.
 */
export async function assertNotReused(
  password: string,
  history: unknown,
  currentHash?: string,
): Promise<void> {
  const hashes: string[] = Array.isArray(history) ? history.filter((h) => typeof h === 'string') : [];

  // The in-use password counts as part of the history.
  const candidates = currentHash ? [currentHash, ...hashes] : hashes;

  for (const hash of candidates.slice(0, PASSWORD_HISTORY_LENGTH)) {
    if (await verifyPassword(password, hash)) {
      throw new AppError(
        422,
        ErrorCode.PASSWORD_REUSED,
        `You cannot reuse any of your last ${PASSWORD_HISTORY_LENGTH} passwords.`,
        { fields: { newPassword: 'This password was used recently.' } },
      );
    }
  }
}

/** Prepend the outgoing hash, capped at the retained length. */
export function pushHistory(history: unknown, outgoingHash: string): string[] {
  const hashes: string[] = Array.isArray(history) ? history.filter((h) => typeof h === 'string') : [];
  return [outgoingHash, ...hashes].slice(0, PASSWORD_HISTORY_LENGTH);
}
