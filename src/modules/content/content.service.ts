/**
 * Content management — spec §8.
 *
 * Three sub-modules, two different publish models:
 *
 *   Articles (§8.1)   Draft ↔ Published status, with a `draftPayload` overlay for
 *                     edits to an already-published article — same pattern as
 *                     products.
 *   Spotlights (§8.2) No draft model. These are small, reversible toggles on the
 *                     products page; §8.2 asks for reorder + activate/deactivate,
 *                     not a publish workflow.
 *   Homepage (§8.3)   TWO ROWS — LIVE and DRAFT. Publish copies DRAFT.sections
 *                     onto LIVE so all pending edits go live *at once*, which is
 *                     what §8.3 requires.
 */
import { AuditModule, ContentStatus, ContentVersion, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AppError, ErrorCode, conflict, notFound } from '@/lib/errors';
import { type AuditContext, writeAudit } from '@/modules/audit/audit.service';
import { listMeta, toSkipTake } from '@/middleware/validate';
import { slugify } from '@/modules/products/products.service';
import type { z } from 'zod';
import type {
  ArticleBody,
  HomepageBody,
  articleListQuerySchema,
  spotlightBodySchema,
} from './content.schemas';

type ArticleListQuery = z.infer<typeof articleListQuerySchema>;
type SpotlightBody = z.infer<typeof spotlightBodySchema>;

// ============================================================================
// ARTICLES (§8.1)
// ============================================================================

const ARTICLE_SELECT = {
  id: true,
  slug: true,
  title: true,
  tag: true,
  readMinutes: true,
  excerpt: true,
  bodyHtml: true,
  contentBlocks: true,
  coverImageUrl: true,
  status: true,
  seoTitle: true,
  seoDesc: true,
  authorName: true,
  draftPayload: true,
  publishedAt: true,
  updatedAt: true,
  updatedBy: { select: { name: true } },
} satisfies Prisma.ArticleSelect;

type ArticleRow = Prisma.ArticleGetPayload<{ select: typeof ARTICLE_SELECT }>;

function serializeArticle(a: ArticleRow) {
  return {
    id: a.id,
    slug: a.slug,
    title: a.title,
    tag: a.tag,
    readMinutes: a.readMinutes,
    // The CMS list column is `read`.
    read: a.readMinutes,
    excerpt: a.excerpt,
    body: a.bodyHtml,
    contentBlocks: a.contentBlocks,
    coverImageUrl: a.coverImageUrl,
    status: a.status,
    statusLabel: a.status === ContentStatus.PUBLISHED ? 'Published' : 'Draft',
    seoTitle: a.seoTitle,
    seoDesc: a.seoDesc,
    authorName: a.authorName,
    by: a.updatedBy?.name ?? a.authorName,
    hasDraft: Boolean(a.draftPayload),
    draftPayload: a.draftPayload,
    publishedAt: a.publishedAt,
    updatedAt: a.updatedAt,
  };
}

