/**
 * Resolver tests.
 *
 * These pin the rules that decide which photograph a customer sees. Two of them
 * reproduce bugs that were live in production before this resolver existed:
 *
 *   - "never shows another pack's photography" — Cichlid C4 has four packs and
 *     photography for one, so the old fallback showed the 1kg pouch to someone
 *     who had selected a different size.
 *   - "a SKU rename changes nothing" — inheritance used to be derived by
 *     stripping an X2 suffix, so renaming a pack silently changed its gallery.
 */
import { describe, expect, it } from 'vitest';
import { MediaType } from '@prisma/client';
import {
  Coverage,
  MediaSource,
  resolveCoverage,
  resolveGallery,
  type ResolvableMedia,
  type ResolvableVariant,
} from './media.resolver';

// ---- Fixtures ---------------------------------------------------------------

const V45: ResolvableVariant = { id: 'v45', sku: 'G2-45G' };
const V200: ResolvableVariant = { id: 'v200', sku: 'G2-200G' };
const V1KG: ResolvableVariant = { id: 'v1kg', sku: 'G2-1KG' };
const V45X2: ResolvableVariant = { id: 'v45x2', sku: 'G2-45GX2', baseVariantId: 'v45' };
const V45X3: ResolvableVariant = { id: 'v45x3', sku: 'G2-45GX3', baseVariantId: 'v45' };

let seq = 0;
const img = (variantId: string | null, position: number, id?: string): ResolvableMedia => ({
  id: id ?? `img-${++seq}`,
  type: MediaType.IMAGE,
  url: `https://res.cloudinary.com/x/${id ?? seq}.jpg`,
  alt: null,
  position,
  variantId,
});
const vid = (variantId: string | null, position: number): ResolvableMedia => ({
  ...img(variantId, position),
  type: MediaType.VIDEO,
});

const ids = (r: { items: { id: string }[] }) => r.items.map((i) => i.id);

// ---- Shared media -----------------------------------------------------------

describe('shared media', () => {
  it('appears for every pack', () => {
    const media = [img(null, 0, 'fish'), img('v45', 1, 'bottle45')];
    for (const v of [V45, V200, V1KG]) {
      expect(ids(resolveGallery(media, v))).toContain('fish');
    }
  });

  it('is the whole gallery when no pack has its own', () => {
    const media = [img(null, 0, 'fish'), img(null, 1, 'panel')];
    const r = resolveGallery(media, V200);
    expect(r.coverage).toBe(Coverage.SHARED_ONLY);
    expect(ids(r)).toEqual(['fish', 'panel']);
  });
});

// ---- Pack-specific ----------------------------------------------------------

describe('pack-specific media', () => {
  it("shows the selected pack's photography", () => {
    const media = [img('v45', 0, 'b45'), img('v1kg', 1, 'p1kg')];
    expect(ids(resolveGallery(media, V45))).toEqual(['b45']);
  });

  it("never leaks another pack's photography", () => {
    const media = [img('v45', 0, 'b45'), img('v1kg', 1, 'p1kg')];
    expect(ids(resolveGallery(media, V45))).not.toContain('p1kg');
  });

  it('combines pack media with shared media, in CMS order', () => {
    const media = [img(null, 0, 'fish'), img('v45', 1, 'b45'), img(null, 2, 'panel')];
    const r = resolveGallery(media, V45);
    expect(r.coverage).toBe(Coverage.EXACT);
    expect(ids(r)).toEqual(['fish', 'b45', 'panel']);
  });
});

// ---- THE LIVE BUG -----------------------------------------------------------

describe('a pack with no photography of its own', () => {
  /*
   * Cichlid C4, as it exists in production: four packs, photography for one.
   * The old storefront returned the entire gallery here, so selecting the 45g
   * showed the 1kg pouch. This is the test that stops that returning.
   */
  it('never falls back to showing every other pack', () => {
    const media = [img('v1kg', 0, 'p1kg'), img('v200', 1, 'p200')];
    const r = resolveGallery(media, V45);
    expect(ids(r)).not.toContain('p1kg');
    expect(ids(r)).not.toContain('p200');
    expect(r.coverage).toBe(Coverage.EMPTY);
  });

  it('prefers shared media over another pack, and says so', () => {
    const media = [img('v1kg', 0, 'p1kg'), img(null, 1, 'fish')];
    const r = resolveGallery(media, V45);
    expect(ids(r)).toEqual(['fish']);
    expect(r.coverage).toBe(Coverage.SHARED_ONLY);
  });
});

// ---- Inheritance ------------------------------------------------------------

describe('multipack inheritance', () => {
  it('borrows the base pack, and reports where from', () => {
    const media = [img('v45', 0, 'b45'), img('v1kg', 1, 'p1kg')];
    const r = resolveGallery(media, V45X2);
    expect(ids(r)).toEqual(['b45']);
    expect(r.coverage).toBe(Coverage.INHERITED);
    expect(r.inheritedFromVariantId).toBe('v45');
    expect(r.items[0]?.source).toBe(MediaSource.INHERITED);
  });

  it('does not inherit once the multipack has its own photography', () => {
    const media = [img('v45', 0, 'b45'), img('v45x2', 1, 'own')];
    const r = resolveGallery(media, V45X2);
    expect(ids(r)).toEqual(['own']);
    expect(r.coverage).toBe(Coverage.EXACT);
  });

  it('falls to shared — never a third pack — when the base has no media', () => {
    const media = [img('v1kg', 0, 'p1kg'), img(null, 1, 'fish')];
    const r = resolveGallery(media, V45X2);
    expect(ids(r)).toEqual(['fish']);
    expect(r.coverage).toBe(Coverage.SHARED_ONLY);
  });

  it('two multipacks inherit the same base independently', () => {
    const media = [img('v45', 0, 'b45')];
    expect(ids(resolveGallery(media, V45X2))).toEqual(['b45']);
    expect(ids(resolveGallery(media, V45X3))).toEqual(['b45']);
  });
});

