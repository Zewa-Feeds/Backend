#!/usr/bin/env python3
"""
Derive category + species tags for each product. DRY RUN — prints only.

Category comes from the PRODUCT'S OWN WORDS, in priority order:
  1. explicit product type   (BSF larvae, hatchery)
  2. "floating" in the copy  -> FLOATING_PELLETS
  3. bottom/substrate zone   -> BOTTOM_DWELLERS
  4. "sinking" in the copy   -> SLOW_SINKING_PELLETS

Feeding Zone alone is NOT enough: G2 is "Mid-water" but the copy says
"slow-sinking", while A10 is "Surface" and genuinely floats. The description is
the more precise signal, so it wins.
"""
import json, re, pathlib

CAT = pathlib.Path(__file__).parent / 'catalogue.json'
products = json.loads(CAT.read_text())

def category_for(p):
    code = (p['code'] or '').upper()
    text = f"{p['shortDescription']} {p['optimisedTitle']}".lower()
    zone = p['suitableFor'].get('Feeding Zone', '').lower()

    if code.startswith('DBSFL'):
        return 'DRIED_BSF_LARVAE', 'product is whole dried larvae, not a pellet'
    if code.startswith('H'):
        return 'HATCHERY_FEEDS', 'three-stage hatchery feed'
    if 'floating' in text:
        return 'FLOATING_PELLETS', 'copy says "floating"'
    # BOTTOM_DWELLERS means the FISH is a bottom feeder (pleco, shrimp), not
    # merely that the pellet reaches the bottom. C5 lists "Mid-water, Bottom"
    # but is a large cichlid pellet for Oscars/Flowerhorns, so it belongs with
    # C4 in slow-sinking — owner decision, 3 Aug 2026.
    if ('bottom' in zone or 'substrate' in zone) and 'mid-water' not in zone:
        return 'BOTTOM_DWELLERS', f'feeding zone "{zone}"'
    if 'sinking' in text:
        return 'SLOW_SINKING_PELLETS', 'copy says "slow-sinking"'
    return 'SLOW_SINKING_PELLETS', 'default (no explicit signal)'

def tags_for(p):
    """Species tags from Primary Species + Also Suitable For."""
    sf = p['suitableFor']
    raw = ' , '.join(filter(None, [sf.get('Primary Species',''), sf.get('Also Suitable For','')]))
    # Strip parenthetical variety lists, then split on commas.
    raw = re.sub(r'\(([^)]*)\)', r', \1', raw)
    parts = [re.sub(r'[^a-z0-9\s-]','',s.strip().lower()) for s in raw.split(',')]
    out = []
    for s in parts:
        s = re.sub(r'\b(large|small|wild|fancy|other|and|species|body|bodied)\b','',s).strip()
        s = re.sub(r'\s+','-',s)
        if 2 < len(s) <= 40 and s not in out:
            out.append(s)
    return out[:20]

print(f"{'CODE':<12} {'SLUG':<20} {'CATEGORY':<22} WHY")
print('-'*100)
rows=[]
for p in products:
    cat, why = category_for(p)
    tags = tags_for(p)
    slug = p['slug']
    # The doc's slug for Hatch'E is "hatche", which reads as a typo and carries
    # no keyword. Slugs lock after first publish, so fix it before import.
    if slug == 'hatche':
        slug = 'hatchery-feeds'
    rows.append({'code':p['code'],'slug':slug,'category':cat,'tags':tags})
    print(f"{(p['code'] or '?'):<12} {slug:<20} {cat:<22} {why}")

print('\n══ species tags ══')
for r in rows:
    print(f"  {r['slug']:<20} {', '.join(r['tags'][:8])}{' …' if len(r['tags'])>8 else ''}")

out = pathlib.Path(__file__).parent / 'derived-meta.json'
out.write_text(json.dumps(rows, indent=2))
print(f"\n→ {out}")

from collections import Counter
print('\n══ products per category ══')
for c,n in Counter(r['category'] for r in rows).most_common():
    print(f"  {c:<24} {n}")
