import { Plugin, TFile, Notice } from 'obsidian';
import { GDocsPluginSettings, FolderMapping, SyncMeta } from '../types';
import { GoogleDocsAPI } from '../api/GoogleDocsAPI';
import { TokenStore } from '../auth/TokenStore';
import { GDocsPoller } from './GDocsPoller';
import { FileWatcher } from './FileWatcher';
import { FolderPoller } from './FolderPoller';
import { ConflictResolver } from './ConflictResolver';
import { htmlToMarkdown, extractDocTitle } from '../converter/HtmlToMarkdown';
import { markdownToGDocsRequests } from '../converter/MarkdownToGDocs';

type PluginWithSettings = Plugin & {
  settings: GDocsPluginSettings;
  saveSettings(): Promise<void>;
};

// sha256 via Web Crypto (available in Electron/browser context)
async function sha256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Strip YAML frontmatter (--- ... ---) from note content before syncing
export function stripFrontmatter(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  return match ? match[1].trimStart() : content;
}

// Parse a Google Docs URL or raw document ID into a document ID
export function parseDocId(urlOrId: string): string {
  const urlMatch = urlOrId.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return urlMatch ? urlMatch[1] : urlOrId.trim();
}

export class SyncEngine {
  private poller: GDocsPoller;
  private folderPoller: FolderPoller;
  private fileWatcher: FileWatcher;
  private conflictResolver: ConflictResolver;

  // Prevents concurrent syncs of the same file. Key: file path or docId.
  private syncQueue: Map<string, Promise<void>> = new Map();

  // docId → last known Drive revision string (populated on start)
  private syncedDocs: Map<string, string> = new Map();

  constructor(
    private plugin: PluginWithSettings,
    private api: GoogleDocsAPI,
    private tokenStore: TokenStore,
  ) {
    this.conflictResolver = new ConflictResolver();

    this.poller = new GDocsPoller(
      this.api,
      (docId) => this.syncRemoteToLocal(docId),
      this.plugin.settings.pollIntervalSeconds,
    );

    this.fileWatcher = new FileWatcher(this.plugin, async (file) => {
      if (this.plugin.settings.autoSyncOnSave && (await this.shouldSync(file))) {
        await this.syncLocalToRemote(file);
      }
    });

    this.folderPoller = new FolderPoller(
      () => this.plugin.settings.folderMappings,
      (folderId, obsidianFolder) => this.importGoogleDriveFolder(folderId, obsidianFolder),
    );
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    // Discover all notes that already have a gdocs-id in their frontmatter
    await this.loadSyncedDocs();

    this.fileWatcher.start();
    this.poller.start(this.syncedDocs);
    this.folderPoller.start();
  }

  stop(): void {
    this.poller.stop();
    this.folderPoller.stop();
  }

  /** Returns the set of docIds currently registered for polling. */
  getSyncedDocIds(): Set<string> {
    return new Set(this.syncedDocs.keys());
  }

