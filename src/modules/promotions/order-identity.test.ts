/**
 * Which orders count as "yours" for a first-order coupon.
 *
 * The WHERE fragment is exported precisely so this can be pinned without a
 * database. It matters because "first order only" was escapable:
 *
 *   - `identified` is `Boolean(ctx.email)`, and the cart only sends an email
 *     once the checkout form has one. A signed-in customer re-pricing before
 *     typing their address looked anonymous, so the prior-order count was
 *     skipped and ZEWA1 was offered to someone who had already used it.
 *   - `email` is client-supplied and optional, so omitting it passed the check
 *     on demand.
 *
 * Both are fixed at the route, which now takes identity from the session. These
 * tests pin the lookup that route feeds.
 */
import { describe, expect, it } from 'vitest';
import { qualifyingOrderWhere } from './orderHistory';

const CUSTOMER = '11111111-1111-4111-8111-111111111111';

/** The OR arm of the built clause, which is the identity being matched. */
const identityOf = (where: ReturnType<typeof qualifyingOrderWhere>) =>
  (where?.OR ?? []) as Record<string, unknown>[];

describe('qualifyingOrderWhere', () => {
  it('returns nothing to count when there is no identity', () => {
    // The old bypass: no email, no customer, so no first-order rule applies.
    expect(qualifyingOrderWhere(undefined, null)).toBeNull();
  });

  it('matches on the customer id when only that is known', () => {
    const identity = identityOf(qualifyingOrderWhere(undefined, CUSTOMER));
    expect(identity).toEqual([{ customerId: CUSTOMER }]);
  });

  it('matches on EITHER identity, so neither alone can be walked around', () => {
    const identity = identityOf(qualifyingOrderWhere('A@Example.com', CUSTOMER));
    // Email is lowercased, because that is how orders store it.
    expect(identity).toEqual([{ email: 'a@example.com' }, { customerId: CUSTOMER }]);
  });

  it('still counts a signed-in order placed under a different email', () => {
    /*
     * The case the email-only check missed, and the reason the route must send
     * the session's customer id: the shopper's order carries a delivery email
     * that is not their account email.
     */
    const identity = identityOf(qualifyingOrderWhere('new-address@example.com', CUSTOMER));
    expect(identity).toContainEqual({ customerId: CUSTOMER });
  });

  it('excludes cancelled orders from the count', () => {
    const where = qualifyingOrderWhere('a@example.com', null);
    expect(where?.status).toEqual({ not: 'CANCELLED' });
  });
});
