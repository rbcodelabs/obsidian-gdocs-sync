import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  ButtonComponent,
  TextComponent,
  Notice,
} from 'obsidian';
import { GDocsPluginSettings, FolderMapping } from './types';
import { GoogleAuth } from './auth/GoogleAuth';
import { GoogleDocsAPI } from './api/GoogleDocsAPI';
import { GoogleTasksAPI, GoogleTaskList } from './api/GoogleTasksAPI';
import { SyncEngine } from './sync/SyncEngine';
import { TasksSyncEngine } from './sync/TasksSyncEngine';
import { StatusBarItem } from './ui/StatusBar';
import { DriveBrowserModal } from './ui/DriveBrowserModal';
import { TokenStore } from './auth/TokenStore';

// Expose the additional fields we need beyond the base Plugin type
export interface GDocsPluginInterface extends Plugin {
  settings: GDocsPluginSettings;
  saveSettings(): Promise<void>;
  auth: GoogleAuth;
  api: GoogleDocsAPI;
  tasksApi: GoogleTasksAPI;
  syncEngine: SyncEngine;
  tasksSyncEngine: TasksSyncEngine;
  statusBar: StatusBarItem;
  startTasksSyncIfEnabled(): Promise<void>;
  fullVaultSyncUnavailable: string;
  tokenStore: TokenStore;
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

    const { connectedEmail } = this.pluginInstance.settings;
    const isConnected = this.pluginInstance.tokenStore.get() !== null;

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

    containerEl.createEl('h2', { text: 'Full vault sync (Geode)' });
    new Setting(containerEl)
      .setName('Google Drive vault transport')
      .setDesc(this.pluginInstance.fullVaultSyncUnavailable || 'Registered with Geode. Connect it from Geode Settings → Sync. Files are stored as original bytes in a dedicated “Geode Vault” Drive folder; native Google Docs note links remain separate.');

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

    // ── Section 3: Drive Folder Mappings ───────────────────────────────────
    containerEl.createEl('h2', { text: 'Drive Folder Sync' });
    containerEl.createEl('p', {
      text: 'Import an entire Google Drive folder. All Docs in the folder become synced notes in the vault folder you choose.',
      cls: 'setting-item-description',
    });

    const mappingListEl = containerEl.createDiv('gdocs-folder-mapping-list');
    this.renderFolderMappings(mappingListEl);

    new Setting(containerEl).addButton((btn: ButtonComponent) => {
      btn
        .setButtonText('+ Add Drive Folder')
        .setCta()
        .onClick(() => {
          new DriveBrowserModal(
            this.app,
            this.pluginInstance as unknown as import('./main').default,
            'folder',
            async (item, _breadcrumbs, vaultDest) => {
              await this.pluginInstance.syncEngine.importGoogleDriveFolder(item.id, vaultDest);
              // importGoogleDriveFolder already saves the FolderMapping to settings
              mappingListEl.empty();
              this.renderFolderMappings(mappingListEl);
            },
          ).open();
        });
    });

    // ── Section 4: Sync Behaviour ───────────────────────────────────────────
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