export async function listArticles(params: ArticleListQuery) {
  const where: Prisma.ArticleWhereInput = {
    deletedAt: null,
    ...(params.status ? { status: params.status } : {}),
    ...(params.tag ? { tag: params.tag } : {}),
    ...(params.q
      ? {
          OR: [
            { title: { contains: params.q, mode: 'insensitive' } },
            { slug: { contains: params.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.article.findMany({
      where,
      select: ARTICLE_SELECT,
      orderBy: { updatedAt: 'desc' },
      ...toSkipTake(params),
    }),
    prisma.article.count({ where }),
  ]);

  // The list does not need full bodies — drop them to keep the payload small.
  return {
    data: rows.map((r) => {
      const { body: _body, contentBlocks: _blocks, draftPayload: _draft, ...rest } = serializeArticle(r);
      return rest;
    }),
    meta: listMeta(params.page, params.limit, total),
  };
}

export async function articleBySlug(slug: string) {
  const article = await prisma.article.findFirst({
    where: { slug, deletedAt: null },
    select: ARTICLE_SELECT,
  });
  if (!article) throw notFound('Article');
  return serializeArticle(article);
}

function articleData(body: ArticleBody) {
  return {
    title: body.title,
    tag: body.tag,
    readMinutes: body.readMinutes,
    excerpt: body.excerpt,
    bodyHtml: body.bodyHtml,
    contentBlocks: (body.contentBlocks ?? undefined) as Prisma.InputJsonValue | undefined,
    coverImageUrl: body.coverImageUrl ?? null,
    coverImageId: body.coverImageId ?? null,
    seoTitle: body.seoTitle ?? null,
    seoDesc: body.seoDesc ?? null,
  };
}

/** Create an article. Always DRAFT — publishing is a separate, permissioned step. */
export async function createArticle(
  body: ArticleBody,
  actorId: string,
  authorName: string,
  ctx: AuditContext,
) {
  const slug = body.slug ?? slugify(body.title);

  const clash = await prisma.article.findUnique({ where: { slug }, select: { id: true } });
  if (clash) {
    throw conflict('An article with that slug already exists.', ErrorCode.SLUG_TAKEN, {
      field: 'slug',
    });
  }

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.article.create({
      data: {
        ...articleData(body),
        slug,
        status: ContentStatus.DRAFT,
        authorName: body.authorName ?? authorName,
        updatedById: actorId,
      },
      select: ARTICLE_SELECT,
    });
    await writeAudit(
      ctx,
      { module: AuditModule.CONTENT, action: `Created article "${body.title}"`, recordId: slug },
      tx,
    );
    return row;
  });

  return serializeArticle(created);
}

/**
 * Save an article edit.
 *
 * Published articles write to `draftPayload`, leaving the live content untouched
 * until Publish. Drafts write through directly.
 */
export async function saveArticle(
  slug: string,
  body: ArticleBody,
  actorId: string,
  ctx: AuditContext,
) {
  const existing = await prisma.article.findFirst({
    where: { slug, deletedAt: null },
    select: { id: true, title: true, status: true, publishedAt: true },
  });
  if (!existing) throw notFound('Article');

  // Slug is the storefront URL; changing it after publish breaks links.
  if (body.slug && body.slug !== slug && existing.publishedAt) {
    throw new AppError(
      409,
      ErrorCode.SLUG_IMMUTABLE,
      'The slug cannot change after an article has been published.',
      { fields: { slug: 'Locked after first publish.' } },
    );
  }

  const isLive = existing.status === ContentStatus.PUBLISHED;

  const updated = await prisma.$transaction(async (tx) => {
    if (isLive) {
      await tx.article.update({
        where: { id: existing.id },
        data: {
          draftPayload: body as unknown as Prisma.InputJsonValue,
          updatedById: actorId,
        },
      });
      await writeAudit(
        ctx,
        {
          module: AuditModule.CONTENT,
          action: `Saved draft changes to article "${existing.title}"`,
          recordId: slug,
        },
        tx,
      );
    } else {
      await tx.article.update({
        where: { id: existing.id },
        data: { ...articleData(body), updatedById: actorId },
      });
      await writeAudit(
        ctx,
        { module: AuditModule.CONTENT, action: `Updated article "${body.title}"`, recordId: slug },
        tx,
      );
    }

    return tx.article.findUniqueOrThrow({ where: { id: existing.id }, select: ARTICLE_SELECT });
  });

  return serializeArticle(updated);
}

/** Publish (§2.1: `articles.publish` is Ops+ — an Editor can write but not ship). */
export async function publishArticle(slug: string, actorId: string, ctx: AuditContext) {
  const existing = await prisma.article.findFirst({
    where: { slug, deletedAt: null },
    select: { id: true, title: true, status: true, publishedAt: true, draftPayload: true },
  });
  if (!existing) throw notFound('Article');

  if (existing.status === ContentStatus.PUBLISHED && !existing.draftPayload) {
    throw new AppError(400, ErrorCode.NOTHING_TO_PUBLISH, 'There are no pending changes to publish.');
  }

  const published = await prisma.$transaction(async (tx) => {
    const overlay = existing.draftPayload as unknown as ArticleBody | null;

    await tx.article.update({
      where: { id: existing.id },
      data: {
        ...(overlay ? articleData(overlay) : {}),
        status: ContentStatus.PUBLISHED,
        publishedAt: existing.publishedAt ?? new Date(),
        // Prisma needs an explicit sentinel to write SQL NULL into a nullable
        // Json column — plain `null` would mean "JSON null" and is rejected.
        draftPayload: Prisma.DbNull,
        updatedById: actorId,
      },
    });

    await writeAudit(
      ctx,
      {
        module: AuditModule.CONTENT,
        action: overlay
          ? `Published pending changes to article "${existing.title}"`
          : `Published article "${existing.title}"`,
        recordId: slug,
      },
      tx,
    );

    return tx.article.findUniqueOrThrow({ where: { id: existing.id }, select: ARTICLE_SELECT });
  });

  return serializeArticle(published);
}

/** Unpublish — reversible, per §17.1's non-destructive-defaults principle. */
export async function setArticleStatus(
  slug: string,
  status: ContentStatus,
  actorId: string,
  ctx: AuditContext,
) {
  const existing = await prisma.article.findFirst({
    where: { slug, deletedAt: null },
    select: { id: true, title: true, status: true, publishedAt: true },
  });
  if (!existing) throw notFound('Article');

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.article.update({
      where: { id: existing.id },
      data: {
        status,
        ...(status === ContentStatus.PUBLISHED && !existing.publishedAt
          ? { publishedAt: new Date() }
          : {}),
        updatedById: actorId,
      },
      select: ARTICLE_SELECT,
    });
    await writeAudit(
      ctx,
      {
        module: AuditModule.CONTENT,
        action:
          status === ContentStatus.PUBLISHED
            ? `Published article "${existing.title}"`
            : `Unpublished article "${existing.title}"`,
        recordId: slug,
      },
      tx,
    );
    return row;
  });

  return serializeArticle(updated);
}

