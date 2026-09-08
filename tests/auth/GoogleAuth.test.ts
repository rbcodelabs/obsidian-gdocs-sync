import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestUrl } from 'obsidian';
import { buildConnectUrl, GoogleAuth, isGeodeHost } from '../../src/auth/GoogleAuth';

describe('GoogleAuth host callback selection', () => {
  it('allows isolated sign-in navigation while retaining original callback state validation', async () => {
    const plugin = { settings: { authProxyUrl: 'https://auth.example', connectedEmail: '' }, saveSettings: vi.fn(async () => {}) };
    const tokens = { set: vi.fn(async () => {}), get: vi.fn(() => ({})) }; const open = vi.fn(async () => {});
    const auth = new GoogleAuth(plugin as never, tokens as never, open);
    await auth.connect();
    const state = new URL(open.mock.calls[0][0]).searchParams.get('state')!;
    await auth.handleCallback({ event: 'auth_complete', state: 'wrong', access_token: 'synthetic', refresh_token: 'synthetic' });
    expect(tokens.set).not.toHaveBeenCalled();
    vi.mocked(requestUrl).mockResolvedValue({ status: 200, json: {} } as never);
    await auth.handleCallback({ event: 'auth_complete', state, access_token: 'synthetic', refresh_token: 'synthetic' });
    expect(tokens.set).toHaveBeenCalledOnce();
  });
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
  it('orders disconnect after an in-flight legacy settings save so old credentials cannot resurrect', async () => {
    let release!: () => void; let arrived!: () => void; let persisted: any;
    const gate = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { arrived = resolve; });
    const plugin = { settings: { connectedEmail: '', tokens: null as unknown }, saveSettings: vi.fn(async () => {}) };
    plugin.saveSettings.mockImplementation(async () => { const captured = structuredClone(plugin.settings); if (plugin.saveSettings.mock.calls.length === 1) { arrived(); await gate; } persisted = captured; });
    const tokens = { set: vi.fn(async value => { plugin.settings.tokens = value; }), clear: vi.fn(async () => { plugin.settings.tokens = null; }), get: vi.fn(() => ({})) };
    const auth = new GoogleAuth(plugin as never, tokens as never); (auth as unknown as { pendingState: string }).pendingState = 'expected';
    requestUrlMock.mockResolvedValue({ status: 200, json: { email: 'synthetic@example.test' } } as never);
    const callback = auth.handleCallback({ event: 'auth_complete', state: 'expected', access_token: 'synthetic', refresh_token: 'synthetic' });
    await started; const disconnect = auth.disconnect(); await new Promise(resolve => setTimeout(resolve, 0)); release(); await Promise.all([callback, disconnect]);
    expect(persisted.tokens).toBeNull(); expect(persisted.connectedEmail).toBe('');
  });
  it('invalidates pending authorization on disconnect before a late callback can reconnect', async () => {
    const plugin = { settings: { connectedEmail: '' }, saveSettings: vi.fn(async () => {}) };
    const tokens = { set: vi.fn(async () => {}), clear: vi.fn(async () => {}), get: vi.fn(() => ({})) };
    const auth = new GoogleAuth(plugin as never, tokens as never); (auth as unknown as { pendingState: string }).pendingState = 'expected';
    await auth.disconnect();
    await auth.handleCallback({ event: 'auth_complete', state: 'expected', access_token: 'synthetic', refresh_token: 'synthetic' });
    expect(tokens.set).not.toHaveBeenCalled(); expect(requestUrlMock).not.toHaveBeenCalled();
  });
  it('does not restore account display or connected callbacks after disconnect during user lookup', async () => {
    let release!: (value: unknown) => void; let arrived!: () => void;
    const lookup = new Promise<unknown>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { arrived = resolve; });
    requestUrlMock.mockImplementation(async () => { arrived(); return await lookup as never; });
    const plugin = { settings: { connectedEmail: '' }, saveSettings: vi.fn(async () => {}) };
    const tokens = { set: vi.fn(async () => {}), clear: vi.fn(async () => {}), get: vi.fn(() => ({})) };
    const auth = new GoogleAuth(plugin as never, tokens as never); const connected = vi.fn(); auth.onConnected = connected;
    (auth as unknown as { pendingState: string }).pendingState = 'expected';
    const callback = auth.handleCallback({ event: 'auth_complete', state: 'expected', access_token: 'synthetic', refresh_token: 'synthetic' });
    await started; await auth.disconnect(); release({ status: 200, json: { email: 'synthetic@example.test' } }); await callback;
    expect(plugin.settings.connectedEmail).toBe(''); expect(connected).not.toHaveBeenCalled(); expect(plugin.saveSettings).toHaveBeenCalledOnce();
  });
  it('claims one callback only once before asynchronous credential persistence', async () => {
    let release!: () => void; const save = new Promise<void>(resolve => { release = resolve; });
    const plugin = { settings: { connectedEmail: '' }, saveSettings: vi.fn(async () => {}) };
    const tokens = { set: vi.fn(async () => save), clear: vi.fn(async () => {}), get: vi.fn(() => ({})) };
    const auth = new GoogleAuth(plugin as never, tokens as never); (auth as unknown as { pendingState: string }).pendingState = 'expected';
    requestUrlMock.mockResolvedValue({ status: 200, json: {} } as never);
    const params = { event: 'auth_complete', state: 'expected', access_token: 'synthetic', refresh_token: 'synthetic' };
    const first = auth.handleCallback(params); const second = auth.handleCallback(params); release(); await Promise.all([first, second]);
    expect(tokens.set).toHaveBeenCalledOnce();
  });

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
