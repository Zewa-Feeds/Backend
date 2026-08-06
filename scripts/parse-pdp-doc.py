#!/usr/bin/env python3
"""
Parse Zewa_PDP_Content_Master_v5.docx into structured JSON.

Read-only: writes scripts/catalogue.json and never touches the database. Run and
inspect the output BEFORE importing anything.

The document uses a strict 18-field layout per product, so parsing keys off the
numbered headings rather than guessing at prose.
"""
import json, re, html, subprocess, sys, pathlib

DOC = pathlib.Path(__file__).parent.parent / 'Zewa_PDP_Content_Master_v5.docx'
OUT = pathlib.Path(__file__).parent / 'catalogue.json'

def lines_from_docx(path):
    xml = subprocess.run(['unzip','-p',str(path),'word/document.xml'],
                         capture_output=True, text=True).stdout
    # Paragraph and table-cell boundaries both become newlines, so table rows
    # survive as separate lines instead of running together.
    xml = re.sub(r'</w:(p|tc)>', '\n', xml)
    txt = html.unescape(re.sub(r'<[^>]+>', '', xml))
    return [l.strip() for l in txt.split('\n') if l.strip()]

FIELDS = {
    2:'optimisedTitle', 3:'slug', 4:'metaDescription', 5:'shortDescription',
    6:'longDescription', 7:'suitableFor', 8:'feeding', 9:'nutrition',
    10:'ingredients', 11:'statutory', 12:'skus', 13:'keyFeatures',
    14:'trust', 15:'tags', 16:'keywords', 17:'imageAlt', 18:'faq',
}

def parse():
    lines = lines_from_docx(DOC)

    # Product blocks start at "N. Zewa Feeds <name>"
    starts = [(i, l) for i, l in enumerate(lines)
              if re.match(r'^\d{1,2}\. Zewa Feeds ', l)]
    products = []

    for n, (idx, heading) in enumerate(starts):
        end = starts[n+1][0] if n+1 < len(starts) else len(lines)
        block = lines[idx:end]

        # Split the block on the numbered field headings.
        buckets, current = {}, None
        for l in block[1:]:
            m = re.match(r'^(\d{1,2})\. (.+)$', l)
            if m and int(m.group(1)) in FIELDS:
                current = FIELDS[int(m.group(1))]
                buckets[current] = []
                continue
            if current:
                buckets[current].append(l)

        code = re.search(r'\(([A-Z0-9/\s\']+)\)\s*$', heading)
        products.append({
            'heading': heading,
            'code': code.group(1).strip() if code else None,
            'raw': {k: v for k, v in buckets.items()},
        })

    return products

def skus_from(raw):
    """SKU table rows: CODE | variant | MRP | SP | HSN."""
    out, rows = [], raw.get('skus', [])
    i = 0
    while i < len(rows):
        if re.match(r'^[A-Z0-9]{1,6}[-_][0-9]{1,4}\s*(G|KG)(X\d)?$', rows[i], re.I):
            chunk = rows[i:i+5]
            if len(chunk) == 5:
                money = lambda s: int(round(float(re.sub(r'[^\d.]','',s) or 0)))
                out.append({
                    'sku': chunk[0].strip(),
                    'variant': chunk[1].strip(),
                    'mrp': money(chunk[2]),
                    'price': money(chunk[3]),
                    'hsn': re.sub(r'\D','',chunk[4]) or '23099090',
                    'tbc': 'TBC' in ' '.join(chunk).upper(),
                })
                i += 5; continue
        i += 1
    return out

def kv_table(rows):
    """Two-column 'Parameter / Value' tables -> dict, skipping the header row."""
    out = {}
    i = 0
    while i + 1 < len(rows):
        k, v = rows[i], rows[i+1]
        if k.lower() in ('attribute','parameter','value'): i += 1; continue
        if len(k) < 60 and not k.startswith('Source:'):
            out[k] = v; i += 2
        else:
            i += 1
    return out

if __name__ == '__main__':
    products = parse()
    result = []
    for p in products:
        raw = p['raw']
        slug = (raw.get('slug',[''])[0] or '').replace('/products/','').strip()
        result.append({
            'code': p['code'],
            'heading': p['heading'],
            'slug': slug,
            'name': ' '.join(raw.get('optimisedTitle',[''])[0].split('—')[0].split()),
            'optimisedTitle': re.sub(r'\s*\[\d+\s*chars?\]$','',raw.get('optimisedTitle',[''])[0]).strip(),
            'metaDescription': re.sub(r'\s*\[\d+\s*chars?\]$','',' '.join(raw.get('metaDescription',[]))).strip(),
            'shortDescription': ' '.join(raw.get('shortDescription',[])).strip(),
            'longParagraphs': raw.get('longDescription',[]),
            'suitableFor': kv_table(raw.get('suitableFor',[])),
            'feeding': ' '.join(raw.get('feeding',[])).strip(),
            'nutrition': kv_table(raw.get('nutrition',[])),
            'ingredients': [l for l in raw.get('ingredients',[]) if not l.startswith('Source:')],
            'keyFeatures': raw.get('keyFeatures',[]),
            'tags': raw.get('tags',[]),
            'skus': skus_from(raw),
            'faq': raw.get('faq',[]),
            'imageAlt': raw.get('imageAlt',[]),
        })

    OUT.write_text(json.dumps(result, indent=2, ensure_ascii=False))

    print(f"parsed {len(result)} products, {sum(len(p['skus']) for p in result)} SKUs")
    print(f"→ {OUT}\n")
    for p in result:
        warn = '' if p['skus'] else '   ⚠ NO SKUS PARSED'
        print(f"  {(p['code'] or '?'):<10} {p['slug']:<22} {len(p['skus'])} SKUs  "
              f"{len(p['keyFeatures'])} features  {len(p['nutrition'])} nutrition{warn}")
