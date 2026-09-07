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
  export interface VaultDescriptor { schema: 1; protocol: 'append-only-history-v1'; vaultId: string; rootId: string; descriptorId: string; name: string; }
  export interface BlobRef { id: string; sha256: string; size: number; }
  export interface HistoryRecord {
    schema: 1; vaultId: string; recordId: string; operationId: string; deviceId: string; entityId: string;
    namespace: 'content' | 'portable-config'; parents: string[]; kind: 'file' | 'folder'; deleted: boolean;
    location: { parentId: string | null; name: string }; blob?: BlobRef;
  }
  export interface HistoryScan { status: 'complete' | 'partial' | 'cancelled' | 'unavailable'; records: HistoryRecord[]; cursor?: string; reset?: boolean; }
  export interface AppendOnlySession {
    scan(cursor: string | undefined, signal: AbortSignal): Promise<HistoryScan>;
    putBlob(input: { operationId: string; sha256: string; size: number; data: ArrayBuffer }, signal: AbortSignal): Promise<BlobRef>;
    readBlob(ref: BlobRef, signal: AbortSignal): Promise<ArrayBuffer>;
    appendRecord(record: HistoryRecord, signal: AbortSignal): Promise<void>;
    close(): Promise<void>;
  }
  export interface AppendOnlySyncProvider {
    readonly id: string; readonly name: string; readonly protocol: 'append-only-history-v1';
    readonly capabilities: { readonly binary: true; readonly conditionalWrites: false; readonly appendOnly: true; readonly delta: true; readonly maxFileSize: 104857600 };
    discover(signal: AbortSignal): Promise<VaultDescriptor[]>;
    createVault(input: { name: string; operationId: string }, signal: AbortSignal): Promise<VaultDescriptor>;
    open(context: { binding: VaultDescriptor; deviceId: string }, signal: AbortSignal): Promise<AppendOnlySession>;
    excludePath?(path: string, data?: ArrayBuffer): string | null | Promise<string | null>;
  }
}
