/**
 * Stacking resolution — the six scenarios the specification names, plus the
 * determinism guarantee.
 *
 * Pure unit tests, no database. The rule is a function over plain data, and
 * that is deliberate: whether two coupons may combine is the part that must be
 * provably correct, so it is written to be provable cheaply.
 */
import { describe, expect, it } from 'vitest';
import { MAX_STACKED_PROMOTIONS, rankForAutomatic, resolveAll, resolveStack } from './stacking';
import type { Candidate } from './types';

/** A candidate carrying only what the stacking rule reads. */
function candidate(
  code: string,
  stackingMode: Candidate['stackingMode'],
  opts: { priority?: number; automatic?: boolean; combinesWithAutomatic?: boolean } = {},
): Candidate {
  return {
    code,
    stackingMode,
    priority: opts.priority ?? 0,
    automatic: opts.automatic ?? false,
    discountableIdx: [0],
    appliedTo: [],
    coupon: {
      combinesWithAutomatic: opts.combinesWithAutomatic ?? true,
    } as Candidate['coupon'],
  };
}

const codes = (cs: readonly Candidate[]) => cs.map((c) => c.code);

describe('two stackable coupons', () => {
  it('apply together', () => {
    const { accepted, rejected } = resolveStack([
      candidate('SAVE10', 'STACKABLE'),
      candidate('SAVE20', 'STACKABLE'),
    ]);

    expect(codes(accepted)).toEqual(['SAVE10', 'SAVE20']);
    expect(rejected).toHaveLength(0);
  });

  it('apply together up to the stack ceiling, then refuse the surplus', () => {
    const many = Array.from({ length: MAX_STACKED_PROMOTIONS + 2 }, (_, i) =>
      candidate(`S${i}`, 'STACKABLE'),
    );
    const { accepted, rejected } = resolveStack(many);

    expect(accepted).toHaveLength(MAX_STACKED_PROMOTIONS);
    expect(rejected).toHaveLength(2);
    expect(rejected[0]!.errorCode).toBe('COUPON_STACK_LIMIT');
  });
});

describe('stackable + non-stackable', () => {
  it('is rejected, whichever arrives second', () => {
    const first = resolveStack([
      candidate('SAVE10', 'STACKABLE'),
      candidate('ALONE', 'NON_STACKABLE'),
    ]);
    expect(codes(first.accepted)).toEqual(['SAVE10']);
    expect(first.rejected[0]!.code).toBe('ALONE');
    expect(first.rejected[0]!.errorCode).toBe('COUPON_NOT_STACKABLE');

    const other = resolveStack([
      candidate('ALONE', 'NON_STACKABLE'),
      candidate('SAVE10', 'STACKABLE'),
    ]);
    expect(codes(other.accepted)).toEqual(['ALONE']);
    expect(other.rejected[0]!.code).toBe('SAVE10');
    expect(other.rejected[0]!.errorCode).toBe('COUPON_NOT_STACKABLE');
  });

  it('names the coupon it conflicted with, so the message can be acted on', () => {
    const { rejected } = resolveStack([
      candidate('SAVE10', 'STACKABLE'),
      candidate('ALONE', 'NON_STACKABLE'),
    ]);
    expect(rejected[0]!.conflictsWith).toEqual(['SAVE10']);
    expect(rejected[0]!.message).toMatch(/cannot be combined/i);
  });
});

describe('exclusive + anything', () => {
  it('is rejected when the exclusive coupon is already applied', () => {
    const { accepted, rejected } = resolveStack([
      candidate('VIPONLY', 'EXCLUSIVE'),
      candidate('SAVE10', 'STACKABLE'),
    ]);
    expect(codes(accepted)).toEqual(['VIPONLY']);
    expect(rejected[0]!.errorCode).toBe('COUPON_EXCLUSIVE');
  });

  it('is rejected when the exclusive coupon arrives second', () => {
    const { accepted, rejected } = resolveStack([
      candidate('SAVE10', 'STACKABLE'),
      candidate('VIPONLY', 'EXCLUSIVE'),
    ]);
    // The coupon already on the cart is kept; removing it stays the customer's
    // decision rather than something the engine does silently.
    expect(codes(accepted)).toEqual(['SAVE10']);
    expect(rejected[0]!.code).toBe('VIPONLY');
    expect(rejected[0]!.errorCode).toBe('COUPON_EXCLUSIVE');
  });

  it('rejects a second exclusive coupon too', () => {
    const { accepted, rejected } = resolveStack([
      candidate('VIP1', 'EXCLUSIVE'),
      candidate('VIP2', 'EXCLUSIVE'),
    ]);
    expect(codes(accepted)).toEqual(['VIP1']);
    expect(rejected[0]!.errorCode).toBe('COUPON_EXCLUSIVE');
  });
});

