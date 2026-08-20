/**
 * The single authority on which media a pack shows.
 *
 * Every surface — storefront, SSR, CMS preview — resolves through this function,
 * so an operator arranging a gallery in the CMS sees exactly what a customer
 * will. Duplicating these rules in a React component is how they drifted apart
 * in the first place.
 *
 * WHAT THIS REPLACES
 *
 * The storefront used to decide the gallery itself, by stripping an "X2" suffix
 * off the SKU to find a multipack's base, and by falling back to the WHOLE
 * gallery whenever the selected pack had no photography of its own. Both were
 * wrong in ways nobody could see:
 *
 *   - the regex made a merchandising rule depend on a naming convention, so
 *     renaming a SKU changed which photographs a customer saw;
 *   - the fallback meant a pack with no photos showed every OTHER pack's photos.
 *     With the current catalogue that is not theoretical: three of Cichlid C4's
 *     four packs have no media, so choosing them showed the 1kg pouch.
 *
 * Showing a customer the wrong physical pack is worse than showing them a
 * generic photo of the product, so that fallback is gone. Inheritance is now
 * read from `baseVariantId`, which is data rather than a naming accident.
 */
import { MediaType } from '@prisma/client';

/** Where a resolved item came from. Drives CMS coverage reporting. */
export const MediaSource = {
  /** Assigned to the selected pack. */
  VARIANT: 'VARIANT',
  /** Assigned to the pack this one inherits from. */
  INHERITED: 'INHERITED',
  /** Not tied to any pack — fish photos, nutrition panels, the product video. */
  SHARED: 'SHARED',
} as const;
export type MediaSource = (typeof MediaSource)[keyof typeof MediaSource];

/**
 * Why this gallery looks the way it does.
 *
 * Deliberately distinct from each other: "inherited" is a decision someone made,
 * "shared only" is a gap that may be fine, and "fallback" is the system coping.
 * Collapsing them into one state is what let incomplete products look finished.
 */
export const Coverage = {
  /** The pack has its own photography. */
  EXACT: 'EXACT',
  /** No photography of its own; it intentionally borrows its base pack's. */
  INHERITED: 'INHERITED',
  /** No pack photography anywhere, but shared assets exist and are appropriate. */
  SHARED_ONLY: 'SHARED_ONLY',
  /** Nothing appropriate; showing product-level media rather than another pack's. */
  FALLBACK: 'FALLBACK',
  /** Nothing renderable at all. */
  EMPTY: 'EMPTY',
} as const;
export type Coverage = (typeof Coverage)[keyof typeof Coverage];

export interface ResolvableMedia {
  id: string;
  type: MediaType;
  url: string;
  alt: string | null;
  position: number;
  variantId: string | null;
  posterUrl?: string | null;
  width?: number | null;
  height?: number | null;
  durationSec?: number | null;
}

export interface ResolvableVariant {
  id: string;
  sku: string;
  baseVariantId?: string | null;
}

export interface ResolvedItem extends ResolvableMedia {
  source: MediaSource;
  isPrimary: boolean;
}

export interface ResolvedGallery {
  items: ResolvedItem[];
  coverage: Coverage;
  /** The variant whose photography is being shown, if any. */
  sourceVariantId: string | null;
  /** Set only when the pack borrowed another pack's photography. */
  inheritedFromVariantId: string | null;
  /** Id of the lead item, or null when the gallery is empty. */
  heroMediaId: string | null;
}

/**
 * Resolve the gallery for one pack.
 *
 * `variant` may be null, which is the "whole product" view a listing card or a
 * product page with no pack chosen yet wants: everything, in CMS order.
 */
