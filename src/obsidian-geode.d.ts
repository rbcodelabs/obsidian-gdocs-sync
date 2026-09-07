import 'obsidian';

declare module 'obsidian' {
  interface Plugin {
    registerSyncProvider(provider: import('geode').SyncProvider | import('geode').AppendOnlySyncProvider): void;
    loadDeviceState<T>(key: string): Promise<T | null>;
    saveDeviceState(key: string, value: unknown): Promise<void>;
    loadSecret(key: string): Promise<string | null>;
    saveSecret(key: string, value: string): Promise<void>;
    removeSecret(key: string): Promise<void>;
  }
}
