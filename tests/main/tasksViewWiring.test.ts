import { describe, expect, it, vi } from 'vitest';
import GDocsPlugin from '../../src/main';
import { TasksView, TASKS_VIEW_TYPE } from '../../src/ui/TasksView';
import { DEFAULT_SETTINGS } from '../../src/types';

/** QA: plugin-level wiring for the Tasks view (reveal helper, unload cleanup, settings defaults). */

function fakePlugin(workspace: Record<string, unknown>) {
  const plugin = Object.create(GDocsPlugin.prototype) as GDocsPlugin;
  Object.assign(plugin, { app: { workspace }, settings: { ...DEFAULT_SETTINGS } });
  return plugin;
}

describe('activateTasksView', () => {
  it('creates a right-sidebar leaf, sets the view type and reveals it when none exists', async () => {
    const right = { setViewState: vi.fn().mockResolvedValue(undefined), view: {} };
    const ws = { getLeavesOfType: vi.fn(() => []), getRightLeaf: vi.fn(() => right), revealLeaf: vi.fn().mockResolvedValue(undefined) };
    await fakePlugin(ws).activateTasksView();
    expect(ws.getRightLeaf).toHaveBeenCalledWith(false);
    expect(right.setViewState).toHaveBeenCalledWith({ type: TASKS_VIEW_TYPE, active: true });
    expect(ws.revealLeaf).toHaveBeenCalledWith(right);
  });

  it('reuses an existing Tasks leaf instead of opening a second one', async () => {
    const existing = { view: {}, setViewState: vi.fn() };
    const ws = { getLeavesOfType: vi.fn(() => [existing]), getRightLeaf: vi.fn(), revealLeaf: vi.fn().mockResolvedValue(undefined) };
    await fakePlugin(ws).activateTasksView();
    expect(ws.getRightLeaf).not.toHaveBeenCalled();
    expect(existing.setViewState).not.toHaveBeenCalled();
    expect(ws.revealLeaf).toHaveBeenCalledWith(existing);
  });

  it('does nothing (and does not throw) when the host has no right sidebar leaf available', async () => {
    const ws = { getLeavesOfType: vi.fn(() => []), getRightLeaf: vi.fn(() => null), revealLeaf: vi.fn() };
    await expect(fakePlugin(ws).activateTasksView()).resolves.toBeUndefined();
    expect(ws.revealLeaf).not.toHaveBeenCalled();
  });

  it('focuses the quick-add input only when asked and only on a real TasksView', async () => {
    const view = Object.create(TasksView.prototype) as TasksView;
    const focus = vi.spyOn(view, 'focusQuickAdd').mockImplementation(() => {});
    const leaf = { view };
    const ws = { getLeavesOfType: vi.fn(() => [leaf]), getRightLeaf: vi.fn(), revealLeaf: vi.fn().mockResolvedValue(undefined) };
    await fakePlugin(ws).activateTasksView(false);
    expect(focus).not.toHaveBeenCalled();
    await fakePlugin(ws).activateTasksView(true);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('does not call focusQuickAdd on a deferred (not yet loaded) leaf view', async () => {
    const leaf = { view: { notATasksView: true } };
    const ws = { getLeavesOfType: vi.fn(() => [leaf]), getRightLeaf: vi.fn(), revealLeaf: vi.fn().mockResolvedValue(undefined) };
    await expect(fakePlugin(ws).activateTasksView(true)).resolves.toBeUndefined();
  });
});

describe('onunload', () => {
  it('does not detach Tasks view leaves on unload (Obsidian restores their layout position)', () => {
    const ws = { detachLeavesOfType: vi.fn() };
    const plugin = fakePlugin(ws);
    Object.assign(plugin, { syncEngine: { stop: vi.fn() }, tasksSyncEngine: { stop: vi.fn() }, fileCommandBar: { destroy: vi.fn() } });
    plugin.onunload();
    expect(ws.detachLeavesOfType).not.toHaveBeenCalled();
  });

  it('survives being unloaded before the engines were created (early-unload)', () => {
    const ws = { detachLeavesOfType: vi.fn() };
    const plugin = fakePlugin(ws);
    expect(() => plugin.onunload()).not.toThrow();
  });
});

describe('settings migration', () => {
  it('gives upgraded installs (saved data without the new key) the Today default', async () => {
    const plugin = Object.create(GDocsPlugin.prototype) as GDocsPlugin;
    (plugin as unknown as { loadData: () => Promise<unknown> }).loadData = async () => ({ tasksFolder: 'My Tasks' });
    await plugin.loadSettings();
    expect(plugin.settings.tasksViewDefaultFilter).toBe('today');
    expect(plugin.settings.tasksFolder).toBe('My Tasks');
  });

  it('tolerates a null data.json (fresh install)', async () => {
    const plugin = Object.create(GDocsPlugin.prototype) as GDocsPlugin;
    (plugin as unknown as { loadData: () => Promise<unknown> }).loadData = async () => null;
    await plugin.loadSettings();
    expect(plugin.settings.tasksViewDefaultFilter).toBe('today');
  });
});
