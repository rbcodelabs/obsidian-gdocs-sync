import { Notice } from 'obsidian';
import { FolderMapping } from '../types';

type ImportFolderFn = (
  folderId: string,
  obsidianFolder: string,
) => Promise<{ imported: number; skipped: number; folderName: string }>;

// How often to check mapped Drive folders for new docs (5 minutes).
// Deliberately slower than the per-doc poller since listing a folder is heavier.
const FOLDER_POLL_INTERVAL_MS = 5 * 60 * 1000;

export class FolderPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  // Maps folderId → human-readable error message for folders currently failing.
  // Cleared per-folder on successful poll. Used by the status modal.
  private folderErrors = new Map<string, string>();

  constructor(
    private getMappings: () => FolderMapping[],
    private importFolder: ImportFolderFn,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), FOLDER_POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Returns a snapshot of all folders currently in an error state. */
  getFolderErrors(): Map<string, string> {
    return new Map(this.folderErrors);
  }

  /** Run immediately (e.g. on plugin start) then let the interval take over. */
  async runNow(): Promise<void> {
    await this.poll();
  }

  private async poll(): Promise<void> {
    const mappings = this.getMappings();
    if (mappings.length === 0) return;

    for (const mapping of mappings) {
      try {
        const { imported } = await this.importFolder(
          mapping.driveFolderId,
          mapping.obsidianFolder,
        );
        // Clear error state so a future failure will notify again
        this.folderErrors.delete(mapping.driveFolderId);
        if (imported > 0) {
          new Notice(
            `✓ GDocs Sync: ${imported} new doc${imported !== 1 ? 's' : ''} pulled from "${mapping.driveFolderName}"`,
          );
        }
      } catch (err) {
        console.error(
          `[FolderPoller] Error polling "${mapping.driveFolderName}":`,
          err,
        );
        // Only notify once per error episode to avoid a notice every 5 minutes
        if (!this.folderErrors.has(mapping.driveFolderId)) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const is404 = errMsg.includes('404');
          const humanMsg = is404
            ? 'Not found in Google Drive — may have been deleted or moved'
            : `Sync error: ${errMsg.slice(0, 120)}`;
          this.folderErrors.set(mapping.driveFolderId, humanMsg);
          if (is404) {
            // Persistent (timeout=0) so the user sees it even if away from the app
            new Notice(
              `GDocs Sync: Folder "${mapping.driveFolderName}" was not found in Google Drive. ` +
                `It may have been deleted or moved. Open Settings > GDocs Sync to update or remove the folder mapping.`,
              0,
            );
          } else {
            new Notice(
              `GDocs Sync: Error syncing folder "${mapping.driveFolderName}". Check the developer console for details.`,
            );
          }
        }
      }
    }
  }
}
