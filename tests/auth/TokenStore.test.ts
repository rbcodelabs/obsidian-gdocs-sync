import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestUrl } from 'obsidian';
import { TokenStore } from '../../src/auth/TokenStore';
import type { GDocsPluginSettings, GDocsTokens } from '../../src/types';

async function makeStore(error: string | null = null) {
  const plugin = {
    settings: {
      authProxyUrl: 'https://auth.example',
      tokens: { accessToken: 'old', refreshToken: 'refresh', expiresAt: 0 },
    },
    saveSettings: vi.fn().mockResolvedValue(undefined),
  };
  if (error) Object.assign(plugin.settings, { error });
  const store = new TokenStore(plugin as never);
  await store.initialize();
  return { store, plugin };
}

function deferredResponse() {
  let resolve!: (value: never) => void;
  const promise = new Promise<never>(done => { resolve = done; });
  return { promise, resolve };
}

const refreshed = { status: 200, json: { access_token: 'refreshed', expires_in: 3600 }, text: '' };

describe('TokenStore refresh', () => {
  const requestUrlMock = vi.mocked(requestUrl);
  beforeEach(() => { requestUrlMock.mockReset(); });
  it('does not restore tokens when an old refresh completes after disconnect', async () => {
    let complete!: (value: never) => void;
    requestUrlMock.mockImplementation(() => new Promise(resolve => { complete = resolve; }) as never);
    const { store, plugin } = await makeStore();
    await store.initialize();
    const refreshing = store.getValidAccessToken();
    await vi.waitFor(() => expect(requestUrlMock).toHaveBeenCalledOnce());
    await store.clear();
    complete({ status: 200, json: { access_token: 'stale', expires_in: 3600 } } as never);
    await expect(refreshing).rejects.toThrow(/account changed/i);
    expect(store.get()).toBeNull();
    expect(plugin.settings.tokens).toBeNull();
  });
  it('does not overwrite a reconnected account with an old refresh result', async () => {
    let complete!: (value: never) => void;
    requestUrlMock.mockImplementation(() => new Promise(resolve => { complete = resolve; }) as never);
    const { store, plugin } = await makeStore();
    await store.initialize();
    const refreshing = store.getValidAccessToken();
    await vi.waitFor(() => expect(requestUrlMock).toHaveBeenCalledOnce());
    const newAccount = { accessToken: 'new-account', refreshToken: 'new-refresh', expiresAt: Date.now() + 3600_000 };
    await store.set(newAccount);
    complete({ status: 200, json: { access_token: 'stale', expires_in: 3600 } } as never);
    await expect(refreshing).rejects.toThrow(/account changed/i);
    expect(store.get()).toEqual(newAccount);
    expect(plugin.settings.tokens).toEqual(newAccount);
  });
  it('shares one refresh request across simultaneous API callers', async () => {
    requestUrlMock.mockResolvedValue({ status: 200, json: { access_token: 'new', expires_in: 3600 } } as never);
    const { store } = await makeStore(); await store.initialize();
    await expect(Promise.all([store.getValidAccessToken(), store.getValidAccessToken()])).resolves.toEqual(['new', 'new']);
    expect(requestUrlMock).toHaveBeenCalledOnce();
  });

  it('times out a hung refresh and permits retry without accepting the late response', async () => {
    vi.useFakeTimers();
    try {
      const oldResponse = deferredResponse();
      requestUrlMock.mockReturnValueOnce(oldResponse.promise).mockResolvedValueOnce(refreshed as never);
      const { store } = await makeStore();
      const pending = store.getValidAccessToken();
      const rejection = expect(pending).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
      await expect(store.getValidAccessToken()).resolves.toBe('refreshed');
      oldResponse.resolve({ status: 400, json: { error: 'invalid_grant' }, text: '' } as never);
      await Promise.resolve();
      expect(store.get()?.accessToken).toBe('refreshed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('advertises connection-safe refresh support', async () => {
    expect((await makeStore()).store).toHaveProperty('supportsConnectionGuard', true);
  });

  it('coalesces concurrent refreshes for the same connection', async () => {
    const response = deferredResponse();
    requestUrlMock.mockReturnValue(response.promise);
    const { store } = await makeStore();
    const first = store.getValidAccessToken();
    const second = store.getValidAccessToken();
    await vi.waitFor(() => expect(requestUrlMock).toHaveBeenCalledTimes(1));
    response.resolve(refreshed as never);
    await expect(Promise.all([first, second])).resolves.toEqual(['refreshed', 'refreshed']);
  });

  it.each([200, 400])('rejects a stale %s response without changing a reconnected account', async status => {
    const response = deferredResponse();
    requestUrlMock.mockReturnValue(response.promise);
    const { store, plugin } = await makeStore();
    const pending = store.getValidAccessToken();
    const rejection = expect(pending).rejects.toThrow(/(?:account|connection) changed/i);
    await vi.waitFor(() => expect(requestUrlMock).toHaveBeenCalledOnce());
    const replacement = { accessToken: 'other-account', refreshToken: 'other-refresh', expiresAt: Date.now() + 3600_000 };
    await store.set(replacement);
    plugin.saveSettings.mockClear();
    response.resolve((status === 200 ? refreshed : { status, json: { error: 'invalid_grant' }, text: '' }) as never);
    await rejection;
    expect(store.get()).toBe(replacement);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it.each([200, 400])('rejects a %s refresh after the proxy changes', async status => {
    const response = deferredResponse();
    requestUrlMock.mockReturnValue(response.promise);
    const { store, plugin } = await makeStore();
    const original = store.get();
    const pending = store.getValidAccessToken();
    const rejection = expect(pending).rejects.toThrow(/(?:account|connection) changed/i);
    await vi.waitFor(() => expect(requestUrlMock).toHaveBeenCalledOnce());
    plugin.settings.authProxyUrl = 'https://other-auth.example';
    response.resolve((status === 200 ? refreshed : { status, json: { error: 'invalid_grant' }, text: '' }) as never);
    await rejection;
    expect(store.get()).toBe(original);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it('does not return the previous account token if reconnect happens during persistence', async () => {
    requestUrlMock.mockResolvedValue(refreshed as never);
    const { store, plugin } = await makeStore();
    let reconnect!: Promise<void>;
    plugin.saveSettings.mockImplementationOnce(async () => {
      reconnect = store.set({ accessToken: 'other-account', refreshToken: 'other-refresh', expiresAt: 3600_000 });
    });
    await expect(store.getValidAccessToken()).rejects.toThrow(/(?:account|connection) changed/i);
    await reconnect;
    expect(store.get()?.accessToken).toBe('other-account');
  });

  it('releases the shared refresh after a network error so another attempt can succeed', async () => {
    requestUrlMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(refreshed as never);
    const { store } = await makeStore();
    await expect(store.getValidAccessToken()).rejects.toThrow('offline');
    await expect(store.getValidAccessToken()).resolves.toBe('refreshed');
    await vi.waitFor(() => expect(requestUrlMock).toHaveBeenCalledTimes(2));
  });

  it('does not join a previous connection refresh after reconnecting', async () => {
    const oldResponse = deferredResponse();
    const newResponse = deferredResponse();
    requestUrlMock.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(newResponse.promise);
    const { store } = await makeStore();
    const oldPending = store.getValidAccessToken();
    const oldRejection = expect(oldPending).rejects.toThrow(/(?:account|connection) changed/i);
    await vi.waitFor(() => expect(requestUrlMock).toHaveBeenCalledOnce());
    await store.set({ accessToken: 'other', refreshToken: 'other-refresh', expiresAt: 0 });
    const newPending = store.getValidAccessToken();
    await vi.waitFor(() => expect(requestUrlMock).toHaveBeenCalledTimes(2));
    oldResponse.resolve({ status: 400, json: { error: 'invalid_grant' }, text: '' } as never);
    await oldRejection;
    const concurrent = store.getValidAccessToken();
    await vi.waitFor(() => expect(requestUrlMock).toHaveBeenCalledTimes(2));
    newResponse.resolve(refreshed as never);
    await expect(Promise.all([newPending, concurrent])).resolves.toEqual(['refreshed', 'refreshed']);
  });

  it('does not restore a disconnected account when refresh completes', async () => {
    const response = deferredResponse();
    requestUrlMock.mockReturnValue(response.promise);
    const { store } = await makeStore();
    const pending = store.getValidAccessToken();
    const rejection = expect(pending).rejects.toThrow(/(?:account|connection) changed/i);
    await vi.waitFor(() => expect(requestUrlMock).toHaveBeenCalledOnce());
    await store.clear();
    response.resolve(refreshed as never);
    await rejection;
    expect(store.get()).toBeNull();
  });

  it('refreshes through requestUrl and stores rotated tokens', async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: { access_token: 'new', refresh_token: 'rotated', expires_in: 3600 },
      text: '',
    } as never);
    const { store, plugin } = await makeStore();
    await store.initialize();

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
    const { store, plugin } = await makeStore();
    await store.initialize();

    await expect(store.getValidAccessToken()).rejects.toThrow(/revoked.*reconnect/i);
    expect(plugin.settings.tokens).toBeNull();
  });

  it('falls back to the HTTP status for a non-JSON refresh failure', async () => {
    requestUrlMock.mockResolvedValue({ status: 502, json: undefined, text: 'bad gateway' } as never);
    const { store } = await makeStore();
    await store.initialize();
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
  it('keeps legacy credentials usable when native storage reads fail without downgrading fresh writes', async () => {
    const p = plugin({
      loadSecret: vi.fn(async () => { throw new Error('keychain locked'); }),
      saveSecret: vi.fn(async () => { throw new Error('keychain locked'); }),
    });
    p.settings.tokens = { ...tokens, expiresAt: Date.now() + 3600_000 };
    const legacy = p.settings.tokens;
    const store = new TokenStore(p as never);
    await expect(store.initialize()).rejects.toThrow('keychain locked');
    expect(store.get()).toEqual(legacy);
    await expect(store.getValidAccessToken()).resolves.toBe('access');
    expect(store.hasSecureStorage()).toBe(false);
    await expect(store.set({ ...legacy, accessToken: 'new' })).rejects.toThrow('keychain locked');
    expect(p.settings.tokens).toEqual(legacy);
    expect(p.saveSettings).not.toHaveBeenCalled();
  });

  it('clears both copies after migration cleanup fails so restart cannot restore disconnected credentials', async () => {
    let secret: string | null = null;
    let persisted: GDocsTokens | null = tokens;
    const p = plugin({
      loadSecret: vi.fn(async () => secret),
      saveSecret: vi.fn(async (_key: string, value: string) => { secret = value; }),
      removeSecret: vi.fn(async () => { secret = null; }),
    });
    p.settings.tokens = tokens;
    p.saveSettings.mockRejectedValueOnce(new Error('disk full'));
    p.saveSettings.mockImplementation(async () => { persisted = p.settings.tokens; });
    const store = new TokenStore(p as never);
    await expect(store.initialize()).rejects.toThrow('disk full');
    expect(store.hasSecureStorage()).toBe(false);
    await store.clear();
    expect(persisted).toBeNull();
    expect(secret).toBeNull();
    p.settings.tokens = persisted;
    const restarted = new TokenStore(p as never);
    await restarted.initialize();
    expect(restarted.get()).toBeNull();
  });

  it('removes leftover legacy credentials on reconnect after failed migration', async () => {
    let secret: string | null = null;
    const p = plugin({
      loadSecret: vi.fn(async () => secret),
      saveSecret: vi.fn(async (_key: string, value: string) => { secret = value; }),
      removeSecret: vi.fn(async () => { secret = null; }),
    });
    p.settings.tokens = tokens;
    p.saveSettings.mockRejectedValueOnce(new Error('disk full'));
    const store = new TokenStore(p as never);
    await expect(store.initialize()).rejects.toThrow('disk full');
    const reconnected = { ...tokens, accessToken: 'reconnected' };
    await store.set(reconnected);
    expect(p.settings.tokens).toBeNull();
    const restarted = new TokenStore(p as never);
    await restarted.initialize();
    expect(restarted.get()).toEqual(reconnected);
  });

  it('reports disconnect persistence failure and retains legacy state for a retry', async () => {
    const p = plugin();
    p.settings.tokens = tokens;
    p.saveSettings.mockRejectedValue(new Error('disk full'));
    const store = new TokenStore(p as never);
    await expect(store.initialize()).rejects.toThrow('disk full');
    await expect(store.clear()).rejects.toThrow('disk full');
    expect(p.settings.tokens).toEqual(tokens);
    expect(store.get()).toEqual(tokens);
    p.saveSettings.mockResolvedValue(undefined);
    await store.clear();
    expect(p.settings.tokens).toBeNull();
    expect(store.get()).toBeNull();
  });

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
