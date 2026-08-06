#!/usr/bin/env python3
"""
Guess which product each file in Listing Images/ belongs to.

DRY RUN ONLY — writes scripts/image-map.json and uploads nothing. Inspect it
(and the UNMATCHED list) before running the importer.

Heuristic, in order of confidence:
  1. SKU code in the path        "1Kg Pouches_/F3-1KG/..."  -> F3
  2. Product word in the path    "Bottles/Betta/..."        -> F3
Ordering within a product prefers a front/hero shot at position 0, because
position 0 becomes the storefront's main image.
"""
import json, re, pathlib

ROOT = pathlib.Path(__file__).parent.parent / 'Listing Images'
OUT  = pathlib.Path(__file__).parent / 'image-map.json'
CAT  = json.loads((pathlib.Path(__file__).parent / 'catalogue.json').read_text())

BY_CODE = {p['code']: p for p in CAT if p['code']}
# Words that appear in folder names, mapped to a product code.
WORD_TO_CODE = {
    'betta': 'F3', 'guppy': 'G2', 'tetra': 'F2', 'micro': 'M3',
    'micropellet': 'M3', 'shrimp': 'S5', 'pleco': 'P5', 'goldfish': 'K4',
    'koi': 'K7', 'monster': 'A10', 'moster': 'A10',   # sic: folder is misspelt
    'dbsfl': 'DBSFL', 'cichlid': 'C4', 'cichild': 'C4',  # sic
    'goldfidh': 'K4',                                    # sic: folder is misspelt
    'hatch': 'H1', 'hatche': 'H1',
}
IMG = {'.png', '.jpg', '.jpeg', '.webp'}

def code_for(rel: str):
    up = rel.upper()
    # 1. explicit SKU code, e.g. F3-1KG or DBSFL_25GX2
    m = re.search(r'\b(DBSFL|A10|[A-Z]\d{1,2})[-_]\d{1,4}(?:G|KG)', up)
    if m and m.group(1) in BY_CODE:
        return m.group(1), 'sku-in-path'
    # 2. product word in a folder name
    low = re.sub(r'[^a-z]+', ' ', rel.lower())
    for word, code in WORD_TO_CODE.items():
        if re.search(rf'\b{word}\b', low) and code in BY_CODE:
            return code, f'word:{word}'
    return None, None

# Folder patterns -> the pack size an image depicts. Anything unmatched is a
# SHARED asset (fish photo, nutrition panel) shown for every pack.
PACK_PATTERNS = [
    (r'\b1\s*kg\b|[-_]1KG\b',        '1kg'),
    (r'\b500\s*g\b|[-_]500G\b',      '500g'),
    (r'\b200\s*g\b|[-_]200G\b',      '200g'),
    (r'\b140\s*g\b|[-_]140G\b',      '140g'),
    (r'\b75\s*g\b|[-_]75G?\b|/75/',  '75g'),
    (r'\b45\s*g\b|[-_]45G\b',        '45g'),
    (r'\b25\s*g\b|[-_]25G?\b|/25/',  '25g'),
    (r'\b20\s*g\b|[-_]20G\b',        '20g'),
    (r'\bbottles?\b',                  'bottle'),   # weakest: bottle folders
]

def pack_for(rel: str):
    """Which pack this image shows, or None for a shared asset."""
    low = rel.lower()
    for pattern, pack in PACK_PATTERNS:
        if re.search(pattern, low):
            return pack
    return None


def hero_rank(name: str) -> int:
    """Lower sorts earlier. Front-of-pack first, feature panels last."""
    n = name.lower()
    if 'front' in n: return 0
    # "Artboard"/"Why Trust" files are marketing panels, not pack shots — push
    # them down so a real product photo wins position 0.
    if 'artboard' in n or 'why trust' in n: return 7
    # A file named after the product itself is usually the hero, e.g.
    # "Tetra Pellets 01.png".
    if re.match(r'^[a-z][a-z\s]{3,}\d{1,2}\.', n): return 1
    if re.match(r'^1[\s._-]*\.?', n): return 1
    if 'iso' in n: return 2
    if 'back' in n: return 8
    if 'blinkit' in n: return 9   # marketplace-specific art, not for our PDP
    return 5

rows, unmatched = [], []
for f in sorted(ROOT.rglob('*')):
    if not f.is_file() or f.suffix.lower() not in IMG: continue
    rel = str(f.relative_to(ROOT))
    if 'superseded' in rel.lower():          # old artwork — skip
        continue
    code, why = code_for(rel)
    if not code:
        unmatched.append(rel); continue
    rows.append({'file': rel, 'code': code, 'slug': BY_CODE[code]['slug'],
                 'rank': hero_rank(f.name), 'why': why, 'pack': pack_for(rel)})

# Assign gallery positions per product, GROUPED BY PACK.
#
# Sorting by hero-rank alone interleaved the packs (200g, 1kg, 200g, 45g, 200g…),
# which renders fine but is unmanageable in the CMS — an admin editing the 1kg
# photos had to hunt through the whole list. Packs are now contiguous, ordered by
# size, with shared assets first so position 0 stays a strong lead image.
PACK_ORDER = ['20g', '25g', '45g', '75g', '140g', '200g', '500g', '1kg', 'bottle']

def pack_key(p):
    if p is None:
        return -1          # shared assets lead
    return PACK_ORDER.index(p) if p in PACK_ORDER else 99

byslug = {}
for r in sorted(rows, key=lambda r: (r['slug'], pack_key(r['pack']), r['rank'], r['file'])):
    byslug.setdefault(r['slug'], []).append(r)
for slug, items in byslug.items():
    for i, r in enumerate(items):
        r['position'] = i
        r['include'] = i < 20

OUT.write_text(json.dumps({'images': rows, 'unmatched': unmatched}, indent=2))
print(f"mapped {len(rows)} images across {len(byslug)} products")
print(f"unmatched: {len(unmatched)}   (skipped 'Superseded')")
print(f"→ {OUT}\n")
from collections import Counter
for slug in sorted(byslug):
    items = byslug[slug]
    packs = Counter(r['pack'] or 'shared' for r in items)
    summary = ' '.join(f'{k}:{v}' for k, v in sorted(packs.items()))
    print(f"  {slug:<20} {len(items):>3}   {summary}")
if unmatched:
    print("\n  UNMATCHED (no product guessed — will not be uploaded):")
    for u in unmatched[:15]: print("   ", u[:78])
    if len(unmatched) > 15: print(f"    … and {len(unmatched)-15} more")
