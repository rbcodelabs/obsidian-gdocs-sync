import { Plugin, Notice, TFile } from 'obsidian';
import { GDocsPluginSettings, DEFAULT_SETTINGS } from './types';
import { TokenStore } from './auth/TokenStore';
import { GoogleAuth } from './auth/GoogleAuth';
import { GoogleDocsAPI } from './api/GoogleDocsAPI';
import { GoogleTasksAPI } from './api/GoogleTasksAPI';
import { SyncEngine } from './sync/SyncEngine';
import { TasksSyncEngine } from './sync/TasksSyncEngine';
import { StatusBarItem } from './ui/StatusBar';
import { FileCommandBar } from './ui/FileCommandBar';
import { FolderImportModal } from './ui/FolderImportModal';
import { DriveBrowserModal } from './ui/DriveBrowserModal';
import { GDocsSettingTab, GDocsPluginInterface } from './settings';
import { SyncStatusModal } from './ui/SyncStatusModal';

export default class GDocsPlugin extends Plugin {
  settings!: GDocsPluginSettings;

  // Core services — assigned in onload() after settings are ready
  tokenStore!: TokenStore;
  auth!: GoogleAuth;
  api!: GoogleDocsAPI;
  tasksApi!: GoogleTasksAPI;
  syncEngine!: SyncEngine;
  tasksSyncEngine!: TasksSyncEngine;
  statusBar!: StatusBarItem;
  fileCommandBar!: FileCommandBar;
  settingsTab!: GDocsSettingTab;
  /** Per-file error messages populated on push/pull failure, read by FileCommandBar */
  perFileErrors: Map<string, string> = new Map();

