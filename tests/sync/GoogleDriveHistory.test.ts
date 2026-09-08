import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestUrl, type RequestUrlParam } from 'obsidian';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../src/sync/drive/ImmutableDriveClient';
import { GoogleDriveSyncProvider } from '../../src/sync/GoogleDriveSyncProvider';
import type { HistoryRecord } from 'geode';

type Stored = { meta: Record<string, any>; bytes: ArrayBuffer };
function drive() {
  const files = new Map<string, Stored>(); let ids = 0; let tick = 0;
  const changes: Array<{ sequence: number; fileId: string; file: Record<string, any> }> = [];
  const reply = (status: number, json: unknown = {}, arrayBuffer = new ArrayBuffer(0)) => ({ status, json, arrayBuffer, headers: {}, text: '' }) as never;
  const handler = vi.fn(async (arg: RequestUrlParam | string) => {
    const p = typeof arg === 'string' ? { url: arg } : arg; const url = new URL(p.url); const method = p.method ?? 'GET';
    if (url.pathname.endsWith('/about')) return reply(200, { user: { permissionId: 'synthetic-account' } });
    if (url.pathname.endsWith('/generateIds')) return reply(200, { ids: Array.from({ length: Number(url.searchParams.get('count') ?? 1) }, () => `id-${++ids}`) });
    if (url.pathname.endsWith('/startPageToken')) return reply(200, { startPageToken: String(tick) });
    if (url.pathname.endsWith('/changes')) return reply(200, { changes: changes.filter(item => item.sequence > Number(url.searchParams.get('pageToken'))), newStartPageToken: String(tick) });
    if (method === 'POST' && url.pathname.endsWith('/files')) {
      let meta: any; let bytes = new ArrayBuffer(0);
      if (url.searchParams.get('uploadType') === 'multipart') {
        const body = Buffer.from(p.body as ArrayBuffer);
        const boundary = p.headers!['Content-Type'].split('boundary=')[1];
        const jsonStart = body.indexOf('\r\n\r\n') + 4;
        const jsonEnd = body.indexOf(`\r\n--${boundary}`, jsonStart);
        meta = JSON.parse(body.subarray(jsonStart, jsonEnd).toString());
        const mediaStart = body.indexOf('\r\n\r\n', jsonEnd + 2) + 4;
        const mediaEnd = body.lastIndexOf(`\r\n--${boundary}--`);
        const media = body.subarray(mediaStart, mediaEnd); bytes = Uint8Array.from(media).buffer;
      } else meta = JSON.parse(p.body as string);
      if (files.has(meta.id)) return reply(409);
      meta = { ...meta, size: String(bytes.byteLength), version: '1', trashed: false };
      files.set(meta.id, { meta, bytes }); changes.push({ sequence: ++tick, fileId: meta.id, file: meta });
      return reply(200, meta);
    }
    if (method === 'GET' && url.pathname.endsWith('/files')) {
      const q = url.searchParams.get('q') ?? '';
      let found = [...files.values()].map(item => item.meta).filter(item => !item.trashed);
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      if (parent) found = found.filter(item => item.parents?.includes(parent));
      for (const match of q.matchAll(/key='([^']+)' and value='([^']+)'/g)) found = found.filter(item => item.appProperties?.[match[1]] === match[2]);
      return reply(200, { files: found, incompleteSearch: false });
    }
    const id = url.pathname.split('/').at(-1)!; const stored = files.get(id);
    if (!stored) return reply(404);
    return reply(200, stored.meta, url.searchParams.get('alt') === 'media' ? stored.bytes : undefined);
  });
  return { handler, files, changes };
}
function local() {
  const state = new Map<string, unknown>(); const secrets = new Map<string, string>();
  const config = {
    loadDeviceState: vi.fn(async <T,>(key: string): Promise<T | null> => structuredClone(state.get(key) ?? null) as T | null),
    saveDeviceState: vi.fn(async (key: string, value: unknown) => { state.set(key, structuredClone(value)); }),
    loadSecret: vi.fn(async (key: string) => secrets.get(key) ?? null),
    saveSecret: vi.fn(async (key: string, value: string) => { secrets.set(key, value); }),
    removeSecret: vi.fn(async (key: string) => { secrets.delete(key); }),
  };
  const tokens = { getValidAccessToken: vi.fn(async () => 'synthetic-token'), hasSecureStorage: () => true, getGeneration: () => 1, assertGeneration: () => {} };
  return { config, state, provider: new GoogleDriveSyncProvider(tokens as never, config as never) };
}
const abort = () => new AbortController().signal;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = (data: ArrayBuffer) => createHash('sha256').update(new Uint8Array(data)).digest('hex');

