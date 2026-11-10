/**
 * Issued invoices do not change when the company's details or tax settings do.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, OrderStatus, PaymentMethod, PaymentStatus } from '@prisma/client';
import { invoiceSnapshotFor, currentInvoiceSnapshot } from './invoice-seller';

const prisma = new PrismaClient();
const ORDER_NO = `ZZINV${Date.now()}`;

beforeAll(async () => {
  await prisma.order.create({
    data: {
      orderNo: ORDER_NO,
      email: 'zzinv@zewafeeds.test',
      phone: '+919000000001',
      status: OrderStatus.PENDING,
      paymentMethod: PaymentMethod.COD,
      paymentStatus: PaymentStatus.UNPAID,
      shippingAddress: { name: 'Inv Test', line1: 'x', city: 'Kochi', state: 'Kerala', pincode: '682001' },
      subtotalPaise: 10000,
      discountPaise: 0,
      shippingPaise: 0,
      totalPaise: 10000,
    } as never,
  });
});

afterAll(async () => {
  await prisma.order.deleteMany({ where: { orderNo: ORDER_NO } });
  await prisma.$disconnect();
});

describe('invoice snapshot', () => {
  it('freezes an older order on first render, then never changes it', async () => {
    const first = await invoiceSnapshotFor(ORDER_NO);
    expect(first).toEqual(await currentInvoiceSnapshot());

    // Someone edits the frozen copy's source of truth: simulate by changing what is stored
    // to a different (earlier) set of details. Later renders must keep using the stored one.
    const earlier = { ...first, address: 'Old registered address, Kerala', gstin: '32OLDGSTIN0000' };
    await prisma.order.update({ where: { orderNo: ORDER_NO }, data: { invoiceSnapshot: earlier } });
    expect(await invoiceSnapshotFor(ORDER_NO)).toEqual(earlier);
  });
});
