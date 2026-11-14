import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TFile } from 'obsidian';
import { FM, canonicalizeFields } from '../../src/converter/TaskNoteMapper';
import { TaskActions } from '../../src/tasks/TaskActions';
import { TasksSyncEngine } from '../../src/sync/TasksSyncEngine';
import { FileWatcher } from '../../src/sync/FileWatcher';

function makeFile(path: string): TFile {
  const f = new TFile();
  f.path = path;
  f.basename = path.split('/').pop()!.replace(/\.md$/, '');
  return f;
}

function makeApp(initial: Record<string, Record<string, unknown>> = {}, leaves: unknown[] = []) {
  const fm = new Map<string, Record<string, unknown>>(Object.entries(initial).map(([k, v]) => [k, { ...v }]));
  const created = new Map<string, string>();
  const folders = new Set<string>();
  const app = {
    vault: {
      getFolderByPath: (p: string) => (folders.has(p) ? { path: p } : null),
      createFolder: vi.fn(async (p: string) => { folders.add(p); }),
      getAbstractFileByPath: (p: string) => (fm.has(p) || created.has(p) ? makeFile(p) : null),
      create: vi.fn(async (p: string, content: string) => { created.set(p, content); return makeFile(p); }),
    },
    fileManager: {
      processFrontMatter: vi.fn(async (file: TFile, cb: (f: Record<string, unknown>) => void) => {
        const cur = fm.get(file.path) ?? {};
        cb(cur);
        fm.set(file.path, cur);
      }),
    },
    workspace: { getLeavesOfType: vi.fn(() => leaves) },
  };
  return { app, fm, created, folders };
}

const PATH = 'Google Tasks/A.md';
const base = { [FM.id]: 'a', [FM.title]: 'Alpha', [FM.completed]: false, [FM.due]: '2026-11-14' };

describe('TaskActions frontmatter writes', () => {
  it('toggleComplete flips gtasks_completed both ways', async () => {
    const { app, fm } = makeApp({ [PATH]: base });
    const actions = new TaskActions(app as never, () => 'Google Tasks');
    await actions.setCompleted(PATH, true);
    expect(fm.get(PATH)![FM.completed]).toBe(true);
    await actions.setCompleted(PATH, false);
    expect(fm.get(PATH)![FM.completed]).toBe(false);
  });

  it('setDue writes a date-only string and clears the key for null', async () => {
    const { app, fm } = makeApp({ [PATH]: base });
    const actions = new TaskActions(app as never, () => 'Google Tasks');
    await actions.setDue(PATH, '2026-12-01');
    expect(fm.get(PATH)![FM.due]).toBe('2026-12-01');
    await actions.setDue(PATH, null);
    expect(FM.due in fm.get(PATH)!).toBe(false);
  });

  it('rejects a malformed due date without writing', async () => {
    const { app } = makeApp({ [PATH]: base });
    const actions = new TaskActions(app as never, () => 'Google Tasks');
    await expect(actions.setDue(PATH, '12/01/2026')).rejects.toThrow(/YYYY-MM-DD/);
    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
  });

  it('rename trims and writes gtasks_title; blank titles are ignored', async () => {
    const { app, fm } = makeApp({ [PATH]: base });
    const actions = new TaskActions(app as never, () => 'Google Tasks');
    await actions.rename(PATH, '  Beta  ');
    expect(fm.get(PATH)![FM.title]).toBe('Beta');
    await actions.rename(PATH, '   ');
    expect(fm.get(PATH)![FM.title]).toBe('Beta');
  });

  it('rejects with a not-found error for a path that is not an existing file', async () => {
    const { app } = makeApp();
    const actions = new TaskActions(app as never, () => 'Google Tasks');
    await expect(actions.setCompleted('Google Tasks/missing.md', true)).rejects.toThrow(/not found/i);
  });
});

