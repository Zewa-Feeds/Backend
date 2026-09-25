/**
 * ZeptoMail webhook signature verification.
 *
 * This is the entire authentication on `/api/v1/webhooks/zeptomail`. If it can be
 * fooled, anyone can mark any email opened, and the tracking data becomes worse
 * than useless because it still reads as evidence.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

const KEY = 'zepto-webhook-key-for-tests';

vi.mock('@/config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/env')>();
  return { ...actual, env: { ...actual.env, ZEPTOMAIL_WEBHOOK_KEY: KEY } };
});

/*
 * Loaded lazily, not with a top-level `await import`: this project compiles as
 * CommonJS, where top-level await is a tsc error (TS1378). A static import would
 * evaluate the module before the env mock is in place.
 */
type Mod = typeof import('./webhook');
let interpret: Mod['interpret'];
let parseSignatureHeader: Mod['parseSignatureHeader'];
let verifyWebhook: Mod['verifyWebhook'];

beforeAll(async () => {
  ({ interpret, parseSignatureHeader, verifyWebhook } = await import('./webhook'));
});

const NOW = 1_700_000_000_000;

/** A header ZeptoMail would actually send: base64 HMAC, percent-encoded. */
function signed(body: string, ts = NOW, key = KEY): string {
  const mac = createHmac('sha256', key).update(body).digest('base64');
  return `ts=${ts};s=${encodeURIComponent(mac)};s-algorithm=HmacSHA256`;
}

const BODY = JSON.stringify({
  event_name: 'email_open',
  webhook_request_id: 'req-1',
  event_message: [{ email_info: { message_id: 'msg-abc' } }],
});

describe('parsing the producer-signature header', () => {
  it('reads ts, s and the algorithm regardless of order', () => {
    const p = parseSignatureHeader('s-algorithm=HmacSHA256;s=abc%3D;ts=123');
    expect(p).toEqual({ ts: 123, signature: 'abc=', algorithm: 'HmacSHA256' });
  });

  /*
   * The trap. A base64 signature ends in '=' padding, which arrives as %3D. Both
   * splitting on every '=' and forgetting to decode would corrupt it, and either
   * mistake rejects every genuine notification.
   */
  it('decodes the percent-encoded padding rather than truncating at the first =', () => {
    const p = parseSignatureHeader(`ts=${NOW};s=YWJjZGVm%3D%3D;s-algorithm=HmacSHA256`);
    expect(p?.signature).toBe('YWJjZGVm==');
  });

  it('returns null on a missing or malformed header', () => {
    expect(parseSignatureHeader(undefined)).toBeNull();
    expect(parseSignatureHeader('garbage')).toBeNull();
    expect(parseSignatureHeader('ts=notanumber;s=x')).toBeNull();
    expect(parseSignatureHeader(`ts=${NOW}`)).toBeNull();
  });

  /* decodeURIComponent throws URIError on a stray '%'; that must not become a 500. */
  it('survives an invalid percent-escape', () => {
    expect(() => parseSignatureHeader(`ts=${NOW};s=%E0%A4%A;s-algorithm=HmacSHA256`)).not.toThrow();
  });
});

