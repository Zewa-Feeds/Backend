/**
 * Customer self-service cancellation, end to end against a real database.
 *
 * The interesting properties here are all ones a mock cannot prove: that stock
 * actually goes back, that an order belonging to someone else is invisible,
 * that two simultaneous transitions cannot both land, and that the customer's
 * cancellation email is queued exactly once.
 *
 * The email queue IS mocked — it is Redis, and what matters is which jobs were
 * enqueued with which payload, not that BullMQ works.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const queued: { name: string; data: any; opts: any }[] = [];
vi.mock('@/jobs/queues', () => ({
  emailQueue: {
    add: vi.fn(async (name: string, data: unknown, opts?: unknown) => {
      queued.push({ name, data, opts });
      return { id: 'job' };
    }),
  },
  paymentQueue: { add: vi.fn(async () => ({ id: 'job' })) },
  maintenanceQueue: { add: vi.fn(async () => ({ id: 'job' })) },
}));

/* Static imports are safe despite the mock above: vitest hoists vi.mock over
   the import graph, so these already see the mocked queue module. */
import { PrismaClient, OrderStatus, PaymentStatus, PaymentMethod } from '@prisma/client';
import { cancelByCustomer, transition } from './orders.service';
import { ns, sweepFixtures, testActor, testCtx } from '@/test/fixtures';

const prisma = new PrismaClient();

const CUSTOMER = { id: '', email: '' };
let actorId = '';

/** A product variant with known stock, so restocking is measurable. */
async function makeVariant(stock: number) {
  const slug = ns('cancel');
  const family = await prisma.productFamily.create({
    data: {
      slug,
      name: `ZZ Cancel ${slug}`,
      category: 'SLOW_SINKING_PELLETS',
      shortDesc: 'fixture',
      variants: {
        create: {
          sku: slug.toUpperCase(),
          pack: '45g',
          mrpPaise: 20000,
          pricePaise: 18000,
          stock,
        },
      },
    },
    include: { variants: true },
  });
  return { familyId: family.id, variant: family.variants[0]! };
}

async function makeOrder(opts: {
  status?: any;
  paymentStatus?: any;
  paymentMethod?: any;
  email?: string;
  customerId?: string | null;
  variantId?: string;
  qty?: number;
}) {
  const orderNo = ns('ord').toUpperCase().slice(0, 20);
  return prisma.order.create({
    data: {
      orderNo,
      customerId: opts.customerId === undefined ? CUSTOMER.id : opts.customerId,
      email: opts.email ?? CUSTOMER.email,
      phone: '9876543210',
      status: opts.status ?? OrderStatus.PENDING,
      paymentStatus: opts.paymentStatus ?? PaymentStatus.UNPAID,
      paymentMethod: opts.paymentMethod ?? PaymentMethod.COD,
      subtotalPaise: 18000,
      totalPaise: 18000,
      shippingAddress: { name: 'Test', line1: 'X', city: 'Y', state: 'Z', pincode: '680014' },
      items: opts.variantId
        ? {
            create: {
              variantId: opts.variantId,
              productName: 'ZZ fixture',
              sku: 'ZZ-SKU',
              pack: '45g',
              unitPricePaise: 18000,
              qty: opts.qty ?? 2,
              hsn: '23099090',
              taxRatePct: '0.00',
              lineTotalPaise: 18000,
            },
          }
        : undefined,
    },
    select: { id: true, orderNo: true },
  });
}

const asCustomer = (reason?: string | null) => ({
  customer: { id: CUSTOMER.id, email: CUSTOMER.email },
  reason: reason ?? null,
  ctx: {
    actorId: null,
    actorName: CUSTOMER.email,
    actorRole: 'CUSTOMER',
    ip: '127.0.0.1',
  },
});

beforeEach(async () => {
  queued.length = 0;
  if (!CUSTOMER.id) {
    const email = `${ns('cust')}@example.invalid`;
    const c = await prisma.customer.create({
      data: { email, firstName: 'Zz', lastName: 'Fixture' },
      select: { id: true, email: true },
    });
    CUSTOMER.id = c.id;
    CUSTOMER.email = c.email;
    actorId = await testActor(prisma);
  }
});