describe('two non-stackable coupons', () => {
  it('are rejected together — only the first applies', () => {
    const { accepted, rejected } = resolveStack([
      candidate('ALONE1', 'NON_STACKABLE'),
      candidate('ALONE2', 'NON_STACKABLE'),
    ]);
    expect(codes(accepted)).toEqual(['ALONE1']);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.code).toBe('ALONE2');
    expect(rejected[0]!.errorCode).toBe('COUPON_NOT_STACKABLE');
  });
});

describe('removing a coupon frees the slot', () => {
  it('lets a previously blocked coupon apply once the blocker is gone', () => {
    const blocked = resolveStack([
      candidate('ALONE', 'NON_STACKABLE'),
      candidate('SAVE10', 'STACKABLE'),
    ]);
    expect(codes(blocked.accepted)).toEqual(['ALONE']);

    // The customer removes ALONE and re-submits what is left.
    const freed = resolveStack([candidate('SAVE10', 'STACKABLE')]);
    expect(codes(freed.accepted)).toEqual(['SAVE10']);
    expect(freed.rejected).toHaveLength(0);
  });
});

describe('duplicates', () => {
  it('cannot double a discount by applying the same code twice', () => {
    const { accepted, rejected } = resolveStack([
      candidate('SAVE10', 'STACKABLE'),
      candidate('SAVE10', 'STACKABLE'),
    ]);
    expect(accepted).toHaveLength(1);
    expect(rejected[0]!.errorCode).toBe('COUPON_DUPLICATE');
  });
});

describe('deterministic priority for automatic promotions', () => {
  it('ranks by mode, then priority, then code', () => {
    const pool = [
      candidate('ZSTACK', 'STACKABLE', { priority: 10 }),
      candidate('ASTACK', 'STACKABLE', { priority: 10 }),
      candidate('MIDDLE', 'NON_STACKABLE', { priority: 5 }),
      candidate('TOP', 'EXCLUSIVE', { priority: 99 }),
    ];
    // EXCLUSIVE first despite the worst priority; then NON_STACKABLE; then the
    // two stackables tied on priority, broken alphabetically.
    expect(codes(rankForAutomatic(pool))).toEqual(['TOP', 'MIDDLE', 'ASTACK', 'ZSTACK']);
  });

  it('gives the same answer whatever order the pool arrives in', () => {
    const pool = [
      candidate('B', 'STACKABLE', { priority: 2 }),
      candidate('A', 'STACKABLE', { priority: 1 }),
      candidate('C', 'STACKABLE', { priority: 1 }),
    ];
    const forward = codes(rankForAutomatic(pool));
    const reversed = codes(rankForAutomatic([...pool].reverse()));
    const shuffled = codes(rankForAutomatic([pool[2]!, pool[0]!, pool[1]!]));

    expect(forward).toEqual(['A', 'C', 'B']);
    expect(reversed).toEqual(forward);
    expect(shuffled).toEqual(forward);
  });

  it('lets an eligible exclusive automatic promotion win outright', () => {
    const { accepted } = resolveAll(
      [],
      [
        candidate('AUTOSTACK', 'STACKABLE', { automatic: true, priority: 0 }),
        candidate('AUTOVIP', 'EXCLUSIVE', { automatic: true, priority: 50 }),
      ],
    );
    expect(codes(accepted)).toEqual(['AUTOVIP']);
  });
});

describe('customer codes versus automatic promotions', () => {
  it('gives a typed code precedence over an automatic one', () => {
    const { accepted } = resolveAll(
      [candidate('TYPED', 'NON_STACKABLE')],
      [candidate('AUTO', 'STACKABLE', { automatic: true })],
    );
    expect(codes(accepted)).toEqual(['TYPED']);
  });

  it('drops a losing automatic promotion silently — the customer never asked', () => {
    const { rejected } = resolveAll(
      [candidate('TYPED', 'NON_STACKABLE')],
      [candidate('AUTO', 'STACKABLE', { automatic: true })],
    );
    expect(rejected).toHaveLength(0);
  });

  it('still reports a typed code that lost, because the customer can act on it', () => {
    const { rejected } = resolveAll(
      [candidate('FIRST', 'NON_STACKABLE'), candidate('SECOND', 'STACKABLE')],
      [],
    );
    expect(rejected.map((r) => r.code)).toEqual(['SECOND']);
  });

  it('honours a coupon that refuses to combine with automatic promotions', () => {
    const { accepted, rejected } = resolveAll(
      [candidate('SOLO', 'STACKABLE', { combinesWithAutomatic: false })],
      [candidate('AUTO', 'STACKABLE', { automatic: true })],
    );
    expect(codes(accepted)).toEqual(['SOLO']);
    expect(rejected).toHaveLength(0);
  });
});

