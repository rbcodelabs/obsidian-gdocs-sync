import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  ButtonComponent,
  TextComponent,
} from 'obsidian';
import { GDocsPluginSettings } from './types';
import { GoogleAuth } from './auth/GoogleAuth';

// Expose the additional fields we need beyond the base Plugin type
export interface GDocsPluginInterface extends Plugin {
  settings: GDocsPluginSettings;
  saveSettings(): Promise<void>;
  auth: GoogleAuth;
}

export class GDocsSettingTab extends PluginSettingTab {
  private pluginInstance: GDocsPluginInterface;

  constructor(app: App, plugin: GDocsPluginInterface) {
    super(app, plugin);
    this.pluginInstance = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ── Section 1: Google Account ───────────────────────────────────────────
    containerEl.createEl('h2', { text: 'Google Account' });

    const { connectedEmail, tokens } = this.pluginInstance.settings;
    const isConnected = tokens !== null;

    new Setting(containerEl)
      .setName('Connection status')
      .setDesc(
        isConnected
          ? `Connected${connectedEmail ? ` as ${connectedEmail}` : ''}`
          : 'Not connected to Google',
      )
      .addButton((btn: ButtonComponent) => {
        if (isConnected) {
          btn
            .setButtonText('Disconnect')
            .setWarning()
            .onClick(async () => {
              await this.pluginInstance.auth.disconnect();
              this.display(); // re-render
            });
        } else {
          btn
            .setButtonText('Connect Google Account')
            .setCta()
            .onClick(async () => {
              await this.pluginInstance.auth.connect();
              // The settings panel will reflect the change after the OAuth
              // callback fires and updates connectedEmail.
            });
        }
      });

    new Setting(containerEl)
      .setName('Auth proxy URL')
      .setDesc(
        'URL of the Vercel-hosted auth proxy that handles the Google OAuth flow. The plugin never holds the Google client secret.',
      )
      .addText((text: TextComponent) => {
        text
          .setPlaceholder('https://gdocs-sync.vercel.app')
          .setValue(this.pluginInstance.settings.authProxyUrl)
          .onChange(async (value) => {
            this.pluginInstance.settings.authProxyUrl = value.trim();
            await this.pluginInstance.saveSettings();
          });
      });

    // ── Section 2: Sync Rules ───────────────────────────────────────────────
    containerEl.createEl('h2', { text: 'Sync Rules' });

    new Setting(containerEl)
      .setName('Sync tag')
      .setDesc(
        'Notes tagged with this value will be automatically synced to Google Docs.',
      )
      .addText((text: TextComponent) => {
        text
          .setPlaceholder('gdocs-sync')
          .setValue(this.pluginInstance.settings.syncTag)
          .onChange(async (value) => {
            this.pluginInstance.settings.syncTag = value.trim();
            await this.pluginInstance.saveSettings();
          });
      });

    // Sync folders list
    new Setting(containerEl)
      .setName('Sync folders')
      .setDesc(
        'All notes inside these folders will be automatically synced. One folder path per entry.',
      );

    const folderListEl = containerEl.createDiv('gdocs-folder-list');
    this.renderFolderList(folderListEl);

    new Setting(containerEl).addButton((btn: ButtonComponent) => {
      btn
        .setButtonText('+ Add folder')
        .onClick(async () => {
          this.pluginInstance.settings.syncFolders.push('');
          await this.pluginInstance.saveSettings();
          folderListEl.empty();
          this.renderFolderList(folderListEl);
        });
    });

    // ── Section 3: Sync Behaviour ───────────────────────────────────────────
    containerEl.createEl('h2', { text: 'Sync Behavior' });

    new Setting(containerEl)
      .setName('Auto-sync on save')
      .setDesc(
        'Automatically push changes to Google Docs 2 seconds after you stop editing a synced note.',
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.pluginInstance.settings.autoSyncOnSave)
          .onChange(async (value) => {
            this.pluginInstance.settings.autoSyncOnSave = value;
            await this.pluginInstance.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Poll interval')
      .setDesc('How often to check Google Docs for remote changes.')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('15', 'Every 15 seconds')
          .addOption('30', 'Every 30 seconds')
          .addOption('60', 'Every 60 seconds')
          .addOption('300', 'Every 5 minutes')
          .setValue(String(this.pluginInstance.settings.pollIntervalSeconds))
          .onChange(async (value) => {
            this.pluginInstance.settings.pollIntervalSeconds = parseInt(value, 10);
            await this.pluginInstance.saveSettings();
          });
      });
  }

  private renderFolderList(container: HTMLElement): void {
    const folders = this.pluginInstance.settings.syncFolders;

    folders.forEach((folder, index) => {
      const setting = new Setting(container)
        .addText((text: TextComponent) => {
          text
            .setPlaceholder('e.g. Work/Projects')
            .setValue(folder)
            .onChange(async (value) => {
              this.pluginInstance.settings.syncFolders[index] = value;
              await this.pluginInstance.saveSettings();
            });
        })
        .addButton((btn: ButtonComponent) => {
          btn.setButtonText('Remove').setWarning().onClick(async () => {
            this.pluginInstance.settings.syncFolders.splice(index, 1);
            await this.pluginInstance.saveSettings();
            container.empty();
            this.renderFolderList(container);
          });
        });

      setting.settingEl.style.borderTop = 'none';
    });

    if (folders.length === 0) {
      container.createEl('p', {
        text: 'No folders configured.',
        cls: 'setting-item-description',
      });
    }
  }
}