    // ── Section 5: Google Tasks Sync ────────────────────────────────────────
    containerEl.createEl('h2', { text: 'Google Tasks Sync' });
    containerEl.createEl('p', {
      text: 'Sync your Google Tasks into notes so you can browse and manage them ' +
        'with an Obsidian Base (table/card view). Requires reconnecting your ' +
        'Google account once to grant Tasks access.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Enable Tasks sync')
      .setDesc('Turn on two-way sync between Google Tasks and notes in the tasks folder.')
      .addToggle((toggle) => {
        toggle
          .setValue(this.pluginInstance.settings.enableTasksSync)
          .onChange(async (value) => {
            this.pluginInstance.settings.enableTasksSync = value;
            await this.pluginInstance.saveSettings();
            if (value) {
              await this.pluginInstance.startTasksSyncIfEnabled();
            } else {
              this.pluginInstance.tasksSyncEngine.stop();
            }
            this.display(); // re-render to show/hide dependent controls
          });
      });

    // Only show the rest of the Tasks controls when the feature is enabled.
    if (this.pluginInstance.settings.enableTasksSync) {
      new Setting(containerEl)
        .setName('Tasks folder')
        .setDesc('Vault folder where synced task notes are stored. Keep this separate from any manual task notes.')
        .addText((text: TextComponent) => {
          text
            .setPlaceholder('Google Tasks')
            .setValue(this.pluginInstance.settings.tasksFolder)
            .onChange(async (value) => {
              this.pluginInstance.settings.tasksFolder = value.trim() || 'Google Tasks';
              await this.pluginInstance.saveSettings();
            });
        });

      new Setting(containerEl)
        .setName('Task lists to sync')
        .setDesc('Choose which Google Tasks lists to sync. If none are selected, all lists sync.');

      const listContainer = containerEl.createDiv('gtasks-list-selection');
      void this.renderTaskListCheckboxes(listContainer);

      new Setting(containerEl)
        .setName('Tasks poll interval')
        .setDesc('How often to check Google Tasks for remote changes.')
        .addDropdown((dropdown) => {
          dropdown
            .addOption('30', 'Every 30 seconds')
            .addOption('60', 'Every 60 seconds')
            .addOption('120', 'Every 2 minutes')
            .addOption('300', 'Every 5 minutes')
            .setValue(String(this.pluginInstance.settings.tasksPollIntervalSeconds))
            .onChange(async (value) => {
              this.pluginInstance.settings.tasksPollIntervalSeconds = parseInt(value, 10);
              await this.pluginInstance.saveSettings();
            });
        });

      new Setting(containerEl)
        .setName('Import now')
        .setDesc('Pull all tasks from the selected lists into the vault immediately.')
        .addButton((btn: ButtonComponent) => {
          btn
            .setButtonText('Import all task lists')
            .setCta()
            .onClick(async () => {
              btn.setButtonText('Importing…').setDisabled(true);
              try {
                const { imported, updated } =
                  await this.pluginInstance.tasksSyncEngine.importAllLists();
                new Notice(`✓ Google Tasks: ${imported} imported, ${updated} updated`);
              } catch (err) {
                new Notice(`⚠ Import failed: ${(err as Error).message}`);
              } finally {
                btn.setButtonText('Import all task lists').setDisabled(false);
              }
            });
        });
    }
  }

  /**
   * Fetch the account's task lists and render a checkbox per list. Selection is
   * stored in settings.syncedTaskListIds (empty array = sync all lists).
   */
  private async renderTaskListCheckboxes(container: HTMLElement): Promise<void> {
    container.empty();
    container.createEl('p', {
      text: 'Loading task lists…',
      cls: 'setting-item-description',
    });

    let lists: GoogleTaskList[];
    try {
      lists = await this.pluginInstance.tasksApi.listTaskLists();
    } catch (err) {
      container.empty();
      container.createEl('p', {
        text: `Could not load task lists: ${(err as Error).message}. ` +
          'You may need to reconnect your Google account to grant Tasks access.',
        cls: 'setting-item-description',
      });
      return;
    }

    container.empty();
    if (lists.length === 0) {
      container.createEl('p', {
        text: 'No task lists found in your Google account.',
        cls: 'setting-item-description',
      });
      return;
    }

    for (const list of lists) {
      new Setting(container)
        .setName(list.title)
        .addToggle((toggle) => {
          const selected = this.pluginInstance.settings.syncedTaskListIds;
          toggle
            .setValue(selected.includes(list.id))
            .onChange(async (value) => {
              const current = this.pluginInstance.settings.syncedTaskListIds;
              if (value && !current.includes(list.id)) {
                current.push(list.id);
              } else if (!value) {
                this.pluginInstance.settings.syncedTaskListIds =
                  current.filter((id) => id !== list.id);
              }
              await this.pluginInstance.saveSettings();
            });
        });
    }
  }

  private renderFolderMappings(container: HTMLElement): void {
    const mappings: FolderMapping[] = this.pluginInstance.settings.folderMappings;

    if (mappings.length === 0) {
      container.createEl('p', {
        text: 'No Drive folders connected yet.',
        cls: 'setting-item-description',
      });
      return;
    }

    mappings.forEach((mapping, index) => {
      const setting = new Setting(container)
        .setName(`📁 ${mapping.driveFolderName}`)
        .setDesc(`→ ${mapping.obsidianFolder}`)
        .addButton((btn: ButtonComponent) => {
          btn
            .setButtonText('Remove')
            .setWarning()
            .onClick(async () => {
              this.pluginInstance.settings.folderMappings.splice(index, 1);
              await this.pluginInstance.saveSettings();
              container.empty();
              this.renderFolderMappings(container);
            });
        });

      setting.settingEl.style.borderTop = 'none';
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
