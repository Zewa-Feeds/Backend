/**
 * ZeptoMail client — configuration detection.
 *
 * These exist because of a production incident, not for coverage. `render.yaml`
 * seeds ZEPTOMAIL_TOKEN with the literal string "placeholder-not-configured" so
 * a fresh deploy boots. The client's skip test was `!env.ZEPTOMAIL_TOKEN`, which
 * a non-empty placeholder passes, so every send went out as
 * `Zoho-enczapikey placeholder-not-configured` and came back 401 SERR_157
 * "Invalid API Token found".
 *
 * The cost was CMS login OTP: nobody could sign in, and the log blamed the key
 * rather than the unreplaced default. What is pinned here is that an
 * unconfigured provider SKIPS instead of calling ZeptoMail, and that a real key
 * still sends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const envState: Record<string, string | undefined> = {};

vi.mock('@/config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/env')>();
  return {
    ...actual,
    env: new Proxy(
      {},
      {
        get: (_t, key: string) =>
          key in envState ? envState[key] : (actual.env as Record<string, unknown>)[key],
      },
    ),
  };
});


/*
 * Imported lazily, not at the top.
 *
 * The client pulls in the logger, which reads `env` as soon as the module is
 * evaluated — a static import therefore runs before `envState` is initialised
 * and dies with "Cannot access 'envState' before initialization". A top-level
 * `await import` fixes that but breaks `tsc`, because this project compiles as
 * CommonJS (TS1378). Loading it in `beforeEach` satisfies both.
 */
type Client = typeof import('./zeptomail.client');
let sendEmail: Client['sendEmail'];

const INPUT = {
  to: [{ email: 'admin@zewafeeds.com' }],
  subject: 'Your CMS login code',
  htmlBody: '<p>123456</p>',
  reference: 'cms-otp-test',
};

beforeEach(async () => {
  for (const k of Object.keys(envState)) delete envState[k];
  envState.ZEPTOMAIL_FROM = 'orders@zewafeeds.com';
  vi.restoreAllMocks();
  ({ sendEmail } = await import('./zeptomail.client'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('an unconfigured ZeptoMail skips instead of calling the API', () => {
  /*
   * The regression itself. A placeholder must never reach ZeptoMail — that is
   * the exact call that produced the 401 and broke CMS login.
   */
  it('treats the render.yaml placeholder as not configured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    envState.ZEPTOMAIL_TOKEN = 'placeholder-not-configured';

    const result = await sendEmail(INPUT);

    expect(result).toEqual({ sent: false, messageId: null, skipped: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is not fooled by the placeholder carrying the auth prefix', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    envState.ZEPTOMAIL_TOKEN = 'Zoho-enczapikey placeholder-not-configured';

    const result = await sendEmail(INPUT);

    expect(result.skipped).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '   ', 'changeme'])('skips a token of %o', async (token) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    envState.ZEPTOMAIL_TOKEN = token;

    const result = await sendEmail(INPUT);

    expect(result.skipped).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips when the sender address is missing, whatever the token', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    envState.ZEPTOMAIL_TOKEN = 'PHtE6r0ERrvo2jN+oBUE5fTvEcOtNI8s9+xu2QBH';
    envState.ZEPTOMAIL_FROM = undefined;

    const result = await sendEmail(INPUT);

    expect(result.skipped).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('a real token still sends', () => {
  it('posts to ZeptoMail and normalises the auth header', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ message_id: 'msg-1' }] }), { status: 200 }),
    );
    // Deliberately the BARE key — the client adds the prefix.
    envState.ZEPTOMAIL_TOKEN = 'PHtE6r0ERrvo2jN+oBUE5fTvEcOtNI8s9+xu2QBH';

    const result = await sendEmail(INPUT);

    expect(result.sent).toBe(true);
    expect(result.messageId).toBe('msg-1');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const headers = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      'Zoho-enczapikey PHtE6r0ERrvo2jN+oBUE5fTvEcOtNI8s9+xu2QBH',
    );
  });

  it('throws on a rejection so the queue retries', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'TM_4001' } }), { status: 401 }),
    );
    envState.ZEPTOMAIL_TOKEN = 'PHtE6r0ERrvo2jN+oBUE5fTvEcOtNI8s9+xu2QBH';

    await expect(sendEmail(INPUT)).rejects.toThrow(/ZeptoMail/i);
  });
});

describe('open tracking on the send payload', () => {
  /*
   * ZeptoMail's default is off, so OMITTING the field is what keeps an untracked
   * template's payload byte-identical to before Phase 2. Sending `false`
   * explicitly would work too, but this pins the weaker change.
   */
  it('omits track_opens entirely when tracking is off', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ message_id: 'm' }] }), { status: 200 }),
    );
    envState.ZEPTOMAIL_TOKEN = 'PHtE6r0ERrvo2jN+oBUE5fTvEcOtNI8s9+xu2QBH';

    await sendEmail({ ...INPUT, trackOpens: false });

    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).not.toHaveProperty('track_opens');
  });

  it('sends track_opens true when tracking is on', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ message_id: 'm' }] }), { status: 200 }),
    );
    envState.ZEPTOMAIL_TOKEN = 'PHtE6r0ERrvo2jN+oBUE5fTvEcOtNI8s9+xu2QBH';

    await sendEmail({ ...INPUT, trackOpens: true });

    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.track_opens).toBe(true);
  });
});
