/**
 * Presentation-layer rules.
 *
 * Pure, so these are fast and exhaustive. The invariants they pin are the ones
 * that were violated in production before this layer existed:
 *
 *   - a card never shows another pack's photograph;
 *   - a video is never used where an <img> is rendered;
 *   - the representative image does not move when stock moves;
 *   - the operator's arrangement survives re-ordering for presentation.
 */
import { describe, expect, it } from 'vitest';
import { MediaType } from '@prisma/client';
import {
  Coverage,
  MediaSource,
  resolveGallery,
  type ResolvableMedia,
} from './media.resolver';
import {
  pickConfiguredVariant,
  pickEffectiveVariant,
  pickHero,
  pickRepresentative,
  pickVideo,
  presentDetail,
  presentListing,
  type PresentableVariant,
} from './media.presentation';

// ---- Fixtures: Guppy Bites' real pack structure ----------------------------

const V45: PresentableVariant = { id: 'v45', sku: 'G2-45G', pack: '45g Bottle', position: 0, stock: 10 };
const V45X2: PresentableVariant = {
  id: 'v45x2', sku: 'G2-45GX2', pack: '45g x 2', position: 1, baseVariantId: 'v45', stock: 10,
};
const V200: PresentableVariant = { id: 'v200', sku: 'G2-200G', pack: '200g Pouch', position: 3, stock: 10 };
const V1KG: PresentableVariant = { id: 'v1kg', sku: 'G2-1KG', pack: '1kg Pouch', position: 4, stock: 10 };
const ALL = [V45, V45X2, V200, V1KG];

let seq = 0;
const img = (variantId: string | null, position: number, id?: string): ResolvableMedia => ({
  id: id ?? `img-${++seq}`,
  type: MediaType.IMAGE,
  url: `https://res.cloudinary.com/x/${id ?? seq}.jpg`,
  alt: id ? `alt ${id}` : null,
  position,
  variantId,
  width: 1000,
  height: 1000,
});
const vid = (variantId: string | null, position: number, id?: string): ResolvableMedia => ({
  ...img(variantId, position, id),
  type: MediaType.VIDEO,
  url: `https://res.cloudinary.com/x/${id ?? seq}.mp4`,
  posterUrl: `https://res.cloudinary.com/x/${id ?? seq}.jpg`,
});

// ---- Representative & Effective variant ------------------------------------

