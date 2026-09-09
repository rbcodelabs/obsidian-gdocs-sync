import { App, Modal } from 'obsidian';

export type PushMode = 'html' | 'surgical';

/**
 * Modal shown before a manual push when the target Google Doc has open
 * comments or pending suggestions. The user chooses between:
 *   - HTML push: full formatting + images, but clears comments/suggestions
 *   - Surgical push: preserves comments/suggestions, no image support
 */
export class PushModeModal extends Modal {
  constructor(
    app: App,
    private readonly commentCount: number,
    private readonly suggestionCount: number,
    private readonly onChoose: (mode: PushMode) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'Google Doc has active changes' });

    contentEl.createEl('p', {
      text: `This doc has ${this.commentCount} comment(s) and ${this.suggestionCount} suggestion(s).`,
    });

    // ── HTML push option ──────────────────────────────────────────────────────
    const htmlSection = contentEl.createDiv({ cls: 'gdocs-push-option' });
    htmlSection.createEl('p', {
      text: 'Full formatting + images. Comments and suggestions will be cleared.',
      cls: 'gdocs-push-option-desc',
    });
    const htmlBtn = htmlSection.createEl('button', {
      text: '↑ Push with HTML',
      cls: 'mod-cta',
    });
    htmlBtn.addEventListener('click', () => {
      this.onChoose('html');
      this.close();
    });

    // ── Surgical push option ──────────────────────────────────────────────────
    const surgicalSection = contentEl.createDiv({ cls: 'gdocs-push-option' });
    surgicalSection.createEl('p', {
      text: 'Preserves comments and suggestions. Images not supported.',
      cls: 'gdocs-push-option-desc',
    });
    const surgicalBtn = surgicalSection.createEl('button', {
      text: '↑ Push surgically',
    });
    surgicalBtn.addEventListener('click', () => {
      this.onChoose('surgical');
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
