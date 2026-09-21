import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomerStatus, PaymentStatus } from '@prisma/client';

const findMany = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    customer: {
      findMany: (...args: unknown[]) => findMany(...args),
    },
  },
}));

import * as customersService from './customers.service';

const MOCK_CUSTOMERS = [
  {
    id: 'cust-1',
    email: 'alice@example.com',
    phone: '9111111111',
    firstName: 'Alice',
    lastName: 'Adams',
    status: CustomerStatus.ACTIVE,
    registeredAt: new Date('2026-01-01T10:00:00.000Z'),
    emailVerifiedAt: new Date('2026-01-01T11:00:00.000Z'),
    orders: [
      { totalPaise: 10000, paymentStatus: PaymentStatus.PAID },
    ],
  },
  {
    id: 'cust-2',
    email: 'charlie@example.com',
    phone: '9222222222',
    firstName: 'Charlie',
    lastName: 'Clark',
    status: CustomerStatus.ACTIVE,
    registeredAt: new Date('2026-03-01T10:00:00.000Z'),
    emailVerifiedAt: null,
    orders: [
      { totalPaise: 30000, paymentStatus: PaymentStatus.PAID },
      { totalPaise: 20000, paymentStatus: PaymentStatus.PAID },
      { totalPaise: 15000, paymentStatus: PaymentStatus.UNPAID }, // unpaid doesn't count towards spend
    ],
  },
  {
    id: 'cust-3',
    email: 'bob@example.com',
    phone: '9333333333',
    firstName: 'Bob',
    lastName: 'Baker',
    status: CustomerStatus.ACTIVE,
    registeredAt: new Date('2026-02-01T10:00:00.000Z'),
    emailVerifiedAt: new Date('2026-02-01T11:00:00.000Z'),
    orders: [],
  },
];

beforeEach(() => {
  findMany.mockReset();
  findMany.mockResolvedValue([...MOCK_CUSTOMERS]);
});

describe('customersService.list sorting', () => {
  it('defaults to sorting by total ordered spend descending', async () => {
    const res = await customersService.list({ page: 1, limit: 10 });
    expect(res.data.map((c) => c.name)).toEqual(['Charlie Clark', 'Alice Adams', 'Bob Baker']);
    expect(res.data[0]!.spent).toBe(500);
    expect(res.data[1]!.spent).toBe(100);
    expect(res.data[2]!.spent).toBe(0);
  });

  it('sorts alphabetically ascending (A-Z) when sort=name and dir=asc', async () => {
    const res = await customersService.list({ page: 1, limit: 10, sort: 'name', dir: 'asc' });
    expect(res.data.map((c) => c.name)).toEqual(['Alice Adams', 'Bob Baker', 'Charlie Clark']);
  });

  it('sorts alphabetically descending (Z-A) when sort=name and dir=desc', async () => {
    const res = await customersService.list({ page: 1, limit: 10, sort: 'name', dir: 'desc' });
    expect(res.data.map((c) => c.name)).toEqual(['Charlie Clark', 'Bob Baker', 'Alice Adams']);
  });

  it('sorts by total ordered spend ascending (Low to High)', async () => {
    const res = await customersService.list({ page: 1, limit: 10, sort: 'spend', dir: 'asc' });
    expect(res.data.map((c) => c.name)).toEqual(['Bob Baker', 'Alice Adams', 'Charlie Clark']);
  });

  it('sorts by orders count', async () => {
    const res = await customersService.list({ page: 1, limit: 10, sort: 'orders', dir: 'desc' });
    expect(res.data[0]!.name).toBe('Charlie Clark');
    expect(res.data[0]!.orders).toBe(3);
  });

  it('sorts by registeredAt date', async () => {
    const res = await customersService.list({ page: 1, limit: 10, sort: 'registered', dir: 'desc' });
    expect(res.data.map((c) => c.name)).toEqual(['Charlie Clark', 'Bob Baker', 'Alice Adams']);
  });
});
