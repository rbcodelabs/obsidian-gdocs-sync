import type { AppendOnlySession, BlobRef, HistoryRecord, HistoryScan, VaultDescriptor } from 'geode';
import type { DriveProviderConfig } from '../GoogleDriveSyncProvider';
import { canonicalJson, ImmutableDriveClient, MAX_BLOB_SIZE, sha256Bytes, type DriveAuth } from './ImmutableDriveClient';

export const PROTOCOL = 'append-only-history-v1' as const;
const DRIVE = 'https://www.googleapis.com/drive/v3';
const FIELDS = 'id,name,mimeType,parents,appProperties,size,trashed,version';
interface Metadata { id: string; name: string; mimeType: string; parents?: string[]; appProperties?: Record<string, string>; size?: string; trashed?: boolean; version: string; }
interface Observations { objects: Record<string, { version: string; hash: string; recordId?: string; kind?: string }>; records: Record<string, string>; }

export class DriveHistorySession implements AppendOnlySession {
  private closed = new AbortController();
  constructor(private client: ImmutableDriveClient, private binding: VaultDescriptor, private deviceId: string, private accountId: string, private config: DriveProviderConfig, private auth: DriveAuth, private serial: <T>(work: () => Promise<T>) => Promise<T>) {}

  async putBlob(input: { operationId: string; sha256: string; size: number; data: ArrayBuffer }, signal: AbortSignal): Promise<BlobRef> {
    this.check(signal); assertUuid(input.operationId);
    if (input.size !== input.data.byteLength || input.size > MAX_BLOB_SIZE) throw new Error('Invalid blob size; maximum is 100 MiB');
    const id = await this.client.create({ operationKey: `blob:${input.operationId}`, metadata: { name: `blob-${input.operationId}`, mimeType: 'application/octet-stream', parents: [this.binding.rootId], appProperties: { ...objectProperties(this.binding, 'blob'), geodeSha256: input.sha256 } }, data: input.data, sha256: input.sha256 }, this.signal(signal));
    this.check(signal);
    return { id, sha256: input.sha256, size: input.size };
  }

  async readBlob(ref: BlobRef, signal: AbortSignal): Promise<ArrayBuffer> {
    this.check(signal); validateBlob(ref);
    const combined = this.signal(signal);
    const meta = await metadataOf(this.client, ref.id, combined);
    this.validateObject(meta, 'blob');
    if (meta.appProperties?.geodeSha256 !== ref.sha256 || Number(meta.size) !== ref.size) throw new Error('Blob metadata integrity failure');
    const bytes = (await this.client.request({ url: `${DRIVE}/files/${encodeURIComponent(ref.id)}?alt=media` }, combined)).arrayBuffer;
    if (bytes.byteLength !== ref.size || await sha256Bytes(bytes) !== ref.sha256) throw new Error('Blob bytes integrity failure');
    await this.observe(meta, ref.sha256, undefined, signal);
    return bytes;
  }

  async appendRecord(record: HistoryRecord, signal: AbortSignal): Promise<void> {
    this.check(signal); validateRecord(record, this.binding.vaultId);
    if (record.deviceId !== this.deviceId) throw new Error('Record device identity mismatch');
    if (record.blob) await this.readBlob(record.blob, signal);
    const data = new TextEncoder().encode(canonicalJson(record)).buffer;
    await this.client.create({ operationKey: `record:${record.operationId}`, metadata: { name: `${record.recordId}.json`, mimeType: 'application/json', parents: [this.binding.rootId], appProperties: { ...objectProperties(this.binding, 'record'), geodeRecordId: record.recordId } }, data, sha256: await sha256Bytes(data) }, this.signal(signal));
    this.check(signal);
  }

