import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestUrl } from 'obsidian';
import { buildConnectUrl, GoogleAuth, isGeodeHost } from '../../src/auth/GoogleAuth';

describe('GoogleAuth host callback selection', () => {
  it('requests the Geode callback only for the explicit Geode host marker', () => {
    const host = { name: 'geode', protocolScheme: 'geode' };
    expect(isGeodeHost(host)).toBe(true);
    expect(buildConnectUrl('https://auth.example', 'state value', host)).toBe(
      'https://auth.example/api/auth/start?state=state%20value&callback_app=geode',
    );
  });

  it('retains the Obsidian flow without the explicit marker', () => {
    expect(isGeodeHost(undefined)).toBe(false);
    expect(buildConnectUrl('https://auth.example', 'state value', undefined)).toBe(
      'https://auth.example/api/auth/start?state=state%20value',
    );
  });
});

describe('GoogleAuth account lookup', () => {
  const requestUrlMock = vi.mocked(requestUrl);
  beforeEach(() => requestUrlMock.mockReset());

  it('fetches the connected email through requestUrl', async () => {
    requestUrlMock.mockResolvedValue({ status: 200, json: { email: 'person@example.com' }, text: '' } as never);
    const plugin = { settings: { connectedEmail: '' }, saveSettings: vi.fn().mockResolvedValue(undefined) };
    const tokenStore = { set: vi.fn().mockResolvedValue(undefined), get: vi.fn().mockReturnValue({}) };
    const auth = new GoogleAuth(plugin as never, tokenStore as never);
    (auth as unknown as { pendingState: string }).pendingState = 'expected';

    await auth.handleCallback({
      event: 'auth_complete', state: 'expected', access_token: 'token', refresh_token: 'refresh', expires_in: '3600',
    });

    expect(requestUrlMock).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://www.googleapis.com/oauth2/v3/userinfo',
      headers: { Authorization: 'Bearer token' },
      throw: false,
    }));
    expect(plugin.settings.connectedEmail).toBe('person@example.com');
  });
});