describe('configured vs effective listing variant', () => {
  describe('configured variant (operator choice)', () => {
    it('uses the operator’s explicit choice when configured', () => {
      expect(pickConfiguredVariant(ALL, 'v200')?.sku).toBe('G2-200G');
    });

    it('falls back to the first ACTIVE pack by position when unconfigured', () => {
      expect(pickConfiguredVariant(ALL, null)?.sku).toBe('G2-45G');
    });

    it('orders by position, not by array order', () => {
      const shuffled = [V1KG, V200, V45X2, V45];
      expect(pickConfiguredVariant(shuffled, null)?.sku).toBe('G2-45G');
    });

    it('never picks a pack from another product', () => {
      expect(pickConfiguredVariant(ALL, 'variant-of-another-product')?.sku).toBe('G2-45G');
    });

    it('skips a retired pack, even when it is the stored choice', () => {
      const retired = ALL.map((v) => (v.id === 'v200' ? { ...v, isActive: false } : v));
      expect(pickConfiguredVariant(retired, 'v200')?.sku).toBe('G2-45G');
    });

    it('retains the configured variant even when it is SOLD OUT', () => {
      const withSoldOut = ALL.map((v) => (v.id === 'v45' ? { ...v, stock: 0 } : v));
      expect(pickConfiguredVariant(withSoldOut, 'v45')?.sku).toBe('G2-45G');
    });
  });

  describe('effective variant (storefront availability-driven fallback)', () => {
    it('uses configured variant when in stock', () => {
      expect(pickEffectiveVariant(ALL, 'v45')?.sku).toBe('G2-45G');
    });

    it('when multiple variants are in stock, uses explicitly configured variant without guessing', () => {
      // Even if v1kg has higher position or stock, configured v45 wins
      expect(pickEffectiveVariant(ALL, 'v45')?.sku).toBe('G2-45G');
      expect(pickEffectiveVariant(ALL, 'v200')?.sku).toBe('G2-200G');
    });

    it('when configured variant is SOLD OUT, deterministically falls back to first in-stock variant', () => {
      // v45 is configured and sold out; v45x2 is next in position and in stock
      const stockState = ALL.map((v) => (v.id === 'v45' ? { ...v, stock: 0 } : v));
      expect(pickEffectiveVariant(stockState, 'v45')?.sku).toBe('G2-45GX2');
    });

    it('falls back past multiple sold out variants to find the next in-stock variant', () => {
      // v45 and v45x2 are sold out; v200 is in stock
      const stockState = ALL.map((v) =>
        v.id === 'v45' || v.id === 'v45x2' ? { ...v, stock: 0 } : v,
      );
      expect(pickEffectiveVariant(stockState, 'v45')?.sku).toBe('G2-200G');
    });

    it('when configured variant comes BACK in stock, it automatically becomes effective again', () => {
      const soldOutState = ALL.map((v) => (v.id === 'v45' ? { ...v, stock: 0 } : v));
      expect(pickEffectiveVariant(soldOutState, 'v45')?.sku).toBe('G2-45GX2');

      const restockedState = ALL.map((v) => (v.id === 'v45' ? { ...v, stock: 15 } : v));
      expect(pickEffectiveVariant(restockedState, 'v45')?.sku).toBe('G2-45G');
    });

    it('when ALL variants are sold out, returns configured variant preserving sold-out behavior', () => {
      const allSoldOut = ALL.map((v) => ({ ...v, stock: 0 }));
      expect(pickEffectiveVariant(allSoldOut, 'v200')?.sku).toBe('G2-200G');
      expect(pickEffectiveVariant(allSoldOut, null)?.sku).toBe('G2-45G');
    });

    it('automatic fallback does NOT mutate or change the configured variant id', () => {
      const soldOutState = ALL.map((v) => (v.id === 'v45' ? { ...v, stock: 0 } : v));
      const configured = pickConfiguredVariant(soldOutState, 'v45');
      const effective = pickEffectiveVariant(soldOutState, 'v45');

      expect(configured?.id).toBe('v45');
      expect(effective?.id).toBe('v45x2');
    });

    it('returns nothing when every pack is retired', () => {
      expect(pickEffectiveVariant(ALL.map((v) => ({ ...v, isActive: false })), null)).toBeNull();
    });
  });

  describe('presentListing presentation', () => {
    it('uses effective variant photography and reports both configured and effective IDs', () => {
      const media = [img('v45', 0, 'bottle-photo'), img('v200', 1, 'pouch-photo')];
      
      // When v45 is in stock:
      const inStock = presentListing(media, ALL, 'v45');
      expect(inStock.representativeVariantId).toBe('v45');
      expect(inStock.effectiveVariantId).toBe('v45');
      expect(inStock.sku).toBe('G2-45G');
      expect(inStock.heroUrl).toContain('bottle-photo');

      // When v45 is sold out, and v45x2 has no photos, but v200 is in stock:
      const v45Out = ALL.map((v) => (v.id === 'v45' || v.id === 'v45x2' ? { ...v, stock: 0 } : v));
      const fallback = presentListing(media, v45Out, 'v45');
      expect(fallback.representativeVariantId).toBe('v45'); // configured stays v45
      expect(fallback.effectiveVariantId).toBe('v200'); // effective becomes v200
      expect(fallback.sku).toBe('G2-200G');
      expect(fallback.heroUrl).toContain('pouch-photo');
    });
  });
});

// ---- Hero -------------------------------------------------------------------