describe('TaskActions dirty-editor guard', () => {
  it('saves an open editor on the target note before writing frontmatter', async () => {
    const order: string[] = [];
    const save = vi.fn(async () => { order.push('save'); });
    const leaf = { view: { file: { path: PATH }, save } };
    const { app } = makeApp({ [PATH]: base }, [leaf]);
    app.fileManager.processFrontMatter.mockImplementation(async (_f, cb) => { order.push('write'); cb({}); });
    const actions = new TaskActions(app as never, () => 'Google Tasks');
    await actions.setCompleted(PATH, true);
    expect(order).toEqual(['save', 'write']);
  });

  it('aborts without writing if the open editor cannot be saved', async () => {
    const leaf = { view: { file: { path: PATH }, save: vi.fn().mockRejectedValue(new Error('disk full')) } };
    const { app } = makeApp({ [PATH]: base }, [leaf]);
    const actions = new TaskActions(app as never, () => 'Google Tasks');
    await expect(actions.setCompleted(PATH, true)).rejects.toThrow(/unsaved/i);
    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
  });

  it('ignores editors open on other notes', async () => {
    const save = vi.fn();
    const { app } = makeApp({ [PATH]: base }, [{ view: { file: { path: 'Other.md' }, save } }]);
    await new TaskActions(app as never, () => 'Google Tasks').setCompleted(PATH, true);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('TaskActions.quickAdd', () => {
  let ctx: ReturnType<typeof makeApp>;
  beforeEach(() => { ctx = makeApp(); });

  it('creates the folder and a note carrying list + title frontmatter', async () => {
    const actions = new TaskActions(ctx.app as never, () => 'Google Tasks/');
    const path = await actions.quickAdd({ title: ' Buy milk ', listId: 'L1', listName: 'Home' });
    expect(path).toBe('Google Tasks/Buy milk.md');
    expect(ctx.app.vault.createFolder).toHaveBeenCalledWith('Google Tasks');
    const content = ctx.created.get(path)!;
    expect(content).toMatch(/^---\n/);
    expect(content).toContain(`${FM.listId}: "L1"`);
    expect(content).toContain(`${FM.listName}: "Home"`);
    expect(content).toContain(`${FM.title}: "Buy milk"`);
    expect(content).toContain(`${FM.completed}: false`);
    expect(content).not.toContain(FM.id);
  });

  it('writes due when given and sanitises unsafe filename characters', async () => {
    const actions = new TaskActions(ctx.app as never, () => 'Google Tasks');
    const path = await actions.quickAdd({ title: 'a/b: c#d', listId: 'L1', listName: 'Home', due: '2026-11-13' });
    expect(path).toBe('Google Tasks/a-b- c-d.md');
    const content = ctx.created.get(path)!;
    expect(content).toContain(`${FM.due}: "2026-11-13"`);
    expect(content).toContain(`${FM.title}: "a/b: c#d"`);
  });

  it('disambiguates a filename collision instead of overwriting', async () => {
    const actions = new TaskActions(ctx.app as never, () => 'Google Tasks');
    const a = await actions.quickAdd({ title: 'Call', listId: 'L1', listName: 'Home' });
    const b = await actions.quickAdd({ title: 'Call', listId: 'L1', listName: 'Home' });
    expect(a).toBe('Google Tasks/Call.md');
    expect(b).not.toBe(a);
    expect(b).toMatch(/^Google Tasks\/Call \(.+\)\.md$/);
    expect(ctx.created.size).toBe(2);
  });

  it('refuses an empty title', async () => {
    const actions = new TaskActions(ctx.app as never, () => 'Google Tasks');
    await expect(actions.quickAdd({ title: '  ', listId: 'L1', listName: 'x' })).rejects.toThrow(/title/i);
  });
});

// ─── Push-loop check against the real sync engine ─────────────────────────────

describe('UI edits and the sync engine hash check (no push loop)', () => {
  it('pushes a UI toggle exactly once, then the engine write-back does not trigger another push', async () => {
    const files = new Map<string, Record<string, unknown>>();
    const bodies = new Map<string, string>();
    const handlers: Record<string, Array<(...a: unknown[]) => void>> = { modify: [], delete: [], rename: [] };
    const serialize = (path: string) => {
      const fm = files.get(path)!;
      const lines = ['---'];
      for (const [k, v] of Object.entries(fm)) lines.push(`${k}: ${typeof v === 'string' ? JSON.stringify(v) : String(v)}`);
      lines.push('---', '');
      return lines.join('\n') + (bodies.get(path) ?? '');
    };
    const vault = {
      getFolderByPath: () => ({}),
      getAbstractFileByPath: (p: string) => (files.has(p) ? makeFile(p) : null),
      getMarkdownFiles: () => [...files.keys()].map(makeFile),
      read: async (f: TFile) => serialize(f.path),
      cachedRead: async (f: TFile) => serialize(f.path),
      modify: async () => {},
      on: (e: string, cb: (...a: unknown[]) => void) => { handlers[e]?.push(cb); return {}; },
    };
    const metadataCache = { getFileCache: (f: TFile) => (files.has(f.path) ? { frontmatter: files.get(f.path) } : null) };
    const fileManager = {
      processFrontMatter: async (f: TFile, cb: (fm: Record<string, unknown>) => void) => cb(files.get(f.path)!),
    };
    const patchTask = vi.fn().mockResolvedValue({
      id: 'T1', title: 'Buy milk', status: 'completed', updated: '2026-11-13T10:00:00.000Z',
    });
    const api = {
      listTaskLists: vi.fn().mockResolvedValue([{ id: 'L1', title: 'Home', updated: '' }]),
      listTasks: vi.fn().mockResolvedValue([{ id: 'T1', title: 'Buy milk', status: 'needsAction', updated: '2026-11-12T10:00:00.000Z' }]),
      patchTask,
    };
    const plugin = {
      settings: { enableTasksSync: true, tasksFolder: 'Google Tasks', syncedTaskListIds: [], tasksPollIntervalSeconds: 60 },
      saveSettings: vi.fn(),
      registerEvent: vi.fn(),
      app: { vault, metadataCache, fileManager },
    };
    const engine = new TasksSyncEngine(plugin as never, api as never, {} as never, new FileWatcher(plugin as never));

    // Seed a note that is in sync with Google (hash matches its fields).
    const path = "Google Tasks/Buy milk.md";
    const fields = { title: "Buy milk", notes: "", completed: false, due: "" };
    const bytes = new TextEncoder().encode(canonicalizeFields(fields));
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
    files.set(path, {
      [FM.id]: "T1", [FM.listId]: "L1", [FM.listName]: "Home", [FM.title]: "Buy milk",
      [FM.completed]: false, [FM.hash]: digest.map((b) => b.toString(16).padStart(2, "0")).join(""),
    });
    bodies.set(path, "");

    const actions = new TaskActions({ ...plugin.app, workspace: { getLeavesOfType: () => [] } } as never, () => 'Google Tasks');
    await actions.setCompleted(path, true);

    await engine.syncLocalToRemote(makeFile(path));
    expect(patchTask).toHaveBeenCalledTimes(1);
    // The engine's own metadata write-back fires another modify; the debounced
    // handler runs syncLocalToRemote again — it must be a no-op.
    await engine.syncLocalToRemote(makeFile(path));
    await engine.syncLocalToRemote(makeFile(path));
    expect(patchTask).toHaveBeenCalledTimes(1);
  });
});
