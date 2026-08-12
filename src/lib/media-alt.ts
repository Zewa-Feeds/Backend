/**
 * Alt text for product imagery.
 *
 * Alt text was originally derived straight from the upload filename, which
 * produced strings a screen reader cannot use:
 *
 *   "Zewa Feeds Guppy Bites G2 — Guppy 03.jpg"   (file extension read aloud)
 *   "Zewa Feeds Guppy Bites G2 — 1"              (a bare number)
 *   "Zewa Feeds Guppy Bites G2 — Jpg1 100.jpg"   (encoder noise)
 *
 * Only ".png" was stripped, so every JPEG kept its extension. The deeper
 * problem is that a filename is not a description: "Guppy 03" tells someone
 * who cannot see the image nothing that "Guppy 02" did not already tell them.
 *
 * So filename fragments that carry no meaning are discarded, and the ones that
 * genuinely describe the shot — front, back, ISO view, lifestyle — are mapped
 * to plain English. Anything left over falls back to the pack size, which is
 * at least a real distinction between two photos of the same product.
 */

/** Filename fragments that describe the actual shot. */
const VIEW_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bfront\b/i, 'front of pack'],
  [/\bback\b/i, 'back of pack, showing the nutrition panel'],
  [/\bside\b/i, 'side of pack'],
  [/\btop\b/i, 'top of pack'],
  [/\biso\b/i, 'angled product view'],
  [/\b(lifestyle|scene|tank)\b/i, 'in an aquarium setting'],
  /*
   * Matches the hyphenated form too, so re-running over already-generated text
   * ("close-up of the pellets") reproduces it exactly instead of oscillating
   * between "close-up" and "close up" on every pass.
   */
  [/\b(macro|closeup|close[- ]?up)\b/i, 'close-up of the pellets'],
  [/\b(pellet|granule|kibble)s?\b/i, 'close-up of the pellets'],
  [/\bhand\b/i, 'pack held in hand'],
];

/** Pack size, e.g. "200G" or "1KG", when the filename encodes one. */
const PACK_SIZE = /\b(\d+\s?(?:g|gm|gms|kg|ml|l))\b/i;

/**
 * Does this fragment already read like a human description rather than a
 * filename?
 *
 * "Albino pleco customer video" is someone describing the shot; "Artboard 1
 * copy 2" and "Jpg1 100" are export noise. The distinguishing signal is real
 * words: three or more alphabetic tokens, none of which are the artefacts
 * design tools and cameras leave behind.
 *
 * Overwriting a human description with a generated one is strictly worse, so
 * anything that passes this test is left exactly as written.
 */
const NOISE = /^(artboard|copy|jpg|jpeg|png|img|image|dsc|final|new|untitled|v\d+|\d+)$/i;

export function looksHandWritten(stem: string): boolean {
  const words = stem.split(/\s+/).filter(Boolean);
  const real = words.filter((w) => /^[a-z]+$/i.test(w) && !NOISE.test(w));
  return real.length >= 3;
}

/**
 * Build alt text from a product name and an upload filename.
 *
 * @param productName Full product name, e.g. "Zewa Feeds Guppy Bites G2".
 * @param fileName    Original upload filename, with or without extension.
 * @param index       Zero-based gallery position, used only as a last resort.
 */
export function buildMediaAlt(
  productName: string,
  fileName: string,
  index = 0,
): string {
  // Strip ANY extension, not just .png, then normalise separators.
  const stem = fileName
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/(?<!close)[-_]+/gi, ' ')
    .trim();

  if (looksHandWritten(stem)) return `${productName} — ${stem}`.slice(0, 300);

  const view = VIEW_WORDS.find(([re]) => re.test(stem))?.[1];
  if (view) {
    const size = stem.match(PACK_SIZE)?.[1];
    const suffix = size ? `, ${size.toUpperCase().replace(/\s+/g, '')} pack` : '';
    return `${productName} — ${view}${suffix}`.slice(0, 300);
  }

  const size = stem.match(PACK_SIZE)?.[1];
  if (size) {
    return `${productName} — ${size.toUpperCase().replace(/\s+/g, '')} pack`.slice(0, 300);
  }

  /*
   * Nothing descriptive in the filename. Repeating the product name alone
   * would make every image identical to a screen reader, so the position is
   * included purely to keep them distinguishable.
   */
  return `${productName} — product photo ${index + 1}`.slice(0, 300);
}
