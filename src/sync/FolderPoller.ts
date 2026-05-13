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
      }
    }
  }
}
