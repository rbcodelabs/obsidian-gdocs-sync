import type { SyncProvider, SyncRemoteEntry, SyncScanResult, SyncSession, SyncWriteInput } from 'geode';
import { TokenStore } from '../auth/TokenStore';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';

export class DriveProviderError extends Error {
  constructor(message: string, readonly code: 'auth_expired' | 'permission_denied' | 'not_found' | 'rate_limited' | 'remote_error') { super(message); this.name = 'DriveProviderError'; }
}

class RemotePreconditionError extends Error { constructor() { super('Google Drive changed since it was scanned'); this.name = 'SyncPreconditionError'; } }

interface DriveMetadata { id: string; name: string; mimeType?: string; parents?: string[]; version?: string; size?: string; md5Checksum?: string; appProperties?: Record<string, string>; }
interface ProviderConfig { rootFolderId: string; saveRootFolderId(id: string): Promise<void> | void; }

function escapeQuery(value: string): string { return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
function splitPath(path: string) { const parts = path.split('/'); return { folders: parts.slice(0, -1), name: parts.at(-1)! }; }

export class GoogleDriveSyncProvider implements SyncProvider {
  readonly id = 'google-drive.full-vault';
  readonly name = 'Google Drive (full vault)';
  // Drive v3 has no atomic If-Match/ETag write precondition. Geode therefore
  // refuses activation rather than treating the preflight comparison below as atomic.
  readonly capabilities = { binary: true, conditionalWrites: false, delta: false, completeSnapshots: true, atomicMoves: true, trash: true } as const;
  constructor(private readonly tokenStore: TokenStore, private readonly config: ProviderConfig) {}

  async open({ vaultId }: { vaultId: string }): Promise<SyncSession> {
    const client = new DriveClient(this.tokenStore);
    const rootId = await client.ensureRoot(this.config.rootFolderId, vaultId);
    if (rootId !== this.config.rootFolderId) await this.config.saveRootFolderId(rootId);
    return new DriveSession(client, rootId);
  }
}

class DriveClient {
  constructor(private readonly tokens: TokenStore) {}
  private async fetch(url: string, options: RequestInit = {}): Promise<Response> {
    const token = await this.tokens.getValidAccessToken();
    const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers ?? {}) } });
    if (!response.ok) {
      const code = response.status === 401 ? 'auth_expired' : response.status === 403 ? 'permission_denied' : response.status === 404 ? 'not_found' : response.status === 429 ? 'rate_limited' : 'remote_error';
      throw new DriveProviderError(`Google Drive request failed (${response.status} ${response.statusText})`, code);
    }
    return response;
  }
  async json<T>(url: string, options?: RequestInit): Promise<T> { const response = await this.fetch(url, options); return response.status === 204 ? undefined as T : response.json() as Promise<T>; }
  async ensureRoot(configured: string, vaultId: string): Promise<string> {
    if (configured) return configured;
    const q = `mimeType='${FOLDER}' and trashed=false and appProperties has { key='geodeVaultId' and value='${escapeQuery(vaultId)}' }`;
    const existing = await this.json<{ files?: DriveMetadata[] }>(`${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id,name,version)&pageSize=10`);
    if (existing.files?.[0]) return existing.files[0].id;
    const created = await this.json<DriveMetadata>(`${DRIVE}/files?fields=id,name,version`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Geode Vault', mimeType: FOLDER, appProperties: { geodeVaultId: vaultId, geodeSyncSchema: '1' } }) });
    return created.id;
  }
  async list(parentId: string, signal: AbortSignal): Promise<DriveMetadata[]> {
    const files: DriveMetadata[] = []; let pageToken: string | undefined;
    do {
      const q = `'${escapeQuery(parentId)}' in parents and trashed=false`;
      const params = new URLSearchParams({ q, fields: 'nextPageToken,files(id,name,mimeType,parents,version,size,md5Checksum,appProperties)', pageSize: '1000' });
      if (pageToken) params.set('pageToken', pageToken);
      const page = await this.json<{ files?: DriveMetadata[]; nextPageToken?: string }>(`${DRIVE}/files?${params}`, { signal });
      files.push(...(page.files ?? [])); pageToken = page.nextPageToken;
    } while (pageToken);
    return files;
  }
  async metadata(id: string, signal: AbortSignal) { return this.json<DriveMetadata>(`${DRIVE}/files/${encodeURIComponent(id)}?fields=id,name,mimeType,parents,version,size,md5Checksum,appProperties`, { signal }); }
  async bytes(id: string, signal: AbortSignal) { return (await this.fetch(`${DRIVE}/files/${encodeURIComponent(id)}?alt=media`, { signal })).arrayBuffer(); }
  async patch(id: string, body: object, signal: AbortSignal, query = '') { return this.json<DriveMetadata>(`${DRIVE}/files/${encodeURIComponent(id)}?fields=id,name,mimeType,parents,version,size,md5Checksum,appProperties${query}`, { method: 'PATCH', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  async upload(id: string, data: ArrayBuffer, signal: AbortSignal) { return this.json<DriveMetadata>(`${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=media&fields=id,name,mimeType,parents,version,size,md5Checksum,appProperties`, { method: 'PATCH', signal, headers: { 'Content-Type': 'application/octet-stream' }, body: data }); }
  async createFile(name: string, parent: string, data: ArrayBuffer, operationKey: string, signal: AbortSignal) {
    const prior = await this.findOperation(operationKey, signal); if (prior) return this.upload(prior.id, data, signal);
    const metadata = await this.json<DriveMetadata>(`${DRIVE}/files?fields=id,name,mimeType,parents,version,size,md5Checksum,appProperties`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, parents: [parent], mimeType: 'application/octet-stream', appProperties: { geodeOperationKey: operationKey } }) });
    return this.upload(metadata.id, data, signal);
  }
  private async findOperation(key: string, signal: AbortSignal) { const q = `trashed=false and appProperties has { key='geodeOperationKey' and value='${escapeQuery(key)}' }`; const found = await this.json<{ files?: DriveMetadata[] }>(`${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,parents,version,size,md5Checksum,appProperties)&pageSize=2`, { signal }); return found.files?.[0]; }
}

