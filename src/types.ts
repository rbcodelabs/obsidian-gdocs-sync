export interface GDocsTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix ms
}

export interface SyncMeta {
  gdocsId: string;
  gdocsUrl: string;
  lastSyncAt: string; // ISO timestamp
  lastSyncHash: string; // sha256 of content at last sync
}

/**
 * Sync metadata written to the frontmatter of a note that mirrors a Google Task.
 * Only the mutable fields (title, notes, completed, due) participate in conflict
 * detection — see lastSyncFieldsHash. Google-owned read-only fields (position,
 * parent, updated) are carried through but never authored locally.
 */
export interface TaskSyncMeta {
  gtasksId: string;
  gtasksListId: string;
  gtasksListName: string; // denormalized so a Base view can group by list name
  // sha256 of the canonical {title, notes, completed, due} snapshot at last sync.
  // Compared field-by-field on the next sync to decide local-vs-remote wins.
  lastSyncFieldsHash: string;
}

/**
 * Maps a Google Drive folder to an Obsidian vault folder.
 * All Docs inside the Drive folder are imported as notes in obsidianFolder,
 * and any notes in obsidianFolder are synced back to their linked Google Docs.
 */
export interface FolderMapping {
  driveFolderId: string;
  driveFolderName: string;  // Display name fetched from Drive at import time
  obsidianFolder: string;   // Vault-relative path, e.g. "Finances & Estate"
}

export interface DriveItem {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
}

/**
 * A corporate Shared Drive (a.k.a. Team Drive) the connected account belongs to.
 * A Shared Drive's id behaves like a folder id for `'<id>' in parents` queries
 * against its root, so it can be browsed/imported through the same
 * listFolderContents/listDocsInFolder/getFolderName machinery as a regular folder.
 */
export interface SharedDrive {
  id: string;
  name: string;
}

export interface GDocsPluginSettings {
  authProxyUrl: string;       // e.g. https://gdocs-sync.vercel.app
  syncTag: string;            // e.g. "gdocs-sync"
  syncFolders: string[];      // folder paths to auto-sync
  folderMappings: FolderMapping[]; // Drive folder → Obsidian folder mappings
  pollIntervalSeconds: number; // how often to poll GDocs for remote changes
  autoSyncOnSave: boolean;
  tokens: GDocsTokens | null;
  connectedEmail: string;     // Google account email shown in settings
  // ── Google Tasks sync ──
  enableTasksSync: boolean;      // master toggle for the Tasks sync feature
  tasksFolder: string;           // vault folder for synced task notes, e.g. "Google Tasks"
  syncedTaskListIds: string[];   // Google Tasks list IDs to sync (empty = all lists)
  tasksPollIntervalSeconds: number; // how often to poll Google Tasks for remote changes
}

export const DEFAULT_SETTINGS: GDocsPluginSettings = {
  authProxyUrl: 'https://obsidian-gdocs-auth.vercel.app',
  syncTag: 'gdocs-sync',
  syncFolders: [],
  folderMappings: [],
  pollIntervalSeconds: 30,
  autoSyncOnSave: true,
  tokens: null,
  connectedEmail: '',
  enableTasksSync: false,
  tasksFolder: 'Google Tasks',
  syncedTaskListIds: [],
  tasksPollIntervalSeconds: 60,
};
