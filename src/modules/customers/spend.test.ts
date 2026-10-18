import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
import { orderSpendPaise, totalSpendPaise, type SpendOrder } from './spend';

const order = (o: Partial<SpendOrder>): SpendOrder => ({
  status: 'DELIVERED',
  paymentStatus: 'PAID',
  paymentMethod: 'RAZORPAY',
  totalPaise: 50000,
  refunds: [],
  ...o,
}) as SpendOrder;

describe('total spent on the website', () => {
  it('counts a paid online order in full', () => {
    expect(orderSpendPaise(order({}))).toBe(50000);
  });

  it('subtracts refunds, including partial ones', () => {
    expect(orderSpendPaise(order({ paymentStatus: 'PARTIALLY_REFUNDED', refunds: [{ amountPaise: 6900 }] }))).toBe(43100);
    expect(orderSpendPaise(order({ paymentStatus: 'REFUNDED', refunds: [{ amountPaise: 50000 }] }))).toBe(0);
  });

  it('counts a delivered COD order, but not one still on its way', () => {
    expect(orderSpendPaise(order({ paymentMethod: 'COD', paymentStatus: 'UNPAID' }))).toBe(50000);
    expect(orderSpendPaise(order({ paymentMethod: 'COD', paymentStatus: 'UNPAID', status: 'SHIPPED' }))).toBe(0);
  });

  it('ignores unpaid attempts and refunded cancellations', () => {
    expect(orderSpendPaise(order({ status: 'PENDING', paymentStatus: 'UNPAID' }))).toBe(0);
    expect(orderSpendPaise(order({ status: 'CANCELLED', paymentStatus: 'REFUNDED', refunds: [{ amountPaise: 50000 }] }))).toBe(0);
  });

  it('still counts a cancelled order whose money has not been returned', () => {
    expect(orderSpendPaise(order({ status: 'CANCELLED', paymentStatus: 'PAID' }))).toBe(50000);
  });

  it('never goes below zero, and sums across orders', () => {
    expect(orderSpendPaise(order({ refunds: [{ amountPaise: 60000 }] }))).toBe(0);
    expect(totalSpendPaise([order({}), order({ totalPaise: 18500 }), order({ paymentStatus: 'UNPAID', status: 'PENDING' })])).toBe(68500);
  });
});
