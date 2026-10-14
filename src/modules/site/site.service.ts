/**
 * Website content — the draft workspace and its numbered publications.
 *
 *   edit    SiteContentDraft (one row, optimistic `revision`)
 *   publish validate → resolve every asset → freeze a SitePublication snapshot
 *           → make it current → queue the storefront regeneration
 *   serve   the storefront build reads the CURRENT snapshot, part by part
 *
 * WHAT A PUBLICATION CONTAINS. The website sections (from the draft) plus every
 * published article (from the Article table's live columns, never a pending
 * overlay). Publishing an article therefore creates a publication too — but it
 * carries the CURRENT LIVE sections forward rather than the draft, so an
 * article release can never smuggle unreviewed homepage edits out with it.
 *
 * WHAT ROLLBACK RESTORES. The website sections of an earlier version, verbatim
 * (including the exact files it served), and the draft is reset to match. It
 * does not touch articles: their published state lives on the Article rows,
 * and silently un-publishing one behind its editor's back would leave the two
 * disagreeing. An article is rolled back by editing or unpublishing it.
 */
import { createHash } from 'node:crypto';
import type { Prisma} from '@prisma/client';
import { AuditModule, ContentStatus, ProductStatus, PublicationStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AppError, ErrorCode, conflict, notFound } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { type AuditContext, writeAudit } from '@/modules/audit/audit.service';
import { publishQueue } from '@/jobs/queues';
import { deployHookConfigured } from '@/integrations/storefront/revalidate';
import type { Issue } from './placements';
import { type SiteSections, siteSectionsSchema } from './site.schemas';
import {
  type ArticleSource,
  type ResolvedArticle,
  articleAssetIds,
  loadAssets,
  resolveArticle,
  resolveSections,
  sectionAssetIds,
  validateSections,
} from './resolve';

const log = logger.child({ module: 'site' });

const DRAFT_KEY = 'site';

/**
 * The shape a brand-new workspace starts from. Real installs are seeded from
 * the existing site by scripts/import-site-content.ts; this only exists so the
 * editor opens on an empty database instead of erroring.
 */
export const DEFAULT_SECTIONS: SiteSections = {
  home: {
    heroSlides: [{ id: 'statement', type: 'statement', enabled: true }],
    showcase: { productSlugs: [] },
    knowledgeHub: { articleSlugs: [] },
    // Empty on purpose: real copy arrives from the import, never from code.
    statement: {
      titleLead: '',
      titleEmphasis: '',
      titleTail: '',
      body: '',
      primaryCta: { label: '', href: '/' },
      secondaryCta: { label: '', href: '/' },
      panel: { eyebrow: '', source: '', bars: [], footnote: '' },
    },
    proof: { eyebrow: '', title: '', intro: '', stats: [], footnote: '' },
  },
  products: { heroBanner: { enabled: false, image: null, alt: '' } },
  blog: { featuredSlug: null, topics: ['All'] },
  about: {
    storyVideo: { youtubeId: 'gcnpEOW09k0', title: 'The Zewa story' },
    founder: { enabled: false, portrait: null, alt: '' },
    milestones: [],
    logos: [],
    copy: {
      hero: { eyebrow: '', title: '', lead: '', sub: '' },
      headlineStats: [],
      story: { eyebrow: '', title: '', paragraphs: [], outcomes: [] },
      purpose: [],
      why: { eyebrow: '', title: '', body: '', loop: [], quote: '' },
      founder: { eyebrow: '', name: '', role: '', statement: '', bio: '', credentials: [], honours: [] },
      values: { eyebrow: '', title: '', items: [] },
      trust: { eyebrow: '', title: '', body: '', trialStats: [], footnote: '', backedByEyebrow: '', backedByTitle: '', institutionsTextOnly: [] },
      milestonesHeading: { eyebrow: '', title: '' },
      range: { eyebrow: '', title: '', body: '', products: [] },
      cta: { title: '', body: '', primary: { label: '', href: '/' }, secondary: { label: '', href: '/' } },
    },
  },
  letters: [],
};

export const SECTION_PARTS = ['home', 'products', 'blog', 'about', 'letters'] as const;
export type SectionPart = (typeof SECTION_PARTS)[number];

// ============================================================================
// HELPERS
// ============================================================================

