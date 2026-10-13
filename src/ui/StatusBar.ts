import { Plugin } from 'obsidian';

export class StatusBarItem {
  private el: HTMLElement;
  private _reauthNeeded = false;

  constructor(plugin: Plugin, onClick?: () => void) {
    // Mobile hosts hide (or do not implement) the status bar. Fall back to a
    // detached element so state updates are harmless no-ops instead of a crash;
    // the 'Show sync status' command exposes the same information on mobile.
    this.el = plugin.addStatusBarItem?.() ?? document.createElement('div');
    if (onClick) {
      this.el.style.cursor = 'pointer';
      this.el.addEventListener('click', onClick);
    }
    this.setIdle();
  }

  /** Returns true when the user needs to reconnect their Google account. */
  get reauthNeeded(): boolean {
    return this._reauthNeeded;
  }

  /** Shown while a sync is in progress. */
  setSyncing(fileName: string): void {
    this._reauthNeeded = false;
    this.el.textContent = `⟳ Syncing ${fileName}...`;
  }

  /** Shown after a successful sync. */
  setSynced(): void {
    this._reauthNeeded = false;
    this.el.textContent = '✓ GDocs synced';
  }

  /** Shown when a sync error occurs. */
  setError(msg: string): void {
    this.el.textContent = `⚠ GDocs: ${msg}`;
  }

  /** Shown when the refresh token is invalid and the user must reconnect. */
  setReauthNeeded(): void {
    this._reauthNeeded = true;
    this.el.textContent = '⚠ GDocs: reconnect required';
  }

  /** Default idle state shown when the plugin is running but not syncing. */
  setIdle(): void {
    this._reauthNeeded = false;
    this.el.textContent = '⇅ GDocs';
  }
}
