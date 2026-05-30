import { Plugin } from 'obsidian';

export class StatusBarItem {
  private el: HTMLElement;
  private _reauthNeeded = false;

  constructor(plugin: Plugin, onClick?: () => void) {
    this.el = plugin.addStatusBarItem();
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
    this.el.setText(`⟳ Syncing ${fileName}...`);
  }

  /** Shown after a successful sync. */
  setSynced(): void {
    this._reauthNeeded = false;
    this.el.setText('✓ GDocs synced');
  }

  /** Shown when a sync error occurs. */
  setError(msg: string): void {
    this.el.setText(`⚠ GDocs: ${msg}`);
  }

  /** Shown when the refresh token is invalid and the user must reconnect. */
  setReauthNeeded(): void {
    this._reauthNeeded = true;
    this.el.setText('⚠ GDocs: reconnect required');
  }

  /** Default idle state shown when the plugin is running but not syncing. */
  setIdle(): void {
    this._reauthNeeded = false;
    this.el.setText('⇅ GDocs');
  }
}