// ---- SKU independence -------------------------------------------------------

describe('SKU renaming', () => {
  it('changes nothing, because resolution keys on ids', () => {
    const media = [img('v45', 0, 'b45'), img(null, 1, 'fish')];
    const before = resolveGallery(media, V45X2);

    const renamedBase = { ...V45, sku: 'GUPPY-BOTTLE-45' };
    const renamedPack = { ...V45X2, sku: 'GUPPY-BOTTLE-45-TWIN' };
    const after = resolveGallery(media, renamedPack);

    expect(ids(after)).toEqual(ids(before));
    expect(after.coverage).toBe(before.coverage);
    expect(after.inheritedFromVariantId).toBe(renamedBase.id);
  });
});

// ---- Ordering, hero, dedupe -------------------------------------------------

describe('ordering', () => {
  it('follows CMS position exactly, and does not reshuffle', () => {
    const media = [img('v45', 3, 'd'), img(null, 1, 'b'), img('v45', 0, 'a'), img(null, 2, 'c')];
    expect(ids(resolveGallery(media, V45))).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('hero', () => {
  it("prefers the pack's own image over a shared one", () => {
    const media = [img(null, 0, 'fish'), img('v45', 1, 'b45')];
    expect(resolveGallery(media, V45).heroMediaId).toBe('b45');
  });

  it('never picks a video — it is used as a thumbnail', () => {
    const media = [vid('v45', 0), img('v45', 1, 'b45')];
    expect(resolveGallery(media, V45).heroMediaId).toBe('b45');
  });

  it('marks exactly one item primary', () => {
    const media = [img(null, 0, 'fish'), img('v45', 1, 'b45'), img('v45', 2, 'b45b')];
    const r = resolveGallery(media, V45);
    expect(r.items.filter((i) => i.isPrimary)).toHaveLength(1);
  });

  it('leaves no hero when the gallery is a video and nothing else', () => {
    /*
     * This used to fall back to the video itself. A hero is rendered as an
     * <img> — card photograph, opening frame, Open Graph image — so promoting a
     * film there produced a broken thumbnail. No hero is the honest answer; the
     * presentation layer shows the poster frame instead.
     */
    const media = [vid(null, 0)];
    const r = resolveGallery(media, V45);
    expect(r.heroMediaId).toBeNull();
    expect(r.items.filter((i) => i.isPrimary)).toHaveLength(0);
  });
});

describe('deduplication', () => {
  it('shows an asset once even when it arrives by two paths', () => {
    const shared = img(null, 0, 'dual');
    // Same row reachable as both shared and (hypothetically) targeted.
    const r = resolveGallery([shared, shared], V45);
    expect(ids(r).filter((i) => i === 'dual')).toHaveLength(1);
  });
});

// ---- Edge cases -------------------------------------------------------------

describe('edge cases', () => {
  it('handles a product with no media at all', () => {
    const r = resolveGallery([], V45);
    expect(r.items).toEqual([]);
    expect(r.coverage).toBe(Coverage.EMPTY);
    expect(r.heroMediaId).toBeNull();
  });

  it('returns everything when no pack is selected', () => {
    const media = [img(null, 0, 'fish'), img('v45', 1, 'b45'), img('v1kg', 2, 'p1kg')];
    expect(ids(resolveGallery(media, null))).toEqual(['fish', 'b45', 'p1kg']);
  });

  it('survives duplicate positions without losing an item', () => {
    const media = [img('v45', 0, 'a'), img('v45', 0, 'b')];
    expect(ids(resolveGallery(media, V45))).toHaveLength(2);
  });

  it('treats a dangling inheritance as no source rather than crashing', () => {
    const orphan: ResolvableVariant = { id: 'vx', sku: 'X', baseVariantId: 'deleted' };
    const media = [img(null, 0, 'fish')];
    const r = resolveGallery(media, orphan);
    expect(r.coverage).toBe(Coverage.SHARED_ONLY);
    expect(ids(r)).toEqual(['fish']);
  });

  it('is deterministic — the same input always resolves identically', () => {
    const media = [img(null, 0, 'fish'), img('v45', 1, 'b45')];
    const a = JSON.stringify(resolveGallery(media, V45));
    const b = JSON.stringify(resolveGallery(media, V45));
    expect(a).toBe(b);
  });
});

// ---- Coverage reporting -----------------------------------------------------

describe('coverage report', () => {
  it('names each pack’s state so the CMS can show the gaps', () => {
    const media = [img('v45', 0, 'b45'), img(null, 1, 'fish')];
    const rows = resolveCoverage(media, [V45, V200, V45X2]);

    expect(rows.find((r) => r.sku === 'G2-45G')?.coverage).toBe(Coverage.EXACT);
    expect(rows.find((r) => r.sku === 'G2-200G')?.coverage).toBe(Coverage.SHARED_ONLY);

    const twin = rows.find((r) => r.sku === 'G2-45GX2');
    expect(twin?.coverage).toBe(Coverage.INHERITED);
    expect(twin?.inheritedFromVariantId).toBe('v45');
  });

  it('reports EMPTY for a pack with nothing usable', () => {
    const media = [img('v1kg', 0, 'p1kg')];
    const rows = resolveCoverage(media, [V45]);
    expect(rows[0]?.coverage).toBe(Coverage.EMPTY);
    expect(rows[0]?.itemCount).toBe(0);
  });
});
