import { Plugin } from 'obsidian';

export class StatusBarItem {
  private el: HTMLElement;

  constructor(plugin: Plugin) {
    this.el = plugin.addStatusBarItem();
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

  /** Default idle state shown when the plugin is running but not syncing. */
  setIdle(): void {
    this.el.setText('⇅ GDocs');
  }
}
