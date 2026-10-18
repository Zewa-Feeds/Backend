/**
 * Total spent on the website — ONE definition, used everywhere the CMS shows it.
 *
 * Money actually taken, net of refunds:
 *   - online orders that were paid (PAID, PARTIALLY_REFUNDED, REFUNDED), and
 *   - Cash on Delivery orders that were delivered (the cash changed hands then),
 *   minus every refund recorded against the order, never below zero.
 *
 * Unpaid attempts count for nothing, and so does a cancelled order once it is
 * refunded — but a cancelled order whose money has not been returned yet still
 * counts, because the customer is still out of pocket. The previous figure
 * counted only `paymentStatus === PAID`, which dropped delivered COD orders and
 * any order with a partial refund entirely, and never subtracted refunds.
 */
import { OrderStatus, PaymentMethod, PaymentStatus, type Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export const SPEND_ORDER_SELECT = {
  status: true,
  paymentStatus: true,
  paymentMethod: true,
  totalPaise: true,
  refunds: { select: { amountPaise: true } },
} satisfies Prisma.OrderSelect;

export type SpendOrder = Prisma.OrderGetPayload<{ select: typeof SPEND_ORDER_SELECT }>;

const PAID_STATES: PaymentStatus[] = [
  PaymentStatus.PAID,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
];

export function orderSpendPaise(o: SpendOrder): number {
  const collected =
    PAID_STATES.includes(o.paymentStatus) ||
    (o.paymentMethod === PaymentMethod.COD && o.status === OrderStatus.DELIVERED);
  if (!collected) return 0;
  const refunded = o.refunds.reduce((sum, r) => sum + r.amountPaise, 0);
  return Math.max(0, o.totalPaise - refunded);
}

export function totalSpendPaise(orders: SpendOrder[]): number {
  return orders.reduce((sum, o) => sum + orderSpendPaise(o), 0);
}

/** Total spent per customer, for a page of customers in one query. */
export async function spendByCustomer(customerIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>(customerIds.map((id) => [id, 0]));
  if (customerIds.length === 0) return out;
  const orders = await prisma.order.findMany({
    where: { customerId: { in: customerIds } },
    select: { customerId: true, ...SPEND_ORDER_SELECT },
  });
  for (const o of orders) {
    if (!o.customerId) continue;
    out.set(o.customerId, (out.get(o.customerId) ?? 0) + orderSpendPaise(o));
  }
  return out;
}
