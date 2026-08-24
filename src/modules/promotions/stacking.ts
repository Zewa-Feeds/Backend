/**
 * Which promotions may apply together.
 *
 * The whole rule lives here, in pure functions over plain data. Nothing in this
 * file touches the database, the cart, or money: given a list of promotions it
 * decides which survive and why the rest did not. That is deliberate — stacking
 * is the part that must be provably correct, so it is the part that is cheapest
 * to test.
 *
 * Three modes, set per coupon in the CMS:
 *
 *   STACKABLE      combines freely with other STACKABLE promotions.
 *   NON_STACKABLE  applies alone. Any other code alongside it is refused.
 *   EXCLUSIVE      applies alone, and outranks everything when the engine has
 *                  to choose between eligible promotions with no customer
 *                  preference to go on.
 *
 * ---------------------------------------------------------------------------
 * Why the FIRST candidate wins rather than the "strongest"
 * ---------------------------------------------------------------------------
 * Candidates arrive in preference order. For codes a customer typed, that is
 * the order they applied them, so the coupon already on the cart wins and the
 * new one is refused with a message. The alternative — letting an incoming
 * EXCLUSIVE coupon silently evict a coupon the customer had already applied —
 * changes the total under them without their asking. Removing a coupon stays an
 * explicit customer action; the API only reports the conflict.
 *
 * Exclusivity is enforced identically either way: the combination never prices.
 * Which of the two survives is a UX question, not a correctness one.
 *
 * Automatic promotions have no customer-chosen order, so `rankForAutomatic`
 * imposes a total one — mode, then configured priority, then code.
 */
import { ErrorCode } from '@/lib/errors';
import type { Candidate, PromotionRejection } from './types';

/**
 * A ceiling on how many promotions may combine at once.
 *
 * Not a business rule so much as a blast radius: each stacked promotion is
 * another redemption row and another discount pass, and a request carrying
 * fifty stackable codes should be refused rather than served.
 */
export const MAX_STACKED_PROMOTIONS = 5;

export interface StackResolution {
  accepted: Candidate[];
  rejected: PromotionRejection[];
}

/** EXCLUSIVE outranks NON_STACKABLE outranks STACKABLE. */
const MODE_RANK = { EXCLUSIVE: 0, NON_STACKABLE: 1, STACKABLE: 2 } as const;

/**
 * Order candidates when nobody has expressed a preference.
 *
 * Total and deterministic: mode, then configured priority, then code. The same
 * pool resolves the same way on any server, on any run — there is no dependence
 * on query order, insertion order or the clock.
 */
export function rankForAutomatic(candidates: readonly Candidate[]): Candidate[] {
  return [...candidates].sort(
    (a, b) =>
      MODE_RANK[a.stackingMode] - MODE_RANK[b.stackingMode] ||
      a.priority - b.priority ||
      a.code.localeCompare(b.code),
  );
}

/** "A", "A and B", "A, B and C" — for a message a customer reads. */
function listCodes(candidates: readonly Candidate[]): string {
  const codes = candidates.map((c) => c.code);
  if (codes.length <= 1) return codes[0] ?? '';
  return `${codes.slice(0, -1).join(', ')} and ${codes[codes.length - 1]}`;
}

/**
 * Can `next` join a set that has already been accepted?
 *
 * Null when it can, or the reason it cannot. The conflict is a property of the
 * pair, not of which one arrived first — only the wording depends on which side
 * carries the restriction.
 */
