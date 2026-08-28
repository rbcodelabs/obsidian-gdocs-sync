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
