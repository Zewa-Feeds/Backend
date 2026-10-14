/**
 * Asset placements — ZewaFeeds-Asset-Specification.pdf (2026-09-12), as data.
 *
 * The specification is the source of truth for what each slot on the site
 * accepts. Encoding it here means the CMS can show an editor the requirement
 * BEFORE they pick a file, and the publish step can refuse a version that would
 * break a placement — rather than both living in a PDF nobody opens.
 *
 * `spec` is the row number in the PDF's master reference table (§08), so a
 * warning in the CMS can be traced back to the document.
 *
 * TWO SEVERITIES, deliberately:
 *   error    the placement cannot render correctly — a missing required file, a
 *            video where an image belongs, a codec the <source> tag does not
 *            declare. Publishing is refused.
 *   warning  it renders, but not as designed — undersized, off-ratio (so it
 *            will be cropped), an opaque JPG where a transparent PNG is asked
 *            for. Shown prominently; publishing is allowed. Two of the seven
 *            live milestone photos are off-ratio today (spec §10, issue 1), so
 *            making ratio an error would refuse to republish the current site.
 */

export type AssetKind = 'IMAGE' | 'VIDEO';

export interface Placement {
  key: string;
  /** Row in the spec's master reference table. Null for slots the spec predates. */
  spec: number | null;
  page: 'Landing' | 'Products' | 'Blog' | 'About';
  label: string;
  kind: AssetKind;
  /** Lower-case extensions accepted at all. Anything else is an error. */
  formats: string[];
  /** Extensions the spec recommends. Anything else accepted is a warning. */
  recommendedFormats: string[];
  /** Target export size from the spec. */
  width: number | null;
  height: number | null;
  /** Below this the placement is visibly soft on retina. */
  minWidth: number | null;
  minHeight: number | null;
  /** Container ratio, [w, h]. Null where the slot preserves any ratio (contain). */
  ratio: [number, number] | null;
  fit: 'cover' | 'contain';
  /** CSS object-position the storefront uses — drives the CMS crop preview. */
  position?: string;
  /** Rendered box at each breakpoint, for the CMS desktop/mobile preview. */
  preview: { desktop: PreviewBox; mobile: PreviewBox };
  transparentPreferred?: boolean;
  guidance: string;
}

interface PreviewBox {
  /** Aspect ratio of the rendered box, or a fixed px height at a given width. */
  ratio?: [number, number];
  width?: number;
  height?: number;
}

const PHOTO = ['jpg', 'jpeg', 'png', 'webp', 'avif'];
const CUTOUT = ['png', 'webp', 'avif'];

