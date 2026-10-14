/**
 * Website content + article block schemas.
 *
 * TEXT IS TEXT. Every string here is rendered by React as a text node, which
 * escapes it — so these fields are NOT passed through `plainText()`. That helper
 * HTML-escapes (`&` → `&amp;`), and React would then print the entity literally:
 * "Kerala Startup Mission &amp; KSIDC". Markup safety comes from never feeding
 * these values to dangerouslySetInnerHTML; the only things that need policing
 * are control characters, length, and URLs.
 *
 * URLS are the one real injection surface (an href or src the storefront puts
 * in an attribute). They are restricted to site-relative paths or https.
 */
import { z } from 'zod';

/** Strip C0 controls (keeping newline and tab) and trim. */
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const clean = (v: string) => v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();

export const text = (max: number) => z.string().max(max * 2).transform(clean).pipe(z.string().max(max));
export const requiredText = (max: number, message = 'Required.') =>
  text(max).pipe(z.string().min(1, message));

/**
 * A link target: a site path ("/products/betta-bites", "#science") or https.
 * Protocol-relative "//host" is refused — it is an off-site link wearing a
 * path's clothes.
 */
export const href = z
  .string()
  .trim()
  .max(500)
  .refine(
    (v) => (v.startsWith('/') && !v.startsWith('//')) || v.startsWith('#') || /^https:\/\/[^\s]+$/.test(v),
    'Use a site path like /products/betta-bites, or a full https:// link.',
  );

const id = z
  .string()
  .trim()
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Lowercase letters, numbers and hyphens.');

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #44E5C2.');

/** A reference into the media library. Resolved to URL + dimensions at publish. */
export const assetRef = z.object({ assetId: z.string().uuid('Pick a file from the library.') });
export type AssetRef = z.infer<typeof assetRef>;

// ============================================================================
// ARTICLE BLOCKS — the storefront's renderer (components/blog/*) is the contract
// ============================================================================

const link = z.object({ text: requiredText(200), href });

export const blockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('lead'), text: requiredText(2000) }),
  z.object({ type: z.literal('p'), text: requiredText(5000), links: z.array(link).max(20).optional() }),
  z.object({
    type: z.literal('h2'),
    id,
    text: requiredText(200),
    /** Short label for the table of contents. Absent = not listed there. */
    toc: text(60).optional(),
  }),
  z.object({ type: z.literal('h3'), id: id.optional(), text: requiredText(200) }),
  z.object({
    type: z.literal('figure'),
    asset: assetRef,
    alt: requiredText(300, 'Describe the image for screen readers.'),
    caption: text(500).optional(),
    aspect: z
      .string()
      .regex(/^\d{1,4} \/ \d{1,4}$/, 'Aspect like "16 / 9".')
      .optional(),
  }),
  z.object({ type: z.literal('takeaways'), title: text(200).optional(), items: z.array(requiredText(1000)).min(1).max(12) }),
  z.object({
    type: z.literal('table'),
    caption: text(300).optional(),
    headers: z.array(text(120)).min(2).max(8),
    rows: z.array(z.array(text(300)).min(2).max(8)).min(1).max(40),
    highlightColumn: z.number().int().min(0).max(7).optional(),
  }),
  z.object({
    type: z.literal('faq'),
    items: z.array(z.object({ q: requiredText(300), a: requiredText(3000) })).min(1).max(20),
  }),
  z.object({
    type: z.literal('references'),
    items: z
      .array(z.object({ n: z.number().int().min(1).max(999).optional(), text: requiredText(1000), href: href.optional() }))
      .min(1)
      .max(60),
  }),
  z.object({ type: z.literal('pullquote'), text: requiredText(600) }),
  z.object({
    type: z.literal('stat-block'),
    items: z.array(z.object({ val: requiredText(20), label: requiredText(120) })).min(1).max(4),
  }),
  z.object({
    type: z.literal('callout'),
    variant: z.enum(['brand', 'info']).optional(),
    title: text(200).optional(),
    text: requiredText(2000),
  }),
  z.object({ type: z.literal('didyouknow'), title: text(200).optional(), text: requiredText(1500) }),
  z.object({
    type: z.literal('proscons'),
    items: z
      .array(
        z.object({
          name: requiredText(120),
          pros: z.array(requiredText(300)).max(10),
          cons: z.array(requiredText(300)).max(10),
        }),
      )
      .min(1)
      .max(6),
  }),
]);

export type Block = z.infer<typeof blockSchema>;

export const blocksSchema = z
  .array(blockSchema)
  .max(400)
  .superRefine((blocks, ctx) => {
    // Heading ids are anchor targets; a duplicate makes a TOC link jump to the
    // wrong section.
    const seen = new Set<string>();
    blocks.forEach((b, i) => {
      if ((b.type === 'h2' || b.type === 'h3') && b.id) {
        if (seen.has(b.id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'id'], message: `Heading id "${b.id}" is used twice.` });
        }
        seen.add(b.id);
      }
    });
  });

