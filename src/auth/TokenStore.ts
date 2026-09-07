import { Plugin, requestUrl } from 'obsidian';
import { isSuccessStatus } from '../api/httpStatus';
import { GDocsTokens, GDocsPluginSettings } from '../types';

// Extend Plugin type to include the settings and saveSettings we expect
type PluginWithSettings = Plugin & {
  settings: GDocsPluginSettings;
  saveSettings(): Promise<void>;
  loadSecret(key: string): Promise<string | null>;
  saveSecret(key: string, value: string): Promise<void>;
  removeSecret(key: string): Promise<void>;
};

const TOKEN_SECRET_KEY = 'google-oauth-tokens';

export class TokenStore {
  private plugin: PluginWithSettings;
  private tokens: GDocsTokens | null = null;
  private secure = false;
  private secureRequired = false;

  constructor(plugin: Plugin) {
    this.plugin = plugin as PluginWithSettings;
  }

  async initialize(): Promise<void> {
    this.tokens = this.plugin.settings.tokens;
    this.secure = false;
    if (typeof this.plugin.loadSecret !== 'function' || typeof this.plugin.saveSecret !== 'function' || typeof this.plugin.removeSecret !== 'function') {
      this.tokens = this.plugin.settings.tokens;
      return;
    }
    this.secureRequired = true;
    const encoded = await this.plugin.loadSecret(TOKEN_SECRET_KEY);
    if (encoded) {
      try { this.tokens = JSON.parse(encoded) as GDocsTokens; } catch { throw new Error('Stored Google credentials are corrupt. Reconnect your account.'); }
    }
    const legacy = this.plugin.settings.tokens;
    if (legacy) {
      this.tokens = legacy;
      try { await this.plugin.saveSecret(TOKEN_SECRET_KEY, JSON.stringify(legacy)); }
      catch { throw new Error('Secure secret storage is unavailable. Legacy credentials were not removed.'); }
      this.plugin.settings.tokens = null;
      try { await this.plugin.saveSettings(); }
      catch (error) { this.plugin.settings.tokens = legacy; await this.plugin.removeSecret(TOKEN_SECRET_KEY).catch(() => undefined); throw error; }
    }
    this.secure = true;
  }

  get(): GDocsTokens | null {
    return this.tokens;
  }

  hasSecureStorage(): boolean { return this.secure; }

  async set(tokens: GDocsTokens): Promise<void> {
    console.log('[TokenStore] set() called. expiresAt:', new Date(tokens.expiresAt).toISOString());
    if (this.secureRequired) {
      this.secure = false;
      await this.plugin.saveSecret(TOKEN_SECRET_KEY, JSON.stringify(tokens));
      await this.clearLegacy();
      this.secure = true;
    }
    else { this.plugin.settings.tokens = tokens; await this.plugin.saveSettings(); }
    this.tokens = tokens;
  }

  async clear(): Promise<void> {
    // A failed migration may leave credentials in both stores. Disconnect only
    // succeeds when neither persisted copy can restore the account on restart.
    await this.clearLegacy();
    if (this.secureRequired) await this.plugin.removeSecret(TOKEN_SECRET_KEY);
    this.tokens = null;
  }

  private async clearLegacy(): Promise<void> {
    const legacy = this.plugin.settings.tokens;
    if (!legacy) return;
    this.plugin.settings.tokens = null;
    try { await this.plugin.saveSettings(); }
    catch (error) { this.plugin.settings.tokens = legacy; throw error; }
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
    const response = await requestUrl({
      url: refreshUrl,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: tokens.refreshToken }),
      throw: false,
    });

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
    return newTokens.accessToken;
  }
}
