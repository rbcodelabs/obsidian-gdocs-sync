import { Plugin, requestUrl } from 'obsidian';
import { isSuccessStatus } from '../api/httpStatus';
import { GDocsTokens, GDocsPluginSettings } from '../types';

// Extend Plugin type to include the settings and saveSettings we expect
type PluginWithSettings = Plugin & {
  settings: GDocsPluginSettings;
  saveSettings(): Promise<void>;
};

export class TokenStore {
  readonly supportsConnectionGuard = true;
  private plugin: PluginWithSettings;
  private pendingRefresh?: {
    tokens: GDocsTokens;
    authProxyUrl: string;
    promise: Promise<string>;
  };

  constructor(plugin: Plugin) {
    this.plugin = plugin as PluginWithSettings;
  }

  get(): GDocsTokens | null {
    return this.plugin.settings.tokens;
  }

  async set(tokens: GDocsTokens): Promise<void> {
    console.log('[TokenStore] set() called. expiresAt:', new Date(tokens.expiresAt).toISOString());
    this.plugin.settings.tokens = tokens;
    await this.plugin.saveSettings();
    console.log('[TokenStore] saveSettings() complete. tokens in settings:', !!this.plugin.settings.tokens);
  }

  async clear(): Promise<void> {
    this.plugin.settings.tokens = null;
    await this.plugin.saveSettings();
  }

  isExpired(): boolean {
    const tokens = this.get();
    if (!tokens) return true;
    // Return true if token expires within the next 60 seconds
    return tokens.expiresAt < Date.now() + 60_000;
  }

  async getValidAccessToken(): Promise<string> {
    const tokens = this.get();
    if (!tokens) {
      throw new Error('No tokens stored. Please connect your Google Account first.');
    }

    if (!this.isExpired()) {
      return tokens.accessToken;
    }

    const authProxyUrl = this.plugin.settings.authProxyUrl;
    if (this.pendingRefresh?.tokens === tokens && this.pendingRefresh.authProxyUrl === authProxyUrl) {
      return this.pendingRefresh.promise;
    }

    const pending = { tokens, authProxyUrl, promise: this.refresh(tokens, authProxyUrl) };
    this.pendingRefresh = pending;
    try {
      return await pending.promise;
    } finally {
      // An older connection finishing must not release a newer connection's slot.
      if (this.pendingRefresh === pending) this.pendingRefresh = undefined;
    }
  }

  private assertCurrentConnection(tokens: GDocsTokens, authProxyUrl: string): void {
    if (this.get() !== tokens || this.plugin.settings.authProxyUrl !== authProxyUrl) {
      throw new Error('Google connection changed during token refresh. Please retry.');
    }
  }

  private async refresh(tokens: GDocsTokens, authProxyUrl: string): Promise<string> {
    // requestUrl has no AbortSignal support. Bound the response wait before any
    // mutation so a late response cannot write tokens after a timed-out attempt.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const response = await Promise.race([
      requestUrl({
        url: `${authProxyUrl}/api/auth/refresh`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: tokens.refreshToken }),
        throw: false,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Google token refresh timed out. Please retry.')), 30_000);
      }),
    ]).finally(() => clearTimeout(timer));

    this.assertCurrentConnection(tokens, authProxyUrl);

    if (!isSuccessStatus(response.status)) {
      // The proxy forwards Google's machine-readable error code as JSON
      // { error: "invalid_grant" | "refresh_failed" | ... }.
      let errorCode = 'refresh_failed';
      try {
        const errBody = response.json as { error?: string } | undefined;
        if (errBody?.error) errorCode = errBody.error;
        else errorCode = `http_${response.status}`;
      } catch {
        // Body wasn't JSON — fall back to the status code.
        errorCode = `http_${response.status}`;
      }

      // "invalid_grant" means the refresh token has been revoked or expired.
      // Clear the stored tokens so the user is prompted to reconnect rather
      // than seeing repeated auth failures on every sync attempt.
      if (errorCode === 'invalid_grant') {
        await this.clear();
        throw new Error(
          'Google account access has been revoked. Please reconnect in plugin settings.',
        );
      }

      throw new Error(`Token refresh failed [${errorCode}]`);
    }

    const data = response.json as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    const newTokens: GDocsTokens = {
      accessToken: data.access_token,
      // Some OAuth servers rotate the refresh token; fall back to existing one if not
      refreshToken: data.refresh_token ?? tokens.refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    await this.set(newTokens);
    this.assertCurrentConnection(newTokens, authProxyUrl);
    return newTokens.accessToken;
  }
}