// ============================================================================
// WEBSITE SECTIONS
// ============================================================================

const slide = z.discriminatedUnion('type', [
  /** The coded "built to digest insects" statement tile. Only toggled/reordered. */
  z.object({ id, type: z.literal('statement'), enabled: z.boolean().default(true) }),
  z.object({
    id,
    type: z.literal('banner'),
    enabled: z.boolean().default(true),
    desktop: assetRef,
    mobile: assetRef,
    alt: requiredText(200, 'Describe the banner for screen readers.'),
    href: href.optional().nullable(),
  }),
  z.object({
    id,
    type: z.literal('video'),
    enabled: z.boolean().default(true),
    mp4: assetRef,
    webm: assetRef.optional().nullable(),
    mobileMp4: assetRef.optional().nullable(),
    poster: assetRef,
    label: text(120).optional(),
  }),
]);

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120);

const milestone = z.object({
  id,
  year: requiredText(12),
  points: z.array(requiredText(300)).min(1).max(8),
  image: assetRef.optional().nullable(),
  imageAlt: text(300).optional(),
});

const logo = z.object({ id, image: assetRef, alt: requiredText(200, 'Name the institution.') });

// ---- Copy blocks (text the pages show around the media) --------------------

const cta = z.object({ label: requiredText(40), href });

/** The coded first hero slide's words and its digestion-comparison panel. */
const statementSchema = z.object({
  /** Rendered as: {titleLead} <em>{titleEmphasis}</em><br/>{titleTail} */
  titleLead: requiredText(120),
  titleEmphasis: text(80),
  titleTail: text(120),
  body: text(600),
  primaryCta: cta,
  secondaryCta: cta,
  panel: z.object({
    eyebrow: text(60),
    source: text(60),
    bars: z
      .array(z.object({ label: requiredText(40), pct: z.number().min(0).max(100), value: requiredText(12), highlight: z.boolean() }))
      .min(1)
      .max(4),
    footnote: text(300),
  }),
});

/** "NABL verified data" — the four proof figures under the hero. */
const proofSchema = z.object({
  eyebrow: text(60),
  title: requiredText(160),
  intro: text(300),
  stats: z.array(z.object({ label: text(60), value: requiredText(12), caption: requiredText(120) })).min(1).max(4),
  footnote: text(300),
});

const aboutCopySchema = z.object({
  hero: z.object({ eyebrow: text(60), title: requiredText(160), lead: text(600), sub: text(600) }),
  headlineStats: z.array(z.object({ value: requiredText(12), label: requiredText(60), note: text(80) })).max(4),
  story: z.object({
    eyebrow: text(60),
    title: requiredText(160),
    paragraphs: z.array(requiredText(1200)).max(6),
    outcomes: z.array(requiredText(160)).max(6),
  }),
  purpose: z.array(z.object({ label: requiredText(40), text: requiredText(400) })).max(4),
  why: z.object({
    eyebrow: text(60),
    title: requiredText(160),
    body: text(1200),
    loop: z.array(z.object({ step: requiredText(40), detail: requiredText(200) })).max(6),
    quote: text(300),
  }),
  founder: z.object({
    eyebrow: text(60),
    name: requiredText(80),
    role: text(120),
    statement: text(800),
    bio: text(800),
    credentials: z.array(z.object({ label: requiredText(20), detail: requiredText(120) })).max(8),
    honours: z.array(requiredText(200)).max(12),
  }),
  values: z.object({
    eyebrow: text(60),
    title: requiredText(160),
    items: z.array(z.object({ title: requiredText(80), detail: requiredText(300) })).max(8),
  }),
  trust: z.object({
    eyebrow: text(60),
    title: requiredText(160),
    body: text(1200),
    trialStats: z.array(z.object({ value: requiredText(12), label: requiredText(80) })).max(4),
    footnote: text(300),
    backedByEyebrow: text(60),
    backedByTitle: text(160),
    /** Named backers with no logo file. */
    institutionsTextOnly: z.array(requiredText(120)).max(20),
  }),
  milestonesHeading: z.object({ eyebrow: text(60), title: text(160) }),
  range: z.object({
    eyebrow: text(60),
    title: requiredText(160),
    body: text(600),
    products: z.array(z.object({ name: requiredText(80), spec: text(160), slug })).max(12),
  }),
  cta: z.object({ title: requiredText(160), body: text(300), primary: cta, secondary: cta }),
});

// ---- Founder's letters ------------------------------------------------------

/**
 * Letter text is a plain string or a list of segments, some bold or italic —
 * the shape components/letters/LetterBody renders. Never HTML.
 */
const segment = z.object({ text: z.string().max(4000).transform(clean), strong: z.boolean().optional(), em: z.boolean().optional() });
const richLine = z.union([requiredText(4000), z.array(segment).min(1).max(40)]);

const letterBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('p'), text: richLine }),
  z.object({ type: z.literal('h2'), text: requiredText(200) }),
  z.object({ type: z.literal('h3'), text: requiredText(200) }),
  z.object({ type: z.literal('phase'), number: z.number().int().min(1).max(99), period: requiredText(40), text: requiredText(200) }),
  z.object({ type: z.literal('lesson'), text: requiredText(1500) }),
  z.object({ type: z.literal('ul'), items: z.array(richLine).min(1).max(30) }),
  z.object({
    type: z.literal('gallery'),
    images: z.array(z.object({ asset: assetRef, alt: requiredText(300, 'Describe each photo.') })).min(1).max(12),
  }),
]);

export const letterSchema = z.object({
  slug,
  title: requiredText(200),
  subtitle: text(300),
  /** YYYY-MM-DD; the newest letter is the one the About page previews. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-01.'),
  dateLabel: requiredText(40),
  author: requiredText(80),
  authorRole: text(80),
  authorOrg: text(120),
  excerpt: requiredText(600),
  cover: z.object({ asset: assetRef, alt: requiredText(300) }).nullable(),
  /** Hidden letters stay in the draft but are not published. */
  published: z.boolean().default(true),
  blocks: z.array(letterBlockSchema).max(300),
});

export type Letter = z.infer<typeof letterSchema>;

export const siteSectionsSchema = z.object({
  home: z.object({
    heroSlides: z
      .array(slide)
      .min(1)
      .max(8)
      .refine((s) => s.some((x) => x.enabled), 'At least one hero slide must be enabled.'),
    /** Which catalogue products lead the Range section, in order. */
    showcase: z.object({ productSlugs: z.array(slug).max(6).default([]) }),
    /** Pinned articles for the Knowledge Hub teaser. Empty = newest three. */
    knowledgeHub: z.object({ articleSlugs: z.array(slug).max(3).default([]) }),
    statement: statementSchema,
    proof: proofSchema,
  }),
  products: z.object({
    heroBanner: z.object({ enabled: z.boolean(), image: assetRef.nullable(), alt: text(200) }),
  }),
  blog: z.object({
    /** Null = newest article. */
    featuredSlug: slug.nullable().default(null),
    topics: z.array(requiredText(40)).min(1).max(12),
  }),
  about: z.object({
    storyVideo: z.object({
      youtubeId: z.string().regex(/^[A-Za-z0-9_-]{11}$/, 'A YouTube video id is 11 characters, e.g. gcnpEOW09k0.'),
      title: requiredText(200),
    }),
    founder: z.object({ enabled: z.boolean(), portrait: assetRef.nullable(), alt: text(200) }),
    milestones: z.array(milestone).max(24),
    logos: z.array(logo).max(40),
    copy: aboutCopySchema,
  }),
  letters: z
    .array(letterSchema)
    .max(100)
    .refine((ls) => new Set(ls.map((l) => l.slug)).size === ls.length, 'Two letters share a slug.'),
});

export type SiteSections = z.infer<typeof siteSectionsSchema>;

export const saveDraftSchema = z.object({
  /** The revision the editor loaded. A stale one is refused, not merged. */
  baseRevision: z.number().int().min(1),
  sections: siteSectionsSchema,
});

export const publishSchema = z.object({
  note: text(300).optional(),
  /** Accept placement warnings. Errors are never overridable. */
  acknowledgeWarnings: z.boolean().default(false),
});

// ============================================================================
// MEDIA LIBRARY
// ============================================================================

const MEDIA_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'svg', 'mp4', 'webm', 'mov'] as const;

/** Registering an upload the browser just completed against a signed ticket. */
export const registerMediaSchema = z.object({
  publicId: z.string().trim().min(1).max(300),
  title: text(200).optional(),
  altText: text(300).optional(),
  tags: z.array(text(40)).max(20).optional(),
});

export const updateMediaSchema = z.object({
  title: requiredText(200).optional(),
  altText: text(300).optional(),
  tags: z.array(requiredText(40)).max(20).optional(),
});

export const replaceMediaSchema = z.object({ publicId: z.string().trim().min(1).max(300) });

export const mediaListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  type: z.enum(['IMAGE', 'VIDEO']).optional(),
  archived: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(48),
});

export const MEDIA_FORMAT_LIST = MEDIA_FORMATS;

// ============================================================================
// ARTICLE BODY (CMS → API). Extends the original schema's fields.
// ============================================================================

export const articleExtrasSchema = z.object({
  shortTitle: text(90).optional().nullable(),
  tagColor: hex.optional().nullable(),
  tags: z.array(requiredText(40)).max(12).optional(),
  stat: text(20).optional().nullable(),
  statLabel: text(120).optional().nullable(),
  coverAssetId: z.string().uuid().optional().nullable(),
  coverMobileAssetId: z.string().uuid().optional().nullable(),
  coverAlt: text(300).optional().nullable(),
  focusKeyword: text(80).optional().nullable(),
  seoKeywords: z.array(requiredText(80)).max(30).optional(),
  ogTitle: text(90).optional().nullable(),
  ogDescription: text(200).optional().nullable(),
  relatedSlugs: z.array(slug).max(6).optional(),
  blocks: blocksSchema.optional(),
});
