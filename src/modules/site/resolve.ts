/**
 * Draft → snapshot.
 *
 * Content stores `{ assetId }`. A publication must not: it is read by the
 * storefront build, which must be able to render from that one document alone
 * — no second lookup, and no dependency on the library still holding the same
 * file later (rollback republishes an old snapshot verbatim).
 *
 * So publishing RESOLVES every reference into a frozen description of the file,
 * and VALIDATES each one against the placement it sits in.
 */
import { categoryColor } from './categoryColor';
import { MediaType, type Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { type Issue, validateAsset } from './placements';
import type { Block, SiteSections } from './site.schemas';

export interface ResolvedAsset {
  assetId: string;
  url: string;
  type: 'IMAGE' | 'VIDEO';
  format: string | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  alt: string;
  posterUrl: string | null;
}

type AssetRow = Prisma.MediaAssetGetPayload<{
  select: {
    id: true; url: true; type: true; format: true; mimeType: true; width: true; height: true;
    altText: true; posterUrl: true; archivedAt: true; title: true;
  };
}>;

export type AssetMap = Map<string, AssetRow>;

// ============================================================================
// WALKING
// ============================================================================

const LABELS: Record<string, string> = {
  home: 'Homepage',
  heroSlides: 'hero slide',
  products: 'Products page',
  heroBanner: 'hero banner',
  about: 'About page',
  milestones: 'milestone',
  logos: 'logo',
  founder: 'founder portrait',
  blocks: 'block',
  contentBlocks: 'block',
  images: 'photo',
  letters: 'letter',
  mobileMp4: 'mobile video',
  mp4: 'video',
  webm: 'WebM video',
};

function describe(path: (string | number)[]): string {
  const words: string[] = [];
  for (let i = 0; i < path.length; i++) {
    const part = path[i];
    if (part === undefined) continue;
    if (typeof part === 'number') {
      if (words.length) words[words.length - 1] += ` ${part + 1}`;
      continue;
    }
    if (part === 'asset' || part === 'image' || part === 'portrait') continue;
    words.push(LABELS[part] ?? part);
  }
  return words.join(' › ');
}

/**
 * Every `{ assetId }` inside a JSON value, with a human description of where.
 * Works on drafts and on resolved snapshots alike (resolved assets keep their
 * `assetId`), which is what lets usage lookups see the live site too.
 */
export function collectAssetIds(value: unknown, base: (string | number)[] = []): [string, string][] {
  const out: [string, string][] = [];
  const walk = (v: unknown, path: (string | number)[]) => {
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, [...path, i]));
      return;
    }
    if (!v || typeof v !== 'object') return;
    const obj = v as Record<string, unknown>;
    if (typeof obj.assetId === 'string') out.push([obj.assetId, describe(path)]);
    // An article or letter in a snapshot: name it by its title.
    const next =
      typeof obj.slug === 'string' && typeof obj.title === 'string'
        ? [`${path.includes('letters') ? 'letter' : 'article'} “${obj.title}”`]
        : path;
    for (const [k, child] of Object.entries(obj)) {
      if (k === 'assetId') continue;
      walk(child, [...next, k]);
    }
  };
  walk(value, base);
  return out;
}

export async function loadAssets(ids: Iterable<string>): Promise<AssetMap> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await prisma.mediaAsset.findMany({
    where: { id: { in: unique } },
    select: {
      id: true, url: true, type: true, format: true, mimeType: true, width: true, height: true,
      altText: true, posterUrl: true, archivedAt: true, title: true,
    },
  });
  return new Map(rows.map((r) => [r.id, r]));
}

export function resolveAsset(ref: { assetId: string } | null | undefined, assets: AssetMap): ResolvedAsset | null {
  if (!ref?.assetId) return null;
  const a = assets.get(ref.assetId);
  if (!a) return null;
  return {
    assetId: a.id,
    url: a.url,
    type: a.type === MediaType.VIDEO ? 'VIDEO' : 'IMAGE',
    format: a.format,
    mimeType: a.mimeType,
    width: a.width,
    height: a.height,
    alt: a.altText,
    posterUrl: a.posterUrl,
  };
}

// ============================================================================
// VALIDATION
// ============================================================================

/** Check one slot: present (if required), not archived, fits its placement. */
function slot(
  issues: Issue[],
  assets: AssetMap,
  ref: { assetId: string } | null | undefined,
  placementKey: string,
  path: string,
  required: boolean,
  label: string,
) {
  if (!ref?.assetId) {
    if (required) issues.push({ level: 'error', path, message: `${label} is required.` });
    return;
  }
  const a = assets.get(ref.assetId);
  if (!a) {
    issues.push({ level: 'error', path, message: `${label} points at a file that no longer exists in the library.` });
    return;
  }
  if (a.archivedAt) {
    issues.push({ level: 'error', path, message: `${label} uses “${a.title}”, which is archived. Restore it or pick another file.` });
  }
  issues.push(
    ...validateAsset(
      placementKey,
      { type: a.type === MediaType.VIDEO ? 'VIDEO' : 'IMAGE', format: a.format, width: a.width, height: a.height },
      path,
    ),
  );
}

