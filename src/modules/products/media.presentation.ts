/**
 * How resolved media is PRESENTED, per surface.
 *
 * `media.resolver.ts` decides WHICH assets a pack may show — ownership,
 * inheritance, targeting, coverage. It is the canonical authority and nothing
 * here second-guesses it. This module only decides the ORDER those assets are
 * shown in, and which one leads, for two different surfaces:
 *
 *   presentListing()  — the product card on the shop grid and the homepage
 *   presentDetail()   — the gallery on a product page, for the selected pack
 *
 * The two are deliberately separate. A card is one photograph plus a hover
 * film; a product page is a browsable gallery. Collapsing them into one rule is
 * what made the card show a 1kg pouch on a listing selling a 45g bottle.
 *
 * WHY A SEPARATE LAYER RATHER THAN A COLUMN
 *
 * `ProductMedia.position` is the operator's arrangement of the gallery, and it
 * must keep meaning exactly that. Presentation priority is a different question
 * asked of the same list — "what leads, what plays on hover, what follows" —
 * and it is DERIVED here rather than stored. So an operator can keep a
 * nutrition panel second in the CMS without it becoming the card's photograph,
 * and neither concept has to be encoded in the other.
 *
 * Everything in this file is pure: same gallery in, same order out. No database,
 * no clock, no environment.
 */
import { MediaType } from '@prisma/client';
import {
  Coverage,
  MediaSource,
  resolveGallery,
  type ResolvableMedia,
  type ResolvableVariant,
  type ResolvedGallery,
  type ResolvedItem,
} from '@/modules/products/media.resolver';

/** The bits of a pack this module needs beyond what the resolver takes. */
export interface PresentableVariant extends ResolvableVariant {
  /** The operator's explicit choice of lead image, from the CMS star. */
  heroMediaId?: string | null;
  pack?: string;
  isActive?: boolean;
  position?: number;
  familyId?: string;
}

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

/**
 * The lead image for a pack.
 *
 * Precedence, in order:
 *   1. the operator's explicit choice, if it is in this pack's gallery
 *   2. the resolver's own hero, if it is in this pack's gallery
 *   3. the first image the pack owns or inherits
 *   4. the first image of any kind, including shared
 *   5. nothing
 *
 * A VIDEO can never win at any step. A hero is used as an <img> — the card
 * photograph, the PDP opening frame, the Open Graph image — and a video URL in
 * an <img> renders as a broken thumbnail. A gallery holding only a video
 * therefore has NO hero, which the surfaces handle by showing a placeholder or
 * the poster frame rather than by promoting the film.
 *
 * Steps 1 and 2 are both checked against the resolved gallery on purpose: a
 * hero that has since been un-assigned, archived, or pointed at another pack
 * must fall back rather than dangle. The database can guarantee the id exists;
 * only the resolver knows whether this pack actually shows it.
 */
export function pickHero(
  gallery: ResolvedGallery,
  variant: Pick<PresentableVariant, 'heroMediaId'> | null,
): ResolvedItem | null {
  const images = gallery.items.filter((m) => m.type === MediaType.IMAGE);
  if (images.length === 0) return null;

  const chosen = variant?.heroMediaId
    ? (images.find((m) => m.id === variant.heroMediaId) ?? null)
    : null;
  if (chosen) return chosen;

  const resolverHero = gallery.heroMediaId
    ? (images.find((m) => m.id === gallery.heroMediaId) ?? null)
    : null;
  if (resolverHero) return resolverHero;

  return images.find((m) => m.source !== MediaSource.SHARED) ?? images[0] ?? null;
}

/**
 * The film for a pack, or null.
 *
 * The first VIDEO in RESOLVED gallery order — never the first video in the
 * product's raw media, which is how a pack-specific clip used to leak onto
 * every other pack. Eligibility is entirely the resolver's answer: a video
 * assigned to one pack simply is not in another pack's gallery, so no rule is
 * needed here to keep it out.
 *
 * "First in resolved order" is deliberate and sufficient. A second video is
 * vanishingly rare (the catalogue has exactly one per product, all shared), and
 * a dedicated ordering column for a case that does not exist would be a field
 * to maintain forever in exchange for nothing.
 */
export function pickVideo(gallery: ResolvedGallery): ResolvedItem | null {
  return gallery.items.find((m) => m.type === MediaType.VIDEO) ?? null;
}

// ---------------------------------------------------------------------------
// Detail — the product page gallery
// ---------------------------------------------------------------------------

export interface DetailPresentation {
  /**
   * Every gallery item, in the order the product page should show them.
   *
   * A permutation of the resolved gallery: nothing is added and nothing is
   * dropped, so the page cannot hide an asset the operator arranged. Only the
   * sequence differs.
   */
  orderedIds: string[];
  /** The opening frame. Always an IMAGE, or null when the pack has none. */
  heroId: string | null;
  videoId: string | null;
  /** Whether that film is the pack's own, inherited, or shared. */
  videoSource: MediaSource | null;
}

