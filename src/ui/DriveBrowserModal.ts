import { App, Modal, Notice, Setting } from 'obsidian';
import { DriveItem } from '../types';
import GDocsPlugin from '../main';

export class DriveBrowserModal extends Modal {
  private mode: 'folder' | 'doc';
  private onSelect: (item: DriveItem, breadcrumbs: DriveItem[], vaultDest: string) => Promise<void>;
  private plugin: GDocsPlugin;

  private currentFolderId = 'root';
  private breadcrumbs: DriveItem[] = [];
  private items: DriveItem[] = [];
  private loading = false;
  private selectedItem: DriveItem | null = null;
  private vaultDestination = '';

  // DOM references (set once in renderShell, updated in-place after)
  private breadcrumbEl!: HTMLElement;
  private listEl!: HTMLElement;
  private ctaEl!: HTMLElement;

  constructor(
    app: App,
    plugin: GDocsPlugin,
    mode: 'folder' | 'doc',
    onSelect: (item: DriveItem, breadcrumbs: DriveItem[], vaultDest: string) => Promise<void>,
  ) {
    super(app);
    this.plugin = plugin;
    this.mode = mode;
    this.onSelect = onSelect;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('gdocs-drive-browser');
    this.setTitle(this.mode === 'folder' ? 'Select a Drive Folder to Sync' : 'Browse Google Drive');
    this.renderShell();
    this.loadFolder('root');
  }

  onClose() {
    this.contentEl.empty();
  }

  private renderShell() {
    const { contentEl } = this;
    contentEl.empty();

    this.breadcrumbEl = contentEl.createDiv({ cls: 'gdocs-breadcrumbs' });
    this.listEl = contentEl.createDiv({ cls: 'gdocs-file-list' });
    this.listEl.style.overflowY = 'auto';
    this.listEl.style.maxHeight = '380px';
    this.listEl.style.marginTop = '8px';
    this.ctaEl = contentEl.createDiv({ cls: 'gdocs-drive-cta' });
    this.ctaEl.style.marginTop = '12px';
  }

  private loadFolder(folderId: string, folderItem?: DriveItem) {
    this.loading = true;
    this.selectedItem = null;
    this.currentFolderId = folderId;
    if (folderItem) this.breadcrumbs.push(folderItem);

    this.renderBreadcrumbs();
    this.renderList();   // shows spinner immediately
    this.renderCTA();

    this.plugin.api.listFolderContents(folderId).then(items => {
      this.items = items;
      this.loading = false;
      this.renderList();
      this.renderCTA();
    }).catch(err => {
      this.loading = false;
      new Notice('Failed to load Drive folder: ' + (err?.message ?? err));
      this.renderList();
    });
  }

  private resetToRoot() {
    this.breadcrumbs = [];
    this.selectedItem = null;
    this.loadFolder('root');
  }

  private renderBreadcrumbs() {
    this.breadcrumbEl.empty();

    const rootSpan = this.breadcrumbEl.createEl('span', { text: 'My Drive', cls: 'gdocs-crumb gdocs-crumb-link' });
    rootSpan.style.cursor = 'pointer';
    rootSpan.style.textDecoration = 'underline';
    rootSpan.addEventListener('click', () => this.resetToRoot());

    this.breadcrumbs.forEach((crumb, i) => {
      this.breadcrumbEl.createEl('span', { text: ' › ' });
      const isLast = i === this.breadcrumbs.length - 1;
      if (isLast) {
        this.breadcrumbEl.createEl('span', { text: crumb.name, cls: 'gdocs-crumb' });
      } else {
        const span = this.breadcrumbEl.createEl('span', { text: crumb.name, cls: 'gdocs-crumb gdocs-crumb-link' });
        span.style.cursor = 'pointer';
        span.style.textDecoration = 'underline';
        span.addEventListener('click', () => {
          this.breadcrumbs = this.breadcrumbs.slice(0, i); // pop back to this level
          this.loadFolder(crumb.id);
        });
      }
    });
  }