describe('verifying a notification', () => {
  it('accepts a correctly signed body', () => {
    expect(verifyWebhook(BODY, signed(BODY), NOW)).toEqual({ ok: true });
  });

  it('accepts the raw Buffer as received, not just a string', () => {
    expect(verifyWebhook(Buffer.from(BODY), signed(BODY), NOW)).toEqual({ ok: true });
  });

  it('rejects a body altered after signing', () => {
    const header = signed(BODY);
    const tampered = BODY.replace('msg-abc', 'msg-evil');
    expect(verifyWebhook(tampered, header, NOW)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('rejects a signature made with the wrong key', () => {
    expect(verifyWebhook(BODY, signed(BODY, NOW, 'not-the-key'), NOW)).toEqual({
      ok: false,
      reason: 'BAD_SIGNATURE',
    });
  });

  it('rejects a missing header', () => {
    expect(verifyWebhook(BODY, undefined, NOW)).toEqual({ ok: false, reason: 'MISSING_HEADER' });
  });

  it('rejects a malformed header', () => {
    expect(verifyWebhook(BODY, 'ts=;s=', NOW)).toEqual({ ok: false, reason: 'MALFORMED_HEADER' });
  });

  /*
   * Replay bound. Without it a captured payload could be replayed forever to
   * inflate open counts — the timestamp is in MILLISECONDS here, unlike the
   * Cloudinary verifier's seconds.
   */
  it('rejects a notification older than the window', () => {
    const old = NOW - 3 * 60 * 60 * 1000;
    expect(verifyWebhook(BODY, signed(BODY, old), NOW)).toEqual({ ok: false, reason: 'STALE' });
  });

  it('rejects a timestamp far in the future', () => {
    const ahead = NOW + 3 * 60 * 60 * 1000;
    expect(verifyWebhook(BODY, signed(BODY, ahead), NOW)).toEqual({ ok: false, reason: 'STALE' });
  });

  it('accepts one inside the window', () => {
    expect(verifyWebhook(BODY, signed(BODY, NOW - 60_000), NOW)).toEqual({ ok: true });
  });

  /* A shorter/longer signature must not throw out of timingSafeEqual. */
  it('rejects a wrong-length signature without throwing', () => {
    const header = `ts=${NOW};s=c2hvcnQ%3D;s-algorithm=HmacSHA256`;
    expect(() => verifyWebhook(BODY, header, NOW)).not.toThrow();
    expect(verifyWebhook(BODY, header, NOW).ok).toBe(false);
  });
});

describe('with no webhook key configured', () => {
  /*
   * REJECT, not pass. The mail client fails OPEN when unconfigured so a missing
   * provider cannot take the API down; this fails CLOSED, because an unverifiable
   * notification is precisely what the key exists to prevent.
   */
  it('refuses everything', async () => {
    vi.resetModules();
    vi.doMock('@/config/env', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/config/env')>();
      return { ...actual, env: { ...actual.env, ZEPTOMAIL_WEBHOOK_KEY: undefined } };
    });
    const mod = await import('./webhook');
    expect(mod.verifyWebhook(BODY, signed(BODY), NOW)).toEqual({
      ok: false,
      reason: 'NOT_CONFIGURED',
    });
    vi.doUnmock('@/config/env');
    vi.resetModules();
  });
});

describe('interpreting a verified payload', () => {
  it('pulls the message id out of the nested payload', () => {
    expect(interpret(JSON.parse(BODY))).toEqual({ kind: 'OPEN', messageIds: ['msg-abc'] });
  });

  it('finds ids whatever depth they sit at', () => {
    const deep = { event_name: 'email_open', event_message: { a: { b: [{ message_id: 'deep-1' }] } } };
    expect(interpret(deep)).toEqual({ kind: 'OPEN', messageIds: ['deep-1'] });
  });

  /*
   * Only opens are acted on. Enabling the bounce or click webhook in the ZeptoMail
   * dashboard must not silently start writing rows this code does not understand.
   */
  it.each(['hardbounce', 'softbounce', 'email_click', 'feedback_loop'])(
    'ignores %s',
    (event) => {
      const r = interpret({ event_name: event, event_message: [{ email_info: { message_id: 'x' } }] });
      expect(r.kind).toBe('IGNORED');
    },
  );

  it('ignores an open carrying no message id', () => {
    expect(interpret({ event_name: 'email_open', event_message: [{}] }).kind).toBe('IGNORED');
  });

  /* Past the signature the payload is still attacker-influenced; never throw. */
  it('does not throw on hostile or circular input', () => {
    const circular: Record<string, unknown> = { event_name: 'email_open' };
    circular.self = circular;
    expect(() => interpret(circular)).not.toThrow();
    expect(() => interpret({ event_name: 'email_open', event_message: null })).not.toThrow();
  });
});
