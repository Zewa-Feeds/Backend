/**
 * ZeptoMail webhook verification.
 *
 * ZeptoMail signs every notification with a `producer-signature` header of the form
 *
 *     ts=1596109465823;s=dN0yVozg…%3D;s-algorithm=HmacSHA256
 *
 * where `s` is an HMAC-SHA256 over the raw notification body, keyed with the Mail
 * Agent's webhook auth key, and base64-encoded.
 *
 * Verifying it is the only thing separating "ZeptoMail says this email was opened"
 * from "anyone on the internet says that". Without it the endpoint is an
 * unauthenticated write into the mail log — an attacker could mark any message
 * opened, which is worse than having no tracking at all because the data then reads
 * as evidence.
 *
 * Three rules the implementation must not bend, all learned from the Cloudinary and
 * Razorpay verifiers already in this codebase:
 *
 *   - the RAW body is what gets hashed. Re-serialising parsed JSON changes the
 *     bytes (key order, whitespace, unicode escapes) and every signature fails.
 *   - the `s` value is URL-ENCODED in the header, so `%3D` must be decoded back to
 *     `=` before comparing. Skipping this rejects every genuine notification.
 *   - the comparison is constant-time. A byte-by-byte `===` leaks the signature
 *     through timing, one character at a time.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@/config/env';

/**
 * How stale a notification may be.
 *
 * ZeptoMail retries, so this cannot be tight — but without a bound, a captured
 * payload could be replayed forever to inflate open counts. Two hours matches the
 * Cloudinary verifier's window: well inside the retry period, well outside anything
 * useful to someone sitting on an old capture.
 *
 * The header's `ts` is in MILLISECONDS, unlike Cloudinary's seconds.
 */
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

export type VerifyResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'NOT_CONFIGURED' | 'MISSING_HEADER' | 'MALFORMED_HEADER' | 'STALE' | 'BAD_SIGNATURE';
    };

/** The three fields ZeptoMail packs into `producer-signature`. */
export interface ParsedSignature {
  ts: number;
  signature: string;
  algorithm: string;
}

/**
 * Split `ts=…;s=…;s-algorithm=…` into its parts.
 *
 * Order is not assumed — the header is parsed as a set of key/value pairs rather
 * than by position, so a provider reordering them cannot break verification.
 */
export function parseSignatureHeader(header: string | undefined): ParsedSignature | null {
  if (!header) return null;

  const parts = new Map<string, string>();
  for (const segment of header.split(';')) {
    const idx = segment.indexOf('=');
    if (idx <= 0) continue;
    // Only the FIRST '=' separates key from value: a base64 signature ends in '='
    // padding, so splitting on every '=' would truncate it.
    parts.set(segment.slice(0, idx).trim().toLowerCase(), segment.slice(idx + 1).trim());
  }

  const tsRaw = parts.get('ts');
  const sRaw = parts.get('s');
  const algorithm = parts.get('s-algorithm') ?? '';
  if (!tsRaw || !sRaw) return null;

  const ts = Number(tsRaw);
  if (!Number.isFinite(ts)) return null;

  /*
   * The header arrives percent-encoded, so base64 padding shows up as %3D. A
   * malformed sequence must not throw — decodeURIComponent raises URIError on a
   * stray '%', and an exception here would turn a bad header into a 500.
   */
  let signature: string;
  try {
    signature = decodeURIComponent(sRaw);
  } catch {
    signature = sRaw;
  }

  return { ts, signature, algorithm };
}

/**
 * Is this notification genuinely from ZeptoMail?
 *
 * `rawBody` must be the bytes as received.
 */
export function verifyWebhook(
  rawBody: Buffer | string,
  header: string | undefined,
  now: number = Date.now(),
): VerifyResult {
  const key = env.ZEPTOMAIL_WEBHOOK_KEY;
  /*
   * Unconfigured means REJECT, not pass.
   *
   * The Phase 1 mail client deliberately fails open when no token is set, because a
   * missing provider must not take the API down. This is the opposite situation: an
   * unverifiable write into the mail log is exactly what the key exists to prevent,
   * so with no key there is nothing to verify and the request is refused.
   */
  if (!key) return { ok: false, reason: 'NOT_CONFIGURED' };
  if (!header) return { ok: false, reason: 'MISSING_HEADER' };

  const parsed = parseSignatureHeader(header);
  if (!parsed) return { ok: false, reason: 'MALFORMED_HEADER' };

  if (Math.abs(now - parsed.ts) > MAX_AGE_MS) return { ok: false, reason: 'STALE' };

  const expected = createHmac('sha256', key).update(rawBody).digest('base64');

  const a = Buffer.from(expected);
  const b = Buffer.from(parsed.signature);
  // Length first: timingSafeEqual throws on a length mismatch, and that throw
  // would itself be an oracle.
  if (a.length !== b.length) return { ok: false, reason: 'BAD_SIGNATURE' };
  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'BAD_SIGNATURE' };
}

/** The subset of a ZeptoMail notification this system acts on. */
export interface ZeptoNotification {
  event_name?: string;
  webhook_request_id?: string;
  mailagent_key?: string;
  event_message?: unknown;
}

export type NotificationOutcome =
  | { kind: 'OPEN'; messageIds: string[] }
  | { kind: 'IGNORED'; reason: string };

/**
 * What a notification means.
 *
 * Only opens are acted on in Phase 2; bounces and clicks are acknowledged and
 * ignored rather than guessed at, so enabling one of those webhooks in the
 * ZeptoMail dashboard cannot silently start writing rows this code does not
 * understand.
 *
 * `event_message` is an array in practice but documented loosely, so both an array
 * and a bare object are accepted and the message ids are gathered from whichever
 * shape arrives. An unrecognised shape yields no ids and is ignored, never a throw:
 * the payload is attacker-influenced once it is past the signature, and a parser
 * that throws on a surprise is a denial-of-service surface.
 */
export function interpret(body: ZeptoNotification): NotificationOutcome {
  const event = (body.event_name ?? '').toLowerCase();
  if (!event.includes('open')) {
    return { kind: 'IGNORED', reason: `unhandled event ${body.event_name ?? 'none'}` };
  }

  const ids = collectMessageIds(body.event_message);
  if (ids.length === 0) return { kind: 'IGNORED', reason: 'no message id in payload' };
  return { kind: 'OPEN', messageIds: ids };
}

/**
 * Pull every `message_id` out of the nested payload.
 *
 * ZeptoMail nests it under `event_message[].email_info.message_id`, but the exact
 * depth is not contractual, so this walks the structure instead of hard-coding a
 * path — a provider adding a level cannot silently stop every open being recorded.
 * Bounded in depth and breadth so a hostile payload cannot make it run long.
 */
function collectMessageIds(node: unknown, depth = 0, found: string[] = []): string[] {
  if (depth > 6 || found.length >= 50 || node == null) return found;

  if (Array.isArray(node)) {
    for (const item of node.slice(0, 50)) collectMessageIds(item, depth + 1, found);
    return found;
  }

  if (typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'message_id' && typeof value === 'string' && value.trim()) {
        found.push(value.trim());
      } else {
        collectMessageIds(value, depth + 1, found);
      }
    }
  }

  return found;
}