  private renderList() {
    this.listEl.empty();

    if (this.loading) {
      this.listEl.createEl('p', { text: '⏳ Loading…', cls: 'gdocs-loading' });
      return;
    }

    if (this.items.length === 0) {
      this.listEl.createEl('p', { text: 'This folder is empty.', cls: 'gdocs-empty' });
      return;
    }

    for (const item of this.items) {
      const isFolder = item.mimeType === 'application/vnd.google-apps.folder';
      const isSelectable = (this.mode === 'folder' && isFolder) || (this.mode === 'doc' && !isFolder);
      const icon = isFolder ? '📁' : '📄';

      const row = this.listEl.createDiv({ cls: 'gdocs-drive-item' });
      row.style.padding = '6px 8px';
      row.style.borderRadius = '4px';
      row.style.cursor = isSelectable ? 'pointer' : 'default';
      row.style.opacity = isSelectable ? '1' : '0.4';
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '8px';

      row.createEl('span', { text: icon });
      row.createEl('span', { text: item.name });

      if (isSelectable) {
        row.addEventListener('click', () => {
          // Clear selection highlight on all rows
          this.listEl.querySelectorAll('.gdocs-drive-item--selected').forEach(el => {
            el.removeClass('gdocs-drive-item--selected');
            (el as HTMLElement).style.background = '';
            (el as HTMLElement).style.color = '';
          });
          // Highlight this row
          row.addClass('gdocs-drive-item--selected');
          row.style.background = 'var(--interactive-accent)';
          row.style.color = 'var(--text-on-accent)';

          this.selectedItem = item;
          this.vaultDestination = item.name;
          this.renderCTA();
        });

        if (isFolder) {
          // Double-click navigates into folder
          row.addEventListener('dblclick', () => {
            this.selectedItem = null;
            this.loadFolder(item.id, item);
          });
        }
      } else if (isFolder && this.mode === 'doc') {
        // In doc mode, folders are still navigable but not selectable
        row.style.cursor = 'pointer';
        row.style.opacity = '1';
        row.addEventListener('dblclick', () => {
          this.loadFolder(item.id, item);
        });
        // Single click on folder in doc mode: navigate in
        row.addEventListener('click', () => {
          this.loadFolder(item.id, item);
        });
      }
    }
  }

  private renderCTA() {
    this.ctaEl.empty();

    if (!this.selectedItem) {
      const cancelBtn = this.ctaEl.createEl('button', { text: 'Cancel' });
      cancelBtn.addEventListener('click', () => this.close());
      return;
    }

    if (this.mode === 'folder') {
      new Setting(this.ctaEl)
        .setName('Vault folder')
        .setDesc('Where to save synced notes in your vault')
        .addText(text => {
          text.setValue(this.vaultDestination || this.selectedItem!.name);
          text.onChange(val => { this.vaultDestination = val; });
        });
    }

    const btnRow = this.ctaEl.createDiv();
    btnRow.style.display = 'flex';
    btnRow.style.gap = '8px';
    btnRow.style.justifyContent = 'flex-end';
    btnRow.style.marginTop = '8px';

    const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => this.close());

    const label = this.mode === 'folder' ? 'Sync This Folder' : 'Import Doc';
    const confirmBtn = btnRow.createEl('button', { text: label, cls: 'mod-cta' });
    confirmBtn.addEventListener('click', async () => {
      if (!this.selectedItem) return;
      const dest = this.vaultDestination || this.selectedItem.name;
      try {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Working…';
        await this.onSelect(this.selectedItem, [...this.breadcrumbs], dest);
        this.close();
      } catch (err) {
        new Notice('Error: ' + ((err as Error)?.message ?? err));
        confirmBtn.disabled = false;
        confirmBtn.textContent = label;
      }
    });
  }
}