describe('hero', () => {
  it('prefers the operator’s star when it is in the gallery', () => {
    const media = [img('v45', 0, 'first'), img('v45', 1, 'starred')];
    const g = resolveGallery(media, V45);
    expect(pickHero(g, { heroMediaId: 'starred' })?.id).toBe('starred');
  });

  it('falls back safely when the star names something this pack does not show', () => {
    const media = [img('v45', 0, 'own'), img('v1kg', 1, 'other-pack')];
    const g = resolveGallery(media, V45);
    // Pointing at the 1kg photo must not drag it into the 45g gallery.
    expect(pickHero(g, { heroMediaId: 'other-pack' })?.id).toBe('own');
  });

  it('falls back when the star names an asset that no longer exists', () => {
    const g = resolveGallery([img('v45', 0, 'own')], V45);
    expect(pickHero(g, { heroMediaId: 'deleted-id' })?.id).toBe('own');
  });

  it('prefers the pack’s own photography over a shared asset', () => {
    const media = [img(null, 0, 'fish'), img('v45', 1, 'bottle')];
    const g = resolveGallery(media, V45);
    expect(pickHero(g, null)?.id).toBe('bottle');
  });

  it('uses an inherited image for a multipack', () => {
    const media = [img('v45', 0, 'bottle')];
    const g = resolveGallery(media, V45X2);
    expect(pickHero(g, null)?.id).toBe('bottle');
    expect(g.coverage).toBe(Coverage.INHERITED);
  });

  it('NEVER returns a video, even when the star names one', () => {
    const media = [vid(null, 0, 'film'), img('v45', 1, 'bottle')];
    const g = resolveGallery(media, V45);
    expect(pickHero(g, { heroMediaId: 'film' })?.id).toBe('bottle');
  });

  it('is null when the gallery holds only a video', () => {
    const g = resolveGallery([vid(null, 0, 'film')], V45);
    expect(pickHero(g, { heroMediaId: 'film' })).toBeNull();
    expect(g.heroMediaId).toBeNull();
  });

  it('is null for an empty gallery', () => {
    const g = resolveGallery([img('v1kg', 0, 'pouch')], V45);
    expect(g.coverage).toBe(Coverage.EMPTY);
    expect(pickHero(g, null)).toBeNull();
  });
});

// ---- Video ------------------------------------------------------------------

describe('video selection', () => {
  it('comes from the RESOLVED gallery, never the raw media', () => {
    // A film shot for the 1kg pouch. The 45g bottle must not play it.
    const media = [img('v45', 0, 'bottle'), vid('v1kg', 1, 'kilo-film')];
    expect(pickVideo(resolveGallery(media, V45))).toBeNull();
    expect(pickVideo(resolveGallery(media, V1KG))?.id).toBe('kilo-film');
  });

  it('reports a shared film as SHARED', () => {
    const media = [vid(null, 0, 'film'), img('v45', 1, 'bottle')];
    expect(pickVideo(resolveGallery(media, V45))?.source).toBe(MediaSource.SHARED);
  });

  it('reports a pack’s own film as VARIANT', () => {
    const media = [vid('v45', 0, 'film'), img('v45', 1, 'bottle')];
    expect(pickVideo(resolveGallery(media, V45))?.source).toBe(MediaSource.VARIANT);
  });

  it('reports a multipack’s borrowed film as INHERITED', () => {
    const media = [vid('v45', 0, 'film'), img('v45', 1, 'bottle')];
    expect(pickVideo(resolveGallery(media, V45X2))?.source).toBe(MediaSource.INHERITED);
  });

  it('takes the first in resolved order when there are several', () => {
    const media = [img('v45', 0, 'bottle'), vid(null, 1, 'a'), vid(null, 2, 'b')];
    expect(pickVideo(resolveGallery(media, V45))?.id).toBe('a');
  });
});

// ---- Detail order -----------------------------------------------------------

describe('detail presentation', () => {
  const media = [
    img(null, 0, 'panel'),      // shared nutrition panel, first in the CMS
    vid(null, 1, 'film'),
    img('v45', 2, 'bottle-a'),
    img('v45', 3, 'bottle-b'),
    img(null, 4, 'fish'),
    img('v1kg', 5, 'pouch'),
  ];

  it('leads with the hero, then the film, then own, then shared', () => {
    const g = resolveGallery(media, V45);
    expect(presentDetail(g, null).orderedIds).toEqual([
      'bottle-a', 'film', 'bottle-b', 'panel', 'fish',
    ]);
  });

  it('never includes another pack’s photography', () => {
    const order = presentDetail(resolveGallery(media, V45), null).orderedIds;
    expect(order).not.toContain('pouch');
  });

  it('keeps CMS order inside each group', () => {
    const extra = [...media, img('v45', 6, 'bottle-c')];
    const order = presentDetail(resolveGallery(extra, V45), null).orderedIds;
    expect(order.indexOf('bottle-b')).toBeLessThan(order.indexOf('bottle-c'));
    expect(order.indexOf('panel')).toBeLessThan(order.indexOf('fish'));
  });

  it('honours the star as the opening frame', () => {
    const g = resolveGallery(media, V45);
    const p = presentDetail(g, { heroMediaId: 'bottle-b' });
    expect(p.heroId).toBe('bottle-b');
    expect(p.orderedIds[0]).toBe('bottle-b');
  });

  it('is a permutation — nothing added, nothing dropped', () => {
    for (const v of ALL) {
      const g = resolveGallery(media, v);
      const p = presentDetail(g, null);
      expect(p.orderedIds.length).toBe(g.items.length);
      expect([...p.orderedIds].sort()).toEqual(g.items.map((m) => m.id).sort());
    }
  });

  it('opens on an image even when a video sorts first in the CMS', () => {
    // Guppy's real arrangement: the film is at position 0.
    const p = presentDetail(resolveGallery(media, V45), null);
    expect(p.orderedIds[0]).not.toBe('film');
    expect(p.heroId).toBe('bottle-a');
  });

  it('leaves no hero for a video-only gallery, and still lists the film', () => {
    const p = presentDetail(resolveGallery([vid(null, 0, 'film')], V45), null);
    expect(p.heroId).toBeNull();
    expect(p.videoId).toBe('film');
    expect(p.orderedIds).toEqual(['film']);
  });

  it('handles an empty gallery without throwing', () => {
    const p = presentDetail(resolveGallery([], V45), null);
    expect(p).toEqual({ orderedIds: [], heroId: null, videoId: null, videoSource: null });
  });
});

