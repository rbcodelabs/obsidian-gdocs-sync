import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FolderPoller } from '../../src/sync/FolderPoller';
import type { FolderMapping } from '../../src/types';

const MAPPING: FolderMapping = {
  driveFolderId: 'folder-abc',
  driveFolderName: 'Finances & Estate',
  obsidianFolder: 'Finances & Estate',
};

describe('FolderPoller', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('calls importFolder for each mapping on the 5-minute interval', async () => {
    const importFolder = vi.fn().mockResolvedValue({ imported: 0, skipped: 1, folderName: 'Finances & Estate' });
    const poller = new FolderPoller(() => [MAPPING], importFolder);

    poller.start();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(importFolder).toHaveBeenCalledTimes(1);
    expect(importFolder).toHaveBeenCalledWith('folder-abc', 'Finances & Estate');
  });

  it('does not call importFolder before the interval fires', async () => {
    const importFolder = vi.fn().mockResolvedValue({ imported: 0, skipped: 0, folderName: 'X' });
    const poller = new FolderPoller(() => [MAPPING], importFolder);

    poller.start();
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000); // 4 minutes — not yet

    expect(importFolder).not.toHaveBeenCalled();
  });

  it('fires multiple times across multiple intervals', async () => {
    const importFolder = vi.fn().mockResolvedValue({ imported: 0, skipped: 0, folderName: 'X' });
    const poller = new FolderPoller(() => [MAPPING], importFolder);

    poller.start();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000); // 15 minutes → 3 ticks

    expect(importFolder).toHaveBeenCalledTimes(3);
  });

  it('stops firing after stop() is called', async () => {
    const importFolder = vi.fn().mockResolvedValue({ imported: 0, skipped: 0, folderName: 'X' });
    const poller = new FolderPoller(() => [MAPPING], importFolder);

    poller.start();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000); // 1 tick
    poller.stop();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000); // would be 2 more ticks

    expect(importFolder).toHaveBeenCalledTimes(1);
  });

  it('does nothing when there are no folder mappings', async () => {
    const importFolder = vi.fn();
    const poller = new FolderPoller(() => [], importFolder);

    poller.start();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(importFolder).not.toHaveBeenCalled();
  });

  it('calls importFolder for each of multiple mappings', async () => {
    const mapping2: FolderMapping = { driveFolderId: 'folder-xyz', driveFolderName: 'Work', obsidianFolder: 'Work' };
    const importFolder = vi.fn().mockResolvedValue({ imported: 0, skipped: 0, folderName: '' });
    const poller = new FolderPoller(() => [MAPPING, mapping2], importFolder);

    poller.start();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(importFolder).toHaveBeenCalledTimes(2);
    expect(importFolder).toHaveBeenCalledWith('folder-abc', 'Finances & Estate');
    expect(importFolder).toHaveBeenCalledWith('folder-xyz', 'Work');
  });

  it('continues polling even if one import throws', async () => {
    const mapping2: FolderMapping = { driveFolderId: 'folder-xyz', driveFolderName: 'Work', obsidianFolder: 'Work' };
    const importFolder = vi.fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValue({ imported: 1, skipped: 0, folderName: 'Work' });

    const poller = new FolderPoller(() => [MAPPING, mapping2], importFolder);

    poller.start();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    // Both mappings attempted despite first one failing
    expect(importFolder).toHaveBeenCalledTimes(2);
  });
});
