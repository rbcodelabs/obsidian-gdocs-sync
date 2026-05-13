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
 * Maps a Google Drive folder to an Obsidian vault folder.
 * All Docs inside the Drive folder are imported as notes in obsidianFolder,
 * and any notes in obsidianFolder are synced back to their linked Google Docs.
 */
export interface FolderMapping {
  driveFolderId: string;
  driveFolderName: string;  // Display name fetched from Drive at import time
  obsidianFolder: string;   // Vault-relative path, e.g. "Finances & Estate"
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
};
