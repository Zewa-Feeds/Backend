import { describe, it, expect, vi } from 'vitest';

const init = vi.hoisted(() => vi.fn());
const capture = vi.hoisted(() => vi.fn());
vi.mock('@sentry/node', () => ({ init, captureException: capture, flush: vi.fn(async () => true) }));

describe('error monitoring', () => {
  it('does nothing without SENTRY_DSN', async () => {
    vi.resetModules();
    vi.doMock('@/config/env', () => ({ env: { SENTRY_DSN: undefined, NODE_ENV: 'test' } }));
    const m = await import('./monitoring');
    m.initMonitoring('api');
    m.captureError(new Error('x'));
    expect(init).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it('reports unexpected errors once a DSN is set, without personal data', async () => {
    vi.resetModules();
    vi.doMock('@/config/env', () => ({ env: { SENTRY_DSN: 'https://k@o1.ingest.sentry.io/1', NODE_ENV: 'production' } }));
    const m = await import('./monitoring');
    m.initMonitoring('api');
    m.captureError(new Error('boom'), { path: '/x' });
    expect(init).toHaveBeenCalledWith(expect.objectContaining({ sendDefaultPii: false }));
    expect(capture).toHaveBeenCalledTimes(1);
  });
});