export function resolveGallery(
  media: ResolvableMedia[],
  variant: ResolvableVariant | null,
): ResolvedGallery {
  // CMS order is authoritative everywhere below. Sorting once here means no
  // later step has to remember to preserve it.
  const ordered = [...media].sort((a, b) => a.position - b.position);
  const shared = ordered.filter((m) => !m.variantId);

  if (!variant) {
    const items = ordered.map((m) => tag(m, m.variantId ? MediaSource.VARIANT : MediaSource.SHARED));
    return finish(items, ordered.length > 0 ? Coverage.EXACT : Coverage.EMPTY, null, null);
  }

  const own = ordered.filter((m) => m.variantId === variant.id);

  // 1. The pack's own photography.
  if (own.length > 0) {
    const items = merge(
      own.map((m) => tag(m, MediaSource.VARIANT)),
      shared.map((m) => tag(m, MediaSource.SHARED)),
      ordered,
    );
    return finish(items, Coverage.EXACT, variant.id, null);
  }

  // 2. Photography it explicitly inherits.
  if (variant.baseVariantId) {
    const inherited = ordered.filter((m) => m.variantId === variant.baseVariantId);
    if (inherited.length > 0) {
      const items = merge(
        inherited.map((m) => tag(m, MediaSource.INHERITED)),
        shared.map((m) => tag(m, MediaSource.SHARED)),
        ordered,
      );
      return finish(items, Coverage.INHERITED, variant.baseVariantId, variant.baseVariantId);
    }
    // A base pack that exists but has no photography of its own falls through to
    // shared, which is still honest — it does not borrow a THIRD pack's photos.
  }

  // 3. Shared assets only.
  if (shared.length > 0) {
    const items = shared.map((m) => tag(m, MediaSource.SHARED));
    return finish(items, Coverage.SHARED_ONLY, null, null);
  }

  /*
   * 4. Nothing appropriate exists.
   *
   * This is where the old code returned every pack's photography. It does not
   * any more: a customer choosing a 45g bottle must never be shown a 1kg pouch
   * just because the 45g pack is missing photos. An empty result the CMS reports
   * as a gap is better than a confidently wrong picture.
   */
  return finish([], Coverage.EMPTY, null, null);
}

/**
 * Combine two tagged sets while keeping the operator's arrangement.
 *
 * Both sets are re-sorted by their ORIGINAL index, so "photo, video, photo" in
 * the CMS stays that way. An earlier version concatenated pack-specific before
 * shared, which silently reshuffled the gallery and made reordering in the CMS
 * appear to do nothing.
 */
function merge(a: ResolvedItem[], b: ResolvedItem[], ordered: ResolvableMedia[]): ResolvedItem[] {
  const indexOf = new Map(ordered.map((m, i) => [m.id, i]));
  // Deduplication happens in finish(), so every return path gets it — not just
  // this one. An earlier version deduped here alone, which left the shared-only
  // and whole-product paths able to emit the same asset twice.
  return [...a, ...b].sort((x, y) => (indexOf.get(x.id) ?? 0) - (indexOf.get(y.id) ?? 0));
}

function tag(m: ResolvableMedia, source: MediaSource): ResolvedItem {
  return { ...m, source, isPrimary: false };
}

/**
 * Pick the lead item and stamp it.
 *
 * Precedence, in order:
 *   1. the first IMAGE belonging to the pack (or inherited from its base)
 *   2. the first IMAGE of any kind
 *   3. nothing
 *
 * A VIDEO is never the hero, and there is no longer a "first item at all"
 * fallback that could make one. The hero is consumed as an <img> — a card
 * photograph, the opening frame of a product page, an Open Graph image — so a
 * video URL there renders as a broken thumbnail. A gallery holding only a video
 * has no hero, which the presentation layer handles by showing the poster frame
 * or a placeholder and keeping the film as secondary media.
 *
 * This is the ONLY thing about resolution the presentation work changed: which
 * assets a pack may show, their coverage and their order are all untouched.
 */
function finish(
  rawItems: ResolvedItem[],
  coverage: Coverage,
  sourceVariantId: string | null,
  inheritedFromVariantId: string | null,
): ResolvedGallery {
  /*
   * One asset can reach the gallery by more than one route — shared and
   * targeted, or targeted and inherited — and must still appear once. Keyed on
   * id rather than URL: the same file can legitimately exist under two records,
   * and two records are two gallery entries.
   *
   * Done here because every path returns through this function.
   */
  const seen = new Set<string>();
  const items = rawItems.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));

  const hero =
    items.find((m) => m.type === MediaType.IMAGE && m.source !== MediaSource.SHARED) ??
    items.find((m) => m.type === MediaType.IMAGE) ??
    null;

  return {
    items: items.map((m) => (hero && m.id === hero.id ? { ...m, isPrimary: true } : m)),
    coverage,
    sourceVariantId,
    inheritedFromVariantId,
    heroMediaId: hero?.id ?? null,
  };
}

/**
 * Coverage for every pack of a product, for the CMS.
 *
 * The point of this is that an operator can see at a glance which packs are
 * carried by shared assets or by another pack's photography — the thing the old
 * fallback actively hid.
 */
export function resolveCoverage(
  media: ResolvableMedia[],
  variants: ResolvableVariant[],
): { variantId: string; sku: string; coverage: Coverage; inheritedFromVariantId: string | null; itemCount: number }[] {
  return variants.map((v) => {
    const r = resolveGallery(media, v);
    return {
      variantId: v.id,
      sku: v.sku,
      coverage: r.coverage,
      inheritedFromVariantId: r.inheritedFromVariantId,
      itemCount: r.items.length,
    };
  });
}
