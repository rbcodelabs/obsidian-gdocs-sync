/**
 * Stable, documented contract for other Obsidian plugins that need to trigger
 * or observe this plugin's Google OAuth connection flow.
 *
 * Access it via:
 *
 * ```js
 * const gdocs = app.plugins.plugins['obsidian-gdocs-sync'];
 * const { email } = await gdocs.connectionApi.requestConnection();
 * ```
 *
 * Everything reachable through `connectionApi` is part of this contract and
 * will not change in a breaking way without a major version bump. Any other
 * property on the underlying object (e.g. `app.plugins.plugins['obsidian-gdocs-sync'].auth`)
 * is an implementation detail and may change or disappear at any time —
 * do not depend on it.
 */
export interface GoogleConnectionResult {
  /** The connected Google account's email, or null if it could not be determined. */
  email: string | null;
}

export interface GoogleConnectionApi {
  /** True if valid tokens are currently stored (does not verify they still work with Google). */
  isConnected(): boolean;

  /** The connected Google account's email, or null if not connected / not yet known. */
  getConnectedEmail(): string | null;

  /**
   * Starts (or reuses) the Google OAuth connection flow.
   *
   * - If already connected and `force` is not set, resolves immediately with
   *   the current connection — no browser window is opened and no state changes.
   * - If a connection flow is already in flight (started by this call or any
   *   other caller), the same in-flight promise is returned rather than
   *   starting a second, competing flow.
   * - Otherwise, opens the system browser to the Google consent screen and
   *   resolves once the OAuth callback completes.
   *
   * The returned promise rejects if: the OAuth state does not match (CSRF
   * check failure), the callback is missing tokens, or no callback arrives
   * within 5 minutes of starting the flow.
   *
   * @param options.force - Start a fresh connection flow even if already connected.
   */
  requestConnection(options?: { force?: boolean }): Promise<GoogleConnectionResult>;

  /** Clears stored tokens and the connected account. Resolves once disconnected. */
  disconnect(): Promise<void>;

  /**
   * Subscribes to connection state changes (connect and disconnect).
   * Returns an unsubscribe function.
   *
   * Connection changes are also broadcast on `app.workspace` as
   * `'gdocs-sync:connected'` / `'gdocs-sync:disconnected'`, each firing with
   * a single `{ email: string | null }` payload — use whichever mechanism
   * suits your plugin's existing event wiring.
   */
  onConnectionChange(callback: (connected: boolean, email: string | null) => void): () => void;
}