// ---- Listing ----------------------------------------------------------------

describe('listing presentation', () => {
  it('uses the representative pack’s hero', () => {
    const media = [img('v45', 0, 'bottle'), img('v1kg', 1, 'pouch')];
    const l = presentListing(media, ALL, null);
    expect(l.heroUrl).toBe('https://res.cloudinary.com/x/bottle.jpg');
    expect(l.sku).toBe('G2-45G');
    expect(l.coverage).toBe(Coverage.EXACT);
  });

  it('follows an explicit representative', () => {
    const media = [img('v45', 0, 'bottle'), img('v200', 1, 'pouch200')];
    expect(presentListing(media, ALL, 'v200').heroUrl).toContain('pouch200');
  });

  it('NEVER shows another pack’s image — Cichlid C4’s bug', () => {
    /*
     * C4's 45g pack has no photography; the 1kg does. The card sells the 45g,
     * and it used to show the 1kg pouch because that was the product's first
     * image. The correct answer is no image at all.
     */
    const media = [img('v1kg', 0, 'kilo-pouch')];
    const l = presentListing(media, ALL, null);
    expect(l.heroUrl).toBeNull();
    expect(l.coverage).toBe(Coverage.EMPTY);
  });

  it('offers the poster when the only asset is a film', () => {
    const media = [vid(null, 0, 'film')];
    const l = presentListing(media, ALL, null);
    expect(l.heroUrl).toBeNull();
    expect(l.posterUrl).toBe('https://res.cloudinary.com/x/film.jpg');
    expect(l.videoUrl).toBe('https://res.cloudinary.com/x/film.mp4');
    expect(l.coverage).toBe(Coverage.SHARED_ONLY);
  });

  it('has neither when the product has no media', () => {
    const l = presentListing([], ALL, null);
    expect(l.heroUrl).toBeNull();
    expect(l.videoUrl).toBeNull();
    expect(l.posterUrl).toBeNull();
    expect(l.coverage).toBe(Coverage.EMPTY);
  });

  it('survives a product with no active packs', () => {
    const l = presentListing([img(null, 0)], ALL.map((v) => ({ ...v, isActive: false })), null);
    expect(l.sku).toBeNull();
    expect(l.coverage).toBe(Coverage.EMPTY);
  });

  it('applies the hover derivative to the film only', () => {
    const media = [img('v45', 0, 'bottle'), vid(null, 1, 'film')];
    const l = presentListing(media, ALL, null, (u) => `${u}?optimised`);
    expect(l.videoUrl).toBe('https://res.cloudinary.com/x/film.mp4?optimised');
    expect(l.heroUrl).not.toContain('optimised');
  });

  it('carries the hero’s alt text and intrinsic size, to reserve layout', () => {
    const l = presentListing([img('v45', 0, 'bottle')], ALL, null);
    expect(l.heroAlt).toBe('alt bottle');
    expect(l.width).toBe(1000);
    expect(l.height).toBe(1000);
  });

  it('uses an inherited image when the representative is a multipack', () => {
    const media = [img('v45', 0, 'bottle')];
    const l = presentListing(media, ALL, 'v45x2');
    expect(l.heroUrl).toContain('bottle');
    expect(l.coverage).toBe(Coverage.INHERITED);
  });

  it('is stable — the same input gives the same payload', () => {
    const media = [img('v45', 0, 'bottle'), vid(null, 1, 'film'), img(null, 2, 'fish')];
    expect(presentListing(media, ALL, null)).toEqual(presentListing(media, ALL, null));
  });
});
