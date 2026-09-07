import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestUrl, type RequestUrlParam } from 'obsidian';
import { createHash } from 'node:crypto';
import { ImmutableDriveClient, type ReservedObject } from '../../src/sync/drive/ImmutableDriveClient';

const bytes = new TextEncoder().encode('synthetic immutable bytes').buffer;
const sha256 = 'e7d3439a31f306feb8f4ada89efe6fb145a70a8f15417cf25e4ae1bd983063c4';
const metadata = { name: 'blob', mimeType: 'application/octet-stream', parents: ['root'], appProperties: { geodeVaultId: 'vault', geodeObjectKind: 'blob' } };
const signal = () => new AbortController().signal;
const response = (status: number, json: unknown = {}, arrayBuffer = new ArrayBuffer(0), headers: Record<string,string> = {}) => ({ status, json, arrayBuffer, headers, text: '' });

function fixture() {
  let persisted: Record<string, ReservedObject> = {};
  const journal = { load: vi.fn(async () => structuredClone(persisted)), save: vi.fn(async (state: Record<string, ReservedObject>) => { persisted = structuredClone(state); }) };
  const auth = { assertCurrent: vi.fn(() => {}), getAccessToken: vi.fn(async () => 'synthetic-token'), refreshAccessToken: vi.fn(async () => 'synthetic-refreshed-token') };
  const sleep = vi.fn(async () => {});
  return { journal, auth, sleep, persisted: () => persisted, client: new ImmutableDriveClient(auth, journal, { sleep, random: () => 0 }) };
}
function respondCreated() {
  vi.mocked(requestUrl).mockResolvedValueOnce(response(200, { ids: ['reserved-id'] }) as never)
    .mockResolvedValueOnce(response(200, { id: 'reserved-id' }) as never)
    .mockResolvedValueOnce(response(200, { id: 'reserved-id', ...metadata, size: String(bytes.byteLength), version: '1', trashed: false }) as never)
    .mockResolvedValueOnce(response(200, {}, bytes) as never);
}

