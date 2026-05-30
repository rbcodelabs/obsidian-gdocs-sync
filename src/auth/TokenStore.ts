import { Plugin } from 'obsidian';
import { GDocsTokens, GDocsPluginSettings } from '../types';

// Extend Plugin type to include the settings and saveSettings we expect
type PluginWithSettings = Plugin & {
  settings: GDocsPluginSettings;
  saveSettings(): Promise<void>;
};

export class TokenStore {
  private plugin: PluginWithSettings;

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

    // Token is expired or about to expire — refresh it via the auth proxy
    const refreshUrl = `${this.plugin.settings.authProxyUrl}/api/auth/refresh`;
    const response = await fetch(refreshUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: tokens.refreshToken }),
    });

    if (!response.ok) {
      // The proxy forwards Google's machine-readable error code as JSON
      // { error: "invalid_grant" | "refresh_failed" | ... }.
      let errorCode = 'refresh_failed';
      try {
        const errBody = await response.json() as { error?: string };
        if (errBody.error) errorCode = errBody.error;
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

    const data = await response.json() as {
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
    return newTokens.accessToken;
  }
}