  async onload(): Promise<void> {
    await this.loadSettings();

    // ── Service initialisation ──────────────────────────────────────────────
    this.tokenStore = new TokenStore(this);
    this.auth = new GoogleAuth(this, this.tokenStore);
    this.api = new GoogleDocsAPI(this.tokenStore);
    this.tasksApi = new GoogleTasksAPI(this.tokenStore);
    this.syncEngine = new SyncEngine(this, this.api, this.tokenStore);
    // Tasks sync shares the Docs sync FileWatcher so there's a single vault
    // 'modify' listener/debounce map across both features.
    this.tasksSyncEngine = new TasksSyncEngine(
      this,
      this.tasksApi,
      this.tokenStore,
      this.syncEngine.getFileWatcher(),
    );
    this.statusBar = new StatusBarItem(this, () => {
      new SyncStatusModal(this.app, this as unknown as GDocsPluginInterface).open();
    });

    this.fileCommandBar = new FileCommandBar(this);

    // Refresh the file command bar whenever a sync completes
    this.syncEngine.addSyncListener((path) => {
      this.fileCommandBar.update(path);
    });

    // ── OAuth protocol handler — registered once here, persistent for plugin lifetime ──
    // Handles obsidian://gdocs-sync in Obsidian and geode://gdocs-sync in Geode.
    console.log('[GDocsPlugin] Registering gdocs-sync protocol handler...');
    this.registerObsidianProtocolHandler('gdocs-sync', async (params) => {
      console.log('[GDocsPlugin] Protocol handler fired! Raw params:', JSON.stringify(params));
      await this.auth.handleCallback(params);
    });
    console.log('[GDocsPlugin] Protocol handler registered.');

    // After a successful connect: refresh settings UI, start the sync engine,
    // and update the status bar so it stops showing "reconnect required".
    this.auth.onConnected = () => {
      this.settingsTab?.display();
      void this.syncEngine.start().then(() => {
        this.statusBar.setIdle();
        void this.startTasksSyncIfEnabled();
      }).catch((err: Error) => {
        console.error('[GDocsPlugin] Failed to start sync engine after reconnect:', err);
        this.statusBar.setError('startup failed');
      });
    };

    // ── Settings tab ────────────────────────────────────────────────────────
    this.settingsTab = new GDocsSettingTab(this.app, this as unknown as GDocsPluginInterface);
    this.addSettingTab(this.settingsTab);

    // ── Commands ────────────────────────────────────────────────────────────

    // Sync the currently active note to Google Docs
    this.addCommand({
      id: 'sync-current-note',
      name: 'Sync current note to Google Docs',
      callback: async () => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
          new Notice('No active note to sync.');
          return;
        }
        if (activeFile.extension !== 'md') {
          new Notice('Only Markdown notes can be synced.');
          return;
        }

        this.statusBar.setSyncing(activeFile.basename);
        try {
          await this.syncEngine.syncLocalToRemote(activeFile, true /* force */);
          this.statusBar.setSynced();
          this.perFileErrors.delete(activeFile.path);
          this.fileCommandBar.update(activeFile.path);
          new Notice(`✓ Synced "${activeFile.basename}" to Google Docs`);
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.includes('revoked')) {
            this.statusBar.setReauthNeeded();
          } else {
            this.statusBar.setError('sync failed');
          }
          this.perFileErrors.set(activeFile.path, msg);
          this.fileCommandBar.update(activeFile.path);
          new Notice(`⚠ Sync failed: ${msg}`);
        }
      },
    });

    // Pull the currently active note FROM Google Docs (remote wins, no conflict check)
    this.addCommand({
      id: 'pull-current-note',
      name: 'Pull current note from Google Docs',
      callback: async () => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
          new Notice('No active note to pull.');
          return;
        }

        const meta = this.app.metadataCache.getFileCache(activeFile);
        const docId: string | undefined = meta?.frontmatter?.['gdocs-id'];
        if (!docId) {
          new Notice('This note is not linked to a Google Doc.');
          return;
        }

        this.statusBar.setSyncing(activeFile.basename);
        try {
          await this.syncEngine.syncRemoteToLocal(docId, true /* forceRemote */);
          this.statusBar.setSynced();
          this.perFileErrors.delete(activeFile.path);
          this.fileCommandBar.update(activeFile.path);
          new Notice(`✓ Pulled latest "${activeFile.basename}" from Google Docs`);
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.includes('revoked')) {
            this.statusBar.setReauthNeeded();
          } else {
            this.statusBar.setError('pull failed');
          }
          this.perFileErrors.set(activeFile.path, msg);
          this.fileCommandBar.update(activeFile.path);
          new Notice(`⚠ Pull failed: ${msg}`);
        }
      },
    });

    // Open the Drive browser modal for importing a single doc
    this.addCommand({
      id: 'import-google-doc',
      name: 'Import Google Doc',
      callback: () => {
        new DriveBrowserModal(
          this.app,
          this,
          'doc',
          async (item, _breadcrumbs, _vaultDest) => {
            this.statusBar.setSyncing('import');
            try {
              await this.syncEngine.importGoogleDoc(item.id);
              this.statusBar.setSynced();
            } catch (err) {
              this.statusBar.setError('import failed');
              throw err; // let modal show the notice
            }
          },
        ).open();
      },
    });

    // Open the Drive folder import modal
    this.addCommand({
      id: 'import-drive-folder',
      name: 'Import Google Drive folder',
      callback: () => {
        new FolderImportModal(
          this.app,
          this.api,
          this.syncEngine,
          () => this.settingsTab?.display(),
        ).open();
      },
    });

    // Sync all notes that match sync rules (tag or folder)
    this.addCommand({
      id: 'sync-all-tagged-notes',
      name: 'Sync all tagged notes',
      callback: async () => {
        const files = this.app.vault.getMarkdownFiles();
        const eligible: TFile[] = [];

        for (const file of files) {
          if (await this.syncEngine.shouldSync(file)) {
            eligible.push(file);
          }
        }

        if (eligible.length === 0) {
          new Notice('No notes found matching sync rules.');
          return;
        }

        new Notice(`Syncing ${eligible.length} note(s) to Google Docs...`);
        this.statusBar.setSyncing(`${eligible.length} notes`);

        let successCount = 0;
        let errorCount = 0;

        for (const file of eligible) {
          try {
            await this.syncEngine.syncLocalToRemote(file);
            successCount++;
          } catch {
            errorCount++;
            console.error(`[GDocsPlugin] Failed to sync ${file.path}`);
          }
        }

        if (errorCount === 0) {
          this.statusBar.setSynced();
          new Notice(`✓ Synced ${successCount} note(s) to Google Docs`);
        } else {
          this.statusBar.setError(`${errorCount} error(s)`);
          new Notice(
            `Sync complete: ${successCount} succeeded, ${errorCount} failed. Check the console for details.`,
          );
        }
      },
    });

    // Sync Google Tasks now (incremental poll on demand)
    this.addCommand({
      id: 'sync-google-tasks-now',
      name: 'Sync Google Tasks now',
      callback: async () => {
        if (!this.settings.enableTasksSync) {
          new Notice('Google Tasks sync is disabled. Enable it in plugin settings.');
          return;
        }
        if (this.tokenStore.get() === null) {
          new Notice('Connect your Google account first.');
          return;
        }
        this.statusBar.setSyncing('tasks');
        try {
          await this.tasksSyncEngine.poll();
          this.statusBar.setSynced();
          new Notice('✓ Google Tasks synced');
        } catch (err) {
          this.statusBar.setError('tasks sync failed');
          new Notice(`⚠ Google Tasks sync failed: ${(err as Error).message}`);
        }
      },
    });

    // Import all task lists (full pull)
    this.addCommand({
      id: 'import-all-task-lists',
      name: 'Import all Google Tasks lists',
      callback: async () => {
        if (!this.settings.enableTasksSync) {
          new Notice('Google Tasks sync is disabled. Enable it in plugin settings.');
          return;
        }
        if (this.tokenStore.get() === null) {
          new Notice('Connect your Google account first.');
          return;
        }
        this.statusBar.setSyncing('tasks import');
        try {
          const { imported, updated } = await this.tasksSyncEngine.importAllLists();
          this.statusBar.setSynced();
          new Notice(`✓ Google Tasks: ${imported} imported, ${updated} updated`);
        } catch (err) {
          this.statusBar.setError('tasks import failed');
          new Notice(`⚠ Google Tasks import failed: ${(err as Error).message}`);
        }
      },
    });

    // ── Start sync engine ────────────────────────────────────────────────────
    // Only start if the user is already connected (has valid tokens).
    if (this.tokenStore.get() !== null) {
      // Eagerly validate the token on startup so we immediately show
      // "reconnect required" if the refresh token has been revoked — rather
      // than waiting up to pollIntervalSeconds for the first poll to fire.
      // If the access token is still fresh this is a no-op (no network call).
      // Any auth error (invalid_grant, network failure, proxy error) means
      // the user needs to reconnect — don't attempt to start the engine.
      let tokenOk = false;
      try {
        await this.tokenStore.getValidAccessToken();
        tokenOk = true;
      } catch (err) {
        console.error('[GDocsPlugin] Token validation failed on startup:', err);
        this.statusBar.setReauthNeeded();
      }

      if (tokenOk) {
        try {
          await this.syncEngine.start();
          this.statusBar.setIdle();
          await this.startTasksSyncIfEnabled();
        } catch (err) {
          console.error('[GDocsPlugin] Failed to start sync engine:', err);
          this.statusBar.setError('startup failed');
        }
      }
    } else {
      this.statusBar.setIdle();
    }

    console.log('[GDocsPlugin] Loaded — Google Docs Sync v' + this.manifest.version);
  }

  onunload(): void {
    this.syncEngine?.stop();
    this.tasksSyncEngine?.stop();
    this.fileCommandBar?.destroy();
    console.log('[GDocsPlugin] Unloaded');
  }

  /**
   * Start Google Tasks sync if the feature is enabled. Safe to call multiple
   * times — the engine registers its handlers once and the shared FileWatcher
   * start() is idempotent. Called from settings when the user toggles it on.
   */
  async startTasksSyncIfEnabled(): Promise<void> {
    if (!this.settings.enableTasksSync) return;
    if (this.tokenStore.get() === null) return;
    try {
      await this.tasksSyncEngine.start();
    } catch (err) {
      console.error('[GDocsPlugin] Failed to start Tasks sync engine:', err);
    }
  }

  // ── Settings persistence ─────────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