export interface ReferenceFacts {
  /** Slugs of products the public catalogue currently serves. */
  activeProductSlugs: Set<string>;
  /** Slugs of articles that will be published in the snapshot. */
  publishedArticleSlugs: Set<string>;
}

export function validateSections(sections: SiteSections, assets: AssetMap, refs: ReferenceFacts): Issue[] {
  const issues: Issue[] = [];

  sections.home.heroSlides.forEach((s, i) => {
    const at = `home.heroSlides.${i}`;
    if (s.type === 'banner') {
      const req = s.enabled;
      slot(issues, assets, s.desktop, 'home.hero.banner.desktop', `${at}.desktop`, req, `Hero slide ${i + 1} desktop image`);
      slot(issues, assets, s.mobile, 'home.hero.banner.mobile', `${at}.mobile`, req, `Hero slide ${i + 1} mobile image`);
    } else if (s.type === 'video') {
      const req = s.enabled;
      slot(issues, assets, s.mp4, 'home.hero.video.mp4', `${at}.mp4`, req, `Hero slide ${i + 1} MP4`);
      slot(issues, assets, s.webm, 'home.hero.video.webm', `${at}.webm`, false, `Hero slide ${i + 1} WebM`);
      slot(issues, assets, s.mobileMp4, 'home.hero.video.mobile', `${at}.mobileMp4`, false, `Hero slide ${i + 1} mobile MP4`);
      slot(issues, assets, s.poster, 'home.hero.video.poster', `${at}.poster`, req, `Hero slide ${i + 1} poster`);
      if (req && !s.mobileMp4) {
        issues.push({
          level: 'warning',
          path: `${at}.mobileMp4`,
          message: 'No mobile encode — phones will download the full desktop video.',
        });
      }
    }
  });

  const ids = sections.home.heroSlides.map((s) => s.id);
  if (new Set(ids).size !== ids.length) {
    issues.push({ level: 'error', path: 'home.heroSlides', message: 'Two hero slides share an id.' });
  }

  sections.home.showcase.productSlugs.forEach((slug, i) => {
    if (!refs.activeProductSlugs.has(slug)) {
      issues.push({
        level: 'warning',
        path: `home.showcase.productSlugs.${i}`,
        message: `“${slug}” is not a published product — the Range section will skip it and fill from the catalogue.`,
      });
    }
  });
  sections.home.knowledgeHub.articleSlugs.forEach((slug, i) => {
    if (!refs.publishedArticleSlugs.has(slug)) {
      issues.push({ level: 'error', path: `home.knowledgeHub.articleSlugs.${i}`, message: `“${slug}” is not a published article.` });
    }
  });
  if (sections.blog.featuredSlug && !refs.publishedArticleSlugs.has(sections.blog.featuredSlug)) {
    issues.push({ level: 'error', path: 'blog.featuredSlug', message: `The featured article “${sections.blog.featuredSlug}” is not published.` });
  }

  const banner = sections.products.heroBanner;
  slot(issues, assets, banner.image, 'products.hero', 'products.heroBanner.image', banner.enabled, 'Products hero banner');
  if (banner.enabled && !banner.alt) {
    issues.push({ level: 'error', path: 'products.heroBanner.alt', message: 'Describe the products banner for screen readers.' });
  }

  const founder = sections.about.founder;
  slot(issues, assets, founder.portrait, 'about.founder', 'about.founder.portrait', founder.enabled, 'Founder portrait');
  if (founder.enabled && !founder.alt) {
    issues.push({ level: 'error', path: 'about.founder.alt', message: 'Describe the founder portrait for screen readers.' });
  }

  sections.about.milestones.forEach((m, i) => {
    slot(issues, assets, m.image, 'about.milestone', `about.milestones.${i}.image`, false, `Milestone ${i + 1} photo`);
    if (m.image && !m.imageAlt) {
      issues.push({ level: 'warning', path: `about.milestones.${i}.imageAlt`, message: `Milestone ${i + 1} photo has no alt text; the bullet points will be read instead.` });
    }
  });
  sections.about.logos.forEach((l, i) => {
    slot(issues, assets, l.image, 'about.logo', `about.logos.${i}.image`, true, `Logo ${i + 1}`);
  });

  (sections.letters ?? []).forEach((letter, i) => {
    if (!letter.published) return;
    slot(issues, assets, letter.cover?.asset, 'letter.cover', `letters.${i}.cover`, false, `Letter “${letter.title}” cover`);
    letter.blocks.forEach((b, j) => {
      if (b.type !== 'gallery') return;
      b.images.forEach((img, k) =>
        slot(issues, assets, img.asset, 'letter.image', `letters.${i}.blocks.${j}.images.${k}`, true, `Letter “${letter.title}” photo ${k + 1}`),
      );
    });
  });
  if (sections.letters && !sections.letters.some((l) => l.published)) {
    issues.push({ level: 'warning', path: 'letters', message: 'No published letter — the About page’s letter section and /letters will be empty.' });
  }

  return issues;
}