  async scan(cursor: string | undefined, signal: AbortSignal): Promise<HistoryScan> {
    this.check(signal);
    const combined = this.signal(signal);
    let token: string | undefined;
    if (cursor) {
      try { const value = JSON.parse(cursor); if (value.vaultId !== this.binding.vaultId || value.accountId !== this.accountId || value.rootId !== this.binding.rootId) throw new Error('Cursor identity mismatch'); token = value.token; }
      catch { throw new Error('Invalid Drive cursor or account binding'); }
    }
    const records: unknown[] = [];
    const observations = await this.loadObservations();
    const recordVariants = new Set<string>();
    const push = (record: unknown) => { const key = canonicalJson(record); if (!recordVariants.has(key)) { recordVariants.add(key); records.push(record); } };
    const reset = !token;
    if (!token) {
      token = (await this.client.request({ url: `${DRIVE}/changes/startPageToken?fields=startPageToken` }, combined)).json?.startPageToken;
      if (typeof token !== 'string') throw new Error('Drive did not return a changes token');
      const entries = await listFiles(this.client, `'${this.binding.rootId}' in parents and trashed=false and appProperties has { key='geodeObjectKind' and value='record' }`, combined);
      for (const entry of entries) push(await this.readRecord(entry, signal, observations));
      const present = new Set(entries.map(entry => entry.id));
      for (const [id, known] of Object.entries(observations.objects)) {
        if (known.kind === 'record' && !present.has(id)) {
          const response = await this.client.request({ url: `${DRIVE}/files/${encodeURIComponent(id)}?fields=${FIELDS}` }, combined, [404]);
          if (response.status === 404) push(integrityEvidence(known.recordId, 'Known immutable record is no longer accessible'));
          else push(await this.readRecord(response.json, signal, observations));
        }
      }
    }
    let next = token;
    const pages = new Set<string>();
    for (;;) {
      if (!next || pages.has(next)) throw new Error('Invalid Drive changes pagination'); pages.add(next);
      const response = await this.client.request({ url: `${DRIVE}/changes?pageToken=${encodeURIComponent(next)}&spaces=drive&fields=nextPageToken,newStartPageToken,changes(fileId,removed,file(${FIELDS}))&pageSize=1000` }, combined, [410]);
      if (response.status === 410) {
        if (reset) throw new Error('Drive changes token expired during bootstrap');
        const rescan = await this.scan(undefined, signal); return { ...rescan, reset: true };
      }
      const page = response.json;
      for (const change of page.changes ?? []) {
        const known = observations.objects[change.fileId];
        if (change.removed || change.file?.trashed) {
          if (known?.kind === 'record') push(integrityEvidence(known.recordId, 'Known immutable record was removed'));
          else if (known) throw new Error('Known immutable Drive blob was removed; history integrity requires attention');
          continue;
        }
        if (known && (change.file?.version !== known.version || !change.file?.parents?.includes(this.binding.rootId) || change.file?.appProperties?.geodeObjectKind !== known.kind || change.file?.appProperties?.geodeVaultId !== this.binding.vaultId || change.file?.appProperties?.geodeSyncProtocol !== PROTOCOL || change.file?.appProperties?.geodeSyncSchema !== '1')) {
          if (known.kind === 'record') { push(integrityEvidence(known.recordId, 'Known immutable record changed or moved')); continue; }
          throw new Error('Known immutable Drive blob changed: integrity failure');
        }
        if (change.file?.parents?.includes(this.binding.rootId) && change.file?.appProperties?.geodeObjectKind === 'record') {
          push(await this.readRecord(change.file, signal, observations));
        }
      }
      if (page.nextPageToken) { next = page.nextPageToken; continue; }
      if (typeof page.newStartPageToken !== 'string') throw new Error('Drive changes response omitted its terminal cursor');
      this.check(signal);
      await this.serial(async () => {
        const latest = await this.loadObservations();
        for (const [id, candidate] of Object.entries(observations.objects)) {
          const previous = latest.objects[id];
          if (previous && (previous.version !== candidate.version || previous.hash !== candidate.hash)) throw new Error('Concurrent immutable observation integrity failure');
          latest.objects[id] = candidate;
        }
        this.check(signal); await this.config.saveDeviceState(this.observationsKey(), latest); this.check(signal);
      });
      return { status: 'complete', records, reset, cursor: JSON.stringify({ accountId: this.accountId, vaultId: this.binding.vaultId, rootId: this.binding.rootId, token: page.newStartPageToken }) };
    }
  }

  async close(): Promise<void> { this.closed.abort(); }

  private async readRecord(meta: Metadata, signal: AbortSignal, observations: Observations): Promise<unknown> {
    const previous = observations.objects[meta.id];
    const recordId = previous?.recordId ?? meta.appProperties?.geodeRecordId;
    try { this.validateObject(meta, 'record'); }
    catch { return integrityEvidence(recordId, 'Record ownership or metadata is invalid'); }
    if (previous && previous.version !== meta.version) return integrityEvidence(recordId, 'Known immutable record version changed');
    const bytes = (await this.client.request({ url: `${DRIVE}/files/${encodeURIComponent(meta.id)}?alt=media` }, this.signal(signal))).arrayBuffer;
    const hash = await sha256Bytes(bytes);
    if (previous && previous.hash !== hash) return integrityEvidence(recordId, 'Known immutable record bytes changed');
    observations.objects[meta.id] = { version: meta.version, hash, recordId, kind: 'record' };
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const record = JSON.parse(text) as HistoryRecord;
      if (text !== canonicalJson(record) || record?.recordId !== recordId) return integrityEvidence(recordId, 'Record is not canonical or its identity differs');
      return record;
    } catch { return integrityEvidence(recordId, 'Record JSON is malformed'); }
  }

  private validateObject(meta: Metadata, kind: string): void {
    if (meta.trashed || !meta.parents?.includes(this.binding.rootId) || meta.appProperties?.geodeVaultId !== this.binding.vaultId || meta.appProperties?.geodeSyncSchema !== '1' || meta.appProperties?.geodeSyncProtocol !== PROTOCOL || meta.appProperties?.geodeObjectKind !== kind || typeof meta.version !== 'string') throw new Error('Managed object identity integrity failure');
  }

  private async observe(meta: Metadata, hash: string, recordId: string | undefined, signal: AbortSignal): Promise<void> {
    await this.serial(async () => {
      const state = await this.loadObservations();
      const previous = state.objects[meta.id];
      if (previous && (previous.version !== meta.version || previous.hash !== hash)) throw new Error('Known immutable object changed: integrity failure');
      if (recordId && state.records[recordId] && state.records[recordId] !== hash) throw new Error('Logical record identity has conflicting immutable bytes');
      state.objects[meta.id] = { version: meta.version, hash, recordId, kind: meta.appProperties?.geodeObjectKind };
      if (recordId) state.records[recordId] = hash;
      this.check(signal);
      await this.config.saveDeviceState(this.observationsKey(), state);
      this.check(signal);
    });
  }
  private observationsKey() { return `drive/observed/${this.accountId}/${this.binding.vaultId}`; }
  private async loadObservations(): Promise<Observations> { return await this.config.loadDeviceState<Observations>(this.observationsKey()) ?? { objects: {}, records: {} }; }
  private check(signal: AbortSignal): void { this.auth.assertCurrent(); this.closed.signal.throwIfAborted(); signal.throwIfAborted(); }
  private signal(signal: AbortSignal): AbortSignal { return AbortSignal.any([signal, this.closed.signal]); }
}

