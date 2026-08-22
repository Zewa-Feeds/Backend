/**
 * Who may reorder the catalogue, and whether the routes are even reachable.
 *
 * Two things are being checked that the service tests cannot see:
 *
 *  1. AUTHORIZATION. Reordering the shop front is merchandising, so it sits
 *     behind products.edit — an EDITOR can read the order but not change it.
 *  2. ROUTE PRECEDENCE. "order" is a valid slug. If GET /products/order were
 *     registered after GET /products/:slug, Express would route it into the
 *     product editor looking for a product named "order" and 404. These mount
 *     the real router, so registration order is actually exercised.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Category, PrismaClient, ProductStatus, Role } from '@prisma/client';
import { ns, sweepFixtures, testActor } from '@/test/fixtures';
import { productsRouter } from './products.routes';
import { errorHandler } from '@/middleware/errorHandler';
import { permissionsFor } from '@/rbac/permissions';

const prisma = new PrismaClient();

/** Role is swapped per test; the router reads whatever this holds. */
let role: Role = Role.ADMIN;
let signedIn = true;
let slug = '';
/*
 * A REAL CmsUser id, not a made-up string.
 *
 * writeAudit stores actorId as a foreign key, so a fabricated principal makes
 * the audit insert fail — and because the audit write is inside the reorder
 * transaction, the whole reorder rolls back and surfaces as a confusing 409.
 */
let staffId = '';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as express.Request & { id: string }).id = 'test-request';
  if (signedIn) {
    req.user = {
      id: staffId,
      email: 'staff@example.test',
      name: 'Staff',
      role,
      permissions: permissionsFor(role),
    };
  }
  next();
});
app.use('/products', productsRouter);
app.use(errorHandler);

let server: Server;
const url = (p: string) => `http://127.0.0.1:${(server.address() as AddressInfo).port}${p}`;

beforeAll(async () => {
  await sweepFixtures(prisma);
  staffId = await testActor(prisma);
  slug = ns('rte');
  await prisma.productFamily.create({
    data: {
      slug,
      name: `ZZ ${slug}`,
      category: Category.SLOW_SINKING_PELLETS,
      status: ProductStatus.ACTIVE,
      shortDesc: 'fixture',
      displayOrder: 900,
    },
  });
  server = app.listen(0);
});

afterAll(async () => {
  server?.close();
  await prisma.productFamily.deleteMany({ where: { slug } });
  await prisma.$disconnect();
});

const getOrder = () => fetch(url('/products/order'));
const patchOrder = (order: string[]) =>
  fetch(url('/products/order'), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ order }),
  });

const currentSlugs = async () => {
  const body = (await (await getOrder()).json()) as { data: { slug: string }[] };
  return body.data.map((r) => r.slug);
};

describe('route precedence', () => {
  it('GET /products/order reaches the order handler, not the product editor', async () => {
    role = Role.ADMIN;
    signedIn = true;
    const res = await getOrder();
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { slug: string; position: number }[] };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.some((r) => r.slug === slug)).toBe(true);
  });

  it('returns rows carrying the fields the reorder screen renders', async () => {
    role = Role.ADMIN;
    const body = (await (await getOrder()).json()) as { data: Record<string, unknown>[] };
    expect(Object.keys(body.data[0]!).sort()).toEqual(
      ['category', 'name', 'position', 'slug', 'status'],
    );
  });
});

describe('authorization', () => {
  it('lets an ADMIN reorder', async () => {
    role = Role.ADMIN;
    expect((await patchOrder(await currentSlugs())).status).toBe(200);
  });

  it('lets OPS reorder', async () => {
    role = Role.OPS_MANAGER;
    expect((await patchOrder(await currentSlugs())).status).toBe(200);
  });

  it('refuses an EDITOR — read yes, reorder no', async () => {
    role = Role.CONTENT_EDITOR;
    expect((await getOrder()).status).toBe(200);

    const res = await patchOrder(await currentSlugs());
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
  });

  it('leaves the order unchanged after a refused attempt', async () => {
    role = Role.ADMIN;
    const before = await currentSlugs();

    role = Role.CONTENT_EDITOR;
    await patchOrder([...before].reverse());

    role = Role.ADMIN;
    expect(await currentSlugs()).toEqual(before);
  });

  it('401s when nobody is signed in', async () => {
    signedIn = false;
    expect((await getOrder()).status).toBe(401);
    expect((await patchOrder(['anything'])).status).toBe(401);
    signedIn = true;
    role = Role.ADMIN;
  });
});

describe('payload validation at the edge', () => {
  it('rejects a body with no order array', async () => {
    role = Role.ADMIN;
    const res = await fetch(url('/products/order'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    // 422 is this project's validation status, set by the validate() middleware.
    expect(res.status).toBe(422);
  });

  it('rejects an empty list rather than wiping the order', async () => {
    role = Role.ADMIN;
    expect((await patchOrder([])).status).toBe(422);
  });
});