/** The asset references inside a section document — what to load before validating. */
export const sectionAssetIds = (sections: unknown) => collectAssetIds(sections).map(([id]) => id);

// ============================================================================
// RESOLUTION
// ============================================================================

export function resolveSections(sections: SiteSections, assets: AssetMap) {
  const r = (ref: { assetId: string } | null | undefined) => resolveAsset(ref, assets);

  return {
    home: {
      heroSlides: sections.home.heroSlides
        .filter((s) => s.enabled)
        .map((s) => {
          if (s.type === 'banner') {
            return { id: s.id, type: s.type, desktop: r(s.desktop), mobile: r(s.mobile), alt: s.alt, href: s.href ?? null };
          }
          if (s.type === 'video') {
            return {
              id: s.id,
              type: s.type,
              mp4: r(s.mp4),
              webm: r(s.webm),
              mobileMp4: r(s.mobileMp4),
              poster: r(s.poster),
              label: s.label ?? null,
            };
          }
          return { id: s.id, type: s.type };
        }),
      showcase: sections.home.showcase,
      knowledgeHub: sections.home.knowledgeHub,
      statement: sections.home.statement,
      proof: sections.home.proof,
    },
    products: {
      heroBanner: sections.products.heroBanner.enabled
        ? { image: r(sections.products.heroBanner.image), alt: sections.products.heroBanner.alt }
        : null,
    },
    blog: sections.blog,
    about: {
      storyVideo: sections.about.storyVideo,
      founder: sections.about.founder.enabled
        ? { portrait: r(sections.about.founder.portrait), alt: sections.about.founder.alt }
        : null,
      milestones: sections.about.milestones.map((m, i) => ({
        id: m.id,
        year: m.year,
        index: String(i + 1).padStart(2, '0'),
        points: m.points,
        image: r(m.image),
        imageAlt: m.imageAlt || null,
      })),
      logos: sections.about.logos.map((l) => ({ id: l.id, image: r(l.image), alt: l.alt })),
      copy: sections.about.copy,
    },
    /** Published letters, newest first, in the shape components/letters renders. */
    letters: (sections.letters ?? [])
      .filter((l) => l.published)
      .sort((a, b) => b.date.localeCompare(a.date))
      .map(({ published: _p, cover, blocks, ...letter }) => {
        const c = r(cover?.asset);
        return {
          ...letter,
          cover: c ? { src: c.url, alt: cover!.alt, width: c.width, height: c.height } : null,
          blocks: blocks.map((b) =>
            b.type === 'gallery'
              ? {
                  type: 'gallery' as const,
                  images: b.images.map((img) => {
                    const a = r(img.asset);
                    return { src: a?.url ?? null, alt: img.alt, width: a?.width ?? null, height: a?.height ?? null, assetId: img.asset.assetId };
                  }),
                }
              : b,
          ),
          coverAssetId: cover?.asset.assetId ?? null,
        };
      }),
  };
}

// ============================================================================
// ARTICLES
// ============================================================================

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

/**
 * Excerpts were authored as compact rich text, but every surface that shows one
 * (cards, meta description, the Knowledge Hub row) renders plain text. Turn the
 * stored HTML into the text it represents.
 */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<\/(p|li)>\s*/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#39|amp|lt|gt|quot|apos|nbsp);/g, (_, e: string) => ENTITIES[e] ?? _)
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ArticleSource {
  slug: string;
  title: string;
  shortTitle: string | null;
  tag: string;
  tagColor: string | null;
  tags: string[];
  readMinutes: number;
  excerpt: string;
  bodyHtml: string;
  contentBlocks: unknown;
  coverAssetId: string | null;
  coverMobileAssetId: string | null;
  coverImageUrl: string | null;
  coverAlt: string | null;
  stat: string | null;
  statLabel: string | null;
  seoTitle: string | null;
  seoDesc: string | null;
  focusKeyword: string | null;
  seoKeywords: string[];
  ogTitle: string | null;
  ogDescription: string | null;
  relatedSlugs: string[];
  authorName: string;
  publishedAt: Date | null;
  revisedAt: Date | null;
}

