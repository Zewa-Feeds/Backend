/**
 * Public storefront API — /api/v1/*
 *
 * No authentication. Two rules hold throughout:
 *
 *  1. **Published data only.** DRAFT products and articles are invisible here;
 *     draft content is reachable only via a signed preview token.
 *  2. **Narrow serializers.** These responses omit internal ids, HSN codes, cost
 *     data and staff attribution. The CMS serializers are not reused.
 */
import { Router } from 'express';
import { ContentStatus, ContentVersion, ProductStatus, ReviewState } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '@/middleware/asyncHandler';
import { validate, emailSchema, slugSchema } from '@/middleware/validate';
import { couponLimiter, reviewLimiter } from '@/middleware/rateLimit';
import { prisma } from '@/lib/prisma';
import { notFound } from '@/lib/errors';
import { plainText } from '@/lib/sanitize';
import {
  CATEGORY_LABELS,
  ACTIVE_CATEGORIES,
  serializePublic,
  FAMILY_SELECT,
  toRupees,
} from '@/modules/products/products.serializer';
import * as settingsService from '@/modules/settings/settings.service';
import * as couponsService from '@/modules/coupons/coupons.service';
import * as reviewsService from '@/modules/reviews/reviews.service';
import { priceCart } from '@/modules/checkout/pricing.service';
import { enabledPaymentMethods } from '@/integrations/razorpay/payment.service';

export const catalogRouter = Router();

/** Cache-friendly: published catalogue changes rarely, and a stale minute is fine. */
const CACHE_60S = 'public, max-age=60, stale-while-revalidate=300';

// ============================================================================
// CATALOGUE
// ============================================================================

catalogRouter.get(
  '/catalog/products',
  validate({
    query: z.object({
      category: z.string().trim().max(40).optional(),
      q: z.string().trim().max(120).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const query = req.query as { category?: string; q?: string };

    // COMING_SOON is included so the storefront can show "notify me" cards;
    // DRAFT and DISCONTINUED never appear.
    const families = await prisma.productFamily.findMany({
      where: {
        deletedAt: null,
        status: { in: [ProductStatus.ACTIVE, ProductStatus.COMING_SOON] },
        ...(query.category
          ? {
              category: (Object.entries(CATEGORY_LABELS).find(
                ([k, label]) => k === query.category || label === query.category,
              )?.[0] ?? undefined) as never,
            }
          : {}),
        ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {}),
      },
      select: FAMILY_SELECT,
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
    });

    res.setHeader('Cache-Control', CACHE_60S);
    res.json({ data: families.map(serializePublic) });
  }),
);

catalogRouter.get(
  '/catalog/products/:slug',
  validate({ params: z.object({ slug: slugSchema }) }),
  asyncHandler(async (req, res) => {
    const family = await prisma.productFamily.findFirst({
      where: {
        slug: req.params.slug as string,
        deletedAt: null,
        status: { in: [ProductStatus.ACTIVE, ProductStatus.COMING_SOON] },
      },
      select: FAMILY_SELECT,
    });
    if (!family) throw notFound('Product');

    // Only APPROVED reviews are public (§9).
    const reviews = await prisma.review.findMany({
      where: { familyId: family.id, state: ReviewState.APPROVED },
      orderBy: { submittedAt: 'desc' },
      take: 20,
      select: {
        rating: true,
        body: true,
        isVerifiedPurchase: true,
        submittedAt: true,
        guestName: true,
        customer: { select: { firstName: true } },
      },
    });

    const ratingSum = reviews.reduce((s, r) => s + r.rating, 0);

    res.setHeader('Cache-Control', CACHE_60S);
    res.json({
      data: {
        ...serializePublic(family),
        reviews: {
          count: reviews.length,
          average: reviews.length > 0 ? Math.round((ratingSum / reviews.length) * 10) / 10 : null,
          items: reviews.map((r) => ({
            // First name only — never expose a reviewer's email or full identity.
            author: r.customer?.firstName ?? r.guestName ?? 'Verified buyer',
            rating: r.rating,
            body: r.body,
            verifiedPurchase: r.isVerifiedPurchase,
            at: r.submittedAt,
          })),
        },
      },
    });
  }),
);

/** Rotating spotlight banners on the products page (§8.2). */
/**
 * Browsable categories, in display order.
 *
 * The storefront used to derive its filter chips from whatever products the
 * catalogue happened to return. That collapsed the list to two entries, because
 * only three of thirteen products are ACTIVE — the rest are still DRAFT, so the
 * public endpoint (correctly) does not return them, and their categories
 * vanished with them.
 *
 * The category list is a fixed taxonomy, not a function of what is published
 * today. Serving it from ACTIVE_CATEGORIES keeps the shop's chips stable as
 * products are published, and keeps one source of truth shared with the CMS.
 */
catalogRouter.get(
  '/catalog/categories',
  asyncHandler(async (_req, res) => {
    res.setHeader('Cache-Control', CACHE_60S);
    res.json({
      data: ACTIVE_CATEGORIES.map((value) => ({
        value,
        label: CATEGORY_LABELS[value],
      })),
    });
  }),
);

catalogRouter.get(
  '/catalog/spotlights',
  asyncHandler(async (_req, res) => {
    const spotlights = await prisma.spotlight.findMany({
      where: { isActive: true, family: { deletedAt: null, status: ProductStatus.ACTIVE } },
      orderBy: { position: 'asc' },
      select: {
        tagline: true,
        subText: true,
        badge: true,
        imageUrl: true,
        family: {
          select: {
            name: true,
            slug: true,
            category: true,
            proteinPct: true,
            variants: {
              where: { isActive: true },
              orderBy: { position: 'asc' },
              select: { pricePaise: true, mrpPaise: true, pack: true },
            },
          },
        },
      },
    });

    res.setHeader('Cache-Control', CACHE_60S);
    res.json({
      data: spotlights.map((s) => ({
        name: s.family.name,
        slug: s.family.slug,
        category: CATEGORY_LABELS[s.family.category],
        tagline: s.tagline,
        subText: s.subText,
        badge: s.badge,
        imageUrl: s.imageUrl,
        proteinPct: s.family.proteinPct,
        packs: s.family.variants.map((v) => v.pack),
        pricePaise: s.family.variants[0]?.pricePaise ?? null,
        mrpPaise: s.family.variants[0]?.mrpPaise ?? null,
        price: s.family.variants[0] ? toRupees(s.family.variants[0].pricePaise) : null,
        mrp: s.family.variants[0] ? toRupees(s.family.variants[0].mrpPaise) : null,
      })),
    });
  }),
);

/** Live homepage sections (§8.3) — never the DRAFT row. */
catalogRouter.get(
  '/catalog/homepage',
  asyncHandler(async (_req, res) => {
    const live = await prisma.homepageContent.findUnique({
      where: { version: ContentVersion.LIVE },
      select: { sections: true, publishedAt: true },
    });

    res.setHeader('Cache-Control', CACHE_60S);
    res.json({ data: { sections: live?.sections ?? {}, publishedAt: live?.publishedAt ?? null } });
  }),
);

// ============================================================================
// CONTENT (§8.1)
// ============================================================================

catalogRouter.get(
  '/content/articles',
  validate({ query: z.object({ tag: z.string().trim().max(40).optional() }) }),
  asyncHandler(async (req, res) => {
    const articles = await prisma.article.findMany({
      where: {
        deletedAt: null,
        status: ContentStatus.PUBLISHED,
        ...(req.query.tag ? { tag: req.query.tag as string } : {}),
      },
      orderBy: { publishedAt: 'desc' },
      select: {
        slug: true,
        title: true,
        tag: true,
        readMinutes: true,
        excerpt: true,
        coverImageUrl: true,
        authorName: true,
        publishedAt: true,
      },
    });

    res.setHeader('Cache-Control', CACHE_60S);
    res.json({ data: articles });
  }),
);

catalogRouter.get(
  '/content/articles/:slug',
  validate({ params: z.object({ slug: slugSchema }) }),
  asyncHandler(async (req, res) => {
    const slug = req.params.slug as string;

    const article = await prisma.article.findFirst({
      where: { slug, deletedAt: null, status: ContentStatus.PUBLISHED },
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
      },
    });
    if (!article) throw notFound('Article');

    const related = await prisma.article.findMany({
      where: {
        deletedAt: null,
        status: ContentStatus.PUBLISHED,
        slug: { not: slug },
        tag: article.tag,
      },
      take: 2,
      orderBy: { publishedAt: 'desc' },
      select: { slug: true, title: true, tag: true, readMinutes: true, coverImageUrl: true },
    });

    res.setHeader('Cache-Control', CACHE_60S);
    res.json({ data: { ...article, related } });
  }),
);