function conflict(
  next: Candidate,
  accepted: readonly Candidate[],
): Omit<PromotionRejection, 'code'> | null {
  if (accepted.length === 0) return null;

  const exclusive = accepted.find((c) => c.stackingMode === 'EXCLUSIVE');
  if (exclusive) {
    return {
      errorCode: ErrorCode.COUPON_EXCLUSIVE,
      message: `${exclusive.code} is an exclusive offer and cannot be combined with ${next.code}.`,
      conflictsWith: [exclusive.code],
    };
  }

  if (next.stackingMode === 'EXCLUSIVE') {
    return {
      errorCode: ErrorCode.COUPON_EXCLUSIVE,
      message: `${next.code} is an exclusive offer. Remove ${listCodes(accepted)} to use it.`,
      conflictsWith: accepted.map((c) => c.code),
    };
  }

  const blocking = accepted.find((c) => c.stackingMode === 'NON_STACKABLE');
  if (blocking) {
    return {
      errorCode: ErrorCode.COUPON_NOT_STACKABLE,
      message: `${blocking.code} cannot be combined with other coupons.`,
      conflictsWith: [blocking.code],
    };
  }

  if (next.stackingMode === 'NON_STACKABLE') {
    return {
      errorCode: ErrorCode.COUPON_NOT_STACKABLE,
      message: `${next.code} cannot be combined with other coupons. Remove ${listCodes(accepted)} to use it.`,
      conflictsWith: accepted.map((c) => c.code),
    };
  }

  /*
   * Both stackable — but a coupon may still refuse to sit beside an AUTOMATIC
   * promotion. Checked in both directions: the restriction belongs to whichever
   * coupon declares it, regardless of which arrived first.
   */
  if (next.automatic) {
    const refuses = accepted.find((c) => !c.coupon.combinesWithAutomatic);
    if (refuses) {
      return {
        errorCode: ErrorCode.COUPON_NOT_STACKABLE,
        message: `${refuses.code} cannot be combined with automatic promotions.`,
        conflictsWith: [refuses.code],
      };
    }
  }
  if (!next.coupon.combinesWithAutomatic) {
    const auto = accepted.find((c) => c.automatic);
    if (auto) {
      return {
        errorCode: ErrorCode.COUPON_NOT_STACKABLE,
        message: `${next.code} cannot be combined with the ${auto.code} promotion.`,
        conflictsWith: [auto.code],
      };
    }
  }

  if (accepted.length >= MAX_STACKED_PROMOTIONS) {
    return {
      errorCode: ErrorCode.COUPON_STACK_LIMIT,
      message: `You can use up to ${MAX_STACKED_PROMOTIONS} coupons on one order.`,
      conflictsWith: accepted.map((c) => c.code),
    };
  }

  return null;
}

/**
 * Resolve a candidate list into the set that may apply together.
 *
 * `candidates` must already be in preference order. Duplicates are refused
 * rather than counted twice, so applying the same code again cannot double a
 * discount.
 */
export function resolveStack(candidates: readonly Candidate[]): StackResolution {
  const accepted: Candidate[] = [];
  const rejected: PromotionRejection[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (seen.has(candidate.code)) {
      rejected.push({
        code: candidate.code,
        errorCode: ErrorCode.COUPON_DUPLICATE,
        message: `${candidate.code} is already applied.`,
        conflictsWith: [candidate.code],
      });
      continue;
    }
    seen.add(candidate.code);

    const problem = conflict(candidate, accepted);
    if (problem) {
      rejected.push({ code: candidate.code, ...problem });
      continue;
    }
    accepted.push(candidate);
  }

  return { accepted, rejected };
}

/**
 * Resolve explicit codes and automatic promotions together.
 *
 * Codes the customer typed are offered first, in the order they applied them —
 * their intent outranks a promotion the shop applied on their behalf. Automatic
 * promotions then compete for whatever slots remain, in ranked order.
 *
 * An automatic promotion that loses is dropped silently: the customer never
 * asked for it, so telling them it was refused would be noise. Only codes they
 * actually entered produce a rejection they can read.
 */
export function resolveAll(
  requested: readonly Candidate[],
  automatic: readonly Candidate[],
): StackResolution {
  const { accepted, rejected } = resolveStack([...requested, ...rankForAutomatic(automatic)]);
  const requestedCodes = new Set(requested.map((c) => c.code));
  return {
    accepted,
    rejected: rejected.filter((r) => requestedCodes.has(r.code)),
  };
}
