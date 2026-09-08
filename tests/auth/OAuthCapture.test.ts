import { describe, expect, it, vi } from 'vitest';
import { installOAuthCapture } from '../live/oauth-capture.mjs';

describe('isolated OAuth response capture', () => {
  it('contains errors from a failing notification callback', async () => {
    let handler: (route: any) => Promise<void> = async () => {};
    await installOAuthCapture({ route: async (pattern, callback) => { if (pattern.includes('/api/auth/callback')) handler = callback; } }, { proxyOrigin: 'https://auth.example.test', expectedState: 'expected', onCallback: vi.fn(), onFailure: () => { throw new Error('synthetic-private-notification'); } });
    await expect(handler({ fetch: async () => { throw new Error('upstream'); }, abort: async () => {} })).resolves.toBeUndefined();
  });
  it('captures proxy redirect in memory without following or rendering a token URL', async () => {
    const uri = 'geode://gdocs-sync?event=auth_complete&state=synthetic-state&access_token=synthetic-access&refresh_token=synthetic-refresh&expires_in=3600';
    const route = { fetch: vi.fn(async () => ({ status: () => 307, headers: () => ({ location: `/auth/success?callback_uri=${encodeURIComponent(uri)}` }), dispose: vi.fn(async () => {}) })), fulfill: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
    let handler: (route: any) => Promise<void> = async () => {};
    const context = { route: vi.fn(async (pattern, callback) => { if (pattern.includes('/api/auth/callback')) handler = callback; }) };
    const onCallback = vi.fn();
    await installOAuthCapture(context, { proxyOrigin: 'https://auth.example.test', expectedState: 'synthetic-state', onCallback });
    await handler(route);
    expect(route.fetch).toHaveBeenCalledWith({ maxRedirects: 0, maxRetries: 0 });
    expect(onCallback).toHaveBeenCalledWith(expect.objectContaining({ access_token: 'synthetic-access', state: 'synthetic-state' }));
    expect(JSON.stringify(route.fulfill.mock.calls)).not.toContain('synthetic-access');
    expect(JSON.stringify(route.fulfill.mock.calls)).not.toContain('callback_uri');
  });
  it('redacts upstream errors and never delivers a mismatched OAuth state', async () => {
    let handler: (route: any) => Promise<void> = async () => {};
    const onCallback = vi.fn(); const onFailure = vi.fn();
    await installOAuthCapture({ route: async (pattern, callback) => { if (pattern.includes('/api/auth/callback')) handler = callback; } }, { proxyOrigin: 'https://auth.example.test', expectedState: 'expected', onCallback, onFailure });
    const route = { fetch: vi.fn(async () => { throw new Error('URL contains synthetic-private-token'); }), fulfill: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
    await handler(route);
    expect(onCallback).not.toHaveBeenCalled();
    expect(JSON.stringify(onFailure.mock.calls)).not.toContain('synthetic-private-token');
    expect(onFailure).toHaveBeenCalledWith('Isolated sign-in failed safely. Retry from the isolated client.');
  });
});
