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
      const errorText = await response.text();
      throw new Error(`Token refresh failed (${response.status}): ${errorText}`);
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