// ============================================================================
// SETTINGS + CART
// ============================================================================

/** Shipping thresholds, GST, announcement bar, maintenance flag. */
catalogRouter.get(
  '/settings/public',
  asyncHandler(async (_req, res) => {
    const settings = await settingsService.getPublic();
    res.setHeader('Cache-Control', 'public, max-age=30');
    res.json({ data: { ...settings, paymentMethods: enabledPaymentMethods() } });
  }),
);

const cartLinesSchema = z.object({
  lines: z
    .array(
      z.object({
        sku: z.string().trim().max(40),
        qty: z.coerce.number().int().min(1).max(99),
      }),
    )
    .min(1, 'Your cart is empty.')
    .max(50),
  couponCode: z.string().trim().max(30).optional().nullable(),
  email: emailSchema.optional(),
  state: z.string().trim().max(60).optional(),
});

/**
 * Re-price a cart against live data.
 *
 * The storefront calls this on mount and before checkout, so a cart held in
 * localStorage for a week cannot check out at last week's prices.
 */
catalogRouter.post(
  '/cart/validate',
  validate({ body: cartLinesSchema }),
  asyncHandler(async (req, res) => {
    const cart = await priceCart(req.body);
    res.json({ data: cart });
  }),
);

/** §10.2 dependency — the checkout "Have a coupon?" input. */
catalogRouter.post(
  '/coupons/validate',
  couponLimiter,
  validate({
    body: z.object({
      code: z.string().trim().min(1).max(30),
      subtotalPaise: z.coerce.number().int().positive(),
      email: emailSchema.optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await couponsService.validateForCart(
      req.body.code,
      req.body.subtotalPaise,
      req.body.email,
    );
    res.json({ data: result });
  }),
);

// ============================================================================
// PUBLIC REVIEW SUBMISSION (§9)
// ============================================================================

catalogRouter.post(
  '/reviews',
  reviewLimiter,
  validate({
    body: z.object({
      productSlug: slugSchema,
      rating: z.coerce.number().int().min(1).max(5),
      // Sanitised: this text is rendered on the PDP.
      body: z.string().trim().min(10, 'Tell us a little more.').max(2000).transform(plainText),
      email: emailSchema,
      name: z.string().trim().max(80).transform(plainText).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const review = await reviewsService.submit({
      productSlug: req.body.productSlug,
      rating: req.body.rating,
      body: req.body.body,
      email: req.body.email,
      guestName: req.body.name,
    });

    // Deliberately does NOT return the review body or id — it is unpublished, and
    // echoing it back invites the assumption that it is live.
    res.status(201).json({
      data: {
        submitted: true,
        verifiedPurchase: review.vp,
        message: 'Thanks! Your review will appear once it has been checked.',
      },
    });
  }),
);