afterAll(async () => {
  await prisma.order.deleteMany({ where: { email: CUSTOMER.email } });
  await prisma.customer.deleteMany({ where: { id: CUSTOMER.id } });
  await sweepFixtures(prisma);
  await prisma.$disconnect();
});

describe('customer cancellation — allowed states', () => {
  it('cancels a PENDING order', async () => {
    const { variant } = await makeVariant(10);
    const order = await makeOrder({ variantId: variant.id, qty: 2 });

    const result = await cancelByCustomer(order.orderNo, asCustomer('Changed my mind'));

    expect(result.status).toBe(OrderStatus.CANCELLED);
    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { status: true, cancelledAt: true, cancelReason: true },
    });
    expect(row.status).toBe(OrderStatus.CANCELLED);
    expect(row.cancelledAt).toBeInstanceOf(Date);
    expect(row.cancelReason).toContain('Changed my mind');
  });

  it('cancels an accepted (PROCESSING) order that has not shipped', async () => {
    const { variant } = await makeVariant(5);
    const order = await makeOrder({ status: OrderStatus.PROCESSING, variantId: variant.id });

    const result = await cancelByCustomer(order.orderNo, asCustomer());
    expect(result.status).toBe(OrderStatus.CANCELLED);
  });

  it('records the reason with a customer attribution prefix', async () => {
    const order = await makeOrder({});
    await cancelByCustomer(order.orderNo, asCustomer('Ordered by mistake'));

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { cancelReason: true },
    });
    // The column also holds staff reasons; the origin has to be legible in the CMS.
    expect(row.cancelReason).toBe('Cancelled by customer — Ordered by mistake');
  });

  it('records "no reason given" when the customer skips the reason', async () => {
    const order = await makeOrder({});
    await cancelByCustomer(order.orderNo, asCustomer(null));

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { cancelReason: true },
    });
    expect(row.cancelReason).toBe('Cancelled by customer — no reason given');
  });
});

describe('customer cancellation — blocked states', () => {
  it('refuses a SHIPPED order even though the lifecycle would allow it', async () => {
    const order = await makeOrder({ status: OrderStatus.SHIPPED });
    await expect(cancelByCustomer(order.orderNo, asCustomer())).rejects.toMatchObject({
      status: 409,
    });

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { status: true },
    });
    expect(row.status).toBe(OrderStatus.SHIPPED);
  });

  it('refuses a DELIVERED order', async () => {
    const order = await makeOrder({ status: OrderStatus.DELIVERED });
    await expect(cancelByCustomer(order.orderNo, asCustomer())).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe('customer cancellation — ownership', () => {
  it("cannot cancel another customer's order, and is told not-found rather than forbidden", async () => {
    const other = await prisma.customer.create({
      data: { email: `${ns('other')}@example.invalid`, firstName: 'Zz', lastName: 'Other' },
      select: { id: true, email: true },
    });
    const order = await makeOrder({ customerId: other.id, email: other.email });

    // 404, not 403 — a 403 would confirm the order number exists.
    await expect(cancelByCustomer(order.orderNo, asCustomer())).rejects.toMatchObject({
      status: 404,
    });

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { status: true },
    });
    expect(row.status).toBe(OrderStatus.PENDING);

    await prisma.order.deleteMany({ where: { id: order.id } });
    await prisma.customer.deleteMany({ where: { id: other.id } });
  });

  it('matches a guest order by email when there is no customerId', async () => {
    const order = await makeOrder({ customerId: null, email: CUSTOMER.email });
    const result = await cancelByCustomer(order.orderNo, asCustomer());
    expect(result.status).toBe(OrderStatus.CANCELLED);
  });
});