export async function listFiles(client: ImmutableDriveClient, q: string, signal: AbortSignal): Promise<Metadata[]> {
  const entries: Metadata[] = []; let token: string | undefined; const pages = new Set<string>();
  do {
    const params = new URLSearchParams({ q, spaces: 'drive', fields: `nextPageToken,incompleteSearch,files(${FIELDS})`, pageSize: '1000' });
    if (token) { if (pages.has(token)) throw new Error('Invalid Drive list pagination'); pages.add(token); params.set('pageToken', token); }
    const page = (await client.request({ url: `${DRIVE}/files?${params}` }, signal)).json;
    if (page.incompleteSearch) throw new Error('Drive listing is incomplete; no cursor was accepted');
    if (!Array.isArray(page.files)) throw new Error('Invalid Drive listing');
    entries.push(...page.files); token = page.nextPageToken;
  } while (token);
  return entries;
}
export async function metadataOf(client: ImmutableDriveClient, id: string, signal: AbortSignal): Promise<Metadata> { return (await client.request({ url: `${DRIVE}/files/${encodeURIComponent(id)}?fields=${FIELDS}` }, signal)).json; }
export function objectProperties(binding: VaultDescriptor, kind: string): Record<string, string> { return { geodeVaultId: binding.vaultId, geodeSyncProtocol: PROTOCOL, geodeSyncSchema: '1', geodeObjectKind: kind }; }
export function validateDescriptorShape(value: VaultDescriptor): void {
  if (!value || value.schema !== 1 || value.protocol !== PROTOCOL || typeof value.name !== 'string' || !value.name || !/^[\w-]+$/.test(value.rootId) || !/^[\w-]+$/.test(value.descriptorId) || value.rootId === value.descriptorId) throw new Error('Invalid Drive descriptor schema');
  assertUuid(value.vaultId);
}
function assertUuid(value: string): void { if (typeof value !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(value)) throw new Error('Invalid immutable identity'); }
function validateBlob(ref: BlobRef): void { if (!ref || !/^[\w-]+$/.test(ref.id) || !/^[a-f0-9]{64}$/.test(ref.sha256) || !Number.isSafeInteger(ref.size) || ref.size < 0 || ref.size > MAX_BLOB_SIZE) throw new Error('Invalid immutable blob reference'); }
function validateRecord(record: HistoryRecord, vaultId: string): void {
  if (!record || record.schema !== 1 || record.vaultId !== vaultId || !['content', 'portable-config'].includes(record.namespace) || !['file', 'folder'].includes(record.kind) || typeof record.deleted !== 'boolean') throw new Error('Invalid history record schema or vault');
  for (const id of [record.vaultId, record.recordId, record.operationId, record.deviceId, record.entityId]) assertUuid(id);
  if (!Array.isArray(record.parents) || canonicalJson([...new Set(record.parents)].sort()) !== canonicalJson(record.parents)) throw new Error('Invalid causal parent list');
  record.parents.forEach(assertUuid);
  if (!record.location || typeof record.location.name !== 'string' || !record.location.name || /[\/\\\0]/.test(record.location.name) || ['.', '..'].includes(record.location.name)) throw new Error('Invalid immutable record location');
  if (record.location.parentId !== null) assertUuid(record.location.parentId);
  if (record.kind === 'file' && !record.deleted) validateBlob(record.blob!);
  else if (record.blob !== undefined) throw new Error('Only live files may carry blob content');
}

function integrityEvidence(recordId: string | undefined, reason: string): unknown {
  const evidence: { recordId?: string; malformedJson: string } = { malformedJson: reason };
  if (recordId && /^[\da-f-]{36}$/i.test(recordId)) evidence.recordId = recordId;
  return evidence;
}
