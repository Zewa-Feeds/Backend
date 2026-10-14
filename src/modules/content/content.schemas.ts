/**
 * Content request schemas (§8).
 *
 * Sanitisation is applied per field according to what the CMS renders it as:
 *   - article body        → full rich text
 *   - article excerpt     → compact (inline emphasis + lists, no headings)
 *   - homepage subtexts   → compact
 *   - titles, SEO, labels → plain text, markup stripped
 */
import { z } from 'zod';
import { ContentStatus } from '@prisma/client';
import { compactText, plainText, richText } from '@/lib/sanitize';
import { enumFilter, paginationSchema, slugSchema } from '@/middleware/validate';
import { articleExtrasSchema, blocksSchema, text } from '@/modules/site/site.schemas';

/** Article tags, matching the CMS's Select options. */
export const ARTICLE_TAGS = ['Science', 'Betta', 'Cichlid', 'Hatchery', 'Guppy', 'Guides'] as const;

/*
 * Titles, tags and SEO strings are rendered by React as text, so they are
 * cleaned with `text()` rather than `plainText()` — the latter HTML-escapes and
 * the storefront would print "&amp;" literally.
 */
export const articleBodySchema = z
  .object({
    title: text(180).pipe(z.string().min(3, 'Title is required.')),
    slug: slugSchema.optional(),
    tag: text(40).pipe(z.string().min(1, 'Pick a category.')),
    readMinutes: z.coerce.number().int().min(1).max(120).default(5),

    // Checked on the sanitised output so markup cannot smuggle length past the limit.
    excerpt: z
      .string()
      .trim()
      .min(1, 'An excerpt is required.')
      .max(2000)
      .transform(compactText)
      .refine((v) => v.replace(/<[^>]*>/g, '').length <= 300, 'Excerpt is too long.'),

    /** Legacy rich-text body. New articles use contentBlocks. */
    bodyHtml: z.string().max(200_000).default('').transform(richText),

    /** The storefront's structured block array — validated block by block. */
    contentBlocks: blocksSchema.optional().nullable(),

    coverImageUrl: z.string().url().max(1000).optional().nullable(),
    coverImageId: z.string().max(200).optional().nullable(),

    seoTitle: text(70).optional().nullable(),
    seoDesc: text(180).optional().nullable(),

    authorName: text(120).optional(),
  })
  .merge(articleExtrasSchema.omit({ blocks: true }));

export const scheduleArticleSchema = z.object({
  /** ISO time in the future, or null to cancel. */
  scheduledAt: z.coerce
    .date()
    .nullable()
    .refine((d) => d === null || d.getTime() > Date.now() + 30_000, 'Pick a time in the future.'),
});

export type ArticleBody = z.infer<typeof articleBodySchema>;

export const articleListQuerySchema = paginationSchema.extend({
  status: enumFilter(z.nativeEnum(ContentStatus)),
  // "All" is the CMS's unset sentinel for the tag dropdown too.
  tag: z
    .string()
    .trim()
    .max(40)
    .optional()
    .transform((v) => (v === 'All' || v === '' ? undefined : v)),
});

// ---- Spotlights (§8.2) -----------------------------------------------------

export const spotlightBodySchema = z.object({
  /** Which product family this spotlight promotes. */
  familyId: z.string().uuid('Pick a product.'),
  tagline: z.string().trim().min(1, 'A tagline is required.').max(120).transform(plainText),
  subText: z.string().trim().max(160).transform(plainText).default(''),
  badge: z.string().trim().max(30).transform(plainText).optional().nullable(),
  // https, or a site path for library files served from the storefront itself.
  imageUrl: z
    .string()
    .max(1000)
    .refine((v) => /^https:\/\/\S+$/.test(v) || (v.startsWith('/') && !v.startsWith('//')), 'Use an https:// URL or a site path.')
    .optional()
    .nullable(),
  isActive: z.boolean().default(true),
});

/**
 * Reorder — the CMS sends the full ordered id list after a drag or arrow move.
 * Taking the whole list rather than a single index makes the operation idempotent.
 */
export const spotlightReorderSchema = z.object({
  order: z.array(z.string().uuid()).min(1, 'Nothing to reorder.').max(20),
});

// ---- Homepage (§8.3) -------------------------------------------------------

/** Subtexts are compact rich text; everything else is plain. */
const heroSchema = z.object({
  eyebrow: z.string().max(120).transform(plainText).default(''),
  title: z.string().max(200).transform(plainText).default(''),
  sub: z.string().max(2000).transform(compactText).default(''),
  cta: z.string().max(60).transform(plainText).default(''),
});

const sectionSchema = z.object({
  title: z.string().max(200).transform(plainText).default(''),
  sub: z.string().max(2000).transform(compactText).default(''),
});

const announcementSchema = z.object({
  text: z.string().max(200).transform(plainText).default(''),
  linkLabel: z.string().max(60).transform(plainText).default(''),
  linkUrl: z.string().max(500).default('/'),
  // Hex only — these values are interpolated into a style attribute on the
  // storefront, so an arbitrary string would be a CSS injection vector.
  bg: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #080C18.').default('#080C18'),
  fg: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #44E5C2.').default('#44E5C2'),
  active: z.boolean().default(false),
});

export const homepageBodySchema = z.object({
  hero: heroSchema,
  science: sectionSchema,
  why: sectionSchema,
  knowledge: sectionSchema,
  announcement: announcementSchema,
});

export type HomepageBody = z.infer<typeof homepageBodySchema>;

export const slugParamSchema = z.object({ slug: slugSchema });
export const idParamSchema = z.object({ id: z.string().uuid() });