describe('append-only Google Drive vaults', () => {
  beforeEach(() => { vi.mocked(requestUrl).mockReset(); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Renderer fetch forbidden'); })); });
  it('verifies known records omitted by a listing instead of quarantining absence alone', async () => {
    const remote = drive(); vi.mocked(requestUrl).mockImplementation(remote.handler as never);
    const a = local(); const binding = await a.provider.createVault({ name: 'QA', operationId: uuid(1) }, abort());
    const session = await a.provider.open({ binding, deviceId: uuid(2) }, abort());
    const record: HistoryRecord = { schema: 1, vaultId: binding.vaultId, recordId: uuid(4), operationId: uuid(3), deviceId: uuid(2), entityId: uuid(5), namespace: 'content', parents: [], kind: 'folder', deleted: false, location: { parentId: null, name: 'folder' } };
    await session.appendRecord(record, abort()); await session.scan(undefined, abort());
    vi.mocked(requestUrl).mockImplementation(async arg => {
      const value = await remote.handler(arg as RequestUrlParam);
      if (new URL((arg as RequestUrlParam).url).pathname.endsWith('/files')) return { ...value, json: { files: [], incompleteSearch: false } } as never;
      return value;
    });
    expect((await session.scan(undefined, abort())).records).toEqual([record]);
  });
  it('forwards scoped malformed evidence alongside healthy records so core can quarantine only the affected component', async () => {
    const remote = drive(); vi.mocked(requestUrl).mockImplementation(remote.handler as never);
    const a = local(); const binding = await a.provider.createVault({ name: 'QA', operationId: uuid(1) }, abort());
    const session = await a.provider.open({ binding, deviceId: uuid(2) }, abort());
    for (let i = 10; i < 12; i++) await session.appendRecord({ schema: 1, vaultId: binding.vaultId, recordId: uuid(i), operationId: uuid(i + 10), deviceId: uuid(2), entityId: uuid(i + 20), namespace: 'content', parents: [], kind: 'folder', deleted: false, location: { parentId: null, name: `folder-${i}` } }, abort());
    const bad = [...remote.files.values()].find(value => value.meta.appProperties?.geodeRecordId === uuid(10))!;
    bad.bytes = new TextEncoder().encode('{broken').buffer;
    const result = await session.scan(undefined, abort());
    expect(result.status).toBe('complete'); expect(result.cursor).toBeDefined();
    expect(result.records).toContainEqual(expect.objectContaining({ recordId: uuid(10), malformedJson: expect.any(String) }));
    expect(result.records).toContainEqual(expect.objectContaining({ recordId: uuid(11), location: { parentId: null, name: 'folder-11' } }));
  });
  it('preserves contradictory variants of a logical record ID for core quarantine', async () => {
    const remote = drive(); vi.mocked(requestUrl).mockImplementation(remote.handler as never);
    const a = local(); const binding = await a.provider.createVault({ name: 'QA', operationId: uuid(1) }, abort());
    const session = await a.provider.open({ binding, deviceId: uuid(2) }, abort());
    const record: HistoryRecord = { schema: 1, vaultId: binding.vaultId, recordId: uuid(4), operationId: uuid(3), deviceId: uuid(2), entityId: uuid(5), namespace: 'content', parents: [], kind: 'folder', deleted: false, location: { parentId: null, name: 'first' } };
    await session.appendRecord(record, abort());
    const first = [...remote.files.values()].find(value => value.meta.appProperties?.geodeObjectKind === 'record')!;
    const other = { ...record, location: { parentId: null, name: 'contradiction' } };
    remote.files.set('contradictory-id', { meta: { ...first.meta, id: 'contradictory-id' }, bytes: new TextEncoder().encode(canonicalJson(other)).buffer });
    const scan = await session.scan(undefined, abort());
    expect(scan.records).toContainEqual(record); expect(scan.records).toContainEqual(other); expect(scan.records).toHaveLength(2);
  });
  it('persists scan observations once for a batch rather than rewriting the growing map per record', async () => {
    const remote = drive(); vi.mocked(requestUrl).mockImplementation(remote.handler as never);
    const a = local(); const binding = await a.provider.createVault({ name: 'QA', operationId: uuid(1) }, abort());
    const session = await a.provider.open({ binding, deviceId: uuid(2) }, abort());
    for (let i = 10; i < 13; i++) await session.appendRecord({ schema: 1, vaultId: binding.vaultId, recordId: uuid(i), operationId: uuid(i + 10), deviceId: uuid(2), entityId: uuid(i + 20), namespace: 'content', parents: [], kind: 'folder', deleted: false, location: { parentId: null, name: `folder-${i}` } }, abort());
    a.config.saveDeviceState.mockClear();
    const result = await session.scan(undefined, abort());
    expect(result.records).toHaveLength(3);
    expect(a.config.saveDeviceState.mock.calls.filter(([key]) => key.includes('/observed/'))).toHaveLength(1);
  });
  it('detects a known record moved outside the managed root through the changes feed', async () => {
    const remote = drive(); vi.mocked(requestUrl).mockImplementation(remote.handler as never);
    const a = local(); const binding = await a.provider.createVault({ name: 'QA', operationId: uuid(1) }, abort());
    const session = await a.provider.open({ binding, deviceId: uuid(2) }, abort());
    await session.appendRecord({ schema: 1, vaultId: binding.vaultId, recordId: uuid(4), operationId: uuid(3), deviceId: uuid(2), entityId: uuid(5), namespace: 'content', parents: [], kind: 'folder', deleted: false, location: { parentId: null, name: 'folder' } }, abort());
    const first = await session.scan(undefined, abort());
    const entry = [...remote.files.values()].find(value => value.meta.appProperties?.geodeObjectKind === 'record')!;
    entry.meta.parents = ['outside']; entry.meta.version = '2';
    remote.changes.push({ sequence: 99, fileId: entry.meta.id, file: entry.meta });
    expect((await session.scan(first.cursor, abort())).records).toEqual([expect.objectContaining({ recordId: uuid(4), malformedJson: expect.any(String) })]);
  });
  it('rejects changed known history without accepting a replacement value', async () => {
    const remote = drive(); vi.mocked(requestUrl).mockImplementation(remote.handler as never);
    const a = local(); const binding = await a.provider.createVault({ name: 'QA', operationId: uuid(1) }, abort());
    const session = await a.provider.open({ binding, deviceId: uuid(2) }, abort());
    const record: HistoryRecord = { schema: 1, vaultId: binding.vaultId, recordId: uuid(4), operationId: uuid(3), deviceId: uuid(2), entityId: uuid(5), namespace: 'content', parents: [], kind: 'folder', deleted: false, location: { parentId: null, name: 'folder' } };
    await session.appendRecord(record, abort());
    await session.scan(undefined, abort());
    const stored = [...remote.files.values()].find(value => value.meta.appProperties?.geodeObjectKind === 'record')!;
    stored.meta.version = '2';
    expect((await session.scan(undefined, abort())).records).toEqual([expect.objectContaining({ recordId: uuid(4), malformedJson: expect.any(String) })]);
  });
  it('rejects incomplete Drive listings instead of returning a complete cursor', async () => {
    const remote = drive(); vi.mocked(requestUrl).mockImplementation(remote.handler as never);
    const a = local(); const binding = await a.provider.createVault({ name: 'QA', operationId: uuid(1) }, abort());
    const session = await a.provider.open({ binding, deviceId: uuid(2) }, abort());
    const original = remote.handler;
    vi.mocked(requestUrl).mockImplementation(async arg => {
      const value = await original(arg as RequestUrlParam);
      if (new URL((arg as RequestUrlParam).url).pathname.endsWith('/files')) return { ...value, json: { files: [], incompleteSearch: true } } as never;
      return value;
    });
    await expect(session.scan(undefined, abort())).rejects.toThrow(/incomplete/i);
  });
  it('rescans on an invalid changes cursor and returns explicit deletion records only', async () => {
    const remote = drive(); vi.mocked(requestUrl).mockImplementation(remote.handler as never);
    const a = local(); const binding = await a.provider.createVault({ name: 'QA', operationId: uuid(1) }, abort());
    const session = await a.provider.open({ binding, deviceId: uuid(2) }, abort());
    const first = await session.scan(undefined, abort());
    const record: HistoryRecord = { schema: 1, vaultId: binding.vaultId, recordId: uuid(4), operationId: uuid(3), deviceId: uuid(2), entityId: uuid(5), namespace: 'content', parents: [uuid(7)], kind: 'folder', deleted: true, location: { parentId: null, name: 'folder' } };
    await session.appendRecord(record, abort());
    let invalid = true;
    vi.mocked(requestUrl).mockImplementation(async arg => {
      if (invalid && new URL((arg as RequestUrlParam).url).pathname.endsWith('/changes')) { invalid = false; return { status: 410, json: {}, headers: {}, arrayBuffer: new ArrayBuffer(0), text: '' }; }
      return remote.handler(arg as RequestUrlParam);
    });
    const recovered = await session.scan(first.cursor, abort());
    expect(recovered.reset).toBe(true); expect(recovered.records).toEqual([record]);
  });
  it('reuses the setup UUID and reserved IDs after a failure between root and descriptor creation', async () => {
    const remote = drive(); vi.mocked(requestUrl).mockImplementation(remote.handler as never);
    const a = local();
    const originalSave = a.config.saveDeviceState.getMockImplementation()!;
    let blocked = true;
    a.config.saveDeviceState.mockImplementation(async (key, value) => {
      if (blocked && Object.keys(value as object).some(key => key.startsWith('descriptor:'))) throw new Error('disk full');
      return originalSave(key, value);
    });
    await expect(a.provider.createVault({ name: 'QA', operationId: uuid(1) }, abort())).rejects.toThrow('disk full');
    expect(remote.files.size).toBe(1);
    const setup = [...a.state.entries()].find(([key]) => key.includes('/setup/'))![1];
    blocked = false;
    const resumed = await a.provider.createVault({ name: 'QA', operationId: uuid(1) }, abort());
    expect(resumed).toEqual(setup); expect(remote.files.size).toBe(2);
  });
  it('creates a durable shared descriptor, discovers it from another client, and joins without local-path identity', async () => {
    const remote = drive(); vi.mocked(requestUrl).mockImplementation(remote.handler as never);
    const a = local();
    const binding = await a.provider.createVault({ name: 'Synthetic QA vault', operationId: uuid(1) }, abort());
    expect(binding).toMatchObject({ schema: 1, protocol: 'append-only-history-v1', name: 'Synthetic QA vault' });
    expect(binding.vaultId).toMatch(/^[\da-f-]{36}$/);
    const b = local();
    expect(await b.provider.discover(abort())).toEqual([binding]);
    await expect(b.provider.open({ binding, deviceId: uuid(2) }, abort())).resolves.toBeDefined();
    expect(remote.files.size).toBe(2);
    const repeated = await a.provider.createVault({ name: 'Synthetic QA vault', operationId: uuid(1) }, abort());
    expect(repeated).toEqual(binding);
    expect(remote.files.size).toBe(2);
  });
  it('publishes a verified blob then one immutable record and reconstructs from a fresh client', async () => {
    const remote = drive(); vi.mocked(requestUrl).mockImplementation(remote.handler as never);
    const a = local(); const binding = await a.provider.createVault({ name: 'QA', operationId: uuid(1) }, abort());
    const session = await a.provider.open({ binding, deviceId: uuid(2) }, abort());
    const data = new Uint8Array([0, 255, 3, 9]).buffer;
    const blob = await session.putBlob({ operationId: uuid(3), sha256: digest(data), size: data.byteLength, data }, abort());
    const record: HistoryRecord = { schema: 1, vaultId: binding.vaultId, recordId: uuid(4), operationId: uuid(3), deviceId: uuid(2), entityId: uuid(5), namespace: 'content', parents: [], kind: 'file', deleted: false, location: { parentId: null, name: 'file.bin' }, blob };
    await session.appendRecord(record, abort());
    await session.appendRecord(record, abort());
    const b = local(); const reader = await b.provider.open({ binding, deviceId: uuid(6) }, abort());
    const scan = await reader.scan(undefined, abort());
    expect(scan.status).toBe('complete'); expect(scan.records).toEqual([record]);
    expect(await reader.readBlob(blob, abort())).toEqual(data);
    expect((await reader.scan(scan.cursor, abort())).records).toEqual([]);
    expect(remote.files.size).toBe(4);
  });
  it('rejects wrong root/schema descriptors and never adopts a legacy prototype folder', async () => {
    const remote = drive(); vi.mocked(requestUrl).mockImplementation(remote.handler as never);
    const a = local(); const binding = await a.provider.createVault({ name: 'QA', operationId: uuid(1) }, abort());
    await expect(a.provider.open({ binding: { ...binding, vaultId: uuid(8) }, deviceId: uuid(2) }, abort())).rejects.toThrow(/descriptor|identity|integrity/i);
    remote.files.get(binding.rootId)!.meta.appProperties.geodeSyncSchema = 'legacy';
    await expect(a.provider.open({ binding, deviceId: uuid(2) }, abort())).rejects.toThrow(/schema|integrity/i);
  });
  it('does not publish a record for a missing or corrupted blob', async () => {
    const remote = drive(); vi.mocked(requestUrl).mockImplementation(remote.handler as never);
    const a = local(); const binding = await a.provider.createVault({ name: 'QA', operationId: uuid(1) }, abort());
    const session = await a.provider.open({ binding, deviceId: uuid(2) }, abort());
    const record: HistoryRecord = { schema: 1, vaultId: binding.vaultId, recordId: uuid(4), operationId: uuid(3), deviceId: uuid(2), entityId: uuid(5), namespace: 'content', parents: [], kind: 'file', deleted: false, location: { parentId: null, name: 'file.bin' }, blob: { id: 'missing', size: 1, sha256: '0'.repeat(64) } };
    await expect(session.appendRecord(record, abort())).rejects.toThrow();
    expect(remote.files.size).toBe(2);
  });
});
