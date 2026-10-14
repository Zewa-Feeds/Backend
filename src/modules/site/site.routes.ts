/**
 * Website content, media library and publishing.
 *
 *   /api/v1/admin/media/*   media.manage                (Editor + Admin)
 *   /api/v1/admin/site/*    site.edit to read and draft (Editor + Admin)
 *                           site.publish to release     (Admin)
 *   /api/v1/site/live/*     public, read by the storefront BUILD only
 *   /api/v1/preview/site/*  signed preview token
 *
 * Every permission is enforced here; the CMS hiding a button is a courtesy.
 */
import { Router, type Response } from 'express';
import { ContentStatus } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '@/middleware/asyncHandler';
import { currentUser, requirePermission } from '@/middleware/auth';
import { slugSchema, validate } from '@/middleware/validate';
import { auditContext } from '@/modules/audit/audit.service';
import { signPreviewToken, verifyPreviewToken } from '@/lib/tokens';
import { forbidden, notFound } from '@/lib/errors';
import { prisma } from '@/lib/prisma';
import { env } from '@/config/env';
import { placementCatalogue } from './placements';
import * as media from './media.service';
import * as site from './site.service';
import { articleAssetIds, loadAssets, resolveArticle, validateArticle, type ArticleSource } from './resolve';
import {
  mediaListQuerySchema,
  publishSchema,
  registerMediaSchema,
  replaceMediaSchema,
  saveDraftSchema,
  updateMediaSchema,
} from './site.schemas';

const idParam = z.object({ id: z.string().uuid() });
const versionParam = z.object({ version: z.coerce.number().int().positive() });
const partParam = z.object({ part: z.enum(site.SECTION_PARTS) });

// ============================================================================
// MEDIA LIBRARY
// ============================================================================

export const mediaRouter = Router();
mediaRouter.use(requirePermission('media.manage'));

mediaRouter.get(
  '/',
  validate({ query: mediaListQuerySchema }),
  asyncHandler(async (req, res) => {
    res.json(await media.listMedia(req.query as never));
  }),
);

mediaRouter.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json({ data: await media.getMedia(req.params.id as string) });
  }),
);

/** Called after the browser finishes a signed upload. Facts are read from Cloudinary, not the client. */
mediaRouter.post(
  '/',
  validate({ body: registerMediaSchema }),
  asyncHandler(async (req, res) => {
    const row = await media.registerUpload(req.body, currentUser(req).id, auditContext(req));
    res.status(201).json({ data: row });
  }),
);

mediaRouter.patch(
  '/:id',
  validate({ params: idParam, body: updateMediaSchema }),
  asyncHandler(async (req, res) => {
    res.json({ data: await media.updateMedia(req.params.id as string, req.body, auditContext(req)) });
  }),
);

mediaRouter.post(
  '/:id/replace',
  validate({ params: idParam, body: replaceMediaSchema }),
  asyncHandler(async (req, res) => {
    res.json({ data: await media.replaceFile(req.params.id as string, req.body.publicId, auditContext(req)) });
  }),
);

mediaRouter.post(
  '/:id/archive',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json({ data: await media.archiveMedia(req.params.id as string, auditContext(req)) });
  }),
);

mediaRouter.post(
  '/:id/restore',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json({ data: await media.restoreMedia(req.params.id as string, auditContext(req)) });
  }),
);

// ============================================================================
// SITE CONTENT
// ============================================================================

export const siteRouter = Router();
siteRouter.use(requirePermission('site.edit'));

siteRouter.get(
  '/placements',
  asyncHandler(async (_req, res) => {
    res.json({ data: placementCatalogue() });
  }),
);

siteRouter.get(
  '/draft',
  asyncHandler(async (_req, res) => {
    res.json({ data: await site.getDraft() });
  }),
);

siteRouter.put(
  '/draft',
  validate({ body: saveDraftSchema }),
  asyncHandler(async (req, res) => {
    res.json({ data: await site.saveDraft(req.body, currentUser(req).id, auditContext(req)) });
  }),
);

siteRouter.get(
  '/draft/validate',
  asyncHandler(async (_req, res) => {
    res.json({ data: await site.validateDraft() });
  }),
);

/** Article checks, for the editor's checklist before publishing. */
siteRouter.get(
  '/articles/:slug/validate',
  validate({ params: z.object({ slug: slugSchema }) }),
  asyncHandler(async (req, res) => {
    const row = await prisma.article.findFirst({ where: { slug: req.params.slug as string, deletedAt: null } });
    if (!row) throw notFound('Article');
    const effective = { ...row, ...((row.draftPayload as object | null) ?? {}) } as unknown as ArticleSource;
    const issues = validateArticle(effective, await loadAssets(articleAssetIds(effective)));
    res.json({ data: { issues } });
  }),
);

