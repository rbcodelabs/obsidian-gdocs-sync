import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestUrl } from 'obsidian';
import { TokenStore } from '../../src/auth/TokenStore';
import type { GDocsPluginSettings, GDocsTokens } from '../../src/types';

function makeStore(error: string | null = null) {
  const plugin = {
    settings: {
      authProxyUrl: 'https://auth.example',
      tokens: { accessToken: 'old', refreshToken: 'refresh', expiresAt: 0 },
    },
    saveSettings: vi.fn().mockResolvedValue(undefined),
  };
  if (error) Object.assign(plugin.settings, { error });
  return { store: new TokenStore(plugin as never), plugin };
}

describe('TokenStore refresh', () => {
  const requestUrlMock = vi.mocked(requestUrl);
  beforeEach(() => requestUrlMock.mockReset());

  it('refreshes through requestUrl and stores rotated tokens', async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: { access_token: 'new', refresh_token: 'rotated', expires_in: 3600 },
      text: '',
    } as never);
    const { store, plugin } = makeStore();

    await expect(store.getValidAccessToken()).resolves.toBe('new');
    expect(requestUrlMock).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://auth.example/api/auth/refresh',
      method: 'POST',
      body: JSON.stringify({ refresh_token: 'refresh' }),
      throw: false,
    }));
    expect(plugin.settings.tokens).toMatchObject({ accessToken: 'new', refreshToken: 'rotated' });
  });

  it('clears revoked tokens and preserves the reconnect error', async () => {
    requestUrlMock.mockResolvedValue({ status: 400, json: { error: 'invalid_grant' }, text: '' } as never);
    const { store, plugin } = makeStore();

    await expect(store.getValidAccessToken()).rejects.toThrow(/revoked.*reconnect/i);
    expect(plugin.settings.tokens).toBeNull();
  });

  it('falls back to the HTTP status for a non-JSON refresh failure', async () => {
    requestUrlMock.mockResolvedValue({ status: 502, json: undefined, text: 'bad gateway' } as never);
    const { store } = makeStore();
    await expect(store.getValidAccessToken()).rejects.toThrow('Token refresh failed [http_502]');
  });
});

const tokens: GDocsTokens = { accessToken: 'access', refreshToken: 'refresh', expiresAt: 42 };

function plugin(overrides: Record<string, unknown> = {}) {
  const settings = { tokens: null } as GDocsPluginSettings;
  return {
    settings,
    saveSettings: vi.fn(async () => {}),
    loadSecret: vi.fn(async () => null),
    saveSecret: vi.fn(async () => {}),
    removeSecret: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('TokenStore secure persistence', () => {
  it('preserves legacy Obsidian persistence when Geode secret storage is absent', async () => {
    const p = plugin({ loadSecret: undefined, saveSecret: undefined, removeSecret: undefined });
    p.settings.tokens = tokens;
    const store = new TokenStore(p as never);
    await store.initialize();
    expect(store.get()).toEqual(tokens);
    expect(store.hasSecureStorage()).toBe(false);
    const next = { ...tokens, accessToken: 'next' };
    await store.set(next);
    expect(p.settings.tokens).toEqual(next);
    await store.clear();
    expect(p.settings.tokens).toBeNull();
  });
  it('migrates legacy settings only after the secure write succeeds', async () => {
    const p = plugin();
    p.settings.tokens = tokens;
    const store = new TokenStore(p as never);

    await store.initialize();

    expect(p.saveSecret).toHaveBeenCalledWith('google-oauth-tokens', JSON.stringify(tokens));
    expect(p.settings.tokens).toBeNull();
    expect(p.saveSettings).toHaveBeenCalledOnce();
    expect(store.get()).toEqual(tokens);
  });

  it('leaves legacy tokens intact when secure migration fails', async () => {
    const p = plugin({ saveSecret: vi.fn(async () => { throw new Error('unavailable'); }) });
    p.settings.tokens = tokens;
    const store = new TokenStore(p as never);

    await expect(store.initialize()).rejects.toThrow('Secure secret storage is unavailable');
    expect(p.settings.tokens).toEqual(tokens);
    expect(p.saveSettings).not.toHaveBeenCalled();
  });

  it('loads, updates and clears tokens through secure storage', async () => {
    const p = plugin({ loadSecret: vi.fn(async () => JSON.stringify(tokens)) });
    const store = new TokenStore(p as never);
    await store.initialize();
    expect(store.get()).toEqual(tokens);

    const next = { ...tokens, accessToken: 'next' };
    await store.set(next);
    expect(p.saveSecret).toHaveBeenCalledWith('google-oauth-tokens', JSON.stringify(next));
    await store.clear();
    expect(p.removeSecret).toHaveBeenCalledWith('google-oauth-tokens');
    expect(store.get()).toBeNull();
  });

  it('restores legacy settings and removes the secure duplicate when data cleanup fails', async () => {
    const p = plugin({ saveSettings: vi.fn(async () => { throw new Error('disk full'); }) });
    p.settings.tokens = tokens;
    const store = new TokenStore(p as never);
    await expect(store.initialize()).rejects.toThrow('disk full');
    expect(p.settings.tokens).toEqual(tokens);
    expect(p.removeSecret).toHaveBeenCalledWith('google-oauth-tokens');
  });
});
