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

export interface GDocsPluginSettings {
  authProxyUrl: string;       // e.g. https://gdocs-sync.vercel.app
  syncTag: string;            // e.g. "gdocs-sync"
  syncFolders: string[];      // folder paths to auto-sync
  pollIntervalSeconds: number; // how often to poll GDocs for remote changes
  autoSyncOnSave: boolean;
  tokens: GDocsTokens | null;
  connectedEmail: string;     // Google account email shown in settings
}

export const DEFAULT_SETTINGS: GDocsPluginSettings = {
  authProxyUrl: 'https://obsidian-gdocs-auth.vercel.app',
  syncTag: 'gdocs-sync',
  syncFolders: [],
  pollIntervalSeconds: 30,
  autoSyncOnSave: true,
  tokens: null,
  connectedEmail: '',
};