class DriveSession implements SyncSession {
  private folders = new Map<string, string>();
  constructor(private readonly client: DriveClient, private readonly rootId: string) { this.folders.set('', rootId); }
  async scan(_cursor: string | undefined, signal: AbortSignal): Promise<SyncScanResult> {
    const entries: SyncRemoteEntry[] = []; const queue: Array<{ id: string; path: string }> = [{ id: this.rootId, path: '' }];
    while (queue.length) { const parent = queue.shift()!; for (const item of await this.client.list(parent.id, signal)) { const path = parent.path ? `${parent.path}/${item.name}` : item.name; const entry = this.entry(item, path); entries.push(entry); if (entry.kind === 'folder') { this.folders.set(path, item.id); queue.push({ id: item.id, path }); } } }
    return { status: 'complete', mode: 'snapshot', entries };
  }
  read(entry: SyncRemoteEntry, signal: AbortSignal) { return this.client.bytes(entry.id, signal); }
  async create(input: SyncWriteInput) { const { folders, name } = splitPath(input.path); const parent = await this.ensureFolders(folders, input.signal); return this.entry(await this.client.createFile(name, parent, input.data, input.operationKey, input.signal), input.path); }
  async update(input: SyncWriteInput & { id: string; expectedRevision: string }) { await this.expectRevision(input.id, input.expectedRevision, input.signal); const updated = await this.client.upload(input.id, input.data, input.signal); return this.moveIfNeeded(updated, input.path, input.expectedRevision, input.signal); }
  async move(input: { id: string; path: string; expectedRevision: string; signal: AbortSignal }) { const current = await this.expectRevision(input.id, input.expectedRevision, input.signal); return this.moveIfNeeded(current, input.path, input.expectedRevision, input.signal); }
  async trash(input: { id: string; expectedRevision: string; signal: AbortSignal }) { await this.expectRevision(input.id, input.expectedRevision, input.signal); await this.client.patch(input.id, { trashed: true }, input.signal); }
  async close() {}
  private entry(item: DriveMetadata, path: string): SyncRemoteEntry { return { id: item.id, path, kind: item.mimeType === FOLDER ? 'folder' : 'file', revision: item.version ?? '0', size: item.size ? Number(item.size) : undefined, hash: item.md5Checksum, operationKey: item.appProperties?.geodeOperationKey }; }
  private async expectRevision(id: string, expected: string, signal: AbortSignal) { const current = await this.client.metadata(id, signal); if ((current.version ?? '0') !== expected) throw new RemotePreconditionError(); return current; }
  private async ensureFolders(parts: string[], signal: AbortSignal) { let path = ''; let parent = this.rootId; for (const name of parts) { path = path ? `${path}/${name}` : name; let id = this.folders.get(path); if (!id) { const found = (await this.client.list(parent, signal)).find(item => item.name === name && item.mimeType === FOLDER); if (found) id = found.id; else id = (await this.client.json<DriveMetadata>(`${DRIVE}/files?fields=id,name,mimeType,parents,version`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }) })).id; this.folders.set(path, id); } parent = id; } return parent; }
  private async moveIfNeeded(current: DriveMetadata, path: string, _expected: string, signal: AbortSignal) { const { folders, name } = splitPath(path); const parent = await this.ensureFolders(folders, signal); const oldParents = current.parents ?? []; const query = oldParents[0] === parent ? '' : `&addParents=${encodeURIComponent(parent)}&removeParents=${encodeURIComponent(oldParents.join(','))}`; const moved = await this.client.patch(current.id, { name }, signal, query); return this.entry(moved, path); }
}
