import { Plugin, Notice, requestUrl } from 'obsidian';
import { isSuccessStatus } from '../api/httpStatus';
import { GDocsPluginSettings, GDocsTokens } from '../types';
import { TokenStore } from './TokenStore';
import { GoogleConnectionApi, GoogleConnectionResult } from './GoogleConnectionApi';

type PluginWithSettings = Plugin & {
  settings: GDocsPluginSettings;
  saveSettings(): Promise<void>;
};

export interface GeodeHostMarker {
  name: 'geode';
  protocolScheme: 'geode';
}

export function isGeodeHost(value: unknown): value is GeodeHostMarker {
  if (!value || typeof value !== 'object') return false;
  const host = value as Partial<GeodeHostMarker>;
  return host.name === 'geode' && host.protocolScheme === 'geode';
}

export function buildConnectUrl(authProxyUrl: string, state: string, host: unknown): string {
  const callback = isGeodeHost(host) ? '&callback_app=geode' : '';
  return `${authProxyUrl}/api/auth/start?state=${encodeURIComponent(state)}${callback}`;
}

const CONNECT_TIMEOUT_MS = 300_000; // 5 minutes

interface PendingConnect {
  promise: Promise<GoogleConnectionResult>;
  resolve: (result: GoogleConnectionResult) => void;
  reject: (err: Error) => void;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

export class GoogleAuth implements GoogleConnectionApi {
  private plugin: PluginWithSettings;
  private tokenStore: TokenStore;

  // Holds the state UUID generated during requestConnection() so the
  // persistent protocol handler (registered in onload) can verify it on return.
  private pendingState: string | null = null;
  private generation = 0;
  private writes: Promise<unknown> = Promise.resolve();

  private serializeWrite<T>(write: () => Promise<T>): Promise<T> {
    const next = this.writes.then(write, write);
    this.writes = next.catch(() => undefined);
    return next;
  }

  // Tracks an in-flight requestConnection() call so concurrent callers are
  // deduped onto the same promise instead of racing separate OAuth flows.
  private pendingConnect: PendingConnect | null = null;

  private connectionListeners: Set<(connected: boolean, email: string | null) => void> = new Set();

  constructor(plugin: Plugin, tokenStore: TokenStore, private openAuthUrl: (url: string) => void | Promise<void> = url => window.require('electron').shell.openExternal(url)) {
    this.plugin = plugin as PluginWithSettings;
    this.tokenStore = tokenStore;
  }

  isConnected(): boolean {
    return this.tokenStore.get() !== null;
  }

  getConnectedEmail(): string | null {
    return this.plugin.settings.connectedEmail || null;
  }

  // Called from main.ts onload() via registerObsidianProtocolHandler.
  // Persistent for the lifetime of the plugin — always ready to receive callbacks.
  async handleCallback(params: Record<string, string>): Promise<void> {
    console.log('[GDocsAuth] handleCallback fired for event:', params['event'] ?? 'unknown');
    console.log('[GDocsAuth] pending OAuth state present:', this.pendingState !== null);

    // Obsidian overwrites "action" with the handler name — we use "event" instead.
    if (params['event'] !== 'auth_complete') {
      console.log('[GDocsAuth] Ignoring — event is not auth_complete:', params['event']);
      return;
    }

    if (!this.pendingState) {
      console.warn('[GDocsAuth] No pendingState — was connect() called first?');
      new Notice('⚠ GDocs Sync: No auth in progress. Please click Connect again.');
      this.failPending(new Error('No auth in progress. Please click Connect again.'));
      return;
    }

    if (params['state'] !== this.pendingState) {
      console.warn('[GDocsAuth] OAuth state mismatch; callback rejected.');
      new Notice('⚠ GDocs Sync: OAuth state mismatch. Auth cancelled.');
      this.failPending(new Error('OAuth state mismatch. Auth cancelled.'));
      return;
    }

    const accessToken = params['access_token'];
    const refreshToken = params['refresh_token'];
    const expiresIn = parseInt(params['expires_in'] ?? '3600', 10);

    console.log('[GDocsAuth] accessToken present:', !!accessToken);
    console.log('[GDocsAuth] refreshToken present:', !!refreshToken);
    console.log('[GDocsAuth] expiresIn:', expiresIn);

    if (!accessToken || !refreshToken) {
      console.error('[GDocsAuth] Missing tokens in callback params.');
      new Notice('⚠ GDocs Sync: Missing tokens in callback. Please try again.');
      this.failPending(new Error('Missing tokens in callback. Please try again.'));
      return;
    }

    const tokens: GDocsTokens = {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
    };
    const generation = this.generation;
    // Claim the callback before persistence so duplicate deliveries cannot race.
    this.pendingState = null;
    console.log('[GDocsAuth] Saving tokens to TokenStore...');
    await this.serializeWrite(async () => {
      if (generation !== this.generation) return;
      await this.tokenStore.set(tokens);
    });
    if (generation !== this.generation) return;
    console.log('[GDocsAuth] Tokens saved. Verifying readback:', !!this.tokenStore.get());

    // Fetch the Google account email for display in settings
    try {
      const resp = await requestUrl({
        url: 'https://www.googleapis.com/oauth2/v3/userinfo',
        headers: { Authorization: `Bearer ${accessToken}` },
        throw: false,
      });
      if (generation !== this.generation) return;
      if (isSuccessStatus(resp.status)) {
        const info = resp.json as { email?: string };
        if (info.email) {
          await this.serializeWrite(async () => {
            if (generation !== this.generation) return;
            this.plugin.settings.connectedEmail = info.email!;
            await this.plugin.saveSettings();
          });
          if (generation !== this.generation) return;
        }
      }
    } catch {
      console.warn('[GDocsAuth] Could not fetch user email (non-fatal).');
    }
    if (generation !== this.generation) return;
    new Notice('✓ Connected to Google');
    console.log('[GDocsAuth] Resolving pending connection...');
    this.resolvePending({ email: this.getConnectedEmail() });
    this.notifyConnectionChange();
    console.log('[GDocsAuth] Auth complete.');
  }