  /** Returns true if the given file path or docId is currently mid-sync. */
  isSyncing(key: string): boolean {
    return this.syncQueue.has(key);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Walk the vault and build the syncedDocs map from notes that have
   * gdocs-id frontmatter. Also fetches the current revision for each
   * so the poller has a baseline to compare against.
   */
  private async loadSyncedDocs(): Promise<void> {
    const files = this.plugin.app.vault.getMarkdownFiles();

    await Promise.allSettled(
      files.map(async (file) => {
        const meta = this.plugin.app.metadataCache.getFileCache(file);
        const gdocsId: string | undefined = meta?.frontmatter?.['gdocs-id'];
        if (!gdocsId) return;

        try {
          const revision = await this.api.getDocumentRevision(gdocsId);
          this.syncedDocs.set(gdocsId, revision);
        } catch {
          // Doc may have been deleted or permissions revoked — skip silently
          console.warn(`[SyncEngine] Could not load revision for doc ${gdocsId}`);
        }
      }),
    );
  }

  /**
   * Returns true if this file should be automatically synced based on:
   * 1. It already has a gdocs-id (explicitly linked)
   * 2. Its tags include the configured syncTag
   * 3. Its path starts with one of the configured syncFolders
   */
  async shouldSync(file: TFile): Promise<boolean> {
    const meta = this.plugin.app.metadataCache.getFileCache(file);
    if (!meta) return false;

    // Already linked to a Google Doc
    if (meta.frontmatter?.['gdocs-id']) return true;

    // Check tags
    const { syncTag, syncFolders } = this.plugin.settings;
    const tags: string[] = meta.frontmatter?.tags ?? [];
    const tagList = Array.isArray(tags) ? tags : [tags];
    if (syncTag && tagList.includes(syncTag)) return true;

    // Check folder membership (manual syncFolders list)
    for (const folder of syncFolders) {
      if (file.path.startsWith(folder.replace(/\/$/, '') + '/')) return true;
    }

    // Check Drive folder mappings
    const { folderMappings } = this.plugin.settings;
    for (const mapping of folderMappings) {
      if (file.path.startsWith(mapping.obsidianFolder.replace(/\/$/, '') + '/')) return true;
    }

    return false;
  }

  // ─── Core sync operations ─────────────────────────────────────────────────

  /**
   * Push local note content to its linked Google Doc.
   * Pass force=true (e.g. from the manual "Sync current note" command) to
   * bypass the hash-skip optimization and always push. The skip is useful for
   * auto-sync-on-save but wrong for an explicit user action.
   * Clears the document and re-inserts all content from scratch (safe for v1;
   * v2 could do diff-based updates to preserve comments and suggestions).
   */
  async syncLocalToRemote(file: TFile, force = false): Promise<void> {
    // Deduplicate concurrent syncs of the same file
    const existing = this.syncQueue.get(file.path);
    if (existing) return existing;

    const task = this._syncLocalToRemote(file, force);
    this.syncQueue.set(file.path, task);
    try {
      await task;
    } finally {
      this.syncQueue.delete(file.path);
    }
  }

  private async _syncLocalToRemote(file: TFile, force = false): Promise<void> {
    const meta = this.plugin.app.metadataCache.getFileCache(file);
    let docId: string | undefined = meta?.frontmatter?.['gdocs-id'];

    // If no doc is linked yet, create one
    if (!docId) {
      docId = await this.createDocForNote(file);
    }

    const rawContent = await this.plugin.app.vault.read(file);
    const bodyContent = stripFrontmatter(rawContent);
    const hash = await sha256(bodyContent);

    // Skip if content hasn't changed since last sync — but never skip a forced push
    const lastHash: string | undefined = meta?.frontmatter?.['gdocs-hash'];
    if (!force && lastHash && lastHash === hash) return;

    try {
      await this.api.clearDocument(docId);
      const requests = markdownToGDocsRequests(bodyContent);
      if (requests.length > 0) {
        await this.api.batchUpdate(docId, requests);
      }

      // Record updated revision so the poller doesn't immediately fire back
      const newRevision = await this.api.getDocumentRevision(docId);
      this.syncedDocs.set(docId, newRevision);

      await this.updateFrontmatter(file, {
        gdocsId: docId,
        gdocsUrl: `https://docs.google.com/document/d/${docId}/edit`,
        lastSyncAt: new Date().toISOString(),
        lastSyncHash: hash,
      });
    } catch (err) {
      new Notice(`⚠ GDocs Sync: Failed to sync "${file.basename}" to Google Docs`);
      console.error('[SyncEngine] syncLocalToRemote error:', err);
      throw err;
    }
  }

  /**
   * Pull a Google Doc's current content and write it to the matching local note.
   * Pass forceRemote=true to skip conflict detection (e.g. explicit "Pull" command).
   * Otherwise uses hash-based conflict detection: if local content hasn't changed
   * since the last sync (hashes match), remote wins automatically. If both sides
   * changed, local wins to avoid silently overwriting the user's edits.
   */
  async syncRemoteToLocal(docId: string, forceRemote = false): Promise<void> {
    const existing = this.syncQueue.get(docId);
    if (existing) return existing;

    const task = this._syncRemoteToLocal(docId, forceRemote);
    this.syncQueue.set(docId, task);
    try {
      await task;
    } finally {
      this.syncQueue.delete(docId);
    }
  }

  private async _syncRemoteToLocal(docId: string, forceRemote = false): Promise<void> {
    // Find the local file that owns this docId
    const files = this.plugin.app.vault.getMarkdownFiles();
    const file = files.find((f) => {
      const cache = this.plugin.app.metadataCache.getFileCache(f);
      return cache?.frontmatter?.['gdocs-id'] === docId;
    });

    if (!file) {
      console.warn(`[SyncEngine] No local file found for docId ${docId}`);
      return;
    }

    try {
      const html = await this.api.exportAsHtml(docId);
      const remoteMarkdown = htmlToMarkdown(html);

      if (!forceRemote) {
        // Hash-based conflict detection: check whether local content has changed
        // since the last sync. Timestamp comparison is unreliable because
        // updateFrontmatter touches the file on every push, keeping mtime fresh.
        const rawContent = await this.plugin.app.vault.read(file);
        const localBodyContent = stripFrontmatter(rawContent);
        const localHash = await sha256(localBodyContent);
        const meta = this.plugin.app.metadataCache.getFileCache(file);
        const lastSyncHash: string | undefined = meta?.frontmatter?.['gdocs-hash'];

        if (lastSyncHash && localHash !== lastSyncHash) {
          // Local was edited since the last sync — treat local as authoritative
          // to avoid silently clobbering the user's work. Push local to remote.
          console.log(`[SyncEngine] Conflict on ${file.path}: local edited since last sync. Local wins.`);
          await this.syncLocalToRemote(file);
          return;
        }
        // If hashes match (or no prior hash), local is unchanged — remote wins.
      }

      // Remote wins — overwrite local body content, preserving frontmatter
      const rawContent = await this.plugin.app.vault.read(file);
      const frontmatterMatch = rawContent.match(/^(---\n[\s\S]*?\n---\n?)/);
      const existingFrontmatter = frontmatterMatch ? frontmatterMatch[1] : '';

      const newContent = existingFrontmatter
        ? existingFrontmatter + remoteMarkdown
        : remoteMarkdown;

      await this.plugin.app.vault.modify(file, newContent);

      const hash = await sha256(remoteMarkdown);
      await this.updateFrontmatter(file, {
        lastSyncAt: new Date().toISOString(),
        lastSyncHash: hash,
      });
    } catch (err) {
      console.error(`[SyncEngine] syncRemoteToLocal error for ${docId}:`, err);
      new Notice(`⚠ GDocs Sync: Failed to pull changes for doc ${docId}`);
      throw err;
    }
  }

  /**
   * Create a new Google Doc for a note that doesn't have one yet.
   * Writes the gdocs-id and gdocs-url to frontmatter, and adds the doc to
   * the polling map.
   */
  async createDocForNote(file: TFile): Promise<string> {
    const { documentId, documentUrl } = await this.api.createDocument(file.basename);

    // Bootstrap the revision so the poller starts from a known state
    const revision = await this.api.getDocumentRevision(documentId);
    this.syncedDocs.set(documentId, revision);

    await this.updateFrontmatter(file, {
      gdocsId: documentId,
      gdocsUrl: documentUrl,
      lastSyncAt: new Date().toISOString(),
      lastSyncHash: '',
    });

    new Notice(`✓ Created Google Doc for "${file.basename}"`);
    return documentId;
  }

  /**
   * Import an existing Google Doc into the vault as a new Markdown note.
   * The note is placed in the vault root; v2 should allow choosing a folder.
   */
  async importGoogleDoc(docIdOrUrl: string): Promise<void> {
    const docId = parseDocId(docIdOrUrl);
    if (!docId) {
      new Notice('⚠ GDocs Sync: Could not parse document ID from the provided input.');
      return;
    }

    try {
      const html = await this.api.exportAsHtml(docId);
      const markdown = htmlToMarkdown(html);
      const title = extractDocTitle(html);
      const hash = await sha256(markdown);

      const docUrl = `https://docs.google.com/document/d/${docId}/edit`;

      // Build frontmatter block
      const frontmatter = [
        '---',
        `gdocs-id: ${docId}`,
        `gdocs-url: "${docUrl}"`,
        `gdocs-last-sync: ${new Date().toISOString()}`,
        `gdocs-hash: ${hash}`,
        '---',
        '',
      ].join('\n');

      const noteContent = frontmatter + markdown;

      // Use the Google Doc title as the note filename, sanitised for the OS
      const safeTitle = (title || 'Imported Google Doc')
        .replace(/[/\\:*?"<>|]/g, '-')
        .trim();

      const notePath = `${safeTitle}.md`;
      await this.plugin.app.vault.create(notePath, noteContent);

      // Track for polling
      const revision = await this.api.getDocumentRevision(docId);
      this.syncedDocs.set(docId, revision);

      new Notice(`✓ Imported "${title}" as ${notePath}`);
    } catch (err) {
      console.error('[SyncEngine] importGoogleDoc error:', err);
      new Notice(`⚠ GDocs Sync: Import failed — ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Import all Google Docs from a Drive folder into an Obsidian vault folder.
   * - Creates the vault folder if it doesn't exist.
   * - Skips any doc that is already linked (has a matching gdocs-id frontmatter).
   * - Saves a FolderMapping to settings so the folder stays in sync going forward.
   *
   * Returns the count of imported and skipped docs, and the Drive folder name.
   */
  async importGoogleDriveFolder(
    folderId: string,
    obsidianFolder: string,
  ): Promise<{ imported: number; skipped: number; folderName: string }> {
    // Fetch folder metadata and doc list from Drive
    const [folderName, docs] = await Promise.all([
      this.api.getFolderName(folderId),
      this.api.listDocsInFolder(folderId),
    ]);

    if (docs.length === 0) {
      return { imported: 0, skipped: 0, folderName };
    }

    // Ensure the vault folder exists
    const folderExists = this.plugin.app.vault.getFolderByPath(obsidianFolder);
    if (!folderExists) {
      await this.plugin.app.vault.createFolder(obsidianFolder);
    }

    // Build a set of already-synced doc IDs to detect duplicates
    const existingDocIds = new Set<string>();
    for (const file of this.plugin.app.vault.getMarkdownFiles()) {
      const cache = this.plugin.app.metadataCache.getFileCache(file);
      const id: string | undefined = cache?.frontmatter?.['gdocs-id'];
      if (id) existingDocIds.add(id);
    }

    let imported = 0;
    let skipped = 0;

    for (const driveFile of docs) {
      if (existingDocIds.has(driveFile.id)) {
        skipped++;
        continue;
      }

      try {
        const html = await this.api.exportAsHtml(driveFile.id);
        const markdown = htmlToMarkdown(html);
        const hash = await sha256(markdown);
        const docUrl = `https://docs.google.com/document/d/${driveFile.id}/edit`;

        const frontmatter = [
          '---',
          `gdocs-id: ${driveFile.id}`,
          `gdocs-url: "${docUrl}"`,
          `gdocs-last-sync: ${new Date().toISOString()}`,
          `gdocs-hash: ${hash}`,
          '---',
          '',
        ].join('\n');

        // Mirror the Drive subfolder structure inside the Obsidian folder.
        // driveFile.relativePath is e.g. "Taxes/2024 Return" for a nested doc.
        const safeRelativePath = driveFile.relativePath
          .replace(/[\\:*?"<>|]/g, '-')
          .trim();
        const notePath = `${obsidianFolder}/${safeRelativePath}.md`;

        // Ensure any intermediate subfolders exist
        const noteFolder = notePath.substring(0, notePath.lastIndexOf('/'));
        if (!this.plugin.app.vault.getFolderByPath(noteFolder)) {
          await this.plugin.app.vault.createFolder(noteFolder);
        }

        await this.plugin.app.vault.create(notePath, frontmatter + markdown);

        // Register for polling
        const revision = await this.api.getDocumentRevision(driveFile.id);
        this.syncedDocs.set(driveFile.id, revision);

        imported++;
      } catch (err) {
        console.error(`[SyncEngine] Failed to import doc ${driveFile.id}:`, err);
        new Notice(`⚠ GDocs Sync: Could not import "${driveFile.name}"`);
      }
    }

    // Save the folder mapping so future notes in this folder auto-sync
    const { folderMappings } = this.plugin.settings;
    const alreadyMapped = folderMappings.some((m: FolderMapping) => m.driveFolderId === folderId);
    if (!alreadyMapped) {
      folderMappings.push({ driveFolderId: folderId, driveFolderName: folderName, obsidianFolder });
      await this.plugin.saveSettings();
    }

    return { imported, skipped, folderName };
  }

  // ─── Frontmatter helper ───────────────────────────────────────────────────

  private async updateFrontmatter(
    file: TFile,
    meta: Partial<SyncMeta>,
  ): Promise<void> {
    await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
      if (meta.gdocsId !== undefined) fm['gdocs-id'] = meta.gdocsId;
      if (meta.gdocsUrl !== undefined) fm['gdocs-url'] = meta.gdocsUrl;
      if (meta.lastSyncAt !== undefined) fm['gdocs-last-sync'] = meta.lastSyncAt;
      if (meta.lastSyncHash !== undefined) fm['gdocs-hash'] = meta.lastSyncHash;
    });
  }
}