/** JSON with sorted keys, so equal content always hashes equal. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const hash = (v: unknown) => createHash('sha256').update(stableStringify(v)).digest('hex');

export interface Snapshot {
  schema: 1;
  sections: ReturnType<typeof resolveSections>;
  articles: ResolvedArticle[];
  /** The draft the sections were resolved from, for rollback. Never served publicly. */
  source: SiteSections;
}

const ARTICLE_SOURCE_SELECT = {
  slug: true,
  title: true,
  shortTitle: true,
  tag: true,
  tagColor: true,
  tags: true,
  readMinutes: true,
  excerpt: true,
  bodyHtml: true,
  contentBlocks: true,
  coverAssetId: true,
  coverMobileAssetId: true,
  coverImageUrl: true,
  coverAlt: true,
  stat: true,
  statLabel: true,
  seoTitle: true,
  seoDesc: true,
  focusKeyword: true,
  seoKeywords: true,
  ogTitle: true,
  ogDescription: true,
  relatedSlugs: true,
  authorName: true,
  publishedAt: true,
  revisedAt: true,
} satisfies Prisma.ArticleSelect;

async function publishedArticleSources(): Promise<ArticleSource[]> {
  return prisma.article.findMany({
    where: { deletedAt: null, status: ContentStatus.PUBLISHED },
    select: ARTICLE_SOURCE_SELECT,
    orderBy: [{ publishedAt: 'desc' }, { slug: 'asc' }],
  });
}

async function referenceFacts(articleSlugs: string[]) {
  const products = await prisma.productFamily.findMany({
    where: { deletedAt: null, status: ProductStatus.ACTIVE },
    select: { slug: true },
  });
  return {
    activeProductSlugs: new Set(products.map((p) => p.slug)),
    publishedArticleSlugs: new Set(articleSlugs),
  };
}

// ============================================================================
// DRAFT
// ============================================================================

async function draftRow() {
  const row = await prisma.siteContentDraft.findUnique({ where: { key: DRAFT_KEY } });
  if (row) return row;
  // First open on an empty database. upsert, so two editors opening at once
  // cannot both try to create it.
  return prisma.siteContentDraft.upsert({
    where: { key: DRAFT_KEY },
    update: {},
    create: { key: DRAFT_KEY, sections: DEFAULT_SECTIONS as unknown as Prisma.InputJsonValue },
  });
}

/** The stored draft, parsed. Falls back to defaults section-by-section if a key is missing. */
function parseSections(raw: unknown): SiteSections {
  const merged = { ...DEFAULT_SECTIONS, ...((raw as object) ?? {}) };
  const parsed = siteSectionsSchema.safeParse(merged);
  return parsed.success ? parsed.data : (merged as SiteSections);
}

export async function getDraft() {
  const row = await draftRow();
  const current = await prisma.sitePublication.findFirst({
    where: { isCurrent: true },
    select: { version: true, snapshot: true },
  });
  const sections = parseSections(row.sections);
  const liveSource = current ? (current.snapshot as unknown as Snapshot).source : null;

  return {
    sections,
    revision: row.revision,
    updatedAt: row.updatedAt,
    updatedById: row.updatedById,
    liveVersion: current?.version ?? null,
    hasUnpublishedChanges: !liveSource || stableStringify(liveSource) !== stableStringify(sections),
  };
}

export async function saveDraft(
  body: { baseRevision: number; sections: SiteSections },
  actorId: string,
  ctx: AuditContext,
) {
  await draftRow();

  const saved = await prisma.$transaction(async (tx) => {
    // Compare-and-set on the revision: an editor working from a stale copy is
    // refused rather than allowed to erase a colleague's changes.
    const { count } = await tx.siteContentDraft.updateMany({
      where: { key: DRAFT_KEY, revision: body.baseRevision },
      data: {
        sections: body.sections as unknown as Prisma.InputJsonValue,
        revision: { increment: 1 },
        updatedById: actorId,
      },
    });
    if (count === 0) return null;
    await writeAudit(ctx, { module: AuditModule.CONTENT, action: 'Saved website draft', recordId: 'site' }, tx);
    return true;
  });

  if (!saved) {
    const latest = await prisma.siteContentDraft.findUnique({ where: { key: DRAFT_KEY }, select: { revision: true } });
    throw new AppError(
      409,
      ErrorCode.CONFLICT,
      'Someone else saved the website draft after you opened it. Reload to see their changes, then reapply yours.',
      { details: { currentRevision: latest?.revision ?? null } },
    );
  }

  return getDraft();
}