  requestConnection(options?: { force?: boolean }): Promise<GoogleConnectionResult> {
    if (this.isConnected() && !options?.force) {
      return Promise.resolve({ email: this.getConnectedEmail() });
    }

    if (this.pendingConnect) {
      return this.pendingConnect.promise;
    }

    let resolveFn!: (result: GoogleConnectionResult) => void;
    let rejectFn!: (err: Error) => void;
    const promise = new Promise<GoogleConnectionResult>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });

    const pending: PendingConnect = {
      promise,
      resolve: resolveFn,
      reject: rejectFn,
      timeoutId: null,
    };
    this.pendingConnect = pending;

    pending.timeoutId = setTimeout(() => {
      this.failPending(new Error('Google sign-in timed out after 5 minutes. Please try again.'));
    }, CONNECT_TIMEOUT_MS);

    const generation = ++this.generation;
    this.pendingState = crypto.randomUUID();
    console.log('[GDocsAuth] requestConnection() called. pendingState set to:', this.pendingState);
    console.log('[GDocsAuth] authProxyUrl:', this.plugin.settings.authProxyUrl);

    const geodeHost = (window as unknown as { geode?: { host?: unknown } }).geode?.host;
    const authUrl = buildConnectUrl(this.plugin.settings.authProxyUrl, this.pendingState, geodeHost);
    // Use Electron's shell.openExternal so the URL opens in the user's default
    // browser with their normal profile — window.open() hands off to Chrome
    // without profile context, which causes it to open incognito. Fired
    // without awaiting so requestConnection() keeps returning the same
    // `pending.promise` reference synchronously for concurrent dedup callers.
    Promise.resolve(this.openAuthUrl(authUrl)).then(() => {
      if (generation !== this.generation) return;
      new Notice('Opening Google sign-in... Return here after authorizing.');
    });

    return pending.promise;
  }

  async disconnect(): Promise<void> {
    const generation = ++this.generation;
    this.pendingState = null;
    // Finish any older settings snapshot before clearing both credential copies.
    // New callbacks queue behind this clear, even if another connect has begun.
    await this.serializeWrite(async () => {
      await this.tokenStore.clear();
      if (generation !== this.generation) return;
      this.plugin.settings.connectedEmail = '';
      await this.plugin.saveSettings();
    });
    if (generation !== this.generation) return;
    new Notice('Disconnected from Google.');
    this.notifyConnectionChange();
  }

  onConnectionChange(callback: (connected: boolean, email: string | null) => void): () => void {
    this.connectionListeners.add(callback);
    return () => {
      this.connectionListeners.delete(callback);
    };
  }

  private resolvePending(result: GoogleConnectionResult): void {
    const pending = this.pendingConnect;
    if (!pending) return;
    if (pending.timeoutId !== null) {
      clearTimeout(pending.timeoutId);
    }
    this.pendingConnect = null;
    pending.resolve(result);
  }

  private failPending(err: Error): void {
    this.pendingState = null;
    const pending = this.pendingConnect;
    if (!pending) return;
    if (pending.timeoutId !== null) {
      clearTimeout(pending.timeoutId);
    }
    this.pendingConnect = null;
    pending.reject(err);
  }

  private notifyConnectionChange(): void {
    const connected = this.isConnected();
    const email = this.getConnectedEmail();
    this.plugin.app.workspace.trigger(
      connected ? 'gdocs-sync:connected' : 'gdocs-sync:disconnected',
      { email },
    );
    for (const listener of this.connectionListeners) {
      try {
        listener(connected, email);
      } catch (e) {
        console.error('[GDocsAuth] connection listener threw:', e);
      }
    }
  }
}
