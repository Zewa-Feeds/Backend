/**
 * Server-side HTML sanitisation — XSS defence for rich text.
 *
 * The CMS uses Tiptap, which produces clean HTML. That is irrelevant: the editor
 * runs on the client, so its output cannot be trusted. Anyone can POST arbitrary
 * HTML to the same endpoint. Sanitising here, on write, is what actually protects
 * the storefront — which renders these fields with `dangerouslySetInnerHTML`.
 *
 * Sanitise on WRITE rather than on read so the database never holds a payload we
 * would not serve, and the cost is paid once.
 */
import sanitizeHtml from 'sanitize-html';

/**
 * Full editor: article bodies, product long descriptions, feeding notes.
 * Mirrors the toolbar in CMS/components/ui/RichText.jsx.
 */
const FULL: sanitizeHtml.IOptions = {
  allowedTags: [
    'p',
    'br',
    'h2',
    'h3',
    'strong',
    'em',
    's',
    'u',
    'ul',
    'ol',
    'li',
    'blockquote',
    'hr',
    'a',
    'code',
  ],
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
  },
  // No javascript:, no data: — those are the XSS vectors in an href.
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesAppliedToAttributes: ['href'],
  // Force external links to be safe: noopener stops reverse-tabnabbing.
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }),
  },
  // Drop the content of anything dangerous rather than escaping it into view.
  nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript', 'iframe'],
};

/**
 * Compact mode: inline emphasis and lists only.
 * For article excerpts and homepage subtexts, where a heading would break layout.
 */
const COMPACT: sanitizeHtml.IOptions = {
  allowedTags: ['p', 'br', 'strong', 'em', 's', 'ul', 'ol', 'li', 'a'],
  allowedAttributes: { a: ['href', 'target', 'rel'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesAppliedToAttributes: ['href'],
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }),
  },
  nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript', 'iframe'],
};

export const sanitizeRichText = (html: string): string => sanitizeHtml(html, FULL);

export const sanitizeCompact = (html: string): string => sanitizeHtml(html, COMPACT);

/**
 * Strip ALL markup, keeping text.
 *
 * For fields that must be plain: SEO titles and descriptions (markup corrupts a
 * meta tag), short descriptions with hard character limits, and internal notes.
 * The CMS deliberately renders these as plain inputs; this enforces it server-side.
 */
export const stripHtml = (input: string): string =>
  sanitizeHtml(input, { allowedTags: [], allowedAttributes: {} }).trim();

/**
 * Zod-friendly transforms.
 *
 * Usage: `z.string().max(5000).transform(richText)`
 */
export const richText = (v: string) => sanitizeRichText(v);
export const compactText = (v: string) => sanitizeCompact(v);
export const plainText = (v: string) => stripHtml(v);
