/**
 * Article category colour — chosen by the category, never per article.
 *
 * Editors used to pick a colour for every article, so one category ended up in
 * several shades (NUTRITION was both #fb923c and #ff9300 on the live site).
 * Now the colour follows the category name: the blog's own topics have fixed
 * colours, and any other category gets one from the palette by a stable hash of
 * its name — the same name always lands on the same colour.
 *
 * Mirrored in CMS/lib/categoryColor.js for the editor's preview swatch. The SAME
 * fixtures are asserted in both test files, so the two cannot drift apart.
 */
export const CATEGORY_COLORS: Record<string, string> = {
  NUTRITION: '#fb923c',
  BIOLOGY: '#44e5c2',
  'FEED SCIENCE': '#60a5fa',
  SCIENCE: '#38bdf8',
  SUSTAINABILITY: '#4ade80',
  HATCHERY: '#f472b6',
  'SPECIES GUIDE': '#a78bfa',
  GUPPY: '#facc15',
};

/** For categories without a fixed colour. All readable on the site's near-black. */
export const FALLBACK_PALETTE = ['#f87171', '#34d399', '#c084fc', '#fbbf24', '#22d3ee', '#e879f9', '#a3e635', '#fda4af'];

export function categoryColor(category: string | null | undefined): string {
  const key = (category ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
  if (!key) return '#44e5c2';
  const fixed = CATEGORY_COLORS[key];
  if (fixed) return fixed;
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK_PALETTE[h % FALLBACK_PALETTE.length]!;
}