siteRouter.post(
  '/preview-token',
  asyncHandler(async (req, res) => {
    const token = signPreviewToken({ sub: currentUser(req).id, kind: 'site', slug: 'site' });
    res.json({
      data: {
        token,
        url: `${env.STOREFRONT_ORIGIN}/preview/site?token=${token}`,
        expiresIn: env.PREVIEW_TOKEN_TTL,
      },
    });
  }),
);

siteRouter.get(
  '/publications',
  validate({ query: z.object({ page: z.coerce.number().int().positive().default(1) }) }),
  asyncHandler(async (req, res) => {
    res.json(await site.listPublications(Number(req.query.page) || 1));
  }),
);

siteRouter.get(
  '/publications/:version',
  validate({ params: versionParam }),
  asyncHandler(async (req, res) => {
    res.json({ data: await site.getPublication(Number(req.params.version)) });
  }),
);

// ---- Release actions: Admin only ------------------------------------------

siteRouter.post(
  '/publish',
  requirePermission('site.publish'),
  validate({ body: publishSchema }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const pub = await site.publishSite(req.body, { id: user.id, name: user.name }, auditContext(req));
    res.status(201).json({ data: pub });
  }),
);

siteRouter.post(
  '/publications/:version/rollback',
  requirePermission('site.publish'),
  validate({ params: versionParam }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const pub = await site.rollbackTo(Number(req.params.version), { id: user.id, name: user.name }, auditContext(req));
    res.status(201).json({ data: pub });
  }),
);

siteRouter.post(
  '/publications/:version/retry',
  requirePermission('site.publish'),
  validate({ params: versionParam }),
  asyncHandler(async (req, res) => {
    res.json({ data: await site.retryPublication(Number(req.params.version), auditContext(req)) });
  }),
);

siteRouter.post(
  '/rebuild',
  requirePermission('site.publish'),
  asyncHandler(async (req, res) => {
    res.json({ data: await site.rebuildSite(auditContext(req)) });
  }),
);

// ============================================================================
// PUBLIC — the storefront build
// ============================================================================

/**
 * Never cached in transit. The storefront's own data cache decides freshness,
 * keyed by tag; an intermediary holding a copy would make "revalidate" fetch a
 * stale snapshot and report success.
 */
function noStore(res: Response) {
  res.setHeader('Cache-Control', 'no-store');
}

export const liveSiteRouter = Router();

liveSiteRouter.get(
  '/version',
  asyncHandler(async (_req, res) => {
    noStore(res);
    res.json({ data: await site.liveVersion() });
  }),
);

liveSiteRouter.get(
  '/sections/:part',
  validate({ params: partParam }),
  asyncHandler(async (req, res) => {
    noStore(res);
    res.json({ data: await site.livePart(req.params.part as site.SectionPart) });
  }),
);

liveSiteRouter.get(
  '/articles',
  asyncHandler(async (_req, res) => {
    noStore(res);
    res.json({ data: await site.liveArticleIndex() });
  }),
);

liveSiteRouter.get(
  '/articles/:slug',
  validate({ params: z.object({ slug: slugSchema }) }),
  asyncHandler(async (req, res) => {
    noStore(res);
    res.json({ data: await site.liveArticle(req.params.slug as string) });
  }),
);

// ============================================================================
// PREVIEW — draft content behind a short-lived signed token
// ============================================================================

export const sitePreviewRouter = Router();
const tokenQuery = z.object({ token: z.string().min(10) });

sitePreviewRouter.get(
  '/sections/:part',
  validate({ params: partParam, query: tokenQuery }),
  asyncHandler(async (req, res) => {
    const claims = verifyPreviewToken(req.query.token as string);
    if (claims.kind !== 'site') throw forbidden('This preview link is not valid for the website.');
    noStore(res);
    res.json({ data: { version: 0, draft: true, data: await site.previewDraftPart(req.params.part as site.SectionPart) } });
  }),
);

/** An article as it would publish: live columns with the pending overlay applied. */
sitePreviewRouter.get(
  '/articles/:slug',
  validate({ params: z.object({ slug: slugSchema }), query: tokenQuery }),
  asyncHandler(async (req, res) => {
    const slug = req.params.slug as string;
    const claims = verifyPreviewToken(req.query.token as string);
    if (!(claims.kind === 'article' && claims.slug === slug) && claims.kind !== 'site') {
      throw forbidden('This preview link is not valid for that article.');
    }
    const row = await prisma.article.findFirst({ where: { slug, deletedAt: null } });
    if (!row) throw notFound('Article');
    const effective = {
      ...row,
      ...((row.draftPayload as object | null) ?? {}),
      slug: row.slug,
      publishedAt: row.publishedAt,
    } as unknown as ArticleSource;
    noStore(res);
    res.json({
      data: {
        version: 0,
        draft: row.status !== ContentStatus.PUBLISHED || Boolean(row.draftPayload),
        data: resolveArticle(effective, await loadAssets(articleAssetIds(effective))),
      },
    });
  }),
);