export const PLACEMENTS: Record<string, Placement> = {
  'home.hero.banner.desktop': {
    key: 'home.hero.banner.desktop',
    spec: 1,
    page: 'Landing',
    label: 'Hero banner — desktop',
    kind: 'IMAGE',
    formats: PHOTO,
    recommendedFormats: ['jpg', 'jpeg', 'webp'],
    width: 1920,
    height: 814,
    minWidth: 1600,
    minHeight: 678,
    ratio: [1920, 814],
    fit: 'contain',
    position: 'center',
    preview: { desktop: { ratio: [1920, 814] }, mobile: { ratio: [1920, 814] } },
    guidance: 'Shown at ≥768px. A separate mobile file is required — do not rely on cropping this one.',
  },
  'home.hero.banner.mobile': {
    key: 'home.hero.banner.mobile',
    spec: 1,
    page: 'Landing',
    label: 'Hero banner — mobile',
    kind: 'IMAGE',
    formats: PHOTO,
    recommendedFormats: ['jpg', 'jpeg', 'webp'],
    width: 1080,
    height: 1080,
    minWidth: 800,
    minHeight: 800,
    ratio: [1, 1],
    fit: 'cover',
    position: 'center',
    preview: { desktop: { ratio: [1, 1] }, mobile: { ratio: [1, 1] } },
    guidance: 'Shown below 768px. Square; keep text inside the centre safe area.',
  },
  'home.hero.video.mp4': {
    key: 'home.hero.video.mp4',
    spec: 2,
    page: 'Landing',
    label: 'Brand video — desktop MP4',
    kind: 'VIDEO',
    formats: ['mp4'],
    recommendedFormats: ['mp4'],
    width: 2880,
    height: 1440,
    minWidth: 1920,
    minHeight: 960,
    ratio: [2, 1],
    fit: 'cover',
    position: 'center',
    preview: { desktop: { ratio: [2, 1] }, mobile: { ratio: [16, 9] } },
    guidance: 'Master at 2:1. The desktop canvas crops edges (object-cover).',
  },
  'home.hero.video.webm': {
    key: 'home.hero.video.webm',
    spec: 2,
    page: 'Landing',
    label: 'Brand video — desktop WebM',
    kind: 'VIDEO',
    formats: ['webm'],
    recommendedFormats: ['webm'],
    width: 2880,
    height: 1440,
    minWidth: 1920,
    minHeight: 960,
    ratio: [2, 1],
    fit: 'cover',
    position: 'center',
    preview: { desktop: { ratio: [2, 1] }, mobile: { ratio: [16, 9] } },
    guidance: 'Optional smaller encode of the same cut, preferred by browsers that support it.',
  },
  'home.hero.video.mobile': {
    key: 'home.hero.video.mobile',
    spec: 2,
    page: 'Landing',
    label: 'Brand video — mobile MP4',
    kind: 'VIDEO',
    formats: ['mp4'],
    recommendedFormats: ['mp4'],
    width: 1280,
    height: 640,
    minWidth: 960,
    minHeight: 480,
    ratio: [2, 1],
    fit: 'cover',
    position: 'center',
    preview: { desktop: { ratio: [16, 9] }, mobile: { ratio: [16, 9] } },
    guidance: 'Dedicated low-bitrate encode for phones. Plays inside a 16:9 well, so edges crop.',
  },
  'home.hero.video.poster': {
    key: 'home.hero.video.poster',
    spec: 2,
    page: 'Landing',
    label: 'Brand video — poster frame',
    kind: 'IMAGE',
    formats: PHOTO,
    recommendedFormats: ['jpg', 'jpeg', 'webp'],
    width: 1600,
    height: 800,
    minWidth: 1280,
    minHeight: 640,
    ratio: [2, 1],
    fit: 'cover',
    position: 'center',
    preview: { desktop: { ratio: [2, 1] }, mobile: { ratio: [16, 9] } },
    guidance: 'Required. The first thing visitors see — preload is "metadata".',
  },
  'products.hero': {
    key: 'products.hero',
    spec: 5,
    page: 'Products',
    label: 'Products page hero banner',
    kind: 'IMAGE',
    formats: PHOTO,
    recommendedFormats: ['jpg', 'jpeg', 'png', 'webp'],
    width: 1920,
    height: 810,
    minWidth: 1584,
    minHeight: 668,
    ratio: [1920, 810],
    fit: 'cover',
    position: 'center',
    preview: { desktop: { width: 1440, height: 500 }, mobile: { width: 390, height: 200 } },
    guidance:
      'One file, cropped to a 200px band on phones and 500px on desktop. Keep the subject and any text in the centre band.',
  },
  'spotlight.image': {
    key: 'spotlight.image',
    spec: 7,
    page: 'Products',
    label: 'Spotlight cutout',
    kind: 'IMAGE',
    formats: PHOTO,
    recommendedFormats: CUTOUT,
    width: 640,
    height: 640,
    minWidth: 400,
    minHeight: 400,
    ratio: null,
    fit: 'contain',
    preview: { desktop: { height: 280 }, mobile: { height: 180 } },
    transparentPreferred: true,
    guidance: 'Never cropped, only height-capped. Clean-edged cutout on a transparent canvas; avoid ultra-wide.',
  },
  'article.cover': {
    key: 'article.cover',
    spec: 10,
    page: 'Blog',
    label: 'Article cover',
    kind: 'IMAGE',
    formats: PHOTO,
    recommendedFormats: ['jpg', 'jpeg', 'webp'],
    width: 2000,
    height: 1125,
    minWidth: 1600,
    minHeight: 900,
    ratio: [16, 9],
    fit: 'cover',
    position: 'center',
    preview: { desktop: { width: 1280, height: 560 }, mobile: { width: 390, height: 580 } },
    guidance:
      'One image serves four crops: Knowledge Hub background (anchored 75% right), featured card (560px tall), grid card (16:9) and article hero (580px, lower third dimmed). Keep the subject in the upper two-thirds, right of centre.',
  },
  'article.cover.mobile': {
    key: 'article.cover.mobile',
    spec: 12,
    page: 'Blog',
    label: 'Article hero — mobile crop',
    kind: 'IMAGE',
    formats: PHOTO,
    recommendedFormats: ['jpg', 'jpeg', 'webp'],
    width: 1080,
    height: 1600,
    minWidth: 720,
    minHeight: 1000,
    ratio: null,
    fit: 'cover',
    position: 'top',
    preview: { desktop: { width: 390, height: 580 }, mobile: { width: 390, height: 580 } },
    guidance: 'Optional. Composed for the tall 580px mobile hero, anchored to the top.',
  },
  'article.figure': {
    key: 'article.figure',
    spec: null,
    page: 'Blog',
    label: 'In-article figure',
    kind: 'IMAGE',
    formats: PHOTO,
    recommendedFormats: ['jpg', 'jpeg', 'png', 'webp'],
    width: 1720,
    height: 968,
    minWidth: 860,
    minHeight: null,
    ratio: null,
    fit: 'cover',
    preview: { desktop: { ratio: [16, 9] }, mobile: { ratio: [16, 9] } },
    guidance: 'Rendered at the prose column width (860px); 2× that for retina.',
  },
  'about.founder': {
    key: 'about.founder',
    spec: 14,
    page: 'About',
    label: 'Founder portrait',
    kind: 'IMAGE',
    formats: PHOTO,
    recommendedFormats: ['jpg', 'jpeg', 'webp'],
    width: 1280,
    height: 1600,
    minWidth: 640,
    minHeight: 800,
    ratio: [4, 5],
    fit: 'cover',
    position: 'center',
    preview: { desktop: { ratio: [4, 5] }, mobile: { ratio: [4, 5] } },
    guidance: 'Portrait 4:5. A square file is cropped top and bottom.',
  },
  'about.milestone': {
    key: 'about.milestone',
    spec: 15,
    page: 'About',
    label: 'Milestone photo',
    kind: 'IMAGE',
    formats: PHOTO,
    recommendedFormats: ['jpg', 'jpeg', 'webp'],
    width: 1360,
    height: 850,
    minWidth: 680,
    minHeight: 425,
    ratio: [16, 10],
    fit: 'cover',
    position: 'center',
    preview: { desktop: { ratio: [16, 10] }, mobile: { ratio: [16, 10] } },
    guidance: '16:10 landscape, subject centred. Portrait or panorama sources are cropped hard.',
  },
  'about.logo': {
    key: 'about.logo',
    spec: 16,
    page: 'About',
    label: 'Institution logo',
    kind: 'IMAGE',
    formats: PHOTO,
    recommendedFormats: CUTOUT,
    width: 470,
    height: 290,
    minWidth: 156,
    minHeight: 96,
    ratio: null,
    fit: 'contain',
    preview: { desktop: { width: 156, height: 96 }, mobile: { width: 132, height: 80 } },
    transparentPreferred: true,
    guidance: 'Never cropped. Trimmed to the mark on a transparent background, ~470×290.',
  },
  // Founder's letters postdate the spec (2026-09-12); the rules below follow
  // how components/letters renders them, not a spec row.
  'letter.cover': {
    key: 'letter.cover',
    spec: null,
    page: 'About',
    label: 'Letter cover',
    kind: 'IMAGE',
    formats: PHOTO,
    recommendedFormats: ['jpg', 'jpeg', 'webp'],
    width: 1200,
    height: null,
    minWidth: 600,
    minHeight: null,
    ratio: null,
    fit: 'cover',
    position: 'center',
    preview: { desktop: { ratio: [3, 4] }, mobile: { ratio: [3, 4] } },
    guidance: 'Shown as the letter card image on the About page and /letters. Any ratio; keep the subject centred.',
  },
  'letter.image': {
    key: 'letter.image',
    spec: null,
    page: 'About',
    label: 'Letter gallery photo',
    kind: 'IMAGE',
    formats: PHOTO,
    recommendedFormats: ['jpg', 'jpeg', 'webp'],
    width: 1200,
    height: null,
    minWidth: 400,
    minHeight: null,
    ratio: null,
    fit: 'contain',
    preview: { desktop: { height: 180 }, mobile: { height: 140 } },
    guidance: 'Galleries keep each photo’s own ratio; nothing is cropped.',
  },
};