/** Every issue the current draft would raise at publish, for the editor's live checklist. */
export async function validateDraft() {
  const { sections } = await getDraft();
  const articles = await publishedArticleSources();
  const assets = await loadAssets(sectionAssetIds(sections));
  const issues = validateSections(sections, assets, await referenceFacts(articles.map((a) => a.slug)));
  return summarise(issues);
}

function summarise(issues: Issue[]) {
  return {
    issues,
    errors: issues.filter((i) => i.level === 'error').length,
    warnings: issues.filter((i) => i.level === 'warning').length,
  };
}

/** A part of the DRAFT, resolved exactly as publishing would — for preview. */
export async function previewDraftPart<P extends SectionPart>(part: P) {
  const { sections } = await getDraft();
  const assets = await loadAssets(sectionAssetIds(sections));
  // A letter being written is usually still hidden — preview shows it anyway.
  const all = { ...sections, letters: (sections.letters ?? []).map((l) => ({ ...l, published: true })) };
  return resolveSections(all, assets)[part] as Snapshot['sections'][P];
}

// ============================================================================
// PUBLICATIONS
// ============================================================================

/** Which public parts differ between two snapshots. Drives what is regenerated. */
export function changedScopes(prev: Snapshot | null, next: Snapshot): string[] {
  if (!prev) return [...SECTION_PARTS, 'articles', ...next.articles.map((a) => `article:${a.slug}`)];

  const scopes: string[] = [];
  for (const part of SECTION_PARTS) {
    if (stableStringify(prev.sections[part]) !== stableStringify(next.sections[part])) scopes.push(part);
  }

  const before = new Map(prev.articles.map((a) => [a.slug, stableStringify(a)]));
  const after = new Map(next.articles.map((a) => [a.slug, stableStringify(a)]));
  const touched = new Set<string>();
  for (const [slug, body] of after) if (before.get(slug) !== body) touched.add(slug);
  for (const slug of before.keys()) if (!after.has(slug)) touched.add(slug);
  // Order changes (a newly published article becoming "newest") move cards too.
  const orderChanged = stableStringify([...before.keys()]) !== stableStringify([...after.keys()]);

  if (touched.size > 0 || orderChanged) scopes.push('articles');
  for (const slug of touched) scopes.push(`article:${slug}`);
  return scopes;
}

/** Storefront cache tags and pages a set of scopes affects. */
export function planFor(scopes: string[], snapshot: Snapshot) {
  const tags = new Set<string>();
  const paths = new Set<string>();
  const removed: string[] = [];
  const live = new Set(snapshot.articles.map((a) => a.slug));

  for (const scope of scopes) {
    if (scope === 'home') {
      tags.add('site:home');
      paths.add('/');
    } else if (scope === 'products') {
      tags.add('site:products');
      paths.add('/products');
    } else if (scope === 'blog') {
      tags.add('site:blog');
      paths.add('/blog');
    } else if (scope === 'about') {
      tags.add('site:about');
      paths.add('/about');
    } else if (scope === 'letters') {
      // The About page previews the newest letter, so it changes too.
      tags.add('site:letters');
      paths.add('/letters');
      paths.add('/about');
      paths.add('/sitemap.xml');
      for (const l of snapshot.sections.letters ?? []) paths.add(`/letters/${l.slug}`);
    } else if (scope === 'articles') {
      // The index feeds the blog list, the Knowledge Hub on the homepage, the
      // sitemap and every article's related-reading cards.
      tags.add('site:articles');
      paths.add('/blog');
      paths.add('/');
      for (const slug of live) paths.add(`/blog/${slug}`);
    } else if (scope.startsWith('article:')) {
      const slug = scope.slice('article:'.length);
      tags.add(`site:article:${slug}`);
      if (live.has(slug)) paths.add(`/blog/${slug}`);
      else removed.push(`/blog/${slug}`);
    }
  }
  if (tags.has('site:articles')) paths.add('/sitemap.xml');

  return { tags: [...tags], paths: [...paths], removed };
}

interface CreateOptions {
  /** Where the website sections come from. */
  sections: 'draft' | 'current';
  note?: string;
  acknowledgeWarnings?: boolean;
  actorId: string | null;
  actorName: string;
  ctx: AuditContext;
  auditAction: string;
  rolledBackFrom?: number;
  /** For rollback: use these resolved sections verbatim. */
  verbatim?: { sections: Snapshot['sections']; source: SiteSections };
  /** False = leave QUEUED for a later Retry (the initial import; see below). */
  enqueue?: boolean;
}

