/**
 * Content routes — /api/v1/admin/content/*
 *
 * The permission split here is the interesting bit (§2.1):
 *   articles.create   ALL roles — an Editor is hired to write
 *   articles.publish  Ops + Admin — but not to decide what ships
 *   articles.delete   Admin only
 *   banners.edit      ALL roles
 *   homepage.edit     ALL roles
 *
 * So a Content Editor has full authoring rights and zero release authority.
 */
import { Router } from 'express';
import { ContentStatus, ContentVersion } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '@/middleware/asyncHandler';
import { currentUser, requirePermission } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { auditContext } from '@/modules/audit/audit.service';
import { signPreviewToken } from '@/lib/tokens';
import { env } from '@/config/env';
import {
  articleBodySchema,
  articleListQuerySchema,
  homepageBodySchema,
  idParamSchema,
  slugParamSchema,
  spotlightBodySchema,
  spotlightReorderSchema,
} from './content.schemas';
import * as contentService from './content.service';

export const contentRouter = Router();

// ============================================================================
// ARTICLES (§8.1)
// ============================================================================
const articlesRouter = Router();
articlesRouter.use(requirePermission('articles.create'));

articlesRouter.get(
  '/',
  validate({ query: articleListQuerySchema }),
  asyncHandler(async (req, res) => {
    const result = await contentService.listArticles(req.query as never);
    res.json(result);
  }),
);

articlesRouter.get(
  '/:slug',
  validate({ params: slugParamSchema }),
  asyncHandler(async (req, res) => {
    const article = await contentService.articleBySlug(req.params.slug as string);
    res.json({ data: article });
  }),
);

articlesRouter.post(
  '/',
  validate({ body: articleBodySchema }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const article = await contentService.createArticle(
      req.body,
      user.id,
      user.name,
      auditContext(req),
    );
    res.status(201).json({ data: article });
  }),
);

articlesRouter.patch(
  '/:slug',
  validate({ params: slugParamSchema, body: articleBodySchema }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const article = await contentService.saveArticle(
      req.params.slug as string,
      req.body,
      user.id,
      auditContext(req),
    );
    res.json({ data: article });
  }),
);

/** Publishing needs `articles.publish` — Editors are excluded (§2.1). */
articlesRouter.post(
  '/:slug/publish',
  requirePermission('articles.publish'),
  validate({ params: slugParamSchema }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const article = await contentService.publishArticle(
      req.params.slug as string,
      user.id,
      auditContext(req),
    );
    res.json({ data: article });
  }),
);

/** Status toggle (publish/unpublish) — also gated on articles.publish. */
articlesRouter.patch(
  '/:slug/status',
  requirePermission('articles.publish'),
  validate({
    params: slugParamSchema,
    body: z.object({ status: z.nativeEnum(ContentStatus) }),
  }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const article = await contentService.setArticleStatus(
      req.params.slug as string,
      req.body.status,
      user.id,
      auditContext(req),
    );
    res.json({ data: article });
  }),
);

articlesRouter.post(
  '/:slug/discard-draft',
  validate({ params: slugParamSchema }),
  asyncHandler(async (req, res) => {
    await contentService.discardArticleDraft(req.params.slug as string, auditContext(req));
    res.json({ data: { ok: true } });
  }),
);

articlesRouter.post(
  '/:slug/preview-token',
  validate({ params: slugParamSchema }),
  asyncHandler(async (req, res) => {
    const slug = req.params.slug as string;
    const token = signPreviewToken({ sub: currentUser(req).id, kind: 'article', slug });
    res.json({
      data: {
        token,
        url: `${env.STOREFRONT_ORIGIN}/preview/blog/${slug}?token=${token}`,
        expiresIn: env.PREVIEW_TOKEN_TTL,
      },
    });
  }),
);

articlesRouter.delete(
  '/:slug',
  requirePermission('articles.delete'),
  validate({ params: slugParamSchema }),
  asyncHandler(async (req, res) => {
    await contentService.deleteArticle(req.params.slug as string, auditContext(req));
    res.json({ data: { ok: true } });
  }),
);

// ============================================================================
// SPOTLIGHTS / BANNERS (§8.2)
// ============================================================================
const spotlightsRouter = Router();
spotlightsRouter.use(requirePermission('banners.edit'));

spotlightsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ data: await contentService.listSpotlights() });
  }),
);

spotlightsRouter.post(
  '/',
  validate({ body: spotlightBodySchema }),
  asyncHandler(async (req, res) => {
    const spotlight = await contentService.createSpotlight(req.body, auditContext(req));
    res.status(201).json({ data: spotlight });
  }),
);

/**
 * Reorder — mounted BEFORE /:id so "reorder" is not read as a uuid.
 */
spotlightsRouter.put(
  '/reorder',
  validate({ body: spotlightReorderSchema }),
  asyncHandler(async (req, res) => {
    const spotlights = await contentService.reorderSpotlights(req.body.order, auditContext(req));
    res.json({ data: spotlights });
  }),
);

spotlightsRouter.patch(
  '/:id',
  validate({ params: idParamSchema, body: spotlightBodySchema.partial() }),
  asyncHandler(async (req, res) => {
    const spotlight = await contentService.updateSpotlight(
      req.params.id as string,
      req.body,
      auditContext(req),
    );
    res.json({ data: spotlight });
  }),
);

spotlightsRouter.patch(
  '/:id/toggle',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    const spotlight = await contentService.toggleSpotlight(req.params.id as string, auditContext(req));
    res.json({ data: spotlight });
  }),
);

spotlightsRouter.delete(
  '/:id',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    await contentService.deleteSpotlight(req.params.id as string, auditContext(req));
    res.json({ data: { ok: true } });
  }),
);

// ============================================================================
// HOMEPAGE (§8.3)
// ============================================================================
const homepageRouter = Router();
homepageRouter.use(requirePermission('homepage.edit'));

/** Defaults to the DRAFT version — that is what the editor loads. */
homepageRouter.get(
  '/',
  validate({ query: z.object({ version: z.nativeEnum(ContentVersion).optional() }) }),
  asyncHandler(async (req, res) => {
    const version = (req.query.version as ContentVersion) ?? ContentVersion.DRAFT;
    res.json({ data: await contentService.getHomepage(version) });
  }),
);

homepageRouter.put(
  '/',
  validate({ body: homepageBodySchema }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const draft = await contentService.saveHomepageDraft(req.body, user.id, auditContext(req));
    res.json({ data: draft });
  }),
);

/** Pushes every pending section edit live at once (§8.3). */
homepageRouter.post(
  '/publish',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const live = await contentService.publishHomepage(user.id, auditContext(req));
    res.json({ data: live });
  }),
);

homepageRouter.post(
  '/discard-draft',
  asyncHandler(async (req, res) => {
    res.json({ data: await contentService.discardHomepageDraft(auditContext(req)) });
  }),
);

homepageRouter.post(
  '/preview-token',
  asyncHandler(async (req, res) => {
    const token = signPreviewToken({
      sub: currentUser(req).id,
      kind: 'homepage',
      slug: 'homepage',
    });
    res.json({
      data: {
        token,
        url: `${env.STOREFRONT_ORIGIN}/preview/homepage?token=${token}`,
        expiresIn: env.PREVIEW_TOKEN_TTL,
      },
    });
  }),
);

contentRouter.use('/articles', articlesRouter);
contentRouter.use('/spotlights', spotlightsRouter);
// The CMS route is /content/banners; keep both names pointing at the same module.
contentRouter.use('/banners', spotlightsRouter);
contentRouter.use('/homepage', homepageRouter);
