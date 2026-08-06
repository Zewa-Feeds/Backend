/**
 * Draft preview — /api/v1/preview/*  (§5.2, §8.1, §8.3)
 *
 * Serves UNPUBLISHED content to a holder of a signed, short-lived token. This is
 * what makes the CMS's Preview button work: staff see the draft rendered by the
 * real storefront before anything goes live.
 *
 * Three constraints keep it from becoming a hole:
 *   - the token is signed with its own secret (JWT_PREVIEW_SECRET) and carries
 *     `typ: 'preview'`, so it cannot be used as an access token
 *   - it is scoped to ONE resource kind + slug, so a leaked token exposes one
 *     draft, not the whole pipeline
 *   - responses are `no-store` and the routes are never indexable
 */
import { Router, type Response } from 'express';
import { ContentVersion } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '@/middleware/asyncHandler';
import { validate, slugSchema } from '@/middleware/validate';
import { verifyPreviewToken } from '@/lib/tokens';
import { forbidden, notFound } from '@/lib/errors';
import { prisma } from '@/lib/prisma';
import { FAMILY_SELECT, serializePublic } from '@/modules/products/products.serializer';

export const previewRouter = Router();

const tokenQuery = z.object({ token: z.string().min(10) });

/** No caching, and no indexing — draft content must not leak into a CDN or crawler. */
function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
}

/**
 * Product preview.
 *
 * Renders the draft overlay when one exists, otherwise the live rows — matching
 * §5.2: "Preview shows the draft version."
 */
previewRouter.get(
  '/products/:slug',
  validate({ params: z.object({ slug: slugSchema }), query: tokenQuery }),
  asyncHandler(async (req, res) => {
    const slug = req.params.slug as string;
    const claims = verifyPreviewToken(req.query.token as string);

    // Scope check: a token for one product must not open another.
    if (claims.kind !== 'product' || claims.slug !== slug) {
      throw forbidden('This preview link is not valid for that product.');
    }

    const family = await prisma.productFamily.findFirst({
      where: { slug, deletedAt: null },
      select: { ...FAMILY_SELECT, draft: { select: { payload: true } } },
    });
    if (!family) throw notFound('Product');

    const { draft, ...live } = family;
    const base = serializePublic({ ...live, draft: null });

    noStore(res);

    if (!draft) {
      res.json({ data: { ...base, isDraft: false } });
      return;
    }

    // Merge the draft payload over the live shape. Variants come from the draft so
    // pack/pricing changes are visible; images stay live (uploads are immediate).
    const payload = draft.payload as Record<string, unknown> & {
      name?: string;
      shortDesc?: string;
      fullDesc?: string;
      protein?: number;
      benefits?: string[];
      nutrition?: Record<string, string>;
      variants?: { sku: string; pack: string; price: number; mrp: number; stock: number }[];
    };

    res.json({
      data: {
        ...base,
        isDraft: true,
        name: payload.name ?? base.name,
        shortDesc: payload.shortDesc ?? base.shortDesc,
        fullDescHtml: payload.fullDesc ?? base.fullDescHtml,
        proteinPct: payload.protein ?? base.proteinPct,
        benefits: payload.benefits ?? base.benefits,
        nutrition: payload.nutrition ?? base.nutrition,
        packs:
          payload.variants?.map((v) => ({
            sku: v.sku,
            pack: v.pack,
            pricePaise: Math.round(v.price * 100),
            mrpPaise: Math.round(v.mrp * 100),
            price: v.price,
            mrp: v.mrp,
            inStock: v.stock > 0,
          })) ?? base.packs,
      },
    });
  }),
);

previewRouter.get(
  '/articles/:slug',
  validate({ params: z.object({ slug: slugSchema }), query: tokenQuery }),
  asyncHandler(async (req, res) => {
    const slug = req.params.slug as string;
    const claims = verifyPreviewToken(req.query.token as string);

    if (claims.kind !== 'article' || claims.slug !== slug) {
      throw forbidden('This preview link is not valid for that article.');
    }

    const article = await prisma.article.findFirst({
      where: { slug, deletedAt: null },
      select: {
        slug: true,
        title: true,
        tag: true,
        readMinutes: true,
        excerpt: true,
        bodyHtml: true,
        contentBlocks: true,
        coverImageUrl: true,
        seoTitle: true,
        seoDesc: true,
        authorName: true,
        publishedAt: true,
        status: true,
        draftPayload: true,
      },
    });
    if (!article) throw notFound('Article');

    const { draftPayload, ...live } = article;
    const overlay = (draftPayload ?? {}) as Record<string, unknown>;

    noStore(res);
    res.json({
      data: {
        ...live,
        ...overlay,
        // Never let an overlay rewrite the identity of what is being previewed.
        slug: live.slug,
        isDraft: Boolean(draftPayload) || live.status === 'DRAFT',
        related: [],
      },
    });
  }),
);

previewRouter.get(
  '/homepage',
  validate({ query: tokenQuery }),
  asyncHandler(async (req, res) => {
    const claims = verifyPreviewToken(req.query.token as string);
    if (claims.kind !== 'homepage') {
      throw forbidden('This preview link is not valid for the homepage.');
    }

    const draft = await prisma.homepageContent.findUnique({
      where: { version: ContentVersion.DRAFT },
      select: { sections: true, updatedAt: true },
    });

    noStore(res);
    res.json({
      data: { sections: draft?.sections ?? {}, isDraft: true, updatedAt: draft?.updatedAt ?? null },
    });
  }),
);
