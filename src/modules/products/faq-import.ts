/**
 * Product FAQs from the PDP master document (scripts/catalogue.json).
 *
 * In the catalogue each product's `faq` is a flat list alternating a labelled
 * question ("Q1: Which fish can eat …?") and its answer. Some lists end with the
 * source document's footer ("— End of PDP Content Master v5.0 —"), which is not
 * an FAQ. Only a "Qn:" line followed by an answer line becomes an entry.
 *
 * The question keeps its wording exactly; only the "Qn: " numbering label is
 * removed, because the storefront numbers nothing. Answers are copied verbatim.
 */
export interface FaqEntry {
  q: string;
  a: string;
}

const LABEL = /^Q\d+:\s*/;

export function parseCatalogueFaq(lines: unknown): FaqEntry[] {
  if (!Array.isArray(lines)) return [];
  const out: FaqEntry[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const q = lines[i];
    const a = lines[i + 1];
    if (typeof q !== 'string' || typeof a !== 'string') continue;
    if (!LABEL.test(q) || LABEL.test(a)) continue;
    out.push({ q: q.replace(LABEL, ''), a });
    i++; // the answer line is consumed
  }
  return out;
}

/** catalogue.json + derived-meta.json → FAQs per product slug. */
export function faqsBySlug(
  catalogue: { code: string; faq?: unknown }[],
  meta: { code: string; slug: string }[],
): Map<string, FaqEntry[]> {
  const slugOf = new Map(meta.map((m) => [m.code, m.slug]));
  const out = new Map<string, FaqEntry[]>();
  for (const product of catalogue) {
    const slug = slugOf.get(product.code);
    const faq = parseCatalogueFaq(product.faq);
    if (slug && faq.length > 0) out.set(slug, faq);
  }
  return out;
}