/** Placements the spec lists that are managed elsewhere (product media) or are not files. */
export const EXTERNAL_PLACEMENTS = [
  { spec: 3, label: 'Landing — Product Showcase grid', managedIn: 'Products → media (pick which products in Website → Homepage)' },
  { spec: 4, label: 'Landing — Knowledge Hub background', managedIn: 'Each article’s cover image' },
  { spec: 6, label: 'Products — card gallery + hover video', managedIn: 'Products → media' },
  { spec: 8, label: 'Product detail — gallery', managedIn: 'Products → media' },
  { spec: 9, label: 'Cart / checkout thumbnails', managedIn: 'Products → media' },
  { spec: 11, label: 'Blog — grid / related card', managedIn: 'Each article’s cover image' },
  { spec: 13, label: 'About — Our Story video', managedIn: 'Website → About (YouTube id)' },
] as const;

export interface AssetFacts {
  type: AssetKind;
  format: string | null;
  width: number | null;
  height: number | null;
}

export interface Issue {
  level: 'error' | 'warning';
  /** Dotted path into the content, so the CMS can attach it to the right slot. */
  path: string;
  message: string;
}

/** 3% — tighter than this flags files that differ by a rounding pixel. */
const RATIO_TOLERANCE = 0.03;

const ratioLabel = ([w, h]: [number, number]) => {
  const r = w / h;
  return Number.isInteger(r) ? `${r}:1` : w > 100 ? `${(w / h).toFixed(2)}:1` : `${w}:${h}`;
};

