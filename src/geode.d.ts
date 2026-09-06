declare module 'geode' {
  export interface SyncProviderCapabilities { binary: boolean; conditionalWrites: boolean; delta: boolean; completeSnapshots: boolean; atomicMoves: boolean; trash: boolean; maxFileSize?: number; }
  export interface SyncRemoteEntry { id: string; path: string; kind: 'file' | 'folder' | 'tombstone'; revision: string; size?: number; hash?: string; deletedPath?: string; operationKey?: string; }
  export interface SyncScanResult { status: 'complete' | 'partial' | 'cancelled' | 'unavailable'; entries: SyncRemoteEntry[]; cursor?: string; mode?: 'snapshot' | 'delta'; errorCode?: string; }
  export interface SyncWriteInput { id?: string; path: string; data: ArrayBuffer; expectedRevision?: string; signal: AbortSignal; operationKey: string; }
  export interface SyncSession {
    scan(cursor: string | undefined, signal: AbortSignal): Promise<SyncScanResult>;
    read(entry: SyncRemoteEntry, signal: AbortSignal): Promise<ArrayBuffer>;
    create(input: SyncWriteInput): Promise<SyncRemoteEntry>;
    update(input: SyncWriteInput & { id: string; expectedRevision: string }): Promise<SyncRemoteEntry>;
    move(input: { id: string; path: string; expectedRevision: string; signal: AbortSignal }): Promise<SyncRemoteEntry | void>;
    trash(input: { id: string; expectedRevision: string; signal: AbortSignal }): Promise<void>;
    close(): Promise<void>;
  }
  export interface SyncProvider { readonly id: string; readonly name: string; readonly capabilities: Readonly<SyncProviderCapabilities>; open(context: { vaultId: string }): Promise<SyncSession>; }
  export class SyncPreconditionError extends Error {}
}
