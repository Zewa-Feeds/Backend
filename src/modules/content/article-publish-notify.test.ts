/**
 * Content Editors may publish blog articles, and every publish, schedule or
 * unpublish by a non-Admin queues an email to the Admins. Real database for the
 * article; the queue and the site snapshot are stubbed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentStatus, MediaStorage, MediaType, PrismaClient, Role } from '@prisma/client';
import { ns, testActor } from '@/test/fixtures';
import type { AuditContext } from '@/modules/audit/audit.service';

const queued = vi.hoisted(() => [] as { name: string; data: { context: Record<string, unknown> } }[]);

vi.mock('@/jobs/queues', () => ({
  emailQueue: { add: vi.fn(async (name: string, data: never) => queued.push({ name, data })) },
}));
// Publishing an article snapshots the site; that is covered in site-publishing.test.
vi.mock('@/modules/site/site.service', () => ({ publishArticleChange: vi.fn(async () => null) }));

import { publishArticle, scheduleArticle, setArticleStatus } from './content.service';
import { can } from '@/rbac/permissions';
import { staffTemplates } from '@/integrations/zeptomail/templates';

const prisma = new PrismaClient();
let actorId = '';
let coverId = '';
const slugs: string[] = [];

const editor = (): AuditContext => ({ actorId, actorName: 'Vaishnavi', actorRole: 'Content Editor', ip: '127.0.0.1' });
const admin = (): AuditContext => ({ actorId, actorName: 'Nik', actorRole: 'Admin', ip: '127.0.0.1' });

async function makeArticle(published = false) {
  const slug = ns('notify');
  slugs.push(slug);
  await prisma.article.create({
    data: {
      slug,
      title: `ZZ Notify ${slug}`,
      tag: 'NUTRITION',
      excerpt: 'An excerpt.',
      authorName: 'Zewa Research Team',
      contentBlocks: [{ type: 'p', text: 'Body.' }],
      coverAssetId: coverId,
      status: published ? ContentStatus.PUBLISHED : ContentStatus.DRAFT,
      publishedAt: published ? new Date() : null,
    },
  });
  return slug;
}

beforeAll(async () => {
  actorId = await testActor(prisma);
  const cover = await prisma.mediaAsset.create({
    data: { storage: MediaStorage.STATIC, type: MediaType.IMAGE, url: `/${ns('cover')}.jpg`, format: 'jpg', width: 2000, height: 1125, title: ns('cover') },
  });
  coverId = cover.id;
});

beforeEach(() => {
  queued.length = 0;
});

afterAll(async () => {
  await prisma.article.deleteMany({ where: { slug: { in: slugs } } });
  await prisma.mediaAsset.deleteMany({ where: { id: coverId } });
  await prisma.$disconnect();
});

describe('blog publishing by Content Editors', () => {
  it('Content Editors hold articles.publish; delete stays Admin-only', () => {
    expect(can(Role.CONTENT_EDITOR, 'articles.publish')).toBe(true);
    expect(can(Role.CONTENT_EDITOR, 'articles.delete')).toBe(false);
    expect(can(Role.OPS_MANAGER, 'articles.publish')).toBe(false);
  });

  it('an Editor publishing queues one Admin email naming them and the article', async () => {
    const slug = await makeArticle();
    await publishArticle(slug, actorId, editor());
    expect(queued).toHaveLength(1);
    expect(queued[0]!.name).toBe('staff-article-published');
    expect(queued[0]!.data.context).toMatchObject({ action: 'published', slug, actorName: 'Vaishnavi' });
  });

  it('an Admin publishing sends nothing', async () => {
    const slug = await makeArticle();
    await publishArticle(slug, actorId, admin());
    expect(queued).toHaveLength(0);
  });

  it('the scheduler firing a publish sends nothing (the scheduling already did)', async () => {
    const slug = await makeArticle();
    await publishArticle(slug, null, { ...editor(), actorId: null }, { scheduled: true });
    expect(queued).toHaveLength(0);
  });

  it('scheduling alerts; cancelling a schedule does not', async () => {
    const slug = await makeArticle();
    const when = new Date(Date.now() + 86_400_000);
    await scheduleArticle(slug, when, editor());
    await scheduleArticle(slug, null, editor());
    expect(queued.map((q) => q.data.context.action)).toEqual(['scheduled']);
    expect(queued[0]!.data.context.scheduledAt).toBe(when.toISOString());
  });

  it('unpublishing alerts', async () => {
    const slug = await makeArticle(true);
    await setArticleStatus(slug, ContentStatus.DRAFT, actorId, editor());
    expect(queued.map((q) => q.data.context.action)).toEqual(['unpublished']);
  });

  it('renders the email with who, what and links', () => {
    const r = staffTemplates['staff-article-published']({
      action: 'published',
      title: 'Why insects?',
      slug: 'why-insects',
      actorName: 'Vaishnavi',
      actorRole: 'Content Editor',
    });
    expect(r.subject).toBe('Blog published: “Why insects?” by Vaishnavi');
    expect(r.html).toContain('/blog/why-insects');
    expect(r.html).toContain('/content/articles/why-insects');
  });
});
