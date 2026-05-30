import { Plugin } from 'obsidian';

export class StatusBarItem {
  private el: HTMLElement;

  constructor(plugin: Plugin, onClick?: () => void) {
    this.el = plugin.addStatusBarItem();
    if (onClick) {
      this.el.style.cursor = 'pointer';
      this.el.addEventListener('click', onClick);
    }
    this.setIdle();
  }

  /** Shown while a sync is in progress. */
  setSyncing(fileName: string): void {
    this.el.setText(`⟳ Syncing ${fileName}...`);
  }

  /** Shown after a successful sync. */
  setSynced(): void {
    this.el.setText('✓ GDocs synced');
  }

  /** Shown when a sync error occurs. */
  setError(msg: string): void {
    this.el.setText(`⚠ GDocs: ${msg}`);
  }

  /** Shown when the refresh token is invalid and the user must reconnect. */
  setReauthNeeded(): void {
    this.el.setText('⚠ GDocs: reconnect required');
  }

  /** Default idle state shown when the plugin is running but not syncing. */
  setIdle(): void {
    this.el.setText('⇅ GDocs');
  }
}
