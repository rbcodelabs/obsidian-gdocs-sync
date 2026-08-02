import { Plugin, TFile } from 'obsidian';

type FileHandler = {
  predicate: (file: TFile) => boolean;
  callback: (file: TFile) => Promise<void>;
};

/**
 * Watches the vault for file modifications and dispatches to registered
 * handlers after a debounce window.
 *
 * A single `vault.on('modify')` listener is the source of truth for "which
 * callback fires for which file": each handler carries a path predicate, and a
 * modified file is dispatched to every handler whose predicate matches. This
 * lets the Docs sync and Tasks sync share one watcher/debounce map rather than
 * racing two independent listeners.
 */
export class FileWatcher {
  // Debounce timers keyed by file path
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private handlers: FileHandler[] = [];
  private started = false;

  /**
   * @param plugin          the owning plugin (for event registration)
   * @param defaultHandler  optional unconditional handler (back-compat with the
   *                        original single-callback API — gating happens
   *                        downstream in the callback itself).
   */
  constructor(
    private plugin: Plugin,
    defaultHandler?: (file: TFile) => Promise<void>,
  ) {
    if (defaultHandler) {
      this.handlers.push({ predicate: () => true, callback: defaultHandler });
    }
  }

  /** Register an additional predicate-gated handler. */
  addHandler(
    predicate: (file: TFile) => boolean,
    callback: (file: TFile) => Promise<void>,
  ): void {
    this.handlers.push({ predicate, callback });
  }

  /**
   * Register the vault 'modify' listener with per-file debouncing. Idempotent —
   * safe for multiple engines (Docs, Tasks) to each call it; only the first
   * call attaches the listener.
   *
   * Obsidian automatically cleans up registered events when the plugin
   * unloads, so there is no corresponding `stop()` method needed.
   *
   * The 2000 ms debounce gives the user time to finish typing before we kick
   * off a sync, preventing excessive API calls during active editing.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    this.plugin.registerEvent(
      this.plugin.app.vault.on('modify', (abstractFile) => {
        // Only care about regular files (not folders)
        if (!(abstractFile instanceof TFile)) return;

        const file = abstractFile as TFile;
        const path = file.path;

        // Clear any pending debounce for this file
        const existingTimer = this.debounceTimers.get(path);
        if (existingTimer !== undefined) {
          clearTimeout(existingTimer);
        }

        // Schedule dispatch after the debounce window
        const timer = setTimeout(() => {
          this.debounceTimers.delete(path);
          for (const handler of this.handlers) {
            if (handler.predicate(file)) {
              void handler.callback(file);
            }
          }
        }, 2000);

        this.debounceTimers.set(path, timer);
      }),
    );
  }
}