describe('immutable Drive create', () => {
  beforeEach(() => vi.mocked(requestUrl).mockReset());
  it('uses a persisted secret resumable session and confirmed byte ranges for large files', async () => {
    const f = fixture();
    const data = new Uint8Array(6 * 1024 * 1024).buffer;
    const hash = createHash('sha256').update(new Uint8Array(data)).digest('hex');
    const sessions = { load: vi.fn(async () => null), save: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
    const sessionUrl = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=synthetic';
    vi.mocked(requestUrl).mockResolvedValueOnce(response(200, { ids: ['reserved-id'] }) as never)
      .mockResolvedValueOnce(response(200, {}, undefined, { location: sessionUrl }) as never)
      .mockResolvedValueOnce(response(308, {}, undefined, { range: 'bytes=0-4194303' }) as never)
      .mockResolvedValueOnce(response(200, { id: 'reserved-id' }) as never)
      .mockResolvedValueOnce(response(200, { id: 'reserved-id', ...metadata, size: String(data.byteLength), version: '1', trashed: false }) as never)
      .mockResolvedValueOnce(response(200, {}, data) as never);
    const client = new ImmutableDriveClient(f.auth, f.journal, { sessions, sleep: f.sleep });
    await expect(client.create({ operationKey: 'large', metadata, data, sha256: hash }, signal())).resolves.toBe('reserved-id');
    expect((vi.mocked(requestUrl).mock.calls[1][0] as RequestUrlParam).url).toContain('uploadType=resumable');
    expect((vi.mocked(requestUrl).mock.calls[2][0] as RequestUrlParam).headers?.['Content-Range']).toBe('bytes 0-4194303/6291456');
    expect((vi.mocked(requestUrl).mock.calls[3][0] as RequestUrlParam).headers?.['Content-Range']).toBe('bytes 4194304-6291455/6291456');
    expect(sessions.save.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(requestUrl).mock.invocationCallOrder[2]);
    expect(JSON.stringify(f.persisted())).not.toContain('upload_id');
    expect(sessions.remove).toHaveBeenCalled();
  });
  it('checks resumable status after a lost chunk response before sending further bytes', async () => {
    const f = fixture();
    const data = new Uint8Array(6 * 1024 * 1024).buffer;
    const hash = createHash('sha256').update(new Uint8Array(data)).digest('hex');
    const sessions = { load: vi.fn(async () => null), save: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
    vi.mocked(requestUrl).mockResolvedValueOnce(response(200, { ids: ['reserved-id'] }) as never)
      .mockResolvedValueOnce(response(200, {}, undefined, { location: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=synthetic' }) as never)
      .mockRejectedValueOnce(new Error('lost response'))
      .mockResolvedValueOnce(response(308, {}, undefined, { range: 'bytes=0-4194303' }) as never)
      .mockResolvedValueOnce(response(200, { id: 'reserved-id' }) as never)
      .mockResolvedValueOnce(response(200, { id: 'reserved-id', ...metadata, size: String(data.byteLength), version: '1', trashed: false }) as never)
      .mockResolvedValueOnce(response(200, {}, data) as never);
    await new ImmutableDriveClient(f.auth, f.journal, { sessions, sleep: f.sleep }).create({ operationKey: 'large', metadata, data, sha256: hash }, signal());
    expect((vi.mocked(requestUrl).mock.calls[3][0] as RequestUrlParam).headers?.['Content-Range']).toBe('bytes */6291456');
    expect((vi.mocked(requestUrl).mock.calls[4][0] as RequestUrlParam).headers?.['Content-Range']).toBe('bytes 4194304-6291455/6291456');
  });
  it('does not recreate a previously verified immutable object when it later disappears', async () => {
    const f = fixture(); respondCreated();
    await f.client.create({ operationKey: 'op', metadata, data: bytes, sha256 }, signal());
    vi.mocked(requestUrl).mockReset();
    vi.mocked(requestUrl).mockResolvedValue(response(404) as never);
    const restarted = new ImmutableDriveClient(f.auth, f.journal, { sleep: f.sleep });
    await expect(restarted.create({ operationKey: 'op', metadata, data: bytes, sha256 }, signal())).rejects.toThrow();
    expect((vi.mocked(requestUrl).mock.calls[0][0] as RequestUrlParam).method ?? 'GET').toBe('GET');
  });
  it('rejects a version change to a previously verified immutable object', async () => {
    const f = fixture(); respondCreated();
    await f.client.create({ operationKey: 'op', metadata, data: bytes, sha256 }, signal());
    vi.mocked(requestUrl).mockReset();
    vi.mocked(requestUrl).mockResolvedValueOnce(response(200, { id: 'reserved-id', ...metadata, size: String(bytes.byteLength), version: '2', trashed: false }) as never)
      .mockResolvedValueOnce(response(200, {}, bytes) as never);
    await expect(f.client.create({ operationKey: 'op', metadata, data: bytes, sha256 }, signal())).rejects.toThrow(/integrity/i);
    expect(requestUrl).toHaveBeenCalledTimes(1);
  });
  it('persists a generated ID before sending one multipart metadata-and-byte creation', async () => {
    const f = fixture();
    respondCreated();
    await expect(f.client.create({ operationKey: 'op', metadata, data: bytes, sha256 }, signal())).resolves.toBe('reserved-id');
    expect(f.journal.save.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(requestUrl).mock.invocationCallOrder[1]);
    const creation = vi.mocked(requestUrl).mock.calls[1][0] as RequestUrlParam;
    expect(creation.url).toContain('uploadType=multipart');
    expect(creation.method).toBe('POST');
    expect(creation.body).toBeInstanceOf(ArrayBuffer);
    const body = new TextDecoder().decode(creation.body as ArrayBuffer);
    expect(body).toContain('"id":"reserved-id"');
    expect(body).toContain('synthetic immutable bytes');
    expect(f.persisted().op.id).toBe('reserved-id');
  });
  it('does not create remotely when the generated ID cannot be persisted', async () => {
    const f = fixture();
    f.journal.save.mockRejectedValue(new Error('disk full'));
    vi.mocked(requestUrl).mockResolvedValueOnce(response(200, { ids: ['reserved-id'] }) as never);
    await expect(f.client.create({ operationKey: 'op', metadata, data: bytes, sha256 }, signal())).rejects.toThrow('disk full');
    expect(requestUrl).toHaveBeenCalledTimes(1);
  });
  it('verifies an existing generated ID after a lost response and restart without overwriting it', async () => {
    const f = fixture();
    vi.mocked(requestUrl).mockResolvedValueOnce(response(200, { ids: ['reserved-id'] }) as never)
      .mockRejectedValue(new Error('response lost'));
    await expect(f.client.create({ operationKey: 'op', metadata, data: bytes, sha256 }, signal())).rejects.toThrow();
    vi.mocked(requestUrl).mockReset();
    vi.mocked(requestUrl).mockResolvedValueOnce(response(409) as never)
      .mockResolvedValueOnce(response(200, { id: 'reserved-id', ...metadata, size: String(bytes.byteLength), version: '1', trashed: false }) as never)
      .mockResolvedValueOnce(response(200, {}, bytes) as never);
    const restarted = new ImmutableDriveClient(f.auth, f.journal, { sleep: f.sleep });
    await expect(restarted.create({ operationKey: 'op', metadata, data: bytes, sha256 }, signal())).resolves.toBe('reserved-id');
    expect(requestUrl).toHaveBeenCalledTimes(3);
    expect(vi.mocked(requestUrl).mock.calls.every(([arg]) => (arg as RequestUrlParam).method !== 'PATCH')).toBe(true);
  });
  it('rejects 409 when existing bytes do not match, including an empty placeholder', async () => {
    const f = fixture();
    vi.mocked(requestUrl).mockResolvedValueOnce(response(200, { ids: ['reserved-id'] }) as never)
      .mockResolvedValueOnce(response(409) as never)
      .mockResolvedValueOnce(response(200, { id: 'reserved-id', ...metadata, size: String(bytes.byteLength), version: '1', trashed: false }) as never)
      .mockResolvedValueOnce(response(200, {}, new ArrayBuffer(0)) as never);
    await expect(f.client.create({ operationKey: 'op', metadata, data: bytes, sha256 }, signal())).rejects.toThrow(/integrity/i);
  });
  it('rejects reuse of an operation key for different metadata before sending another request', async () => {
    const f = fixture(); respondCreated();
    await f.client.create({ operationKey: 'op', metadata, data: bytes, sha256 }, signal());
    vi.mocked(requestUrl).mockClear();
    await expect(f.client.create({ operationKey: 'op', metadata: { ...metadata, name: 'different' }, data: bytes, sha256 }, signal())).rejects.toThrow(/operation/i);
    expect(requestUrl).not.toHaveBeenCalled();
  });
  it('blocks oversized or hash-mismatched bytes before reservation or networking', async () => {
    const f = fixture();
    await expect(f.client.create({ operationKey: 'op', metadata, data: bytes, sha256: '0'.repeat(64) }, signal())).rejects.toThrow(/hash/i);
    expect(requestUrl).not.toHaveBeenCalled();
  });
  it('honors cancellation after an uncertain response without clearing the reservation', async () => {
    const f = fixture(); const abort = new AbortController();
    vi.mocked(requestUrl).mockResolvedValueOnce(response(200, { ids: ['reserved-id'] }) as never)
      .mockImplementationOnce(async () => { abort.abort(); return response(200, { id: 'reserved-id' }) as never; });
    await expect(f.client.create({ operationKey: 'op', metadata, data: bytes, sha256 }, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.persisted().op.id).toBe('reserved-id');
    expect(requestUrl).toHaveBeenCalledTimes(2);
  });
});
