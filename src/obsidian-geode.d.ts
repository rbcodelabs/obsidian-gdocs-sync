import 'obsidian';

declare module 'obsidian' {
  interface Plugin {
    registerSyncProvider(provider: import('geode').SyncProvider): void;
    loadSecret(key: string): Promise<string | null>;
    saveSecret(key: string, value: string): Promise<void>;
    removeSecret(key: string): Promise<void>;
  }
}
