import { describe, it, expect, vi } from 'vitest';
import { TFile } from 'obsidian';
import { pushNoteToGoogleDocs, pullNoteFromGoogleDocs, GDocsPluginLike } from '../../src/sync/SyncActions';

function makeTFile(path = 'Notes/Foo.md'): TFile {
  const f = new TFile();
  f.path = path;
  f.basename = path.split('/').pop()!.replace(/\.md$/, '');
  f.extension = 'md';
  return f;
}

function makePlugin(overrides: { frontmatter?: Record<string, unknown> } = {}): GDocsPluginLike & {
  statusBar: {
    setSyncing: ReturnType<typeof vi.fn>;
    setSynced: ReturnType<typeof vi.fn>;
    setError: ReturnType<typeof vi.fn>;
    setReauthNeeded: ReturnType<typeof vi.fn>;
  };
  syncEngine: {
    syncLocalToRemote: ReturnType<typeof vi.fn>;
    syncRemoteToLocal: ReturnType<typeof vi.fn>;
  };
  fileCommandBar: { update: ReturnType<typeof vi.fn> };
} {
  return {
    app: {
      metadataCache: {
        getFileCache: vi.fn(() => ({ frontmatter: overrides.frontmatter })),
      },
    } as never,
    statusBar: {
      setSyncing: vi.fn(),
      setSynced: vi.fn(),
      setError: vi.fn(),
      setReauthNeeded: vi.fn(),
    } as never,
    syncEngine: {
      syncLocalToRemote: vi.fn().mockResolvedValue(undefined),
      syncRemoteToLocal: vi.fn().mockResolvedValue(undefined),
    } as never,
    perFileErrors: new Map(),
    fileCommandBar: { update: vi.fn() },
  };
}

describe('pushNoteToGoogleDocs', () => {
  it('syncs the file and shows a success notice', async () => {
    const plugin = makePlugin();
    const file = makeTFile();

    await pushNoteToGoogleDocs(plugin, file);

    expect(plugin.statusBar.setSyncing).toHaveBeenCalledWith('Foo');
    expect(plugin.syncEngine.syncLocalToRemote).toHaveBeenCalledWith(file, true);
    expect(plugin.statusBar.setSynced).toHaveBeenCalled();
    expect(plugin.perFileErrors.has(file.path)).toBe(false);
    expect(plugin.fileCommandBar.update).toHaveBeenCalledWith(file.path);
  });

  it('rejects non-markdown files with a notice and does not call syncEngine', async () => {
    const plugin = makePlugin();
    const file = makeTFile('Attachments/photo.png');
    file.extension = 'png';

    await pushNoteToGoogleDocs(plugin, file);

    expect(plugin.syncEngine.syncLocalToRemote).not.toHaveBeenCalled();
    expect(plugin.statusBar.setSyncing).not.toHaveBeenCalled();
  });

  it('sets error state and records perFileErrors on failure', async () => {
    const plugin = makePlugin();
    plugin.syncEngine.syncLocalToRemote.mockRejectedValue(new Error('network down'));
    const file = makeTFile();

    await pushNoteToGoogleDocs(plugin, file);

    expect(plugin.statusBar.setError).toHaveBeenCalledWith('sync failed');
    expect(plugin.perFileErrors.get(file.path)).toBe('network down');
    expect(plugin.fileCommandBar.update).toHaveBeenCalledWith(file.path);
  });

  it('triggers reauth flow when the error message mentions revocation', async () => {
    const plugin = makePlugin();
    plugin.syncEngine.syncLocalToRemote.mockRejectedValue(new Error('token has been revoked'));
    const file = makeTFile();

    await pushNoteToGoogleDocs(plugin, file);

    expect(plugin.statusBar.setReauthNeeded).toHaveBeenCalled();
    expect(plugin.statusBar.setError).not.toHaveBeenCalled();
  });
});

describe('pullNoteFromGoogleDocs', () => {
  it('pulls the linked doc and shows a success notice', async () => {
    const plugin = makePlugin({ frontmatter: { 'gdocs-id': 'doc123' } });
    const file = makeTFile();

    await pullNoteFromGoogleDocs(plugin, file);

    expect(plugin.statusBar.setSyncing).toHaveBeenCalledWith('Foo');
    expect(plugin.syncEngine.syncRemoteToLocal).toHaveBeenCalledWith('doc123', true);
    expect(plugin.statusBar.setSynced).toHaveBeenCalled();
    expect(plugin.perFileErrors.has(file.path)).toBe(false);
    expect(plugin.fileCommandBar.update).toHaveBeenCalledWith(file.path);
  });

  it('shows a notice and does not call syncEngine when there is no gdocs-id', async () => {
    const plugin = makePlugin({ frontmatter: {} });
    const file = makeTFile();

    await pullNoteFromGoogleDocs(plugin, file);

    expect(plugin.syncEngine.syncRemoteToLocal).not.toHaveBeenCalled();
    expect(plugin.statusBar.setSyncing).not.toHaveBeenCalled();
  });

  it('sets error state and records perFileErrors on failure', async () => {
    const plugin = makePlugin({ frontmatter: { 'gdocs-id': 'doc123' } });
    plugin.syncEngine.syncRemoteToLocal.mockRejectedValue(new Error('server error'));
    const file = makeTFile();

    await pullNoteFromGoogleDocs(plugin, file);

    expect(plugin.statusBar.setError).toHaveBeenCalledWith('pull failed');
    expect(plugin.perFileErrors.get(file.path)).toBe('server error');
  });

  it('triggers reauth flow when the error message mentions revocation', async () => {
    const plugin = makePlugin({ frontmatter: { 'gdocs-id': 'doc123' } });
    plugin.syncEngine.syncRemoteToLocal.mockRejectedValue(new Error('token has been revoked'));
    const file = makeTFile();

    await pullNoteFromGoogleDocs(plugin, file);

    expect(plugin.statusBar.setReauthNeeded).toHaveBeenCalled();
    expect(plugin.statusBar.setError).not.toHaveBeenCalled();
  });
});
