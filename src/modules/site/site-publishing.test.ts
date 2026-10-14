/**
 * Website content: draft → validated, versioned publication → what the
 * storefront build reads. Against the real database, because the guarantees
 * are database guarantees: one current version, compare-and-set drafts, and an
 * article release that cannot drag unreviewed homepage edits out with it.
 *
 * The site tables are singletons, so this suite owns them while it runs and
 * clears them afterwards. Re-run scripts/import-site-content.ts to restore a
 * local dev site.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ContentStatus, MediaStorage, MediaType, PrismaClient, PublicationStatus } from '@prisma/client';
import { ns, sweepFixtures, testActor, testCtx } from '@/test/fixtures';
import * as site from './site.service';
import * as media from './media.service';
import { publishArticle } from '@/modules/content/content.service';
import { referencedOutsideProducts } from '@/modules/uploads/lifecycle.service';
import { publishDueArticles } from './scheduler';
import type { SiteSections } from './site.schemas';

const prisma = new PrismaClient();
let actorId = '';
const user = () => ({ id: actorId, name: 'Integration Test' });

const ids: Record<string, string> = {};
const articleSlugs: string[] = [];

async function asset(key: string, data: { type?: MediaType; format: string; width: number; height: number; url?: string }) {
  const row = await prisma.mediaAsset.create({
    data: {
      storage: MediaStorage.STATIC,
      type: data.type ?? MediaType.IMAGE,
      url: data.url ?? `/${ns(key)}.${data.format}`,
      format: data.format,
      width: data.width,
      height: data.height,
      title: ns(key),
    },
  });
  ids[key] = row.id;
  return row;
}

function sections(over: Partial<SiteSections> = {}): SiteSections {
  return {
    ...site.DEFAULT_SECTIONS,
    home: {
      ...site.DEFAULT_SECTIONS.home,
      heroSlides: [
        { id: 'statement', type: 'statement', enabled: true },
        { id: 'banner', type: 'banner', enabled: true, desktop: { assetId: ids.desktop! }, mobile: { assetId: ids.mobile! }, alt: 'Superior nutrition' },
      ],
      showcase: { productSlugs: [] },
      knowledgeHub: { articleSlugs: [] },
    },
    about: {
      ...site.DEFAULT_SECTIONS.about,
      milestones: [{ id: 'm1', year: '2023', points: ['Trials'], image: { assetId: ids.portrait! }, imageAlt: 'Award' }],
    },
    ...over,
  };
}

async function resetSite() {
  await prisma.sitePublication.deleteMany({});
  await prisma.siteContentDraft.deleteMany({});
}

async function saveDraft(s: SiteSections) {
  const { revision } = await site.getDraft();
  return site.saveDraft({ baseRevision: revision, sections: s }, actorId, testCtx(actorId));
}

async function makeArticle(label: string, published: boolean) {
  const slug = ns(label);
  articleSlugs.push(slug);
  await prisma.article.create({
    data: {
      slug,
      title: `ZZ ${label}`,
      tag: 'NUTRITION',
      excerpt: 'An excerpt.',
      authorName: 'Zewa Research Team',
      contentBlocks: [{ type: 'p', text: 'Body.' }],
      coverAssetId: ids.cover!,
      status: published ? ContentStatus.PUBLISHED : ContentStatus.DRAFT,
      publishedAt: published ? new Date('2026-10-01T00:00:00+05:30') : null,
    },
  });
  return slug;
}

beforeAll(async () => {
  await sweepFixtures(prisma);
  actorId = await testActor(prisma);
  await resetSite();
  await asset('desktop', { format: 'jpg', width: 1920, height: 814 });
  await asset('mobile', { format: 'jpg', width: 1080, height: 1080 });
  await asset('portrait', { format: 'jpg', width: 2210, height: 3072 }); // off-ratio → warning
  await asset('cover', { format: 'jpg', width: 2000, height: 1125 });
  await asset('video', { type: MediaType.VIDEO, format: 'mp4', width: 2880, height: 1440 });
});

beforeEach(resetSite);

afterAll(async () => {
  await resetSite();
  await prisma.article.deleteMany({ where: { slug: { in: articleSlugs } } });
  await prisma.mediaAsset.deleteMany({ where: { id: { in: Object.values(ids) } } });
  await prisma.$disconnect();
});

describe('draft', () => {
  it('refuses a save based on a stale revision instead of overwriting a colleague', async () => {
    const first = await site.getDraft();
    await site.saveDraft({ baseRevision: first.revision, sections: sections() }, actorId, testCtx(actorId));
    await expect(
      site.saveDraft({ baseRevision: first.revision, sections: site.DEFAULT_SECTIONS }, actorId, testCtx(actorId)),
    ).rejects.toMatchObject({ status: 409 });
    expect((await site.getDraft()).sections.home.heroSlides).toHaveLength(2);
  });
});

describe('publishing the website', () => {
  it('blocks on errors: an enabled slide pointing at a file that is not in the library', async () => {
    const s = sections();
    s.home.heroSlides[1] = {
      id: 'banner',
      type: 'banner',
      enabled: true,
      desktop: { assetId: ids.desktop! },
      mobile: { assetId: '00000000-0000-4000-8000-000000000000' },
      alt: 'x',
    };
    await saveDraft(s);
    await expect(site.publishSite({ acknowledgeWarnings: true }, user(), testCtx(actorId))).rejects.toMatchObject({
      status: 422,
    });
    expect(await prisma.sitePublication.count()).toBe(0);
  });

  it('needs warnings acknowledged, then publishes v-next as the single current version', async () => {
    await saveDraft(sections());
    await expect(site.publishSite({ acknowledgeWarnings: false }, user(), testCtx(actorId))).rejects.toMatchObject({
      status: 409,
      details: { needsAcknowledgement: true },
    });

    const v1 = await site.publishSite({ acknowledgeWarnings: true, note: 'first' }, user(), testCtx(actorId));
    expect(v1.isCurrent).toBe(true);
    expect(v1.status).toBe(PublicationStatus.QUEUED);
    expect(v1.scopes).toEqual(expect.arrayContaining(['home', 'about']));

    // The snapshot is self-contained: URLs and dimensions frozen in.
    const part = await site.livePart('home');
    const banner = part.data.heroSlides.find((x) => x.type === 'banner') as { desktop: { url: string; width: number } };
    expect(banner.desktop).toMatchObject({ url: expect.stringMatching(/^\//), width: 1920 });

    // Edit only the About page → only "about" changes.
    const s = sections();
    s.about.milestones[0]!.year = '2024';
    await saveDraft(s);
    const v2 = await site.publishSite({ acknowledgeWarnings: true }, user(), testCtx(actorId));
    expect(v2.version).toBeGreaterThan(v1.version);
    expect(v2.scopes).toEqual(['about']);
    expect(v2.plan).toMatchObject({ tags: ['site:about'], paths: ['/about'] });

    const current = await prisma.sitePublication.findMany({ where: { isCurrent: true } });
    expect(current.map((c) => c.version)).toEqual([v2.version]);
    // The older in-flight version can no longer be regenerated over the new one.
    expect((await prisma.sitePublication.findUnique({ where: { version: v1.version } }))?.status).toBe(PublicationStatus.SUPERSEDED);
  });

  it('refuses to publish an identical snapshot', async () => {
    await saveDraft(sections());
    await site.publishSite({ acknowledgeWarnings: true }, user(), testCtx(actorId));
    await expect(site.publishSite({ acknowledgeWarnings: true }, user(), testCtx(actorId))).rejects.toMatchObject({
      code: 'NOTHING_TO_PUBLISH',
    });
  });

  it('the database itself refuses two current versions', async () => {
    await saveDraft(sections());
    await site.publishSite({ acknowledgeWarnings: true }, user(), testCtx(actorId));
    await expect(
      prisma.sitePublication.create({
        data: { snapshot: {}, contentHash: 'x', isCurrent: true, publishedByName: 'rogue' },
      }),
    ).rejects.toThrow();
  });
});

describe('articles', () => {
  it('publishing an article carries the LIVE sections forward, never the draft', async () => {
    await saveDraft(sections());
    const v1 = await site.publishSite({ acknowledgeWarnings: true }, user(), testCtx(actorId));

    // An editor is mid-way through a homepage change...
    const wip = sections();
    wip.home.heroSlides = [{ id: 'statement', type: 'statement', enabled: true }];
    await saveDraft(wip);

    // ...when an admin publishes an article.
    const slug = await makeArticle('pub', false);
    const result = await publishArticle(slug, actorId, testCtx(actorId));
    expect(result.siteVersion).toBeGreaterThan(v1.version);

    const home = await site.livePart('home');
    expect(home.data.heroSlides).toHaveLength(2); // unreviewed draft did NOT ship
    const article = await site.liveArticle(slug);
    expect(article.data).toMatchObject({ slug, cover: { width: 2000 }, blocks: [{ type: 'p' }] });

    const pub = await prisma.sitePublication.findFirst({ where: { isCurrent: true } });
    expect(pub?.scopes).toEqual(expect.arrayContaining(['articles', `article:${slug}`]));
    expect(pub?.scopes).not.toContain('home');
  });

  it('an unpublished article is not served (the page 404s)', async () => {
    await saveDraft(sections());
    await site.publishSite({ acknowledgeWarnings: true }, user(), testCtx(actorId));
    const slug = await makeArticle('draft', false);
    await expect(site.liveArticle(slug)).rejects.toMatchObject({ status: 404 });
  });

  it('refuses to publish an article without a cover', async () => {
    const slug = await makeArticle('nocover', false);
    await prisma.article.update({ where: { slug }, data: { coverAssetId: null, coverImageUrl: null } });
    await expect(publishArticle(slug, actorId, testCtx(actorId))).rejects.toMatchObject({ status: 422 });
    expect((await prisma.article.findUnique({ where: { slug } }))?.status).toBe(ContentStatus.DRAFT);
  });
});

describe('scheduled publishing', () => {
  it('publishes a due article and leaves a future one alone', async () => {
    await saveDraft(sections());
    await site.publishSite({ acknowledgeWarnings: true }, user(), testCtx(actorId));
    const due = await makeArticle('due', false);
    const later = await makeArticle('later', false);
    await prisma.article.update({ where: { slug: due }, data: { scheduledAt: new Date(Date.now() - 60_000) } });
    await prisma.article.update({ where: { slug: later }, data: { scheduledAt: new Date(Date.now() + 3_600_000) } });

    const out = await publishDueArticles();
    expect(out.published).toBeGreaterThanOrEqual(1);
    expect(await prisma.article.findUnique({ where: { slug: due } })).toMatchObject({ status: ContentStatus.PUBLISHED, scheduledAt: null });
    expect((await prisma.article.findUnique({ where: { slug: later } }))?.status).toBe(ContentStatus.DRAFT);
    await expect(site.liveArticle(due)).resolves.toBeTruthy();
  });

  it('cancels — rather than retries forever — a schedule that can no longer publish', async () => {
    const bad = await makeArticle('bad', false);
    await prisma.article.update({ where: { slug: bad }, data: { coverAssetId: null, scheduledAt: new Date(Date.now() - 60_000) } });
    const out = await publishDueArticles();
    expect(out.failed).toBeGreaterThanOrEqual(1);
    expect(await prisma.article.findUnique({ where: { slug: bad } })).toMatchObject({ status: ContentStatus.DRAFT, scheduledAt: null });
  });
});

describe('rollback', () => {
  it('restores an earlier version’s sections as a NEW version, and resets the draft to match', async () => {
    await saveDraft(sections());
    const v1 = await site.publishSite({ acknowledgeWarnings: true }, user(), testCtx(actorId));
    const changed = sections();
    changed.about.milestones = [];
    await saveDraft(changed);
    await site.publishSite({ acknowledgeWarnings: true }, user(), testCtx(actorId));
    expect((await site.livePart('about')).data.milestones).toHaveLength(0);

    const v3 = await site.rollbackTo(v1.version, user(), testCtx(actorId));
    expect(v3.rolledBackFrom).toBe(v1.version);
    expect((await site.livePart('about')).data.milestones).toHaveLength(1);
    expect((await site.getDraft()).sections.about.milestones).toHaveLength(1);
    expect((await site.getDraft()).hasUnpublishedChanges).toBe(false);
  });
});

describe('media library safety', () => {
  it('will not archive a file the live site or the draft uses', async () => {
    await saveDraft(sections());
    await site.publishSite({ acknowledgeWarnings: true }, user(), testCtx(actorId));
    await expect(media.archiveMedia(ids.desktop!, testCtx(actorId))).rejects.toMatchObject({ status: 409 });
    const usage = (await media.usagesFor([ids.desktop!])).get(ids.desktop!)!;
    expect(usage.map((u) => u.scope)).toEqual(expect.arrayContaining(['draft', 'live']));
  });

  it('archives an unused file, reversibly', async () => {
    const row = await asset('spare', { format: 'png', width: 10, height: 10 });
    expect((await media.archiveMedia(row.id, testCtx(actorId))).archived).toBe(true);
    expect((await media.restoreMedia(row.id, testCtx(actorId))).archived).toBe(false);
  });

  it('protects library uploads — and files they replaced — from the orphan sweep', async () => {
    const publicId = ns('zewa/site/sweep');
    const old = ns('zewa/site/old');
    const row = await prisma.mediaAsset.create({
      data: {
        storage: MediaStorage.CLOUDINARY,
        type: MediaType.IMAGE,
        publicId,
        url: `https://res.cloudinary.com/x/image/upload/${publicId}.jpg`,
        title: 'sweep',
        previousPublicIds: [old],
      },
    });
    ids.sweep = row.id;
    const held = await referencedOutsideProducts(prisma, [publicId, old, ns('zewa/site/abandoned')]);
    expect(held.sort()).toEqual([old, publicId].sort());
  });
});

describe('letters', () => {
  const letter = (slug: string, date: string, published: boolean) => ({
    slug, title: slug, subtitle: '', date, dateLabel: date, author: 'Nik Mulakkal', authorRole: '', authorOrg: '',
    excerpt: 'x', cover: { asset: { assetId: ids.cover! }, alt: 'cover' }, published,
    blocks: [{ type: 'p' as const, text: [{ text: 'Hi ' }, { text: 'All', strong: true }] }],
  });

  it('publishes only letters marked published, newest first, with resolved covers', async () => {
    await saveDraft({ ...sections(), letters: [letter('old', '2025-01-01', true), letter('wip', '2027-01-01', false), letter('new', '2026-10-01', true)] });
    await site.publishSite({ acknowledgeWarnings: true }, user(), testCtx(actorId));
    const live = await site.livePart('letters');
    expect(live.data.map((l) => l.slug)).toEqual(['new', 'old']);
    expect(live.data[0]!.cover).toMatchObject({ alt: 'cover', width: 2000 });
    // ...but the draft preview shows the hidden one too.
    expect((await site.previewDraftPart('letters')).map((l) => l.slug)).toContain('wip');
  });

  it('regenerates the About page and every letter page when letters change', () => {
    const snap = { articles: [], sections: { letters: [{ slug: 'a' }, { slug: 'b' }] } } as unknown as site.Snapshot;
    const plan = site.planFor(['letters'], snap);
    expect(plan.tags).toEqual(['site:letters']);
    expect(plan.paths).toEqual(expect.arrayContaining(['/letters', '/about', '/letters/a', '/letters/b', '/sitemap.xml']));
  });
});

describe('regeneration plan', () => {
  it('maps article changes to the blog, the homepage teaser, the sitemap and every article page', () => {
    const snap = { articles: [{ slug: 'a' }, { slug: 'b' }] } as unknown as site.Snapshot;
    const plan = site.planFor(['articles', 'article:a', 'article:gone'], snap);
    expect(plan.tags).toEqual(['site:articles', 'site:article:a', 'site:article:gone']);
    expect(plan.paths).toEqual(expect.arrayContaining(['/', '/blog', '/blog/a', '/blog/b', '/sitemap.xml']));
    expect(plan.removed).toEqual(['/blog/gone']);
  });
});