/**
 * Freeze a new publication and make it current.
 *
 * Returns null when nothing would change — publishing an identical snapshot
 * would only churn the storefront's caches.
 */
async function createPublication(opts: CreateOptions) {
  const current = await prisma.sitePublication.findFirst({
    where: { isCurrent: true },
    select: { version: true, snapshot: true, contentHash: true },
  });
  const prev = (current?.snapshot as unknown as Snapshot | undefined) ?? null;

  const articleRows = await publishedArticleSources();

  let sections: Snapshot['sections'];
  let source: SiteSections;
  const issues: Issue[] = [];

  if (opts.verbatim) {
    sections = opts.verbatim.sections;
    source = opts.verbatim.source;
  } else if (opts.sections === 'current' && prev) {
    sections = prev.sections;
    source = prev.source;
  } else {
    source = (await getDraft()).sections;
    const assets = await loadAssets(sectionAssetIds(source));
    issues.push(...validateSections(source, assets, await referenceFacts(articleRows.map((a) => a.slug))));
    sections = resolveSections(source, assets);
  }

  const errors = issues.filter((i) => i.level === 'error');
  if (errors.length > 0) {
    throw new AppError(422, ErrorCode.VALIDATION_FAILED, `The website draft has ${errors.length} problem${errors.length === 1 ? '' : 's'} to fix before it can be published.`, {
      details: summarise(issues),
    });
  }
  const warnings = issues.filter((i) => i.level === 'warning');
  if (warnings.length > 0 && !opts.acknowledgeWarnings) {
    throw new AppError(409, ErrorCode.CONFLICT, `The draft has ${warnings.length} warning${warnings.length === 1 ? '' : 's'}. Review them, then publish again to accept.`, {
      details: { ...summarise(issues), needsAcknowledgement: true },
    });
  }

  const articleAssets = await loadAssets(articleRows.flatMap((a) => articleAssetIds(a)));
  const snapshot: Snapshot = {
    schema: 1,
    sections,
    articles: articleRows.map((a) => resolveArticle(a, articleAssets)),
    source,
  };

  const contentHash = hash({ sections: snapshot.sections, articles: snapshot.articles });
  if (current && current.contentHash === contentHash) return null;

  const scopes = changedScopes(prev, snapshot);

  const created = await prisma.$transaction(async (tx) => {
    // Clear first, then set: the partial unique index on isCurrent rejects any
    // moment with two current rows, so this order is the only legal one.
    await tx.sitePublication.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } });
    const row = await tx.sitePublication.create({
      data: {
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
        contentHash,
        scopes,
        note: opts.note ?? null,
        isCurrent: true,
        rolledBackFrom: opts.rolledBackFrom ?? null,
        publishedById: opts.actorId,
        publishedByName: opts.actorName,
      },
      select: { id: true, version: true },
    });
    // Anything still in flight for an older version is now moot.
    await tx.sitePublication.updateMany({
      where: { id: { not: row.id }, status: { in: [PublicationStatus.QUEUED, PublicationStatus.DEPLOYING] } },
      data: { status: PublicationStatus.SUPERSEDED },
    });
    await writeAudit(
      opts.ctx,
      {
        module: AuditModule.CONTENT,
        action: `${opts.auditAction} (v${row.version})`,
        recordId: `site:v${row.version}`,
        diff: { scopes, note: opts.note ?? null, warningsAccepted: warnings.length } as Prisma.InputJsonValue,
      },
      tx,
    );
    return row;
  });

  if (opts.enqueue !== false) await enqueuePublish(created.id, 'revalidate');
  return getPublication(created.version);
}

export async function enqueuePublish(publicationId: string, mode: 'revalidate' | 'deploy-hook', retryKey = '') {
  try {
    await publishQueue.add(
      'publish',
      { publicationId, mode },
      // One job per publication+mode: a double-click or a retried request
      // cannot queue the same regeneration twice. Retries get a fresh key.
      { jobId: `pub-${publicationId}-${mode}${retryKey ? `-${retryKey}` : ''}` },
    );
  } catch (err) {
    // The publication is committed and current; only the nudge failed. Record
    // it so the CMS shows Retry instead of a spinner that never ends.
    log.error({ err, publicationId }, 'could not queue the storefront regeneration');
    await prisma.sitePublication.update({
      where: { id: publicationId },
      data: { status: PublicationStatus.FAILED, lastError: 'Could not queue the regeneration job (is Redis reachable?). Use Retry.' },
    });
  }
}