/**
 * Order a pack's gallery for the product page.
 *
 *   1. the hero image
 *   2. the film
 *   3. the rest of what this pack owns or inherits, in CMS order
 *   4. shared assets, in CMS order
 *
 * Pack-specific before shared because a shopper who has chosen "45g Bottle"
 * came to see that bottle; fish photography and nutrition panels are context
 * and belong after it. Within each group the operator's arrangement is kept
 * exactly, which is the whole point of not storing a second ordering.
 */
export function presentDetail(
  gallery: ResolvedGallery,
  variant: Pick<PresentableVariant, 'heroMediaId'> | null,
): DetailPresentation {
  const hero = pickHero(gallery, variant);
  const video = pickVideo(gallery);

  const lead = [hero, video].filter((m): m is ResolvedItem => m !== null);
  const leadIds = new Set(lead.map((m) => m.id));

  const rest = gallery.items.filter((m) => !leadIds.has(m.id));
  // Two stable passes rather than a comparator: `items` is already in CMS
  // order, so filtering preserves it and no sort is needed (or wanted — a
  // non-stable sort would reshuffle equal keys).
  const ownOrInherited = rest.filter((m) => m.source !== MediaSource.SHARED);
  const shared = rest.filter((m) => m.source === MediaSource.SHARED);

  return {
    orderedIds: [...lead, ...ownOrInherited, ...shared].map((m) => m.id),
    heroId: hero?.id ?? null,
    videoId: video?.id ?? null,
    videoSource: video?.source ?? null,
  };
}

// ---------------------------------------------------------------------------
// Listing — the product card
// ---------------------------------------------------------------------------

/**
 * The pack whose photography REPRESENTS a product on listing surfaces.
 *
 * Explicit choice first, then the first active pack by the operator's own
 * ordering. Both are stock-independent on purpose: the card used to lead with
 * "the first pack that is in stock", so a pack selling out silently changed
 * which photograph the whole catalogue showed for that product. Merchandising
 * imagery must not move because of a stock count.
 *
 * The explicit id is validated on write (same family, active), but it is
 * re-checked here too: a pack deactivated after the choice was made must fall
 * back rather than represent the product with a retired pack.
 *
 * NOTE: this decides IMAGERY ONLY. Price, availability and the Add-to-Cart SKU
 * continue to follow the first purchasable pack — see adaptProduct on the
 * storefront. Those are different questions and deliberately have different
 * answers.
 */
export function pickRepresentative<T extends PresentableVariant>(
  variants: T[],
  representativeVariantId: string | null | undefined,
): T | null {
  const active = variants.filter((v) => v.isActive !== false);
  if (active.length === 0) return null;

  const explicit = representativeVariantId
    ? (active.find((v) => v.id === representativeVariantId) ?? null)
    : null;
  if (explicit) return explicit;

  // `variants` reaches here in position order from the query. Sorting again
  // makes the rule hold for any caller, not just that one.
  return [...active].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0] ?? null;
}

export interface ListingPresentation {
  representativeVariantId: string | null;
  sku: string | null;
  pack: string | null;
  /** The card photograph. Null means "no suitable image" — show a placeholder. */
  heroUrl: string | null;
  heroAlt: string | null;
  width: number | null;
  height: number | null;
  /** Hover film. Already a lightweight derivative, not the master upload. */
  videoUrl: string | null;
  /** Poster frame — also the card's fallback image when there is no hero. */
  posterUrl: string | null;
  videoSource: MediaSource | null;
  coverage: Coverage;
}

/**
 * Everything a product card needs, decided on the server.
 *
 * The card used to work this out itself: filter the raw media by the first
 * in-stock pack's SKU, take the first image, and fall back to the product's
 * first image of any pack when that came up empty. That last step is why a card
 * selling Cichlid C4 45g showed a 1kg pouch.
 *
 * There is no fallback to another pack here and there must never be one. A
 * product with nothing suitable returns `heroUrl: null`, and the card shows a
 * placeholder — an honest gap rather than a confidently wrong photograph.
 *
 * `optimiseVideo` is injected rather than imported so this module stays pure
 * and testable without Cloudinary configuration.
 */
export function presentListing(
  media: ResolvableMedia[],
  variants: PresentableVariant[],
  representativeVariantId: string | null | undefined,
  optimiseVideo: (url: string) => string = (url) => url,
): ListingPresentation {
  const representative = pickRepresentative(variants, representativeVariantId);

  if (!representative) {
    return {
      representativeVariantId: null,
      sku: null,
      pack: null,
      heroUrl: null,
      heroAlt: null,
      width: null,
      height: null,
      videoUrl: null,
      posterUrl: null,
      videoSource: null,
      coverage: Coverage.EMPTY,
    };
  }

  const gallery = resolveGallery(media, representative);
  const hero = pickHero(gallery, representative);
  const video = pickVideo(gallery);

  return {
    representativeVariantId: representative.id,
    sku: representative.sku,
    pack: representative.pack ?? null,
    heroUrl: hero?.url ?? null,
    heroAlt: hero?.alt ?? null,
    width: hero?.width ?? null,
    height: hero?.height ?? null,
    videoUrl: video ? optimiseVideo(video.url) : null,
    posterUrl: video?.posterUrl ?? null,
    videoSource: video?.source ?? null,
    coverage: gallery.coverage,
  };
}