export async function discardArticleDraft(slug: string, ctx: AuditContext): Promise<void> {
  const existing = await prisma.article.findFirst({
    where: { slug, deletedAt: null },
    select: { id: true, title: true, draftPayload: true },
  });
  if (!existing) throw notFound('Article');
  if (!existing.draftPayload) {
    throw new AppError(400, ErrorCode.NOTHING_TO_PUBLISH, 'There are no pending changes to discard.');
  }

  await prisma.$transaction(async (tx) => {
    await tx.article.update({
      where: { id: existing.id },
      data: { draftPayload: Prisma.DbNull },
    });
    await writeAudit(
      ctx,
      {
        module: AuditModule.CONTENT,
        action: `Discarded draft changes to article "${existing.title}"`,
        recordId: slug,
      },
      tx,
    );
  });
}

/** Soft delete — §2.1 makes this Admin-only. */
export async function deleteArticle(slug: string, ctx: AuditContext): Promise<void> {
  const existing = await prisma.article.findFirst({
    where: { slug, deletedAt: null },
    select: { id: true, title: true },
  });
  if (!existing) throw notFound('Article');

  await prisma.$transaction(async (tx) => {
    await tx.article.update({
      where: { id: existing.id },
      data: { deletedAt: new Date(), status: ContentStatus.DRAFT },
    });
    await writeAudit(
      ctx,
      { module: AuditModule.CONTENT, action: `Deleted article "${existing.title}"`, recordId: slug },
      tx,
    );
  });
}

// ============================================================================
// SPOTLIGHTS (§8.2)
// ============================================================================

const SPOTLIGHT_SELECT = {
  id: true,
  tagline: true,
  subText: true,
  badge: true,
  imageUrl: true,
  position: true,
  isActive: true,
  family: { select: { id: true, name: true, slug: true } },
} satisfies Prisma.SpotlightSelect;

type SpotlightRow = Prisma.SpotlightGetPayload<{ select: typeof SPOTLIGHT_SELECT }>;

const serializeSpotlight = (s: SpotlightRow) => ({
  id: s.id,
  familyId: s.family.id,
  // The CMS column is `prod`.
  prod: s.family.name,
  productSlug: s.family.slug,
  tagline: s.tagline,
  subText: s.subText,
  badge: s.badge,
  imageUrl: s.imageUrl,
  position: s.position,
  isActive: s.isActive,
});

export async function listSpotlights() {
  const rows = await prisma.spotlight.findMany({
    select: SPOTLIGHT_SELECT,
    orderBy: { position: 'asc' },
  });
  return rows.map(serializeSpotlight);
}

