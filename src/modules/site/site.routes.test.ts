/**
 * Who may do what to the website — enforced by the routes, not the CMS UI.
 *
 *   Content Editor  edit + preview the draft, manage the library; NOT publish
 *   Ops Manager     nothing here (operations, not content)
 *   Admin           everything, including publish / rollback / rebuild
 *
 * The real routers are mounted, so a permission forgotten on any handler shows
 * up here as the wrong status code.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { PrismaClient, Role } from '@prisma/client';
import { sweepFixtures, testActor } from '@/test/fixtures';
import { errorHandler } from '@/middleware/errorHandler';
import { can, permissionsFor } from '@/rbac/permissions';
import { liveSiteRouter, mediaRouter, siteRouter } from './site.routes';

const prisma = new PrismaClient();
let role: Role = Role.ADMIN;
let staffId = '';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as express.Request & { id: string }).id = 'test-request';
  req.user = { id: staffId, email: 'staff@example.test', name: 'Staff', role, permissions: permissionsFor(role) };
  next();
});
app.use('/admin/site', siteRouter);
app.use('/admin/media', mediaRouter);
app.use('/site/live', liveSiteRouter);
app.use(errorHandler);

let server: Server;
const call = async (method: string, path: string, body?: unknown) => {
  const port = (server.address() as AddressInfo).port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.status;
};

beforeAll(async () => {
  await sweepFixtures(prisma);
  staffId = await testActor(prisma);
  await prisma.sitePublication.deleteMany({});
  server = app.listen(0);
});

afterAll(async () => {
  server?.close();
  await prisma.$disconnect();
});

describe('permission matrix', () => {
  it('editors author, admins release, ops stay out', () => {
    expect(can(Role.CONTENT_EDITOR, 'site.edit')).toBe(true);
    expect(can(Role.CONTENT_EDITOR, 'media.manage')).toBe(true);
    expect(can(Role.CONTENT_EDITOR, 'site.publish')).toBe(false);
    expect(can(Role.OPS_MANAGER, 'site.edit')).toBe(false);
    expect(can(Role.OPS_MANAGER, 'media.manage')).toBe(false);
    expect(can(Role.ADMIN, 'site.publish')).toBe(true);
  });
});

describe('routes', () => {
  it('a Content Editor can read the draft and the library', async () => {
    role = Role.CONTENT_EDITOR;
    expect(await call('GET', '/admin/site/draft')).toBe(200);
    expect(await call('GET', '/admin/site/placements')).toBe(200);
    expect(await call('GET', '/admin/media')).toBe(200);
  });

  it('a Content Editor cannot publish, roll back, retry or rebuild', async () => {
    role = Role.CONTENT_EDITOR;
    expect(await call('POST', '/admin/site/publish', { acknowledgeWarnings: true })).toBe(403);
    expect(await call('POST', '/admin/site/publications/1/rollback')).toBe(403);
    expect(await call('POST', '/admin/site/publications/1/retry')).toBe(403);
    expect(await call('POST', '/admin/site/rebuild')).toBe(403);
  });

  it('an Ops Manager is refused everywhere in website content', async () => {
    role = Role.OPS_MANAGER;
    expect(await call('GET', '/admin/site/draft')).toBe(403);
    expect(await call('PUT', '/admin/site/draft', { baseRevision: 1, sections: {} })).toBe(403);
    expect(await call('GET', '/admin/media')).toBe(403);
    expect(await call('POST', '/admin/media', { publicId: 'x' })).toBe(403);
  });

  it('an Admin reaches publish (and gets a real answer, not 403)', async () => {
    role = Role.ADMIN;
    const status = await call('POST', '/admin/site/rebuild');
    expect(status).not.toBe(403);
  });

  it('the live content endpoint is public and says when nothing is published', async () => {
    expect(await call('GET', '/site/live/sections/home')).toBe(404);
    expect(await call('GET', '/site/live/sections/checkout')).toBe(422);
  });
});