/**
 * GLOBALLY_STACKABLE — "rides alongside anything, but only one of its kind".
 *
 * The mode exists so the free-shipping first-order benefit can always apply,
 * whatever else is on the cart, without ever becoming a second percentage
 * discount. Both halves of that need pinning: it must survive an EXCLUSIVE
 * coupon, and a second one must always be refused.
 */
describe('a globally stackable coupon', () => {
  it('applies alongside an EXCLUSIVE coupon that arrived first', () => {
    const { accepted, rejected } = resolveStack([
      candidate('BENS12', 'EXCLUSIVE'),
      candidate('ZEWA1', 'GLOBALLY_STACKABLE'),
    ]);
    expect(codes(accepted)).toEqual(['BENS12', 'ZEWA1']);
    expect(rejected).toHaveLength(0);
  });

  it('applies when it arrived first and an EXCLUSIVE coupon follows', () => {
    // The exclusive coupon must still be judged against the rest of the stack,
    // and here the rest is empty — so it applies too.
    const { accepted, rejected } = resolveStack([
      candidate('ZEWA1', 'GLOBALLY_STACKABLE'),
      candidate('BENS12', 'EXCLUSIVE'),
    ]);
    expect(codes(accepted)).toEqual(['ZEWA1', 'BENS12']);
    expect(rejected).toHaveLength(0);
  });

  it('applies alongside a NON_STACKABLE coupon', () => {
    const { accepted } = resolveStack([
      candidate('ALONE', 'NON_STACKABLE'),
      candidate('ZEWA1', 'GLOBALLY_STACKABLE'),
    ]);
    expect(codes(accepted)).toEqual(['ALONE', 'ZEWA1']);
  });

  it('applies alongside an ordinary stackable coupon', () => {
    const { accepted } = resolveStack([
      candidate('SPECIAL10', 'STACKABLE'),
      candidate('ZEWA1', 'GLOBALLY_STACKABLE'),
    ]);
    expect(codes(accepted)).toEqual(['SPECIAL10', 'ZEWA1']);
  });

  it('REFUSES a second globally stackable coupon', () => {
    // Two of these would stack with nothing to stop them; if both were
    // percentages they would compound. This is the guard that makes the mode
    // safe to hand out.
    const { accepted, rejected } = resolveStack([
      candidate('ZEWA1', 'GLOBALLY_STACKABLE'),
      candidate('OTHERPERK', 'GLOBALLY_STACKABLE'),
    ]);
    expect(codes(accepted)).toEqual(['ZEWA1']);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.code).toBe('OTHERPERK');
    expect(rejected[0]!.message).toMatch(/only one offer of its kind/i);
  });

  it('does not let an exclusive coupon block a later ordinary one through it', () => {
    // ZEWA1 must not act as a shield: SPECIAL10 is still refused by BENS12.
    const { accepted, rejected } = resolveStack([
      candidate('BENS12', 'EXCLUSIVE'),
      candidate('ZEWA1', 'GLOBALLY_STACKABLE'),
      candidate('SPECIAL10', 'STACKABLE'),
    ]);
    expect(codes(accepted)).toEqual(['BENS12', 'ZEWA1']);
    expect(codes(rejected as never)).toEqual(['SPECIAL10']);
  });

  it('still honours the overall stack limit', () => {
    const many = Array.from({ length: MAX_STACKED_PROMOTIONS }, (_, i) =>
      candidate(`S${i}`, 'STACKABLE'),
    );
    const { accepted, rejected } = resolveStack([...many, candidate('ZEWA1', 'GLOBALLY_STACKABLE')]);
    expect(accepted).toHaveLength(MAX_STACKED_PROMOTIONS);
    expect(rejected[0]!.code).toBe('ZEWA1');
  });

  it('is ranked first among automatic promotions, so it is never crowded out', () => {
    const ranked = rankForAutomatic([
      candidate('C', 'STACKABLE'),
      candidate('B', 'EXCLUSIVE'),
      candidate('A', 'GLOBALLY_STACKABLE'),
    ]);
    expect(codes(ranked)[0]).toBe('A');
  });

  it('rides along with an automatic promotion even when the other refuses them', () => {
    const { accepted } = resolveAll(
      [candidate('ZEWA1', 'GLOBALLY_STACKABLE', { combinesWithAutomatic: false })],
      [candidate('AUTOSALE', 'STACKABLE', { automatic: true })],
    );
    // ZEWA1 combines with anything by definition; AUTOSALE is then judged
    // against the rest of the stack, which is empty.
    expect(codes(accepted)).toContain('ZEWA1');
  });
});
