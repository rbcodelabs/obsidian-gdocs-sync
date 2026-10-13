import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform, requestUrl, noticeLog } from 'obsidian';
import { GoogleAuth } from '../../src/auth/GoogleAuth';
import { TokenStore } from '../../src/auth/TokenStore';
import { DEFAULT_SETTINGS } from '../../src/types';
import { StatusBarItem } from '../../src/ui/StatusBar';

// Simulates the Geode mobile runtime: WKWebView with no Node/Electron
// (window.require is undefined) and the Geode host marker present.
type MobileWindow = Window & { require?: unknown; geode?: unknown };
const win = () => window as unknown as MobileWindow;
const requestUrlMock = vi.mocked(requestUrl);
let openMock: ReturnType<typeof vi.fn>;
const original = { isMobile: Platform.isMobile, isMobileApp: Platform.isMobileApp, isDesktop: Platform.isDesktop };

beforeEach(() => {
  Platform.isMobile = true;
  Platform.isMobileApp = true;
  Platform.isDesktop = false;
  openMock = vi.fn();
  delete win().require;
  win().open = openMock as never;
  win().geode = { host: { name: 'geode', protocolScheme: 'geode' } };
  requestUrlMock.mockReset();
  noticeLog.length = 0;
});

afterEach(() => {
  Object.assign(Platform, original);
  delete win().geode;
});

async function makeAuth() {
  const plugin = {
    settings: { ...DEFAULT_SETTINGS, authProxyUrl: 'https://auth.example' },
    saveSettings: vi.fn(async () => {}),
    app: { workspace: { trigger: vi.fn() } },
    // Geode mobile exposes Keychain-backed secrets through the same API.
    ...secretStore(),
  };
  const tokenStore = new TokenStore(plugin as never);
  await tokenStore.initialize();
  return { plugin, tokenStore, auth: new GoogleAuth(plugin as never, tokenStore) };
}

function secretStore() {
  const secrets = new Map<string, string>();
  return {
    loadSecret: vi.fn(async (k: string) => secrets.get(k) ?? null),
    saveSecret: vi.fn(async (k: string, v: string) => { secrets.set(k, v); }),
    removeSecret: vi.fn(async (k: string) => { secrets.delete(k); }),
  };
}

describe('GoogleAuth on a mobile host (no Electron)', () => {
  it('opens the Geode-callback sign-in URL via window.open without throwing', async () => {
    const { auth } = await makeAuth();
    void auth.requestConnection().catch(() => undefined);
    expect(openMock).toHaveBeenCalledTimes(1);
    const [url, target] = openMock.mock.calls[0];
    expect(target).toBe('_blank');
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://auth.example/api/auth/start');
    expect(parsed.searchParams.get('callback_app')).toBe('geode');
    expect(parsed.searchParams.get('state')).toBeTruthy();
  });

  it('completes the connect flow from the geode:// protocol-handler callback', async () => {
    const { auth, tokenStore, plugin } = await makeAuth();
    const connect = auth.requestConnection();
    const state = new URL(openMock.mock.calls[0][0]).searchParams.get('state')!;

    requestUrlMock.mockResolvedValue({ status: 200, json: { email: 'me@example.com' } } as never);
    await auth.handleCallback({ event: 'auth_complete', state, access_token: 'at', refresh_token: 'rt', expires_in: '3600' });

    await expect(connect).resolves.toEqual({ email: 'me@example.com' });
    expect(auth.isConnected()).toBe(true);
    expect(tokenStore.hasSecureStorage()).toBe(true);
    // Tokens live in the secure store, not in data.json
    expect(plugin.saveSecret).toHaveBeenCalled();
    expect(plugin.settings.tokens).toBeFalsy();
  });

  it('rejects a callback whose state does not match', async () => {
    const { auth } = await makeAuth();
    const connect = auth.requestConnection();
    connect.catch(() => undefined);
    await auth.handleCallback({ event: 'auth_complete', state: 'forged', access_token: 'at', refresh_token: 'rt' });
    await expect(connect).rejects.toThrow(/state mismatch/i);
    expect(auth.isConnected()).toBe(false);
  });

  it('fails the pending connection with a notice when no browser can be opened', async () => {
    delete (window as unknown as { open?: unknown }).open;
    const { auth } = await makeAuth();
    await expect(auth.requestConnection()).rejects.toThrow(/Could not open the browser/);
    expect(noticeLog.some(m => m.includes('Could not open the browser'))).toBe(true);
  });
});

describe('TokenStore without secure storage on mobile', () => {
  it('degrades as on desktop: no secure storage reported, Docs/Tasks tokens still usable', async () => {
    const plugin = {
      settings: { ...DEFAULT_SETTINGS },
      saveSettings: vi.fn(async () => {}),
      app: { workspace: { trigger: vi.fn() } },
    };
    const store = new TokenStore(plugin as never);
    await store.initialize();
    expect(store.hasSecureStorage()).toBe(false);
  });
});

describe('StatusBarItem on hosts without a status bar', () => {
  it('does not crash when addStatusBarItem is unavailable', () => {
    const item = new StatusBarItem({} as never);
    expect(() => { item.setSyncing('note'); item.setSynced(); item.setError('x'); item.setReauthNeeded(); item.setIdle(); }).not.toThrow();
  });
});