export function articleAssetIds(a: Pick<ArticleSource, 'coverAssetId' | 'coverMobileAssetId' | 'contentBlocks'>): string[] {
  return [a.coverAssetId, a.coverMobileAssetId, ...collectAssetIds(a.contentBlocks).map(([id]) => id)].filter(
    (x): x is string => Boolean(x),
  );
}

export function validateArticle(a: ArticleSource, assets: AssetMap, path = 'article'): Issue[] {
  const issues: Issue[] = [];
  if (!a.coverAssetId && !a.coverImageUrl) {
    issues.push({ level: 'error', path: `${path}.coverAssetId`, message: 'A cover image is required — it feeds the blog cards, the article hero and the Knowledge Hub.' });
  }
  slot(issues, assets, a.coverAssetId ? { assetId: a.coverAssetId } : null, 'article.cover', `${path}.coverAssetId`, false, 'Cover image');
  slot(issues, assets, a.coverMobileAssetId ? { assetId: a.coverMobileAssetId } : null, 'article.cover.mobile', `${path}.coverMobileAssetId`, false, 'Mobile cover');
  const blocks = Array.isArray(a.contentBlocks) ? (a.contentBlocks as Block[]) : [];
  blocks.forEach((b, i) => {
    if (b.type === 'figure') slot(issues, assets, b.asset, 'article.figure', `${path}.blocks.${i}.asset`, true, `Figure in block ${i + 1}`);
  });
  if (blocks.length === 0 && !a.bodyHtml) {
    issues.push({ level: 'error', path: `${path}.blocks`, message: 'The article has no body.' });
  }
  if (!a.seoDesc) {
    issues.push({ level: 'warning', path: `${path}.seoDesc`, message: 'No SEO description — the excerpt will be used.' });
  }
  return issues;
}

/** Hex accent → the 10% tint the badges use, matching the original data exactly. */
export function tintOf(hex: string | null): string | null {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.10)`;
}

export function resolveArticle(a: ArticleSource, assets: AssetMap) {
  const blocks = (Array.isArray(a.contentBlocks) ? (a.contentBlocks as Block[]) : []).map((b) => {
    if (b.type !== 'figure') return b;
    const asset = resolveAsset(b.asset, assets);
    return { ...b, asset, src: asset?.url ?? null, width: asset?.width ?? null, height: asset?.height ?? null };
  });

  const cover = resolveAsset(a.coverAssetId ? { assetId: a.coverAssetId } : null, assets);
  const coverMobile = resolveAsset(a.coverMobileAssetId ? { assetId: a.coverMobileAssetId } : null, assets);
  const excerpt = htmlToText(a.excerpt);
  const published = (a.publishedAt ?? new Date()).toISOString();

  return {
    slug: a.slug,
    title: a.title,
    shortTitle: a.shortTitle || a.title,
    tag: a.tag,
    // From the category, not the article: one category, one colour. The stored
    // per-article colour is ignored — see categoryColor.ts.
    tagColor: categoryColor(a.tag),
    tagBg: tintOf(categoryColor(a.tag)),
    tags: a.tags,
    readMinutes: a.readMinutes,
    excerpt,
    cover: cover ?? (a.coverImageUrl ? { assetId: null, url: a.coverImageUrl, type: 'IMAGE', format: null, mimeType: null, width: null, height: null, alt: '', posterUrl: null } : null),
    coverMobile,
    coverAlt: a.coverAlt || cover?.alt || a.title,
    stat: a.stat,
    statLabel: a.statLabel,
    seo: {
      title: a.seoTitle || null,
      description: a.seoDesc || excerpt,
      focusKeyword: a.focusKeyword || null,
      keywords: a.seoKeywords,
      ogTitle: a.ogTitle || null,
      ogDescription: a.ogDescription || null,
    },
    author: a.authorName,
    publishedAt: published,
    modifiedAt: (a.revisedAt ?? a.publishedAt ?? new Date()).toISOString(),
    toc: blocks
      .filter((b): b is Extract<Block, { type: 'h2' }> => b.type === 'h2' && Boolean(b.toc))
      .map((b) => ({ id: b.id, label: b.toc as string })),
    blocks,
    // Articles written in the old rich-text editor have no blocks. Their HTML
    // was sanitised on save against the same allowlist .prose-zewa styles.
    bodyHtml: blocks.length === 0 ? a.bodyHtml : null,
    relatedSlugs: a.relatedSlugs,
  };
}

export type ResolvedArticle = ReturnType<typeof resolveArticle>;
