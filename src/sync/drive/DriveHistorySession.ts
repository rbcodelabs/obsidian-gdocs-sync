import type { AppendOnlySession, BlobRef, HistoryRecord, HistoryScan, VaultDescriptor } from 'geode';
import type { DriveProviderConfig } from '../GoogleDriveSyncProvider';
import { canonicalJson, ImmutableDriveClient, MAX_BLOB_SIZE, sha256Bytes, type DriveAuth } from './ImmutableDriveClient';

export const PROTOCOL = 'append-only-history-v1' as const;
/**
 * Maximum Drive round trips a scan keeps in flight. A shared vault's first scan
 * reads every historical record and checks every referenced blob; one at a time,
 * that is thousands of sequential round trips. Six in flight cuts the wall time
 * several-fold while staying well inside Drive's per-user request quota (and its
 * 429s still flow through ImmutableDriveClient's bounded backoff).
 */
export const SCAN_CONCURRENCY = 6;
type PrefetchedBodies = Map<string, { bytes: ArrayBuffer } | { error: unknown }>;

/**
 * Maps `items` through `task` with at most `limit` tasks in flight; results keep
 * input order. On the first failure no further items are started, in-flight tasks
 * are allowed to settle (so nothing outlives the call), and that first error is
 * rethrown — the same observable outcome as a serial loop that stops at a throw.
 */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Concurrency limit must be a positive integer');
  const results = new Array<R>(items.length);
  let next = 0; let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (!failure && next < items.length) {
      const index = next++;
      try { results[index] = await task(items[index], index); }
      catch (error) { failure ??= { error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure.error;
  return results;
}
const DRIVE = 'https://www.googleapis.com/drive/v3';
const FIELDS = 'id,name,mimeType,parents,appProperties,size,trashed,version';
interface Metadata { id: string; name: string; mimeType: string; parents?: string[]; appProperties?: Record<string, string>; size?: string; trashed?: boolean; version: string; }
interface Observations { objects: Record<string, { version: string; hash: string; recordId?: string; kind?: string; blob?: BlobRef; size?: number }>; records: Record<string, string>; }

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
    const bytes = (await this.client.request({ url: `${DRIVE}/files/${encodeURIComponent(ref.id)}?alt=media` }, combined, [], true, { expectedBytes: ref.size })).arrayBuffer;
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
    const pendingKey = `${this.observationsKey()}/pending-blobs`;
    const previousPending = await this.config.loadDeviceState<Record<string, BlobRef>>(pendingKey) ?? {};
    const references = new Map<string, BlobRef>(Object.values(previousPending).map(ref => [ref.id, ref]));
    const knownRefs = new Map<string, BlobRef>();
    for (const object of Object.values(observations.objects)) if (object.blob) knownRefs.set(object.blob.id, object.blob);
    const availability = new Map<string, 'available' | 'pending' | 'corrupt'>();
    const changedBlobs = new Set<string>();
    const addReference = (ref: BlobRef) => {
      const previous = knownRefs.get(ref.id);
      if (previous && (previous.sha256 !== ref.sha256 || previous.size !== ref.size)) availability.set(ref.id, 'corrupt');
      knownRefs.set(ref.id, ref); references.set(ref.id, ref);
    };
    // Record bodies are fetched ahead with bounded concurrency, but every state
    // mutation (observations, blob references, availability, output order) still
    // happens in this serial pass, in the original order. addReference in
    // particular is NOT disjoint across records — many records share one blob id —
    // so it must stay serial for results to match the one-at-a-time scan exactly.
    const read = async (entry: Metadata, bodies?: PrefetchedBodies) => { const record = await this.readRecord(entry, signal, observations, bodies); const ref = observations.objects[entry.id]?.blob; if (ref) addReference(ref); return record; };
    const recordVariants = new Set<string>();
    const push = (record: unknown) => { const key = canonicalJson(record); if (!recordVariants.has(key)) { recordVariants.add(key); records.push(record); } };
    const reset = !token;
    if (!token) {
      for (const ref of knownRefs.values()) references.set(ref.id, ref);
      token = (await this.client.request({ url: `${DRIVE}/changes/startPageToken?fields=startPageToken` }, combined)).json?.startPageToken;
      if (typeof token !== 'string') throw new Error('Drive did not return a changes token');
      const entries = await listFiles(this.client, `'${this.binding.rootId}' in parents and trashed=false and appProperties has { key='geodeObjectKind' and value='record' }`, combined);
      const bodies = await this.prefetchRecordBodies(entries, signal, observations);
      for (const entry of entries) push(await read(entry, bodies));
      const present = new Set(entries.map(entry => entry.id));
      for (const [id, known] of Object.entries(observations.objects)) {
        if (known.kind === 'record' && !present.has(id)) {
          const response = await this.client.request({ url: `${DRIVE}/files/${encodeURIComponent(id)}?fields=${FIELDS}` }, combined, [404]);
          if (response.status === 404) push(integrityEvidence(known.recordId, 'Known immutable record is no longer accessible'));
          else push(await read(response.json));
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
      const changedRecords = (page.changes ?? []).filter((change: any) => !change.removed && !change.file?.trashed && change.file?.parents?.includes(this.binding.rootId) && change.file?.appProperties?.geodeObjectKind === 'record').map((change: any) => change.file as Metadata);
      const bodies = await this.prefetchRecordBodies(changedRecords, signal, observations);
      for (const change of page.changes ?? []) {
        const known = observations.objects[change.fileId] ?? await this.config.loadDeviceState<Observations['objects'][string]>(this.blobObservationKey(change.fileId));
        if (change.removed || change.file?.trashed) {
          if (known?.kind === 'record') push(integrityEvidence(known.recordId, 'Known immutable record was removed'));
          else if (known) { availability.set(change.fileId, 'pending'); const ref = knownRefs.get(change.fileId); if (ref) references.set(ref.id, ref); }
          continue;
        }
        if (known && (!change.file?.parents?.includes(this.binding.rootId) || change.file?.appProperties?.geodeObjectKind !== known.kind || change.file?.appProperties?.geodeVaultId !== this.binding.vaultId || change.file?.appProperties?.geodeSyncProtocol !== PROTOCOL || change.file?.appProperties?.geodeSyncSchema !== '1')) {
          if (known.kind === 'record') { push(integrityEvidence(known.recordId, 'Known immutable record changed or moved')); continue; }
          availability.set(change.fileId, 'corrupt'); continue;
        }
        if (known?.kind === 'blob' && change.file?.version !== known.version) {
          changedBlobs.add(change.fileId);
          const ref = knownRefs.get(change.fileId); if (ref) references.set(ref.id, ref);
        }
        if (change.file?.parents?.includes(this.binding.rootId) && change.file?.appProperties?.geodeObjectKind === 'record') {
          push(await read(change.file, bodies));
        }
      }
      if (page.nextPageToken) { next = page.nextPageToken; continue; }
      if (typeof page.newStartPageToken !== 'string') throw new Error('Drive changes response omitted its terminal cursor');
      const pending: Record<string, BlobRef> = {};
      // `references` is keyed by blob id, so each task owns one id: it reads only
      // availability[ref.id], and blobAvailability's only write (observe) is keyed by
      // that id and runs under the provider-wide serial lock. Results are applied
      // afterwards in reference order so the returned availability order is unchanged.
      const refs = [...references.values()];
      const states = await mapWithConcurrency(refs, SCAN_CONCURRENCY, async ref => {
        this.check(signal);
        return availability.get(ref.id) === 'corrupt' ? 'corrupt' as const : await this.blobAvailability(ref, signal, changedBlobs.has(ref.id));
      });
      refs.forEach((ref, index) => { const state = states[index]; availability.set(ref.id, state); if (state === 'pending') pending[ref.id] = ref; });
      this.check(signal);
      await this.serial(async () => {
        const latest = await this.loadObservations();
        for (const [id, candidate] of Object.entries(observations.objects)) {
          const previous = latest.objects[id];
          if (previous && previous.hash !== candidate.hash) throw new Error('Concurrent immutable observation integrity failure');
          latest.objects[id] = candidate;
        }
        this.check(signal); await this.config.saveDeviceState(this.observationsKey(), latest); this.check(signal);
        if (Object.keys(pending).length || Object.keys(previousPending).length) await this.config.saveDeviceState(pendingKey, pending);
        this.check(signal);
      });
      return { status: 'complete', records, reset, blobAvailability: [...availability].map(([id, status]) => ({ id, status })), cursor: JSON.stringify({ accountId: this.accountId, vaultId: this.binding.vaultId, rootId: this.binding.rootId, token: page.newStartPageToken }) };
    }
  }

  async close(): Promise<void> { this.closed.abort(); }

  /** Metadata checks readRecord performs before any network read; evidence means no read. */
  private recordPrecheck(meta: Metadata, observations: Observations): { recordId: string | undefined; evidence?: unknown } {
    const recordId = observations.objects[meta.id]?.recordId ?? meta.appProperties?.geodeRecordId;
    try { this.validateObject(meta, 'record'); }
    catch { return { recordId, evidence: integrityEvidence(recordId, 'Record ownership or metadata is invalid') }; }
    if (meta.appProperties?.geodeRecordId !== recordId || meta.name !== `${recordId}.json` || meta.mimeType !== 'application/json') return { recordId, evidence: integrityEvidence(recordId, 'Record identity metadata changed') };
    return { recordId };
  }

  private fetchRecordBody(meta: Metadata, signal: AbortSignal): Promise<ArrayBuffer> {
    return this.client.request({ url: `${DRIVE}/files/${encodeURIComponent(meta.id)}?alt=media` }, this.signal(signal), [], true, { expectedBytes: Number(meta.size) }).then(response => response.arrayBuffer);
  }

  /**
   * Fetches record bodies with bounded concurrency ahead of the serial pass. It is
   * side-effect free (network reads only, into a map owned by this call), so it
   * cannot change scan results — it can only make the serial pass stop waiting on
   * the network one round trip at a time. A failure is recorded rather than thrown
   * and stops further prefetching; readRecord rethrows it only if the serial pass
   * actually reaches that read, which is exactly where the serial scan would fail.
   */
  private async prefetchRecordBodies(entries: Metadata[], signal: AbortSignal, observations: Observations): Promise<PrefetchedBodies> {
    const bodies: PrefetchedBodies = new Map();
    const wanted = [...new Map(entries.filter(meta => !this.recordPrecheck(meta, observations).evidence).map(meta => [meta.id, meta])).values()];
    let failed = false;
    await mapWithConcurrency(wanted, SCAN_CONCURRENCY, async meta => {
      if (failed) return;
      try { bodies.set(meta.id, { bytes: await this.fetchRecordBody(meta, signal) }); }
      catch (error) { failed = true; bodies.set(meta.id, { error }); }
    });
    return bodies;
  }

  private async readRecord(meta: Metadata, signal: AbortSignal, observations: Observations, bodies?: PrefetchedBodies): Promise<unknown> {
    const previous = observations.objects[meta.id];
    const { recordId, evidence } = this.recordPrecheck(meta, observations);
    if (evidence) return evidence;
    const prefetched = bodies?.get(meta.id);
    if (prefetched && 'error' in prefetched) throw prefetched.error;
    const bytes = prefetched?.bytes ?? await this.fetchRecordBody(meta, signal);
    const hash = await sha256Bytes(bytes);
    if (previous && previous.hash !== hash) return integrityEvidence(recordId, 'Known immutable record bytes changed');
    observations.objects[meta.id] = { version: meta.version, hash, recordId, kind: 'record' };
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const record = JSON.parse(text) as HistoryRecord;
      if (text !== canonicalJson(record) || record?.recordId !== recordId) return integrityEvidence(recordId, 'Record is not canonical or its identity differs');
      if (record.blob) { try { validateBlob(record.blob); observations.objects[meta.id].blob = structuredClone(record.blob); } catch { /* Core retains and quarantines the malformed raw record. */ } }
      return record;
    } catch { return integrityEvidence(recordId, 'Record JSON is malformed'); }
  }

  private validateObject(meta: Metadata, kind: string): void {
    if (meta.trashed || !meta.parents?.includes(this.binding.rootId) || meta.appProperties?.geodeVaultId !== this.binding.vaultId || meta.appProperties?.geodeSyncSchema !== '1' || meta.appProperties?.geodeSyncProtocol !== PROTOCOL || meta.appProperties?.geodeObjectKind !== kind || typeof meta.version !== 'string') throw new Error('Managed object identity integrity failure');
  }

  private async blobAvailability(ref: BlobRef, signal: AbortSignal, forceRead = false): Promise<'available' | 'pending' | 'corrupt'> {
    const response = await this.client.request({ url: `${DRIVE}/files/${encodeURIComponent(ref.id)}?fields=${FIELDS}` }, this.signal(signal), [404]);
    if (response.status === 404 || response.json?.trashed) return 'pending';
    const meta = response.json as Metadata;
    try { this.validateObject(meta, 'blob'); } catch { return 'corrupt'; }
    if (Number(meta.size) !== ref.size || meta.appProperties?.geodeSha256 !== ref.sha256) return 'corrupt';
    const previous = await this.config.loadDeviceState<Observations['objects'][string]>(this.blobObservationKey(ref.id)); this.check(signal);
    if (previous?.hash !== undefined && previous.hash !== ref.sha256) return 'corrupt';
    // Drive versions include server metadata changes; a new version requires bytes,
    // not an assumption that immutable content changed.
    if (!forceRead && previous?.version === meta.version) return 'available';
    const content = await this.client.request({ url: `${DRIVE}/files/${encodeURIComponent(ref.id)}?alt=media` }, this.signal(signal), [404], true, { expectedBytes: ref.size });
    if (content.status === 404) return 'pending';
    if (content.arrayBuffer.byteLength !== ref.size || await sha256Bytes(content.arrayBuffer) !== ref.sha256) return 'corrupt';
    await this.observe(meta, ref.sha256, undefined, signal);
    return 'available';
  }

  private async observe(meta: Metadata, hash: string, recordId: string | undefined, signal: AbortSignal): Promise<void> {
    await this.serial(async () => {
      const previous = await this.config.loadDeviceState<Observations['objects'][string]>(this.blobObservationKey(meta.id));
      if (previous && previous.hash !== hash) throw new Error('Known immutable object changed: integrity failure');
      this.check(signal);
      if (!previous || previous.version !== meta.version) await this.config.saveDeviceState(this.blobObservationKey(meta.id), { version: meta.version, hash, recordId, kind: meta.appProperties?.geodeObjectKind, size: Number(meta.size) });
      this.check(signal);
    });
  }
  private observationsKey() { return `drive/observed/${this.accountId}/${this.binding.vaultId}/${this.binding.rootId}/${this.binding.descriptorId}`; }
  private blobObservationKey(id: string) { return `${this.observationsKey()}/blob/${encodeURIComponent(id)}`; }
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
