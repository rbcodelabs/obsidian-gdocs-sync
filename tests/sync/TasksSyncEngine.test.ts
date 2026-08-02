import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TFile } from 'obsidian';
import { TasksSyncEngine } from '../../src/sync/TasksSyncEngine';
import { FileWatcher } from '../../src/sync/FileWatcher';
import { FM } from '../../src/converter/TaskNoteMapper';
import type { GoogleTask, GoogleTaskList } from '../../src/api/GoogleTasksAPI';

// ─── In-memory vault fake ───────────────────────────────────────────────────────

const LIST: GoogleTaskList = { id: 'L1', title: 'Personal', updated: 't' };

function makeTFile(path: string): TFile {
  const f = new TFile();
  f.path = path;
  f.basename = path.split('/').pop()!.replace(/\.md$/, '');
  f.extension = 'md';
  return f;
}

function parseFM(content: string): { fm: Record<string, unknown>; body: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: content };
  const fm: Record<string, unknown> = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const rawVal = line.slice(idx + 1).trim();
    let val: unknown = rawVal;
    if (rawVal === 'true') val = true;
    else if (rawVal === 'false') val = false;
    else if (rawVal.startsWith('"')) {
      try {
        val = JSON.parse(rawVal);
      } catch {
        /* keep raw */
      }
    }
    fm[key] = val;
  }
  return { fm, body: m[2] };
}

