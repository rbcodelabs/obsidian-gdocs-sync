import { App, ButtonComponent, Modal } from 'obsidian';

/**
 * Consent gate shown before the managed Google Drive full-vault transport is
 * registered with Geode. The transport ships in every build but stays dormant
 * until the user reads this and confirms — so the copy has to be honest about
 * what has and has not been verified, not reassuring.
 */
export class FullVaultSyncConsentModal extends Modal {
  constructor(
    app: App,
    private onConfirm: () => void | Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('gdocs-full-vault-consent');

    contentEl.createEl('h2', { text: 'Enable full vault sync (beta)?' });

    // The disclosure is deliberately long, and it is taller than the modal's
    // content box at every realistic window size. Scroll the prose rather than
    // the whole modal, so the title and the action buttons are always on screen
    // — otherwise both buttons render outside the visible modal and the dialog
    // looks like it has no way to accept or dismiss it.
    const body = contentEl.createDiv('gdocs-full-vault-consent-body');

    body.createEl('p', {
      text: 'This is an unverified beta. It syncs your entire vault to a dedicated “Geode Vault” folder in your Google Drive using an append-only immutable history. Turn it on only if you accept the limits below.',
    });

    body.createEl('h3', { text: 'Real limits, in effect today' });
    const limits = body.createEl('ul');
    limits.createEl('li', { text: 'Maximum 100 MiB per file. Larger files are not synced.' });
    limits.createEl('li', {
      text: 'Every revision is retained as immutable history with no garbage collection. Drive storage use grows with every change and is never reclaimed automatically.',
    });

    body.createEl('h3', { text: 'Not yet verified' });
    const unverified = body.createEl('ul');
    unverified.createEl('li', { text: 'Live Google sign-in for the vault transport.' });
    unverified.createEl('li', { text: 'Multiple clients authorized independently against the same vault.' });
    unverified.createEl('li', { text: 'Conflict handling and fresh-device vault reconstruction.' });
    unverified.createEl('li', { text: 'Interrupted or resumed uploads.' });
    unverified.createEl('li', { text: 'Behaviour at scale (large vaults, large histories).' });
    unverified.createEl('li', { text: 'The 24-hour soak test.' });

    body.createEl('p', {
      text: 'Try this on a test vault first. Do not make it the only copy of anything you care about.',
      cls: 'mod-warning',
    });

    const buttons = contentEl.createDiv('modal-button-container');

    new ButtonComponent(buttons)
      .setButtonText('Cancel')
      .setCta()
      .onClick(() => this.close());

    new ButtonComponent(buttons)
      .setButtonText('I understand — enable beta sync')
      .setWarning()
      .onClick(async () => {
        this.close();
        await this.onConfirm();
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
