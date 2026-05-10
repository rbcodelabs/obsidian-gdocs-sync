import { App, Modal, Setting, ButtonComponent } from 'obsidian';

export class ImportModal extends Modal {
  private urlOrId = '';
  private onSubmit: (urlOrId: string) => Promise<void>;

  constructor(app: App, onSubmit: (urlOrId: string) => Promise<void>) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'Import Google Doc' });
    contentEl.createEl('p', {
      text: 'Paste a Google Doc URL or document ID to import it as a new note.',
      cls: 'setting-item-description',
    });

    new Setting(contentEl)
      .setName('Google Doc URL or ID')
      .addText((text) => {
        text
          .setPlaceholder(
            'https://docs.google.com/document/d/… or document ID',
          )
          .onChange((value) => {
            this.urlOrId = value.trim();
          });

        // Auto-focus the input field when the modal opens
        window.setTimeout(() => text.inputEl.focus(), 50);
      });

    new Setting(contentEl)
      .addButton((btn: ButtonComponent) => {
        btn
          .setButtonText('Import')
          .setCta()
          .onClick(async () => {
            if (!this.urlOrId) return;
            this.close();
            await this.onSubmit(this.urlOrId);
          });
      })
      .addButton((btn: ButtonComponent) => {
        btn.setButtonText('Cancel').onClick(() => this.close());
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
