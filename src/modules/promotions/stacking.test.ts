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