describe('customer cancellation — idempotency and races', () => {
  it('treats a repeat cancellation as success rather than an error', async () => {
    const order = await makeOrder({});
    await cancelByCustomer(order.orderNo, asCustomer('Changed my mind'));

    const second = await cancelByCustomer(order.orderNo, asCustomer('Changed my mind'));
    expect(second.status).toBe(OrderStatus.CANCELLED);
  });

  it('queues the customer cancellation email exactly once across a double submit', async () => {
    const order = await makeOrder({});
    await cancelByCustomer(order.orderNo, asCustomer());
    await cancelByCustomer(order.orderNo, asCustomer());

    const customerEmails = queued.filter(
      (j) => j.data?.kind === 'customer' && j.data?.template === 'order-cancelled',
    );
    expect(customerEmails).toHaveLength(1);
  });

  it('does not restock twice when cancellation is repeated', async () => {
    const { variant } = await makeVariant(10);
    const order = await makeOrder({ variantId: variant.id, qty: 3 });

    await cancelByCustomer(order.orderNo, asCustomer());
    await cancelByCustomer(order.orderNo, asCustomer());

    const after = await prisma.productVariant.findUniqueOrThrow({
      where: { id: variant.id },
      select: { stock: true },
    });
    expect(after.stock).toBe(13); // 10 + 3, once.
  });

  it('loses safely when ops ships the order first', async () => {
    const order = await makeOrder({});

    /* Accept it first — that is what mints the invoice number a dispatch
       requires, so this follows the real path rather than a shortcut. */
    await transition(
      order.orderNo,
      { to: OrderStatus.PROCESSING, fields: {}, notifyCustomer: false },
      testCtx(actorId),
    );

    // Ops wins the race; the customer's request arrives against a stale view.
    await transition(
      order.orderNo,
      {
        to: OrderStatus.SHIPPED,
        fields: { carrier: 'DTDC', trackingNumber: 'ZZ123' },
        notifyCustomer: false,
      },
      testCtx(actorId),
    );

    await expect(cancelByCustomer(order.orderNo, asCustomer())).rejects.toMatchObject({
      status: 409,
    });

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { status: true },
    });
    expect(row.status).toBe(OrderStatus.SHIPPED);
  });
});

describe('customer cancellation — stock', () => {
  it('returns reserved stock to the variant', async () => {
    const { variant } = await makeVariant(7);
    const order = await makeOrder({ variantId: variant.id, qty: 4 });

    await cancelByCustomer(order.orderNo, asCustomer());

    const after = await prisma.productVariant.findUniqueOrThrow({
      where: { id: variant.id },
      select: { stock: true },
    });
    expect(after.stock).toBe(11);
  });
});

describe('customer cancellation — payment and refunds', () => {
  it('creates NO refund for a paid Razorpay order — that stays an admin action', async () => {
    const order = await makeOrder({
      paymentMethod: PaymentMethod.RAZORPAY,
      paymentStatus: PaymentStatus.PAID,
    });

    await cancelByCustomer(order.orderNo, asCustomer());

    const refunds = await prisma.refund.findMany({ where: { orderId: order.id } });
    expect(refunds).toHaveLength(0);

    // Money is still ours until someone sends it back; saying otherwise would lie.
    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { paymentStatus: true, status: true },
    });
    expect(row.paymentStatus).toBe(PaymentStatus.PAID);
    expect(row.status).toBe(OrderStatus.CANCELLED);
  });

  it('creates no refund for COD either', async () => {
    const order = await makeOrder({
      paymentMethod: PaymentMethod.COD,
      paymentStatus: PaymentStatus.UNPAID,
    });

    await cancelByCustomer(order.orderNo, asCustomer());

    const refunds = await prisma.refund.findMany({ where: { orderId: order.id } });
    expect(refunds).toHaveLength(0);
  });
});