export async function createSpotlight(
  body: SpotlightBody,
  ctx: AuditContext,
) {
  const family = await prisma.productFamily.findFirst({
    where: { id: body.familyId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!family) throw notFound('Product');

  // §8.2 highlights "up to 3 products" — cap active spotlights at 3 so the
  // rotating banner cannot silently grow beyond what the design supports.
  if (body.isActive) {
    const activeCount = await prisma.spotlight.count({ where: { isActive: true } });
    if (activeCount >= 3) {
      throw conflict(
        'There are already 3 active spotlights. Deactivate one first.',
        ErrorCode.CONFLICT,
      );
    }
  }

  const maxPosition = await prisma.spotlight.aggregate({ _max: { position: true } });

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.spotlight.create({
      data: {
        familyId: body.familyId,
        tagline: body.tagline,
        subText: body.subText,
        badge: body.badge ?? null,
        imageUrl: body.imageUrl ?? null,
        isActive: body.isActive,
        position: (maxPosition._max.position ?? -1) + 1,
      },
      select: SPOTLIGHT_SELECT,
    });
    await writeAudit(
      ctx,
      {
        module: AuditModule.CONTENT,
        action: `Created spotlight for ${family.name}`,
        recordId: row.id,
      },
      tx,
    );
    return row;
  });

  return serializeSpotlight(created);
}

export async function updateSpotlight(
  id: string,
  body: Partial<SpotlightBody>,
  ctx: AuditContext,
) {
  const existing = await prisma.spotlight.findUnique({
    where: { id },
    select: { id: true, family: { select: { name: true } } },
  });
  if (!existing) throw notFound('Spotlight');

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.spotlight.update({
      where: { id },
      data: {
        ...(body.familyId ? { familyId: body.familyId } : {}),
        ...(body.tagline !== undefined ? { tagline: body.tagline } : {}),
        ...(body.subText !== undefined ? { subText: body.subText } : {}),
        ...(body.badge !== undefined ? { badge: body.badge } : {}),
        ...(body.imageUrl !== undefined ? { imageUrl: body.imageUrl } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
      select: SPOTLIGHT_SELECT,
    });
    await writeAudit(
      ctx,
      {
        module: AuditModule.CONTENT,
        action: `Updated spotlight for ${existing.family.name}`,
        recordId: id,
      },
      tx,
    );
    return row;
  });

  return serializeSpotlight(updated);
}

/** Toggle active without deleting (§8.2). */
export async function toggleSpotlight(id: string, ctx: AuditContext) {
  const existing = await prisma.spotlight.findUnique({
    where: { id },
    select: { id: true, isActive: true, family: { select: { name: true } } },
  });
  if (!existing) throw notFound('Spotlight');

  if (!existing.isActive) {
    const activeCount = await prisma.spotlight.count({ where: { isActive: true } });
    if (activeCount >= 3) {
      throw conflict(
        'There are already 3 active spotlights. Deactivate one first.',
        ErrorCode.CONFLICT,
      );
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.spotlight.update({
      where: { id },
      data: { isActive: !existing.isActive },
      select: SPOTLIGHT_SELECT,
    });
    await writeAudit(
      ctx,
      {
        module: AuditModule.CONTENT,
        action: `${existing.isActive ? 'Deactivated' : 'Activated'} spotlight ${existing.family.name}`,
        recordId: id,
      },
      tx,
    );
    return row;
  });

  return serializeSpotlight(updated);
}

/**
 * Reorder (§8.2).
 *
 * Takes the full ordered id list, so the operation is idempotent and a dropped
 * request cannot leave positions half-applied.
 */
export async function reorderSpotlights(order: string[], ctx: AuditContext) {
  const existing = await prisma.spotlight.findMany({ select: { id: true } });
  const known = new Set(existing.map((s) => s.id));

  const unknown = order.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new AppError(422, ErrorCode.VALIDATION_FAILED, 'Unknown spotlight in the order list.');
  }
  if (order.length !== existing.length) {
    throw new AppError(
      422,
      ErrorCode.VALIDATION_FAILED,
      'The order list must include every spotlight.',
    );
  }

  await prisma.$transaction(async (tx) => {
    for (const [position, id] of order.entries()) {
      await tx.spotlight.update({ where: { id }, data: { position } });
    }
    await writeAudit(
      ctx,
      { module: AuditModule.CONTENT, action: 'Reordered homepage spotlights', recordId: 'spotlights' },
      tx,
    );
  });

  return listSpotlights();
}

