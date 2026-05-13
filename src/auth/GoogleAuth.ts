import { Plugin, Notice } from 'obsidian';
import { GDocsPluginSettings, GDocsTokens } from '../types';
import { TokenStore } from './TokenStore';

type PluginWithSettings = Plugin & {
  settings: GDocsPluginSettings;
  saveSettings(): Promise<void>;
};

export class GoogleAuth {
  private plugin: PluginWithSettings;
  private tokenStore: TokenStore;

  // Holds the state UUID generated during connect() so the persistent
  // protocol handler (registered in onload) can verify it on return.
  private pendingState: string | null = null;

  // Called after successful auth so the settings tab can refresh its UI.
  onConnected: (() => void) | null = null;

  constructor(plugin: Plugin, tokenStore: TokenStore) {
    this.plugin = plugin as PluginWithSettings;
    this.tokenStore = tokenStore;
  }

  // Called from main.ts onload() via registerObsidianProtocolHandler.
  // Persistent for the lifetime of the plugin — always ready to receive callbacks.
  async handleCallback(params: Record<string, string>): Promise<void> {
    console.log('[GDocsAuth] handleCallback fired. params:', JSON.stringify(params));
    console.log('[GDocsAuth] pendingState:', this.pendingState);

    // Obsidian overwrites "action" with the handler name — we use "event" instead.
    if (params['event'] !== 'auth_complete') {
      console.log('[GDocsAuth] Ignoring — event is not auth_complete:', params['event']);
      return;
    }

    if (!this.pendingState) {
      console.warn('[GDocsAuth] No pendingState — was connect() called first?');
      new Notice('⚠ GDocs Sync: No auth in progress. Please click Connect again.');
      return;
    }

    if (params['state'] !== this.pendingState) {
      console.warn('[GDocsAuth] State mismatch. Expected:', this.pendingState, 'Got:', params['state']);
      new Notice('⚠ GDocs Sync: OAuth state mismatch. Auth cancelled.');
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
      return;
    }

    const tokens: GDocsTokens = {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
    };

    console.log('[GDocsAuth] Saving tokens to TokenStore...');
    await this.tokenStore.set(tokens);
    console.log('[GDocsAuth] Tokens saved. Verifying readback:', !!this.tokenStore.get());
    this.pendingState = null;

    // Fetch the Google account email for display in settings
    try {
      const resp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (resp.ok) {
        const info = await resp.json() as { email?: string };
        if (info.email) {
          this.plugin.settings.connectedEmail = info.email;
          await this.plugin.saveSettings();
          console.log('[GDocsAuth] Connected email set to:', info.email);
        }
      }
    } catch (e) {
      console.warn('[GDocsAuth] Could not fetch user email (non-fatal):', e);
    }

    new Notice('✓ Connected to Google');
    console.log('[GDocsAuth] Calling onConnected callback...');
    this.onConnected?.();
    console.log('[GDocsAuth] Auth complete.');
  }

  async connect(): Promise<void> {
    this.pendingState = crypto.randomUUID();
    console.log('[GDocsAuth] connect() called. pendingState set to:', this.pendingState);
    console.log('[GDocsAuth] authProxyUrl:', this.plugin.settings.authProxyUrl);

    const authUrl = `${this.plugin.settings.authProxyUrl}/api/auth/start?state=${encodeURIComponent(this.pendingState)}`;
    console.log('[GDocsAuth] Opening auth URL:', authUrl);
    // Use Electron's shell.openExternal so the URL opens in the user's default
    // browser with their normal profile — window.open() hands off to Chrome
    // without profile context, which causes it to open incognito.
    const { shell } = window.require('electron');
    shell.openExternal(authUrl);

    new Notice('Opening Google sign-in... Return here after authorizing.');
  }

  async disconnect(): Promise<void> {
    await this.tokenStore.clear();
    this.plugin.settings.connectedEmail = '';
    await this.plugin.saveSettings();
    new Notice('Disconnected from Google.');
  }
}
