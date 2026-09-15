import { TFile } from 'obsidian';
import { pushNoteToGoogleDocs, pullNoteFromGoogleDocs, GDocsPluginLike } from '../sync/SyncActions';

// Minimal interface — avoids importing GDocsPlugin directly (circular dep risk),
// same pattern as FileCommandBar.ts's GDocsPluginLike. Extends the SyncActions
// shape with the registerEvent hook needed to wire up the workspace listener.
export interface FileMenuPluginLike extends GDocsPluginLike {
  registerEvent(event: import('obsidian').EventRef): void;
}

/**
 * Adds "Sync to Google Docs" / "Pull from Google Docs" / "Open in Google Docs"
 * entries to Obsidian's native file context menu. Obsidian raises the same
 * 'file-menu' event for the view-header "..." menu, file-explorer right-click,
 * and tab-header right-click — we don't filter by source since all of these
 * are useful surfaces for these actions.
 */
export function registerFileMenuActions(plugin: FileMenuPluginLike): void {
  plugin.registerEvent(
    plugin.app.workspace.on('file-menu', (menu, file) => {
      if (!(file instanceof TFile) || file.extension !== 'md') return;

      const meta = plugin.app.metadataCache.getFileCache(file);
      const frontmatter = meta?.frontmatter;
      const docId: string | undefined = frontmatter?.['gdocs-id'];

      menu.addSeparator();

      menu.addItem((item) => {
        item
          .setTitle('Sync to Google Docs')
          .setIcon('upload-cloud')
          .onClick(() => {
            void pushNoteToGoogleDocs(plugin, file);
          });
      });

      if (docId) {
        menu.addItem((item) => {
          item
            .setTitle('Pull from Google Docs')
            .setIcon('download-cloud')
            .onClick(() => {
              void pullNoteFromGoogleDocs(plugin, file);
            });
        });

        menu.addItem((item) => {
          item
            .setTitle('Open in Google Docs')
            .setIcon('external-link')
            .onClick(() => {
              const url: string =
                frontmatter?.['gdocs-url'] ?? `https://docs.google.com/document/d/${docId}/edit`;
              window.open(url, '_blank');
            });
        });
      }
    })
  );
}
