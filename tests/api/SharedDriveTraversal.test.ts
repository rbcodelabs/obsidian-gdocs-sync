import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestUrl } from 'obsidian';
import { GoogleDocsAPI } from '../../src/api/GoogleDocsAPI';

const mock = vi.mocked(requestUrl);
const api = () => new GoogleDocsAPI({ getValidAccessToken: async () => 'synthetic-token' } as never);
const response = (json: object) => ({ status: 200, json } as never);
const urlAt = (index: number) => new URL((mock.mock.calls[index][0] as { url: string }).url);
const folder = { id: 'child', name: 'Child', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '' };
const doc = { id: 'doc', name: 'Notes', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-01-01' };

beforeEach(() => mock.mockReset());

describe('complete Drive traversal', () => {
  it('resolves a pasted nested folder and searches its entire Shared Drive', async () => {
    mock.mockResolvedValueOnce(response({ driveId: 'team-drive' })).mockResolvedValueOnce(response({ files: [doc] }));
    expect(await api().listFolderContents('nested-folder')).toEqual([doc]);
    expect(urlAt(0).pathname).toContain('/files/nested-folder');
    expect(urlAt(0).searchParams.get('fields')).toBe('driveId');
    expect(urlAt(0).searchParams.get('supportsAllDrives')).toBe('true');
    expect(urlAt(1).searchParams.get('corpora')).toBe('drive');
    expect(urlAt(1).searchParams.get('driveId')).toBe('team-drive');
  });

  it('keeps personal folders in the user corpus without a drive ID', async () => {
    mock.mockResolvedValueOnce(response({})).mockResolvedValueOnce(response({ files: [doc] }));
    expect(await api().listFolderContents('personal-folder')).toEqual([doc]);
    expect(urlAt(1).searchParams.get('corpora')).toBe('user');
    expect(urlAt(1).searchParams.has('driveId')).toBe(false);
  });

  it('browses My Drive root without a metadata lookup', async () => {
    mock.mockResolvedValueOnce(response({ files: [folder] }));
    expect(await api().listFolderContents('root')).toEqual([folder]);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(urlAt(0).searchParams.get('corpora')).toBe('user');
  });

  it('follows empty intermediate file pages and preserves the drive scope', async () => {
    mock.mockResolvedValueOnce(response({ driveId: 'team-drive' }))
      .mockResolvedValueOnce(response({ files: [], nextPageToken: 'page+/=' }))
      .mockResolvedValueOnce(response({ files: [doc] }));
    expect(await api().listFolderContents('nested')).toEqual([doc]);
    expect(urlAt(2).searchParams.get('pageToken')).toBe('page+/=');
    expect(urlAt(2).searchParams.get('driveId')).toBe('team-drive');
    expect(urlAt(2).searchParams.get('corpora')).toBe('drive');
    expect(urlAt(1).searchParams.get('fields')).toContain('nextPageToken');
  });

  it('imports later pages and nested folders with one resolved drive scope', async () => {
    mock.mockResolvedValueOnce(response({ driveId: 'team-drive' }))
      .mockResolvedValueOnce(response({ files: [], nextPageToken: 'second' }))
      .mockResolvedValueOnce(response({ files: [folder] }))
      .mockResolvedValueOnce(response({ files: [doc], nextPageToken: 'child-second' }))
      .mockResolvedValueOnce(response({ files: [{ ...doc, id: 'doc2', name: 'More' }] }));
    expect(await api().listDocsInFolder('nested')).toEqual([
      { id: 'doc', name: 'Notes', modifiedTime: '2026-01-01', relativePath: 'Child/Notes' },
      { id: 'doc2', name: 'More', modifiedTime: '2026-01-01', relativePath: 'Child/More' },
    ]);
    expect(mock).toHaveBeenCalledTimes(5);
    for (let i = 1; i < 5; i++) {
      expect(urlAt(i).searchParams.get('driveId')).toBe('team-drive');
      expect(urlAt(i).searchParams.get('corpora')).toBe('drive');
    }
  });

  it('does not silently fall back to incomplete results when metadata fails', async () => {
    mock.mockResolvedValueOnce({ status: 403, text: 'Access denied' } as never);
    await expect(api().listFolderContents('nested')).rejects.toThrow('403');
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('rejects a later-page failure instead of returning a partial import', async () => {
    mock.mockResolvedValueOnce(response({ files: [doc], nextPageToken: 'second' }))
      .mockResolvedValueOnce({ status: 500, text: 'Unavailable' } as never);
    await expect(api().listDocsInFolder('root')).rejects.toThrow('500');
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('lists Shared Drives from all pages, including empty intermediate pages', async () => {
    mock.mockResolvedValueOnce(response({ drives: [{ id: 'one', name: 'One' }], nextPageToken: 'second' }))
      .mockResolvedValueOnce(response({ nextPageToken: 'third' }))
      .mockResolvedValueOnce(response({ drives: [{ id: 'three', name: 'Three' }] }));
    expect(await api().listSharedDrives()).toEqual([{ id: 'one', name: 'One' }, { id: 'three', name: 'Three' }]);
    expect(urlAt(0).searchParams.get('fields')).toContain('nextPageToken');
    expect(urlAt(2).searchParams.get('pageToken')).toBe('third');
  });

  it('rejects later Shared Drive page errors rather than hiding missing drives', async () => {
    mock.mockResolvedValueOnce(response({ drives: [], nextPageToken: 'second' }))
      .mockResolvedValueOnce({ status: 403, text: 'Access denied' } as never);
    await expect(api().listSharedDrives()).rejects.toThrow('403');
  });
});