export async function publishSite(
  body: { note?: string; acknowledgeWarnings: boolean },
  user: { id: string; name: string },
  ctx: AuditContext,
) {
  const result = await createPublication({
    sections: 'draft',
    note: body.note,
    acknowledgeWarnings: body.acknowledgeWarnings,
    actorId: user.id,
    actorName: user.name,
    ctx,
    auditAction: 'Published website',
  });
  if (!result) {
    throw new AppError(400, ErrorCode.NOTHING_TO_PUBLISH, 'The live site already matches the draft — nothing to publish.');
  }
  return result;
}

/**
 * Called after an article's published state changes. Carries the live sections
 * forward; only the article list changes.
 */
export async function publishArticleChange(
  reason: string,
  actor: { id: string | null; name: string },
  ctx: AuditContext,
) {
  try {
    return await createPublication({
      sections: 'current',
      // Article-level checks ran before the article was published; section
      // issues are not this release's concern.
      acknowledgeWarnings: true,
      actorId: actor.id,
      actorName: actor.name,
      ctx,
      auditAction: reason,
    });
  } catch (err) {
    // The article itself is committed. A failed snapshot must not turn a
    // successful article publish into an error — log it; the next website
    // publish will include the article.
    log.error({ err, reason }, 'article published but the site snapshot could not be created');
    return null;
  }
}

export async function rollbackTo(version: number, user: { id: string; name: string }, ctx: AuditContext) {
  const target = await prisma.sitePublication.findUnique({ where: { version }, select: { snapshot: true, version: true, isCurrent: true } });
  if (!target) throw notFound('Version');
  if (target.isCurrent) throw conflict(`v${version} is already the live version.`);

  const snap = target.snapshot as unknown as Snapshot;

  const result = await createPublication({
    sections: 'current',
    verbatim: { sections: snap.sections, source: snap.source },
    acknowledgeWarnings: true,
    note: `Rollback to v${version}`,
    rolledBackFrom: version,
    actorId: user.id,
    actorName: user.name,
    ctx,
    auditAction: `Rolled the website back to v${version}`,
  });

  // The workspace follows the live site, so the next edit starts from what
  // customers now see rather than from the version that was rolled away from.
  await prisma.siteContentDraft.update({
    where: { key: DRAFT_KEY },
    data: { sections: snap.source as unknown as Prisma.InputJsonValue, revision: { increment: 1 }, updatedById: user.id },
  });

  if (!result) throw new AppError(400, ErrorCode.NOTHING_TO_PUBLISH, `The live site already matches v${version}.`);
  return result;
}

export async function retryPublication(version: number, ctx: AuditContext) {
  const pub = await prisma.sitePublication.findUnique({ where: { version }, select: { id: true, isCurrent: true, status: true } });
  if (!pub) throw notFound('Version');
  if (!pub.isCurrent) throw conflict('Only the current version can be retried — a newer one has replaced it.');
  if (pub.status === PublicationStatus.LIVE) throw conflict('This version is already live.');

  await prisma.sitePublication.update({ where: { id: pub.id }, data: { status: PublicationStatus.QUEUED, lastError: null } });
  await writeAuditSafeWrapped(ctx, `Retried storefront regeneration for v${version}`, `site:v${version}`);
  await enqueuePublish(pub.id, 'revalidate', String(Date.now()));
  return getPublication(version);
}

export async function rebuildSite(ctx: AuditContext) {
  if (!deployHookConfigured()) {
    throw new AppError(503, ErrorCode.INTEGRATION_NOT_CONFIGURED, 'Full rebuilds need STOREFRONT_DEPLOY_HOOK_URL set on the API.');
  }
  const current = await prisma.sitePublication.findFirst({ where: { isCurrent: true }, select: { id: true, version: true } });
  if (!current) throw new AppError(400, ErrorCode.NOTHING_TO_PUBLISH, 'Nothing has been published yet.');

  await prisma.sitePublication.update({ where: { id: current.id }, data: { status: PublicationStatus.QUEUED, lastError: null } });
  await writeAuditSafeWrapped(ctx, `Triggered a full storefront rebuild for v${current.version}`, `site:v${current.version}`);
  await enqueuePublish(current.id, 'deploy-hook', String(Date.now()));
  return getPublication(current.version);
}

