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

/** Article tags, matching the CMS's Select options. */
export const ARTICLE_TAGS = ['Science', 'Betta', 'Cichlid', 'Hatchery', 'Guppy', 'Guides'] as const;

export const articleBodySchema = z.object({
  title: z.string().trim().min(3, 'Title is required.').max(180).transform(plainText),
  slug: slugSchema.optional(),
  tag: z.string().trim().min(1, 'Pick a tag.').max(40).transform(plainText),
  readMinutes: z.coerce.number().int().min(1).max(120).default(5),

  // §8.1 — compact rich text, 180-char limit in the CMS editor. Checked on the
  // sanitised output so markup cannot be used to smuggle length past the limit.
  excerpt: z
    .string()
    .trim()
    .min(1, 'An excerpt is required.')
    .max(2000)
    .transform(compactText)
    .refine((v) => v.replace(/<[^>]*>/g, '').length <= 300, 'Excerpt is too long.'),

  bodyHtml: z.string().max(200_000).default('').transform(richText),

  /** The storefront's structured block array, passed through unchanged. */
  contentBlocks: z.array(z.record(z.string(), z.unknown())).optional().nullable(),

  coverImageUrl: z.string().url().max(1000).optional().nullable(),
  coverImageId: z.string().max(200).optional().nullable(),

  // Meta tags must be plain.
  seoTitle: z.string().trim().max(70).transform(plainText).optional().nullable(),
  seoDesc: z.string().trim().max(180).transform(plainText).optional().nullable(),

  authorName: z.string().trim().max(120).transform(plainText).optional(),
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
  imageUrl: z.string().url().max(1000).optional().nullable(),
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
