import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleDriveSyncProvider } from '../../src/sync/GoogleDriveSyncProvider';

const tokenStore = { getValidAccessToken: vi.fn(async () => 'token') };
const root = { id: 'root', name: 'Geode Vault', mimeType: 'application/vnd.google-apps.folder', appProperties: { geodeVaultId: 'v' }, trashed: false };

function response(body: unknown, init: ResponseInit = {}) {
  return new Response(typeof body === 'string' || body instanceof ArrayBuffer ? body : JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('GoogleDriveSyncProvider', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('reports Drive v3 conditional-write limitations so Geode fails closed', () => {
    const provider = new GoogleDriveSyncProvider(tokenStore as never, { rootFolderId: 'root', saveRootFolderId: vi.fn() });
    expect(provider.capabilities).toMatchObject({ binary: true, completeSnapshots: true, conditionalWrites: false, trash: true });
  });

  it('creates and recursively scans a dedicated Drive folder across pages', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ files: [] }))
      .mockResolvedValueOnce(response({ id: 'root', name: 'Geode Vault', version: '1' }))
      .mockResolvedValueOnce(response({ files: [
        { id: 'a', name: 'a.md', mimeType: 'text/markdown', parents: ['root'], version: '2', size: '3', md5Checksum: 'h' },
      ], nextPageToken: 'next' }))
      .mockResolvedValueOnce(response({ files: [
        { id: 'dir', name: 'nested', mimeType: 'application/vnd.google-apps.folder', parents: ['root'], version: '3' },
      ] }))
      .mockResolvedValueOnce(response({ files: [
        { id: 'b', name: 'b.bin', mimeType: 'application/octet-stream', parents: ['dir'], version: '4', size: '2' },
      ] }));

    const provider = new GoogleDriveSyncProvider(tokenStore as never, { rootFolderId: '', saveRootFolderId: vi.fn(async () => {}) });
    const session = await provider.open({ vaultId: 'vault-id' });
    const result = await session.scan(undefined, new AbortController().signal);

    expect(result.status).toBe('complete');
    expect(result.mode).toBe('snapshot');
    expect(result.entries.map((entry) => [entry.id, entry.path, entry.kind, entry.revision])).toEqual([
      ['a', 'a.md', 'file', '2'], ['dir', 'nested', 'folder', '3'], ['b', 'nested/b.bin', 'file', '4'],
    ]);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('pageToken=next'))).toBe(true);
  });

  it('round-trips raw bytes and passes abort signals', async () => {
    const bytes = new Uint8Array([0, 255, 1]).buffer;
    const signal = new AbortController().signal;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(root)).mockResolvedValueOnce(response(bytes));
    const provider = new GoogleDriveSyncProvider(tokenStore as never, { rootFolderId: 'root', saveRootFolderId: vi.fn() });
    const session = await provider.open({ vaultId: 'v' });

    await expect(session.read({ id: 'x', path: 'x.bin', kind: 'file', revision: '1' }, signal)).resolves.toEqual(bytes);
    expect(fetchMock.mock.calls[1]?.[1]?.signal).toBe(signal);
  });

  it('fails an update before upload when the expected Drive version changed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(root)).mockResolvedValueOnce(response({ id: 'x', version: '8' }));
    const provider = new GoogleDriveSyncProvider(tokenStore as never, { rootFolderId: 'root', saveRootFolderId: vi.fn() });
    const session = await provider.open({ vaultId: 'v' });

    await expect(session.update({ id: 'x', path: 'x.md', data: new ArrayBuffer(0), expectedRevision: '7', operationKey: 'op', signal: new AbortController().signal }))
      .rejects.toMatchObject({ name: 'SyncPreconditionError' });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('creates raw files idempotently using an operation key', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(root))
      .mockResolvedValueOnce(response({ files: [] }))
      .mockResolvedValueOnce(response({ id: 'new', name: 'x.bin', parents: ['root'], version: '1', appProperties: { geodeOperationKey: 'op' } }))
      .mockResolvedValueOnce(response({ id: 'new', name: 'x.bin', parents: ['root'], version: '2', size: '3', appProperties: { geodeOperationKey: 'op' } }));
    const session = await new GoogleDriveSyncProvider(tokenStore as never, { rootFolderId: 'root', saveRootFolderId: vi.fn() }).open({ vaultId: 'v' });
    const data = new Uint8Array([0, 1, 255]).buffer;
    await expect(session.create({ path: 'x.bin', data, operationKey: 'op', signal: new AbortController().signal })).resolves.toMatchObject({ id: 'new', revision: '2', size: 3, operationKey: 'op' });
    expect(fetchMock.mock.calls[3]?.[1]?.body).toBe(data);
  });

  it('moves and trashes only after matching the expected Drive version', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(root))
      .mockResolvedValueOnce(response({ id: 'x', name: 'old.md', parents: ['root'], version: '7' }))
      .mockResolvedValueOnce(response({ id: 'x', name: 'new.md', parents: ['root'], version: '8' }))
      .mockResolvedValueOnce(response({ id: 'x', name: 'new.md', parents: ['root'], version: '8' }))
      .mockResolvedValueOnce(response({ id: 'x', name: 'new.md', parents: ['root'], version: '9' }));
    const session = await new GoogleDriveSyncProvider(tokenStore as never, { rootFolderId: 'root', saveRootFolderId: vi.fn() }).open({ vaultId: 'v' });
    await session.move({ id: 'x', path: 'new.md', expectedRevision: '7', signal: new AbortController().signal });
    await session.trash({ id: 'x', expectedRevision: '8', signal: new AbortController().signal });
    expect(String(fetchMock.mock.calls[2]?.[1]?.body)).toContain('new.md');
    expect(String(fetchMock.mock.calls[4]?.[1]?.body)).toContain('trashed');
  });

  it.each([401, 403, 404, 429])('maps Drive HTTP %s to an actionable provider error', async (status) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(root)).mockResolvedValueOnce(response('failure', { status, statusText: 'nope' }));
    const provider = new GoogleDriveSyncProvider(tokenStore as never, { rootFolderId: 'root', saveRootFolderId: vi.fn() });
    const session = await provider.open({ vaultId: 'v' });
    await expect(session.read({ id: 'x', path: 'x', kind: 'file', revision: '1' }, new AbortController().signal))
      .rejects.toMatchObject({ code: status === 401 ? 'auth_expired' : status === 429 ? 'rate_limited' : status === 404 ? 'not_found' : 'permission_denied' });
  });

  it('rejects a configured root that belongs to another vault', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response({ ...root, appProperties: { geodeVaultId: 'other' } }));
    const provider = new GoogleDriveSyncProvider(tokenStore as never, { rootFolderId: 'root', saveRootFolderId: vi.fn() });
    await expect(provider.open({ vaultId: 'v' })).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('does not overwrite an object found for a replayed create operation', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(root))
      .mockResolvedValueOnce(response({ files: [{ id: 'existing', name: 'x.bin', version: '3', size: '3', appProperties: { geodeOperationKey: 'op' } }] }));
    const session = await new GoogleDriveSyncProvider(tokenStore as never, { rootFolderId: 'root', saveRootFolderId: vi.fn() }).open({ vaultId: 'v' });
    await expect(session.create({ path: 'x.bin', data: new Uint8Array([9]).buffer, operationKey: 'op', signal: new AbortController().signal })).resolves.toMatchObject({ id: 'existing', revision: '3' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