export async function deleteSpotlight(id: string, ctx: AuditContext): Promise<void> {
  const existing = await prisma.spotlight.findUnique({
    where: { id },
    select: { id: true, family: { select: { name: true } } },
  });
  if (!existing) throw notFound('Spotlight');

  await prisma.$transaction(async (tx) => {
    await tx.spotlight.delete({ where: { id } });
    await writeAudit(
      ctx,
      {
        module: AuditModule.CONTENT,
        action: `Deleted spotlight for ${existing.family.name}`,
        recordId: id,
      },
      tx,
    );
  });
}

// ============================================================================
// HOMEPAGE (§8.3)
// ============================================================================

/** Read a version, creating it from LIVE (or defaults) if absent. */
async function ensureHomepage(version: ContentVersion) {
  const existing = await prisma.homepageContent.findUnique({ where: { version } });
  if (existing) return existing;

  // A missing DRAFT should start as a copy of LIVE, not empty — otherwise
  // opening the editor would appear to wipe the homepage.
  const live = await prisma.homepageContent.findUnique({ where: { version: ContentVersion.LIVE } });

  return prisma.homepageContent.create({
    data: {
      version,
      sections: (live?.sections ?? {}) as Prisma.InputJsonValue,
    },
  });
}

export async function getHomepage(version: ContentVersion = ContentVersion.DRAFT) {
  const row = await ensureHomepage(version);
  return {
    version: row.version,
    sections: row.sections,
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
  };
}

/** Save the draft. The live homepage is untouched (§8.3). */
export async function saveHomepageDraft(
  body: HomepageBody,
  actorId: string,
  ctx: AuditContext,
) {
  await ensureHomepage(ContentVersion.DRAFT);

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.homepageContent.update({
      where: { version: ContentVersion.DRAFT },
      data: { sections: body as unknown as Prisma.InputJsonValue, updatedById: actorId },
    });
    await writeAudit(
      ctx,
      { module: AuditModule.CONTENT, action: 'Saved homepage draft', recordId: 'homepage' },
      tx,
    );
    return row;
  });

  return { version: updated.version, sections: updated.sections, updatedAt: updated.updatedAt };
}

/**
 * Publish the homepage (§8.3).
 *
 * Copies DRAFT.sections onto LIVE in one statement, so every pending section edit
 * goes live together — the storefront never sees a half-updated homepage.
 */
export async function publishHomepage(actorId: string, ctx: AuditContext) {
  const draft = await ensureHomepage(ContentVersion.DRAFT);
  await ensureHomepage(ContentVersion.LIVE);

  const published = await prisma.$transaction(async (tx) => {
    const row = await tx.homepageContent.update({
      where: { version: ContentVersion.LIVE },
      data: {
        sections: draft.sections as Prisma.InputJsonValue,
        publishedAt: new Date(),
        updatedById: actorId,
      },
    });
    await writeAudit(
      ctx,
      { module: AuditModule.CONTENT, action: 'Published homepage changes', recordId: 'homepage' },
      tx,
    );
    return row;
  });

  return {
    version: published.version,
    sections: published.sections,
    publishedAt: published.publishedAt,
  };
}

/** Revert the draft to whatever is live. */
export async function discardHomepageDraft(ctx: AuditContext) {
  const live = await ensureHomepage(ContentVersion.LIVE);
  await ensureHomepage(ContentVersion.DRAFT);

  const reverted = await prisma.$transaction(async (tx) => {
    const row = await tx.homepageContent.update({
      where: { version: ContentVersion.DRAFT },
      data: { sections: live.sections as Prisma.InputJsonValue },
    });
    await writeAudit(
      ctx,
      { module: AuditModule.CONTENT, action: 'Discarded homepage draft', recordId: 'homepage' },
      tx,
    );
    return row;
  });

  return { version: reverted.version, sections: reverted.sections };
}