describe('customer cancellation — notifications', () => {
  it('queues the customer cancellation email through the existing lifecycle template', async () => {
    const order = await makeOrder({});
    await cancelByCustomer(order.orderNo, asCustomer('Delivery time is too long'));

    const email = queued.find(
      (j) => j.data?.kind === 'customer' && j.data?.template === 'order-cancelled',
    );
    expect(email).toBeTruthy();
    expect(email!.data.orderNo).toBe(order.orderNo);
  });

  it('alerts ops, flagging a paid order as needing a refund', async () => {
    const order = await makeOrder({
      paymentMethod: PaymentMethod.RAZORPAY,
      paymentStatus: PaymentStatus.PAID,
    });
    await cancelByCustomer(order.orderNo, asCustomer());

    const staff = queued.find(
      (j) => j.data?.kind === 'staff' && j.data?.template === 'staff-order-cancelled',
    );
    expect(staff).toBeTruthy();
    expect(staff!.data.context.cancelledBy).toBe('customer');
    expect(staff!.data.context.refundState).toBe('pending');
  });

  it('alerts ops with no refund due for COD', async () => {
    const order = await makeOrder({ paymentStatus: PaymentStatus.UNPAID });
    await cancelByCustomer(order.orderNo, asCustomer());

    const staff = queued.find(
      (j) => j.data?.kind === 'staff' && j.data?.template === 'staff-order-cancelled',
    );
    expect(staff!.data.context.refundState).toBe('none');
  });

  it('keys the ops alert per order so a retry cannot double-send', async () => {
    const order = await makeOrder({});
    await cancelByCustomer(order.orderNo, asCustomer());

    const staff = queued.find((j) => j.data?.template === 'staff-order-cancelled');
    expect(staff!.opts?.jobId).toBe(`staff-cancelled-${order.id}`);
  });
});

describe('customer cancellation — audit trail', () => {
  it('records the actor as CUSTOMER, not as a staff member', async () => {
    const order = await makeOrder({});
    await cancelByCustomer(order.orderNo, asCustomer('Ordered by mistake'));

    const entries = await prisma.auditLog.findMany({
      where: { recordId: order.orderNo },
      select: { actorId: true, actorName: true, actorRole: true, action: true },
    });

    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.actorRole).toBe('CUSTOMER');
      expect(e.actorName).toBe(CUSTOMER.email);
      /*
       * actorId is for CmsUser ids. Writing a customer id there would make the
       * log claim a staff member acted, which is the opposite of the truth
       * this row exists to record.
       */
      expect(e.actorId).toBeNull();
    }

    // The reason is in the trail too, so "why" survives alongside "who".
    expect(entries.some((e) => e.action.includes('Ordered by mistake'))).toBe(true);
  });

  it('stamps the cancellation timestamp', async () => {
    const before = new Date();
    const order = await makeOrder({});
    await cancelByCustomer(order.orderNo, asCustomer());

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { cancelledAt: true },
    });
    expect(row.cancelledAt).toBeInstanceOf(Date);
    expect(row.cancelledAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });
});

describe('admin cancellation still works', () => {
  it('lets an admin cancel a SHIPPED order — the return-to-origin path', async () => {
    const order = await makeOrder({ status: OrderStatus.SHIPPED });

    const result = await transition(
      order.orderNo,
      {
        to: OrderStatus.CANCELLED,
        fields: { cancelReason: 'Returned to origin by courier' },
        notifyCustomer: true,
      },
      testCtx(actorId),
    );

    expect(result.status).toBe(OrderStatus.CANCELLED);
    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { cancelReason: true },
    });
    // No customer prefix — this was staff.
    expect(row.cancelReason).toBe('Returned to origin by courier');
  });

  it('still restocks on an admin cancellation', async () => {
    const { variant } = await makeVariant(2);
    const order = await makeOrder({ variantId: variant.id, qty: 5 });

    await transition(
      order.orderNo,
      { to: OrderStatus.CANCELLED, fields: { cancelReason: 'Out of stock' }, notifyCustomer: false },
      testCtx(actorId),
    );

    const after = await prisma.productVariant.findUniqueOrThrow({
      where: { id: variant.id },
      select: { stock: true },
    });
    expect(after.stock).toBe(7);
  });
});
