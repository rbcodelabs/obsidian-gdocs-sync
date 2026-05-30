import { App, Modal } from 'obsidian';
import { GDocsPluginInterface } from '../settings';

interface DocStatus {
  noteName: string;
  notePath: string;
  docId: string;
  docUrl: string;
  lastSyncAt: string;
  isSyncing: boolean;
  isPolled: boolean;
}

export class SyncStatusModal extends Modal {
  constructor(
    app: App,
    private plugin: GDocsPluginInterface,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('gdocs-status-modal');

    contentEl.createEl('h2', { text: 'Google Docs Sync Status' });

    const { settings, syncEngine } = this.plugin;

    // ── Account ──────────────────────────────────────────────────────────────
    const accountSection = contentEl.createDiv('gdocs-status-section');
    accountSection.createEl('h3', { text: 'Account' });

    const hasTokens = settings.tokens !== null;
    const reauthNeeded = this.plugin.statusBar.reauthNeeded;
    // Show as "connected" only if we have tokens AND auth is not broken
    const isConnected = hasTokens && !reauthNeeded;

    const accountRow = accountSection.createDiv('gdocs-status-row');

    if (reauthNeeded) {
      accountRow.createEl('span', {
        text: '⚠ Google account token expired — reconnect required',
        cls: 'gdocs-status-warn',
      });
      const reconnectBtn = accountRow.createEl('button', {
        text: 'Reconnect Google Account',
        cls: 'mod-cta gdocs-reconnect-btn',
      });
      reconnectBtn.addEventListener('click', () => {
        void this.plugin.auth.connect();
        this.close();
      });
    } else {
      accountRow.createEl('span', {
        text: isConnected
          ? `Connected as ${settings.connectedEmail || 'Google user'}`
          : 'Not connected to Google',
        cls: isConnected ? 'gdocs-status-ok' : 'gdocs-status-warn',
      });
      if (!isConnected) {
        const connectBtn = accountRow.createEl('button', {
          text: 'Connect Google Account',
          cls: 'mod-cta gdocs-reconnect-btn',
        });
        connectBtn.addEventListener('click', () => {
          void this.plugin.auth.connect();
          this.close();
        });
      }
    }

    // ── Synced Documents ──────────────────────────────────────────────────────
    const docsSection = contentEl.createDiv('gdocs-status-section');
    docsSection.createEl('h3', { text: 'Synced Documents' });

    const files = this.app.vault.getMarkdownFiles();
    const syncedDocIds = syncEngine.getSyncedDocIds();
    const docStatuses: DocStatus[] = [];

    for (const file of files) {
      const meta = this.app.metadataCache.getFileCache(file);
      const docId: string | undefined = meta?.frontmatter?.['gdocs-id'];
      if (!docId) continue;

      docStatuses.push({
        noteName: file.basename,
        notePath: file.path,
        docId,
        docUrl:
          (meta?.frontmatter?.['gdocs-url'] as string | undefined) ??
          `https://docs.google.com/document/d/${docId}/edit`,
        lastSyncAt: (meta?.frontmatter?.['gdocs-last-sync'] as string | undefined) ?? '',
        isSyncing: syncEngine.isSyncing(file.path) || syncEngine.isSyncing(docId),
        isPolled: syncedDocIds.has(docId),
      });
    }

    if (docStatuses.length === 0) {
      docsSection.createEl('p', {
        text: 'No notes are currently linked to Google Docs.',
        cls: 'gdocs-status-empty',
      });
    } else {
      const table = docsSection.createEl('table', { cls: 'gdocs-status-table' });
      const thead = table.createEl('thead');
      const headerRow = thead.createEl('tr');
      headerRow.createEl('th', { text: 'Note' });
      headerRow.createEl('th', { text: 'Status' });
      headerRow.createEl('th', { text: 'Last Sync' });
      headerRow.createEl('th', { text: '' });

      const tbody = table.createEl('tbody');

      for (const doc of docStatuses) {
        const row = tbody.createEl('tr');

        // Note name — click to open
        const noteCell = row.createEl('td');
        const noteLink = noteCell.createEl('a', {
          text: doc.noteName,
          cls: 'gdocs-note-link',
          href: '#',
        });
        noteLink.addEventListener('click', (e) => {
          e.preventDefault();
          void this.app.workspace.openLinkText(doc.notePath, '', false);
          this.close();
        });

        // Status pill
        const statusCell = row.createEl('td');
        if (doc.isSyncing) {
          statusCell.createEl('span', { text: '⟳ Syncing', cls: 'gdocs-pill gdocs-pill-syncing' });
        } else if (doc.isPolled) {
          statusCell.createEl('span', { text: '✓ Active', cls: 'gdocs-pill gdocs-pill-ok' });
        } else {
          statusCell.createEl('span', { text: '○ Linked', cls: 'gdocs-pill gdocs-pill-linked' });
        }

        // Last sync
        const timeCell = row.createEl('td', { cls: 'gdocs-time-cell' });
        if (doc.lastSyncAt) {
          const date = new Date(doc.lastSyncAt);
          timeCell.setText(this.formatRelativeTime(date));
          timeCell.title = date.toLocaleString();
        } else {
          timeCell.setText('Never');
        }

        // Open in GDocs link
        const actionsCell = row.createEl('td', { cls: 'gdocs-actions-cell' });
        const gdocsLink = actionsCell.createEl('a', {
          text: '↗',
          title: 'Open in Google Docs',
          href: doc.docUrl,
          cls: 'gdocs-external-link',
        });
        gdocsLink.target = '_blank';
        gdocsLink.rel = 'noopener';
      }
    }

    // ── Folder Mappings ──────────────────────────────────────────────────────
    const { folderMappings } = settings;
    if (folderMappings.length > 0) {
      const foldersSection = contentEl.createDiv('gdocs-status-section');
      foldersSection.createEl('h3', { text: 'Folder Sync' });

      for (const mapping of folderMappings) {
        const row = foldersSection.createDiv('gdocs-folder-mapping-row');
        row.createEl('span', {
          text: `📁 ${mapping.driveFolderName}`,
          cls: 'gdocs-folder-drive',
        });
        row.createEl('span', { text: ' → ', cls: 'gdocs-folder-arrow' });
        row.createEl('span', {
          text: mapping.obsidianFolder,
          cls: 'gdocs-folder-vault',
        });
      }
    }

    // ── Config summary ────────────────────────────────────────────────────────
    const configSection = contentEl.createDiv('gdocs-status-section');
    configSection.createEl('h3', { text: 'Configuration' });

    const configGrid = configSection.createDiv('gdocs-config-grid');
    configGrid.createEl('div', {
      text: `Poll interval: every ${settings.pollIntervalSeconds}s`,
    });
    configGrid.createEl('div', {
      text: `Auto-sync on save: ${settings.autoSyncOnSave ? 'on' : 'off'}`,
    });
    if (settings.syncTag) {
      configGrid.createEl('div', { text: `Sync tag: #${settings.syncTag}` });
    }
    if (settings.syncFolders.length > 0) {
      configGrid.createEl('div', {
        text: `Sync folders: ${settings.syncFolders.join(', ')}`,
      });
    }

    // ── Footer ────────────────────────────────────────────────────────────────
    const footer = contentEl.createDiv('gdocs-status-footer');
    const settingsBtn = footer.createEl('button', {
      text: 'Open Settings',
      cls: 'mod-cta',
    });
    settingsBtn.addEventListener('click', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.app as any).setting?.open();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.app as any).setting?.openTabById('obsidian-gdocs-sync');
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private formatRelativeTime(date: Date): string {
    const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
    if (diffSec < 60) return 'just now';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return `${Math.floor(diffSec / 86400)}d ago`;
  }
}
