/**
 * How many real orders a customer has placed.
 *
 * This is what "first order", "first 2 orders" and "existing customer" are
 * measured against, so what counts is the whole question.
 *
 * ---------------------------------------------------------------------------
 * What counts as a qualifying order
 * ---------------------------------------------------------------------------
 * The codebase already commits to a definition of a real order, in the two
 * places `confirmRedemption()` is called: an online order counts when payment is
 * captured, and a COD order counts when ops ACCEPTS it (PROCESSING) — the
 * commitment point, since payment lands on delivery.
 *
 * Reusing that definition rather than inventing one means "first order" and
 * "revenue" can never disagree about what an order is.
 *
 *   status != CANCELLED
 *   AND ( paymentStatus IN (PAID, PARTIALLY_REFUNDED)
 *         OR (paymentMethod = COD AND status IN (PROCESSING, SHIPPED, DELIVERED)) )
 *
 * So an abandoned cart never counts (no Order row exists at all), an unpaid
 * Razorpay order never counts, and a cancelled order stops counting. A fully
 * refunded order DOES count: it happened, and refunding it does not hand back a
 * first-order discount that was already spent.
 *
 * ---------------------------------------------------------------------------
 * Identity
 * ---------------------------------------------------------------------------
 * Matched on email OR customerId, never one alone. Email alone misses orders
 * placed while signed in under a different address; customerId alone misses
 * guest orders placed before the account existed. Together they close the gap a
 * shopper could otherwise walk through to qualify as "first order" repeatedly.
 *
 * `Customer.email` is unique and checkout links a guest to a Customer row by
 * lowercased email, so the two identities converge on their own. The remaining
 * evasion — a fresh email per order — is one no email-keyed system can prevent,
 * and the existing per-customer limit already accepts it.
 */
import { OrderStatus, PaymentMethod, PaymentStatus, type Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

/** The WHERE fragment defining a qualifying order. Exported so tests pin it. */
export function qualifyingOrderWhere(
  email?: string,
  customerId?: string | null,
): Prisma.OrderWhereInput | null {
  const identity: Prisma.OrderWhereInput[] = [];
  if (email) identity.push({ email: email.toLowerCase() });
  if (customerId) identity.push({ customerId });
  // No identity at all — a guest who has not typed an email yet. Nothing to count.
  if (identity.length === 0) return null;

  return {
    OR: identity,
    status: { not: OrderStatus.CANCELLED },
    AND: [
      {
        OR: [
          { paymentStatus: { in: [PaymentStatus.PAID, PaymentStatus.PARTIALLY_REFUNDED] } },
          {
            paymentMethod: PaymentMethod.COD,
            status: {
              in: [OrderStatus.PROCESSING, OrderStatus.SHIPPED, OrderStatus.DELIVERED],
            },
          },
        ],
      },
    ],
  };
}

/**
 * Count this customer's qualifying orders.
 *
 * One indexed query — `Order[email, status, paymentStatus]` exists for exactly
 * this. Returns 0 when there is no identity to count against, which makes an
 * anonymous cart look like a first-time buyer; checkout re-evaluates with a real
 * email before anything is charged, so a promotion quoted here is still verified
 * against the true count before it is honoured.
 */
export async function qualifyingOrderCount(
  email?: string,
  customerId?: string | null,
): Promise<number> {
  const where = qualifyingOrderWhere(email, customerId);
  if (!where) return 0;
  return prisma.order.count({ where });
}
