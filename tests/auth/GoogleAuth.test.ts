import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestUrl } from 'obsidian';
import { buildConnectUrl, GoogleAuth, isGeodeHost } from '../../src/auth/GoogleAuth';
import { TokenStore } from '../../src/auth/TokenStore';
import { DEFAULT_SETTINGS, GDocsPluginSettings, GDocsTokens } from '../../src/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeFakePlugin(settingsOverrides: Partial<GDocsPluginSettings> = {}) {
  const settings: GDocsPluginSettings = { ...DEFAULT_SETTINGS, ...settingsOverrides };
  const trigger = vi.fn();
  const plugin = {
    settings,
    saveSettings: vi.fn(async () => {}),
    app: { workspace: { trigger } },
  };
  return { plugin, trigger };
}

function validTokens(): GDocsTokens {
  return { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000 };
}

function makeAuth(settingsOverrides: Partial<GDocsPluginSettings> = {}) {
  const { plugin, trigger } = makeFakePlugin(settingsOverrides);
  const tokenStore = new TokenStore(plugin as never);
  const auth = new GoogleAuth(plugin as never, tokenStore);
  return { plugin, trigger, tokenStore, auth };
}

let openExternalMock: ReturnType<typeof vi.fn>;
const requestUrlMock = vi.mocked(requestUrl);

beforeEach(() => {
  openExternalMock = vi.fn();
  (globalThis as unknown as { window: unknown }).window =
    (globalThis as unknown as { window?: unknown }).window ?? {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).require = () => ({ shell: { openExternal: openExternalMock } });
  requestUrlMock.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── Geode host detection / URL building ────────────────────────────────────

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

  it('allows isolated sign-in navigation while retaining original callback state validation', async () => {
    const { auth } = makeAuth();

    auth.requestConnection();
    const state = new URL(openExternalMock.mock.calls[0][0]).searchParams.get('state')!;

    await auth.handleCallback({ event: 'auth_complete', state: 'wrong', access_token: 'synthetic', refresh_token: 'synthetic' });
    expect(auth.isConnected()).toBe(false);

    requestUrlMock.mockResolvedValue({ status: 200, json: {} } as never);
    await auth.handleCallback({ event: 'auth_complete', state, access_token: 'synthetic', refresh_token: 'synthetic' });
    expect(auth.isConnected()).toBe(true);
  });
});

// ─── isConnected / getConnectedEmail ────────────────────────────────────────

describe('GoogleAuth.isConnected / getConnectedEmail', () => {
  it('reflect settings.tokens and settings.connectedEmail', () => {
    const { plugin, auth } = makeAuth();
    expect(auth.isConnected()).toBe(false);
    expect(auth.getConnectedEmail()).toBeNull();

    plugin.settings.tokens = validTokens();
    plugin.settings.connectedEmail = 'user@example.com';

    expect(auth.isConnected()).toBe(true);
    expect(auth.getConnectedEmail()).toBe('user@example.com');
  });
});

// ─── requestConnection — already connected ──────────────────────────────────

