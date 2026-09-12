import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { installOAuthCapture } from '../live/oauth-capture.mjs';

const origin = 'https://auth.example.test';
const completion = `${origin}/isolated-qa-auth-complete`;
const pendingPages: Array<{ close(): Promise<void> }> = [];

function fixture() {
  const cdp = Object.assign(new EventEmitter(), { send: vi.fn(async () => ({})) });
  const events = new EventEmitter();
  const page = {
    context: () => ({ newCDPSession: async () => cdp }),
    once: events.once.bind(events),
    close: vi.fn(async () => { events.emit('close'); }),
    waitForURL: vi.fn(async () => {}),
    goto: vi.fn(async () => {}),
  };
  pendingPages.push(page);
  const state = Buffer.from(JSON.stringify({ state: 'expected', callbackApp: 'geode' })).toString('base64url');
  const callback = () => cdp.emit('Fetch.requestPaused', { requestId: 'synthetic-request', request: { method: 'GET', url: `${origin}/api/auth/callback?code=synthetic-code&state=${state}` } });
  return { cdp, page, callback };
}

afterEach(async () => {
  await Promise.all(pendingPages.splice(0).map(page => page.close()));
  vi.unstubAllGlobals();
});

describe('isolated OAuth response capture', () => {
  it('contains errors from a failing notification callback', async () => {
    const { cdp, page, callback } = fixture();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('synthetic-private-upstream'); }));
    const capture = await installOAuthCapture(page, { proxyOrigin: origin, expectedState: 'expected', onCallback: vi.fn(), onFailure: () => { throw new Error('synthetic-private-notification'); } });
    callback();
    await vi.waitFor(() => expect(cdp.send).toHaveBeenCalledWith('Fetch.fulfillRequest', expect.objectContaining({ responseCode: 303 })));
    cdp.emit('Fetch.requestPaused', { requestId: 'completion', request: { method: 'GET', url: completion } });
    await expect(capture.finished).resolves.toBe(false);
  });

  it('captures proxy redirect in memory without following or rendering a token URL', async () => {
    const { cdp, page, callback } = fixture();
    const uri = 'geode://gdocs-sync?event=auth_complete&state=expected&access_token=synthetic-access&refresh_token=synthetic-refresh';
    const fetchMock = vi.fn(async () => ({ status: 307, headers: new Headers({ location: `/auth/success?callback_uri=${encodeURIComponent(uri)}` }), body: null }));
    vi.stubGlobal('fetch', fetchMock);
    const onCallback = vi.fn();
    const capture = await installOAuthCapture(page, { proxyOrigin: origin, expectedState: 'expected', onCallback });
    callback();
    await vi.waitFor(() => expect(cdp.send).toHaveBeenCalledWith('Fetch.fulfillRequest', expect.objectContaining({ responseCode: 303 })));
    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirect: 'manual', signal: expect.any(AbortSignal) }));
    expect(onCallback).toHaveBeenCalledWith(expect.objectContaining({ access_token: 'synthetic-access', state: 'expected' }));
    expect(JSON.stringify(cdp.send.mock.calls)).not.toContain('synthetic-access');
    expect(JSON.stringify(cdp.send.mock.calls)).not.toContain('callback_uri');
    cdp.emit('Fetch.requestPaused', { requestId: 'completion', request: { method: 'GET', url: completion } });
    await expect(capture.finished).resolves.toBe(true);
    expect(cdp.send).toHaveBeenCalledWith('Page.resetNavigationHistory');
  });

  it('redacts upstream errors and does not deliver failed authorization', async () => {
    const { cdp, page, callback } = fixture();
    const onCallback = vi.fn(); const onFailure = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('URL contains synthetic-private-token'); }));
    await installOAuthCapture(page, { proxyOrigin: origin, expectedState: 'expected', onCallback, onFailure });
    callback();
    await vi.waitFor(() => expect(cdp.send).toHaveBeenCalledWith('Fetch.fulfillRequest', expect.objectContaining({ responseCode: 303 })));
    expect(onCallback).not.toHaveBeenCalled();
    expect(JSON.stringify(onFailure.mock.calls)).not.toContain('synthetic-private-token');
    expect(onFailure).toHaveBeenCalledWith('Isolated sign-in failed safely. Retry from the isolated client.');
  });
});