async function writeAuditSafeWrapped(ctx: AuditContext, action: string, recordId: string) {
  await writeAudit(ctx, { module: AuditModule.CONTENT, action, recordId });
}

const PUBLICATION_LIST_SELECT = {
  id: true,
  version: true,
  scopes: true,
  note: true,
  isCurrent: true,
  rolledBackFrom: true,
  status: true,
  method: true,
  attempts: true,
  lastError: true,
  verifiedPaths: true,
  createdAt: true,
  liveAt: true,
  publishedByName: true,
} satisfies Prisma.SitePublicationSelect;

export async function listPublications(page = 1, limit = 20) {
  const [rows, total] = await Promise.all([
    prisma.sitePublication.findMany({
      select: PUBLICATION_LIST_SELECT,
      orderBy: { version: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.sitePublication.count(),
  ]);
  return {
    data: rows,
    meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
    deployHookConfigured: deployHookConfigured(),
  };
}

export async function getPublication(version: number) {
  const row = await prisma.sitePublication.findUnique({
    where: { version },
    select: { ...PUBLICATION_LIST_SELECT, snapshot: true },
  });
  if (!row) throw notFound('Version');
  const snap = row.snapshot as unknown as Snapshot;
  const { snapshot: _s, ...meta } = row;
  return {
    ...meta,
    summary: {
      articles: snap.articles.map((a) => ({ slug: a.slug, title: a.title })),
      heroSlides: snap.sections.home.heroSlides.length,
      milestones: snap.sections.about.milestones.length,
      logos: snap.sections.about.logos.length,
    },
    plan: planFor(row.scopes, snap),
  };
}

// ============================================================================
// PUBLIC READS — the storefront build's only content source
// ============================================================================

async function currentSnapshot() {
  const row = await prisma.sitePublication.findFirst({
    where: { isCurrent: true },
    select: { version: true, createdAt: true, snapshot: true },
  });
  if (!row) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'No website version has been published yet.', {
      details: { reason: 'NO_PUBLICATION' },
    });
  }
  return { version: row.version, publishedAt: row.createdAt, snapshot: row.snapshot as unknown as Snapshot };
}

export async function livePart<P extends SectionPart>(part: P) {
  const { version, publishedAt, snapshot } = await currentSnapshot();
  return { version, publishedAt, data: snapshot.sections[part] as Snapshot['sections'][P] };
}

/** The article index — everything a card needs, without bodies. */
export async function liveArticleIndex() {
  const { version, publishedAt, snapshot } = await currentSnapshot();
  return {
    version,
    publishedAt,
    data: snapshot.articles.map(({ blocks: _b, bodyHtml: _h, toc: _t, ...card }) => card),
  };
}

export async function liveArticle(slug: string) {
  const { version, publishedAt, snapshot } = await currentSnapshot();
  const article = snapshot.articles.find((a) => a.slug === slug);
  if (!article) throw notFound('Article');
  return { version, publishedAt, data: article };
}

export async function liveVersion() {
  const row = await prisma.sitePublication.findFirst({
    where: { isCurrent: true },
    select: { version: true, createdAt: true, status: true },
  });
  return row ? { version: row.version, publishedAt: row.createdAt, status: row.status } : null;
}

/**
 * Publish the draft on behalf of a script (the initial content import).
 * Warnings are accepted — the import reproduces the site as it already is,
 * including the two off-ratio milestone photos the spec calls out.
 */
export async function publishFromScript(note: string, ctx: AuditContext) {
  return createPublication({
    sections: 'draft',
    note,
    acknowledgeWarnings: true,
    actorId: null,
    actorName: ctx.actorName,
    ctx,
    auditAction: note,
    /*
     * NOT queued. The import runs before the new storefront is deployed, and
     * the storefront then BUILDS from this version — so there is nothing to
     * regenerate yet. Queueing would have the worker call the OLD storefront,
     * whose /api/revalidate reads the request as a catalogue-wide purge, then
     * fail verification (old pages carry no version marker) and, with a deploy
     * hook set, trigger a rebuild of whatever branch the hook builds. The
     * version stays QUEUED until someone presses Retry after the deploy.
     */
    enqueue: false,
  });
}

/** The current snapshot without its private `source`, as the storefront sees it. */
export async function exportCurrentSnapshot() {
  const { version, publishedAt, snapshot } = await currentSnapshot();
  const { source: _source, ...publicSnapshot } = snapshot;
  return { version, publishedAt, ...publicSnapshot };
}