/**
 * Check one asset against one placement. Pure, so the CMS preview and the
 * publish gate agree by construction.
 */
export function validateAsset(placementKey: string, asset: AssetFacts | null, path: string): Issue[] {
  const p = PLACEMENTS[placementKey];
  if (!p) return [{ level: 'error', path, message: `Unknown placement "${placementKey}".` }];
  if (!asset) return [];

  const issues: Issue[] = [];
  const err = (message: string) => issues.push({ level: 'error', path, message });
  const warn = (message: string) => issues.push({ level: 'warning', path, message });

  if (asset.type !== p.kind) {
    err(`${p.label} needs ${p.kind === 'VIDEO' ? 'a video' : 'an image'}.`);
    return issues;
  }

  const format = asset.format?.toLowerCase() ?? null;
  if (format && !p.formats.includes(format)) {
    err(`${p.label} must be ${p.formats.map((f) => f.toUpperCase()).join(' or ')} — this file is ${format.toUpperCase()}.`);
  } else if (format && !p.recommendedFormats.includes(format)) {
    warn(
      p.transparentPreferred
        ? `${p.label} should be a transparent ${(p.recommendedFormats[0] ?? 'png').toUpperCase()} — a ${format.toUpperCase()} will show its background.`
        : `The spec recommends ${p.recommendedFormats.map((f) => f.toUpperCase()).join('/')} here.`,
    );
  }

  if (!asset.width || !asset.height) {
    warn('Dimensions are unknown, so size and ratio could not be checked.');
    return issues;
  }

  if ((p.minWidth && asset.width < p.minWidth) || (p.minHeight && asset.height < p.minHeight)) {
    warn(
      `${asset.width}×${asset.height} is smaller than the ${p.height ? `${p.width}×${p.height}` : `${p.width}px width`} the spec asks for — it will look soft on retina screens.`,
    );
  }

  if (p.ratio) {
    const want = p.ratio[0] / p.ratio[1];
    const have = asset.width / asset.height;
    if (Math.abs(have - want) / want > RATIO_TOLERANCE) {
      warn(
        p.fit === 'cover'
          ? `Ratio is ${have.toFixed(2)}:1 but the slot is ${ratioLabel(p.ratio)} — the edges will be cropped.`
          : `Ratio is ${have.toFixed(2)}:1 but the slot is ${ratioLabel(p.ratio)} — it will be letterboxed.`,
      );
    }
  } else if (p.fit === 'contain' && asset.width / asset.height > 3) {
    warn('Very wide files render tiny in a height-capped slot.');
  }

  return issues;
}

/** Public, serialisable view for the CMS. */
export function placementCatalogue() {
  return { placements: Object.values(PLACEMENTS), managedElsewhere: EXTERNAL_PLACEMENTS };
}
