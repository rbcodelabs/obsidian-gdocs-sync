import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestUrl } from 'obsidian';
import { TokenStore } from '../../src/auth/TokenStore';

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

function deferredResponse() {
  let resolve!: (value: never) => void;
  const promise = new Promise<never>(done => { resolve = done; });
  return { promise, resolve };
}

const refreshed = { status: 200, json: { access_token: 'refreshed', expires_in: 3600 }, text: '' };

describe('TokenStore refresh', () => {
  const requestUrlMock = vi.mocked(requestUrl);
  beforeEach(() => requestUrlMock.mockReset());

  it('times out a hung refresh and permits retry without accepting the late response', async () => {
    vi.useFakeTimers();
    try {
      const oldResponse = deferredResponse();
      requestUrlMock.mockReturnValueOnce(oldResponse.promise).mockResolvedValueOnce(refreshed as never);
      const { store } = makeStore();
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

  it('advertises connection-safe refresh support', () => {
    expect(makeStore().store).toHaveProperty('supportsConnectionGuard', true);
  });

  it('coalesces concurrent refreshes for the same connection', async () => {
    const response = deferredResponse();
    requestUrlMock.mockReturnValue(response.promise);
    const { store } = makeStore();
    const first = store.getValidAccessToken();
    const second = store.getValidAccessToken();
    expect(requestUrlMock).toHaveBeenCalledTimes(1);
    response.resolve(refreshed as never);
    await expect(Promise.all([first, second])).resolves.toEqual(['refreshed', 'refreshed']);
  });

  it.each([200, 400])('rejects a stale %s response without changing a reconnected account', async status => {
    const response = deferredResponse();
    requestUrlMock.mockReturnValue(response.promise);
    const { store, plugin } = makeStore();
    const pending = store.getValidAccessToken();
    const rejection = expect(pending).rejects.toThrow(/connection changed/i);
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
    const { store, plugin } = makeStore();
    const original = store.get();
    const pending = store.getValidAccessToken();
    const rejection = expect(pending).rejects.toThrow(/connection changed/i);
    plugin.settings.authProxyUrl = 'https://other-auth.example';
    response.resolve((status === 200 ? refreshed : { status, json: { error: 'invalid_grant' }, text: '' }) as never);
    await rejection;
    expect(store.get()).toBe(original);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it('does not return the previous account token if reconnect happens during persistence', async () => {
    requestUrlMock.mockResolvedValue(refreshed as never);
    const { store, plugin } = makeStore();
    plugin.saveSettings.mockImplementationOnce(async () => {
      await store.set({ accessToken: 'other-account', refreshToken: 'other-refresh', expiresAt: 3600_000 });
    });
    await expect(store.getValidAccessToken()).rejects.toThrow(/connection changed/i);
    expect(store.get()?.accessToken).toBe('other-account');
  });

  it('releases the shared refresh after a network error so another attempt can succeed', async () => {
    requestUrlMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(refreshed as never);
    const { store } = makeStore();
    await expect(store.getValidAccessToken()).rejects.toThrow('offline');
    await expect(store.getValidAccessToken()).resolves.toBe('refreshed');
    expect(requestUrlMock).toHaveBeenCalledTimes(2);
  });

  it('does not join a previous connection refresh after reconnecting', async () => {
    const oldResponse = deferredResponse();
    const newResponse = deferredResponse();
    requestUrlMock.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(newResponse.promise);
    const { store } = makeStore();
    const oldPending = store.getValidAccessToken();
    const oldRejection = expect(oldPending).rejects.toThrow(/connection changed/i);
    await store.set({ accessToken: 'other', refreshToken: 'other-refresh', expiresAt: 0 });
    const newPending = store.getValidAccessToken();
    expect(requestUrlMock).toHaveBeenCalledTimes(2);
    oldResponse.resolve({ status: 400, json: { error: 'invalid_grant' }, text: '' } as never);
    await oldRejection;
    const concurrent = store.getValidAccessToken();
    expect(requestUrlMock).toHaveBeenCalledTimes(2);
    newResponse.resolve(refreshed as never);
    await expect(Promise.all([newPending, concurrent])).resolves.toEqual(['refreshed', 'refreshed']);
  });

  it('does not restore a disconnected account when refresh completes', async () => {
    const response = deferredResponse();
    requestUrlMock.mockReturnValue(response.promise);
    const { store } = makeStore();
    const pending = store.getValidAccessToken();
    const rejection = expect(pending).rejects.toThrow(/connection changed/i);
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
