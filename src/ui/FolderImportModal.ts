import { App, Modal, Notice, Setting, ButtonComponent, TextComponent } from 'obsidian';
import { GoogleDocsAPI } from '../api/GoogleDocsAPI';
import { SyncEngine } from '../sync/SyncEngine';

export class FolderImportModal extends Modal {
  private folderUrlOrId = '';
  private obsidianFolder = '';
  private api: GoogleDocsAPI;
  private syncEngine: SyncEngine;
  private onComplete: () => void;

  constructor(
    app: App,
    api: GoogleDocsAPI,
    syncEngine: SyncEngine,
    onComplete: () => void,
  ) {
    super(app);
    this.api = api;
    this.syncEngine = syncEngine;
    this.onComplete = onComplete;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'Import Google Drive Folder' });
    contentEl.createEl('p', {
      text: 'Paste a Google Drive folder URL. All Google Docs inside it will be imported as notes and kept in sync.',
      cls: 'setting-item-description',
    });

    new Setting(contentEl)
      .setName('Google Drive folder URL')
      .setDesc('e.g. https://drive.google.com/drive/folders/…')
      .addText((text: TextComponent) => {
        text
          .setPlaceholder('https://drive.google.com/drive/folders/…')
          .onChange((value) => {
            this.folderUrlOrId = value.trim();
          });
        window.setTimeout(() => text.inputEl.focus(), 50);
      });

    new Setting(contentEl)
      .setName('Obsidian destination folder')
      .setDesc('Vault folder where imported notes will be saved (created if it doesn\'t exist).')
      .addText((text: TextComponent) => {
        text
          .setPlaceholder('e.g. Finances & Estate')
          .onChange((value) => {
            this.obsidianFolder = value.trim();
          });
      });

    new Setting(contentEl)
      .addButton((btn: ButtonComponent) => {
        btn
          .setButtonText('Import')
          .setCta()
          .onClick(async () => {
            if (!this.folderUrlOrId) {
              new Notice('⚠ Please enter a Google Drive folder URL.');
              return;
            }
            if (!this.obsidianFolder) {
              new Notice('⚠ Please enter a destination folder name.');
              return;
            }
            this.close();
            await this.runImport();
          });
      })
      .addButton((btn: ButtonComponent) => {
        btn.setButtonText('Cancel').onClick(() => this.close());
      });
  }

  private async runImport(): Promise<void> {
    const folderId = GoogleDocsAPI.parseFolderId(this.folderUrlOrId);

    try {
      new Notice(`⟳ Fetching folder contents…`);
      const { imported, skipped, folderName } =
        await this.syncEngine.importGoogleDriveFolder(folderId, this.obsidianFolder);

      new Notice(
        `✓ Imported ${imported} doc${imported !== 1 ? 's' : ''} from "${folderName}" → ${this.obsidianFolder}` +
          (skipped > 0 ? ` (${skipped} already synced, skipped)` : ''),
      );
      this.onComplete();
    } catch (err) {
      console.error('[FolderImportModal] Import failed:', err);
      new Notice(`⚠ Folder import failed — ${(err as Error).message}`);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
