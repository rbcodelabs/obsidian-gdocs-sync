import { Notice, TFile } from 'obsidian';
import { SyncEngine } from './SyncEngine';
import { StatusBarItem } from '../ui/StatusBar';

// Minimal interface — avoids importing GDocsPlugin directly (circular dep risk),
// same pattern as FileCommandBar.ts's GDocsPluginLike.
export interface GDocsPluginLike {
  app: import('obsidian').App;
  statusBar: StatusBarItem;
  syncEngine: SyncEngine;
  /** Per-file error messages surfaced by push/pull failures */
  perFileErrors: Map<string, string>;
  fileCommandBar?: {
    update(path?: string): void;
  };
}

/**
 * Push a note's local content to its linked Google Doc (or create a new one).
 * Shared by the "sync-current-note" command and the file-menu action so both
 * entry points behave identically.
 */
export async function pushNoteToGoogleDocs(plugin: GDocsPluginLike, file: TFile): Promise<void> {
  if (file.extension !== 'md') {
    new Notice('Only Markdown notes can be synced.');
    return;
  }

  plugin.statusBar.setSyncing(file.basename);
  try {
    await plugin.syncEngine.syncLocalToRemote(file, true /* force */);
    plugin.statusBar.setSynced();
    plugin.perFileErrors.delete(file.path);
    plugin.fileCommandBar?.update(file.path);
    new Notice(`✓ Synced "${file.basename}" to Google Docs`);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('revoked')) {
      plugin.statusBar.setReauthNeeded();
    } else {
      plugin.statusBar.setError('sync failed');
    }
    plugin.perFileErrors.set(file.path, msg);
    plugin.fileCommandBar?.update(file.path);
    new Notice(`⚠ Sync failed: ${msg}`);
  }
}

/**
 * Pull the latest remote content for a note from its linked Google Doc
 * (remote wins, no conflict check). Shared by the "pull-current-note"
 * command and the file-menu action.
 */
export async function pullNoteFromGoogleDocs(plugin: GDocsPluginLike, file: TFile): Promise<void> {
  const meta = plugin.app.metadataCache.getFileCache(file);
  const docId: string | undefined = meta?.frontmatter?.['gdocs-id'];
  if (!docId) {
    new Notice('This note is not linked to a Google Doc.');
    return;
  }

  plugin.statusBar.setSyncing(file.basename);
  try {
    await plugin.syncEngine.syncRemoteToLocal(docId, true /* forceRemote */);
    plugin.statusBar.setSynced();
    plugin.perFileErrors.delete(file.path);
    plugin.fileCommandBar?.update(file.path);
    new Notice(`✓ Pulled latest "${file.basename}" from Google Docs`);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('revoked')) {
      plugin.statusBar.setReauthNeeded();
    } else {
      plugin.statusBar.setError('pull failed');
    }
    plugin.perFileErrors.set(file.path, msg);
    plugin.fileCommandBar?.update(file.path);
    new Notice(`⚠ Pull failed: ${msg}`);
  }
}