function serializeFM(fm: Record<string, unknown>, body: string): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined) continue;
    if (typeof v === 'boolean') lines.push(`${k}: ${v}`);
    else {
      const s = String(v);
      lines.push(/[:#]/.test(s) || s === '' ? `${k}: ${JSON.stringify(s)}` : `${k}: ${s}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n') + body;
}

function makeVault() {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {
    modify: [],
    delete: [],
    rename: [],
  };

  const vault = {
    getFolderByPath: (p: string) => (folders.has(p) ? { path: p } : null),
    createFolder: async (p: string) => {
      folders.add(p);
    },
    create: async (path: string, content: string) => {
      files.set(path, content);
      return makeTFile(path);
    },
    getAbstractFileByPath: (path: string) => (files.has(path) ? makeTFile(path) : null),
    getMarkdownFiles: () => Array.from(files.keys()).map(makeTFile),
    read: async (file: TFile) => files.get(file.path) ?? '',
    modify: async (file: TFile, content: string) => {
      files.set(file.path, content);
    },
    on: (event: string, cb: (...args: unknown[]) => void) => {
      handlers[event]?.push(cb);
      return { event, cb };
    },
    _files: files,
    _folders: folders,
    _handlers: handlers,
  };

  const metadataCache = {
    getFileCache: (file: TFile) => {
      const content = files.get(file.path);
      if (content === undefined) return null;
      return { frontmatter: parseFM(content).fm };
    },
  };

  const fileManager = {
    processFrontMatter: async (file: TFile, cb: (fm: Record<string, unknown>) => void) => {
      const content = files.get(file.path) ?? '---\n---\n';
      const { fm, body } = parseFM(content);
      cb(fm);
      files.set(file.path, serializeFM(fm, body));
    },
  };

  return { vault, metadataCache, fileManager };
}

function makeApi() {
  return {
    listTaskLists: vi.fn().mockResolvedValue([LIST]),
    listTasks: vi.fn().mockResolvedValue([]),
    insertTask: vi.fn(),
    patchTask: vi.fn(),
    deleteTask: vi.fn().mockResolvedValue(undefined),
  };
}

function makeEngine(apiOverrides: Partial<ReturnType<typeof makeApi>> = {}) {
  const api = { ...makeApi(), ...apiOverrides };
  const { vault, metadataCache, fileManager } = makeVault();
  const plugin = {
    settings: {
      enableTasksSync: true,
      tasksFolder: 'Google Tasks',
      syncedTaskListIds: [] as string[],
      tasksPollIntervalSeconds: 60,
    },
    saveSettings: vi.fn().mockResolvedValue(undefined),
    registerEvent: vi.fn(),
    app: { vault, metadataCache, fileManager },
  };
  const fileWatcher = new FileWatcher(plugin as never);
  const engine = new TasksSyncEngine(
    plugin as never,
    api as never,
    {} as never,
    fileWatcher,
  );
  return { engine, api, vault, plugin };
}

function task(overrides: Partial<GoogleTask> = {}): GoogleTask {
  return {
    id: 'T1',
    title: 'Buy milk',
    status: 'needsAction',
    updated: '2026-08-02T10:00:00.000Z',
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────────

describe('TasksSyncEngine.importAllLists', () => {
  it('creates a note per task with correct frontmatter and body', async () => {
    const { engine, api, vault } = makeEngine({
      listTasks: vi.fn().mockResolvedValue([task({ notes: 'Get 2% milk' })]),
    });

    const result = await engine.importAllLists();

    expect(result.imported).toBe(1);
    const path = 'Google Tasks/Buy milk.md';
    expect(vault._files.has(path)).toBe(true);
    const { fm, body } = parseFM(vault._files.get(path)!);
    expect(fm[FM.id]).toBe('T1');
    expect(fm[FM.listName]).toBe('Personal');
    expect(fm[FM.completed]).toBe(false);
    expect(body).toBe('Get 2% milk');
  });

  it('requests completed and hidden tasks so finished ones are included', async () => {
    const listTasks = vi.fn().mockResolvedValue([]);
    const { engine } = makeEngine({ listTasks });
    await engine.importAllLists();
    expect(listTasks).toHaveBeenCalledWith('L1', { showCompleted: true, showHidden: true });
  });

  it('disambiguates a filename collision using the task id', async () => {
    const { engine, vault } = makeEngine({
      listTasks: vi.fn().mockResolvedValue([
        task({ id: 'AAA111', title: 'Call' }),
        task({ id: 'BBB222', title: 'Call' }),
      ]),
    });
    await engine.importAllLists();
    expect(vault._files.has('Google Tasks/Call.md')).toBe(true);
    expect(vault._files.has('Google Tasks/Call (BBB222).md')).toBe(true);
  });
});

describe('TasksSyncEngine.poll — remote → local', () => {
  it('remote change wins when the local note is unchanged', async () => {
    const listTasks = vi
      .fn()
      .mockResolvedValueOnce([task({ notes: 'v1' })]) // initial import
      .mockResolvedValueOnce([task({ notes: 'v2 remote edit', updated: '2026-08-02T11:00:00.000Z' })]); // poll
    const { engine, vault } = makeEngine({ listTasks });

    await engine.importAllLists();
    await engine.poll();

    const { body } = parseFM(vault._files.get('Google Tasks/Buy milk.md')!);
    expect(body).toBe('v2 remote edit');
  });

  it('soft-deletes (does not remove) a note when the remote task is deleted', async () => {
    const listTasks = vi
      .fn()
      .mockResolvedValueOnce([task()]) // import
      .mockResolvedValueOnce([task({ deleted: true, updated: '2026-08-02T12:00:00.000Z' })]); // poll
    const { engine, vault } = makeEngine({ listTasks });

    await engine.importAllLists();
    await engine.poll();

    const path = 'Google Tasks/Buy milk.md';
    expect(vault._files.has(path)).toBe(true); // never hard-deleted
    expect(parseFM(vault._files.get(path)!).fm[FM.deleted]).toBe(true);
  });
});

describe('TasksSyncEngine.poll — conflict resolution', () => {
  it('merges a local title edit with a remote completion, pushing the merged result', async () => {
    const patchTask = vi.fn().mockImplementation((_l, _t, fields) =>
      Promise.resolve(task({ title: fields.title, status: fields.status, updated: '2026-08-02T13:00:00.000Z' })),
    );
    const listTasks = vi
      .fn()
      .mockResolvedValueOnce([task({ notes: 'body' })]) // import — base
      .mockResolvedValueOnce([task({ notes: 'body', status: 'completed', updated: '2026-08-02T13:00:00.000Z' })]); // remote completed it
    const { engine, api, vault } = makeEngine({ listTasks, patchTask });

    await engine.importAllLists();

    // Simulate a local edit: rename the title in frontmatter before the poll.
    const path = 'Google Tasks/Buy milk.md';
    const { fm, body } = parseFM(vault._files.get(path)!);
    fm[FM.title] = 'Buy oat milk';
    vault._files.set(path, serializeFM(fm, body));

    await engine.poll();

    // Merged result: local title kept AND remote completion applied.
    expect(api.patchTask).toHaveBeenCalledTimes(1);
    const pushed = api.patchTask.mock.calls[0][2];
    expect(pushed.title).toBe('Buy oat milk');
    expect(pushed.status).toBe('completed');

    const after = parseFM(vault._files.get(path)!).fm;
    expect(after[FM.title]).toBe('Buy oat milk');
    expect(after[FM.completed]).toBe(true);
  });
});

describe('TasksSyncEngine — local → remote', () => {
  it('inserts a new task when the user creates a note without a gtasks-id', async () => {
    const insertTask = vi.fn().mockResolvedValue(task({ id: 'NEW', title: 'Water plants' }));
    const { engine, api, vault } = makeEngine({ insertTask });

    // User authored a bare note in the tasks folder (just body text, no frontmatter).
    const path = 'Google Tasks/Water plants.md';
    vault._files.set(path, 'remember the ferns');

    await engine.syncLocalToRemote(makeTFile(path));

    expect(api.insertTask).toHaveBeenCalledTimes(1);
    const [listId, fields] = api.insertTask.mock.calls[0];
    expect(listId).toBe('L1');
    expect(fields.title).toBe('Water plants'); // from filename
    expect(fields.notes).toBe('remember the ferns');
    // gtasks-id written back
    expect(parseFM(vault._files.get(path)!).fm[FM.id]).toBe('NEW');
  });

  it('patches the remote task when a linked note changes', async () => {
    const patchTask = vi.fn().mockResolvedValue(task({ status: 'completed', updated: '2026-08-02T14:00:00.000Z' }));
    const { engine, api, vault } = makeEngine({
      listTasks: vi.fn().mockResolvedValue([task({ notes: 'body' })]),
      patchTask,
    });
    await engine.importAllLists();

    // Flip completion locally.
    const path = 'Google Tasks/Buy milk.md';
    const { fm, body } = parseFM(vault._files.get(path)!);
    fm[FM.completed] = true;
    vault._files.set(path, serializeFM(fm, body));

    await engine.syncLocalToRemote(makeTFile(path));

    expect(api.patchTask).toHaveBeenCalledTimes(1);
    expect(api.patchTask.mock.calls[0][2].status).toBe('completed');
  });

  it('skips the push when the note is unchanged since last sync', async () => {
    const patchTask = vi.fn();
    const { engine, api, vault } = makeEngine({
      listTasks: vi.fn().mockResolvedValue([task({ notes: 'body' })]),
      patchTask,
    });
    await engine.importAllLists();

    // No edit — just re-run the push for the same file.
    await engine.syncLocalToRemote(makeTFile('Google Tasks/Buy milk.md'));

    expect(api.patchTask).not.toHaveBeenCalled();
  });
});

describe('TasksSyncEngine — local delete → remote delete', () => {
  it('deletes the remote task when its note is deleted in the vault', async () => {
    const deleteTask = vi.fn().mockResolvedValue(undefined);
    const { engine, api, vault, plugin } = makeEngine({
      listTasks: vi.fn().mockResolvedValue([task()]),
      deleteTask,
    });

    await engine.start(); // registers the vault 'delete' listener
    // start() runs importAllLists too — the note now exists and is tracked.
    expect(vault._files.has('Google Tasks/Buy milk.md')).toBe(true);

    // Fire the captured 'delete' handler as Obsidian would.
    const deleteHandlers = vault._handlers.delete;
    expect(deleteHandlers.length).toBe(1);
    const deleted = makeTFile('Google Tasks/Buy milk.md');
    await deleteHandlers[0](deleted);

    expect(api.deleteTask).toHaveBeenCalledWith('L1', 'T1');

    engine.stop();
    void plugin;
  });

  it('ignores deletion of a note that was never a tracked task', async () => {
    const deleteTask = vi.fn();
    const { engine, api, vault } = makeEngine({ deleteTask });
    await engine.start();

    await vault._handlers.delete[0](makeTFile('Google Tasks/not-tracked.md'));

    expect(api.deleteTask).not.toHaveBeenCalled();
    engine.stop();
  });
});
