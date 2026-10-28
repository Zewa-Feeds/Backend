/**
 * One key per nutrient.
 *
 * The catalogue import stored nutrition under display labels ("Crude Fat (min)")
 * while the CMS form reads and writes short keys (`fat`). The form therefore
 * opened empty on every imported product, and saving wrote `fat` NEXT TO
 * "Crude Fat (min)" — the PDP then listed each nutrient twice.
 *
 * Everything that stores or serves nutrition passes through here, so any
 * spelling collapses to the short key. Where both spellings are present the
 * short key wins: it is what the CMS writes, so it is the latest edit.
 *
 * Crude protein is dropped. It is ProductFamily.proteinPct ("mirrors Basic
 * Info" in the CMS); a second copy here could only disagree with it.
 * Unrecognised keys are custom nutrients and pass through untouched.
 */

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

/** Normalised spelling → short key. Qualifiers like "(min)" normalise away. */
const ALIASES: Record<string, string> = {};
const alias = (key: string, ...spellings: string[]) => {
  for (const s of [key, ...spellings]) ALIASES[norm(s)] = key;
};
alias('fat', 'Crude Fat', 'Crude Fat (min)');
alias('fiber', 'fibre', 'Crude Fiber', 'Crude Fibre', 'Crude Fiber (max)', 'Crude Fibre (max)');
alias('moisture', 'Moisture (max)');
alias('ash', 'Ash (max)');
alias('calcium', 'Calcium (min)');
alias('phosphorus', 'phosphorous', 'Phosphorus (min)', 'Phosphorous (min)');

const PROTEIN = new Set(['protein', 'crudeprotein', 'crudeproteinmin'].map(norm));

export function canonicalNutrition(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, string> = {};
  const fromShortKey = new Set<string>();

  for (const [rawKey, rawVal] of Object.entries(input as Record<string, unknown>)) {
    if (rawVal === null || rawVal === undefined) continue;
    const val = String(rawVal).trim();
    const n = norm(rawKey);
    if (PROTEIN.has(n)) continue;

    const key = ALIASES[n] ?? rawKey;
    const isShortKey = rawKey === key;
    // A label spelling never overwrites a value the CMS wrote under the short key.
    if (fromShortKey.has(key) && !isShortKey) continue;
    if (!val) {
      // An emptied CMS field clears the nutrient, label spelling included.
      if (isShortKey) {
        delete out[key];
        fromShortKey.add(key);
      }
      continue;
    }
    out[key] = val;
    if (isShortKey) fromShortKey.add(key);
  }
  return out;
}
