import { Plugin, TFile } from 'obsidian';

export class FileWatcher {
  // Debounce timers keyed by file path
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(
    private plugin: Plugin,
    private onFileChange: (file: TFile) => Promise<void>,
  ) {}

  /**
   * Register a vault 'modify' event listener with per-file debouncing.
   *
   * Obsidian automatically cleans up registered events when the plugin
   * unloads, so there is no corresponding `stop()` method needed.
   *
   * The 2000 ms debounce gives the user time to finish typing before we kick
   * off a sync, preventing excessive API calls during active editing.
   */
  start(): void {
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

        // Schedule the sync callback after the debounce window
        const timer = setTimeout(() => {
          this.debounceTimers.delete(path);
          void this.onFileChange(file);
        }, 2000);

        this.debounceTimers.set(path, timer);
      }),
    );
  }
}