describe('GoogleAuth.requestConnection — already connected', () => {
  it('resolves immediately with the current email, without opening a browser', async () => {
    const { auth } = makeAuth({ tokens: validTokens(), connectedEmail: 'user@example.com' });

    const result = await auth.requestConnection();

    expect(result).toEqual({ email: 'user@example.com' });
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it('with force: true still opens the browser instead of short-circuiting', () => {
    const { auth } = makeAuth({ tokens: validTokens(), connectedEmail: 'user@example.com' });

    const connectPromise = auth.requestConnection({ force: true });
    connectPromise.catch(() => {
      /* left pending intentionally; fake timers prevent a real leak */
    });

    expect(openExternalMock).toHaveBeenCalledTimes(1);
  });
});

// ─── requestConnection — dedup ───────────────────────────────────────────────

describe('GoogleAuth.requestConnection — dedup', () => {
  it('returns the same in-flight promise for concurrent calls and opens the browser once', () => {
    const { auth } = makeAuth();

    const p1 = auth.requestConnection();
    const p2 = auth.requestConnection();
    p1.catch(() => {
      /* left pending intentionally; fake timers prevent a real leak */
    });

    expect(p1).toBe(p2);
    expect(openExternalMock).toHaveBeenCalledTimes(1);
  });
});

// ─── requestConnection + handleCallback — success ───────────────────────────

describe('GoogleAuth successful connect flow', () => {
  it('resolves requestConnection, marks connected, and broadcasts gdocs-sync:connected', async () => {
    const { auth, trigger } = makeAuth();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('test-state' as any);
    requestUrlMock.mockResolvedValue({ status: 200, json: { email: 'user@example.com' } } as never);

    const connectPromise = auth.requestConnection();
    expect(openExternalMock).toHaveBeenCalledTimes(1);

    await auth.handleCallback({
      event: 'auth_complete',
      state: 'test-state',
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: '3600',
    });

    const result = await connectPromise;

    expect(result).toEqual({ email: 'user@example.com' });
    expect(auth.isConnected()).toBe(true);
    expect(trigger).toHaveBeenCalledWith('gdocs-sync:connected', { email: 'user@example.com' });
  });

  it('notifies onConnectionChange listeners, and stops after unsubscribe', async () => {
    const { auth } = makeAuth();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('state-1' as any);
    requestUrlMock.mockResolvedValue({ status: 200, json: { email: 'user@example.com' } } as never);

    const listener = vi.fn();
    const unsubscribe = auth.onConnectionChange(listener);

    const connectPromise = auth.requestConnection();
    await auth.handleCallback({
      event: 'auth_complete',
      state: 'state-1',
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: '3600',
    });
    await connectPromise;

    expect(listener).toHaveBeenCalledWith(true, 'user@example.com');
    listener.mockClear();

    unsubscribe();

    await auth.disconnect();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('state-2' as any);
    const connectPromise2 = auth.requestConnection();
    await auth.handleCallback({
      event: 'auth_complete',
      state: 'state-2',
      access_token: 'at2',
      refresh_token: 'rt2',
      expires_in: '3600',
    });
    await connectPromise2;

    expect(listener).not.toHaveBeenCalled();
  });
});

// ─── requestConnection + handleCallback — state mismatch ────────────────────

describe('GoogleAuth connect flow — state mismatch', () => {
  it('rejects the pending promise and leaves the account disconnected', async () => {
    const { auth } = makeAuth();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('real-state' as any);

    const connectPromise = auth.requestConnection();
    const rejection = expect(connectPromise).rejects.toThrow();

    await auth.handleCallback({
      event: 'auth_complete',
      state: 'wrong-state',
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: '3600',
    });

    await rejection;
    expect(auth.isConnected()).toBe(false);
  });
});

// ─── disconnect ──────────────────────────────────────────────────────────────

describe('GoogleAuth.disconnect', () => {
  it('clears connection state and broadcasts gdocs-sync:disconnected', async () => {
    const { auth, trigger } = makeAuth({ tokens: validTokens(), connectedEmail: 'user@example.com' });

    await auth.disconnect();

    expect(auth.isConnected()).toBe(false);
    expect(auth.getConnectedEmail()).toBeNull();
    expect(trigger).toHaveBeenCalledWith('gdocs-sync:disconnected', { email: null });
  });
});

// ─── requestConnection — timeout ─────────────────────────────────────────────

describe('GoogleAuth.requestConnection — timeout', () => {
  it('rejects after 5 minutes with no callback', async () => {
    const { auth } = makeAuth();

    const connectPromise = auth.requestConnection();
    const rejection = expect(connectPromise).rejects.toThrow(/timed out/i);

    await vi.advanceTimersByTimeAsync(300_001);

    await rejection;
    expect(auth.isConnected()).toBe(false);
  });
});

// ─── Concurrent disconnect / handleCallback ordering ────────────────────────

describe('GoogleAuth disconnect/callback races', () => {
  it('orders disconnect after an in-flight legacy settings save so old credentials cannot resurrect', async () => {
    let release!: () => void;
    let arrived!: () => void;
    let persisted: any;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { arrived = resolve; });
    const { plugin } = makeFakePlugin();
    plugin.saveSettings = vi.fn(async () => {
      const captured = structuredClone(plugin.settings);
      if ((plugin.saveSettings as ReturnType<typeof vi.fn>).mock.calls.length === 1) {
        arrived();
        await gate;
      }
      persisted = captured;
    });
    const tokens = {
      set: vi.fn(async (value: unknown) => { (plugin.settings as unknown as { tokens: unknown }).tokens = value; }),
      clear: vi.fn(async () => { (plugin.settings as unknown as { tokens: unknown }).tokens = null; }),
      get: vi.fn(() => ({})),
    };
    const auth = new GoogleAuth(plugin as never, tokens as never);
    (auth as unknown as { pendingState: string }).pendingState = 'expected';
    requestUrlMock.mockResolvedValue({ status: 200, json: { email: 'synthetic@example.test' } } as never);

    const callback = auth.handleCallback({ event: 'auth_complete', state: 'expected', access_token: 'synthetic', refresh_token: 'synthetic' });
    await started;
    const disconnect = auth.disconnect();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await Promise.all([callback, disconnect]);

    expect(persisted.tokens).toBeNull();
    expect(persisted.connectedEmail).toBe('');
  });

  it('invalidates pending authorization on disconnect before a late callback can reconnect', async () => {
    const { plugin } = makeFakePlugin();
    const tokens = { set: vi.fn(async () => {}), clear: vi.fn(async () => {}), get: vi.fn(() => ({})) };
    const auth = new GoogleAuth(plugin as never, tokens as never);
    (auth as unknown as { pendingState: string }).pendingState = 'expected';

    await auth.disconnect();
    await auth.handleCallback({ event: 'auth_complete', state: 'expected', access_token: 'synthetic', refresh_token: 'synthetic' });

    expect(tokens.set).not.toHaveBeenCalled();
    expect(requestUrlMock).not.toHaveBeenCalled();
  });

  it('does not restore account display or connected callbacks after disconnect during user lookup', async () => {
    let release!: (value: unknown) => void;
    let arrived!: () => void;
    const lookup = new Promise<unknown>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { arrived = resolve; });
    requestUrlMock.mockImplementation(async () => { arrived(); return await lookup as never; });
    const { plugin } = makeFakePlugin();
    const tokens = { set: vi.fn(async () => {}), clear: vi.fn(async () => {}), get: vi.fn(() => ({})) };
    const auth = new GoogleAuth(plugin as never, tokens as never);
    const listener = vi.fn();
    auth.onConnectionChange(listener);
    (auth as unknown as { pendingState: string }).pendingState = 'expected';

    const callback = auth.handleCallback({ event: 'auth_complete', state: 'expected', access_token: 'synthetic', refresh_token: 'synthetic' });
    await started;
    await auth.disconnect();
    release({ status: 200, json: { email: 'synthetic@example.test' } });
    await callback;

    expect(plugin.settings.connectedEmail).toBe('');
    expect(listener).not.toHaveBeenCalledWith(true, 'synthetic@example.test');
    expect(plugin.saveSettings).toHaveBeenCalledOnce();
  });

  it('claims one callback only once before asynchronous credential persistence', async () => {
    let release!: () => void;
    const save = new Promise<void>(resolve => { release = resolve; });
    const { plugin } = makeFakePlugin();
    const tokens = { set: vi.fn(async () => save), clear: vi.fn(async () => {}), get: vi.fn(() => ({})) };
    const auth = new GoogleAuth(plugin as never, tokens as never);
    (auth as unknown as { pendingState: string }).pendingState = 'expected';
    requestUrlMock.mockResolvedValue({ status: 200, json: {} } as never);

    const params = { event: 'auth_complete', state: 'expected', access_token: 'synthetic', refresh_token: 'synthetic' };
    const first = auth.handleCallback(params);
    const second = auth.handleCallback(params);
    release();
    await Promise.all([first, second]);

    expect(tokens.set).toHaveBeenCalledOnce();
  });

  it('fetches the connected email through requestUrl', async () => {
    requestUrlMock.mockResolvedValue({ status: 200, json: { email: 'person@example.com' }, text: '' } as never);
    const { plugin } = makeFakePlugin();
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
