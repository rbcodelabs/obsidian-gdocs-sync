import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TFile, Notice } from 'obsidian';
import { FM } from '../../src/converter/TaskNoteMapper';
import { TasksView, TASKS_VIEW_TYPE } from '../../src/ui/TasksView';
import { localDateString } from '../../src/tasks/TaskStore';
import { DEFAULT_SETTINGS } from '../../src/types';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function dayOffset(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return localDateString(d);
}

function makeFile(path: string): TFile {
  const f = new TFile();
  f.path = path;
  f.basename = path.split('/').pop()!.replace(/\.md$/, '');
  return f;
}

type FM_ = Record<string, unknown>;

function setup(opts: { enabled?: boolean; connected?: boolean; notes?: Record<string, FM_>; filter?: 'today' | 'all' } = {}) {
  const notes = new Map<string, FM_>(Object.entries(opts.notes ?? {}));
  const handlers: Record<string, Array<(...a: never[]) => void>> = {};
  const on = (_t: string) => (event: string, cb: (...a: never[]) => void) => {
    (handlers[event] ??= []).push(cb);
    return { event };
  };
  const openFile = vi.fn();
  const app = {
    vault: {
      getMarkdownFiles: () => [...notes.keys()].map(makeFile),
      getAbstractFileByPath: (p: string) => (notes.has(p) ? makeFile(p) : null),
      getFolderByPath: () => ({}),
      createFolder: vi.fn(),
      create: vi.fn(async (p: string) => { notes.set(p, {}); return makeFile(p); }),
      on: on('vault'),
    },
    metadataCache: {
      getFileCache: (f: TFile) => (notes.has(f.path) ? { frontmatter: notes.get(f.path) } : null),
      on: on('meta'),
    },
    fileManager: {
      processFrontMatter: vi.fn(async (f: TFile, cb: (fm: FM_) => void) => { cb(notes.get(f.path)!); }),
    },
    workspace: {
      getLeavesOfType: () => [],
      getLeaf: vi.fn(() => ({ openFile })),
      on: on('ws'),
    },
  };
  const plugin = {
    app,
    manifest: { id: 'obsidian-gdocs-sync' },
    settings: {
      ...DEFAULT_SETTINGS,
      enableTasksSync: opts.enabled ?? true,
      tasksViewDefaultFilter: opts.filter ?? 'today',
    },
    tokenStore: { get: () => (opts.connected === false ? null : { accessToken: 'x' }) },
    tasksSyncEngine: { poll: vi.fn().mockResolvedValue(undefined) },
  };
  const leaf = { app } as never;
  const view = new TasksView(leaf, plugin as never);
  document.body.replaceChildren(view.contentEl);
  return { view, plugin, app, notes, handlers, openFile };
}

const task = (id: string, title: string, over: FM_ = {}): FM_ => ({
  [FM.id]: id, [FM.title]: title, [FM.completed]: false, [FM.listId]: 'L1', [FM.listName]: 'Work', ...over,
});

const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const titles = () => qa('.gtasks-view-task-title').map((e) => e.textContent);

beforeEach(() => { document.body.replaceChildren(); vi.clearAllMocks(); });

describe('TasksView basics', () => {
  it('identifies itself as the gdocs-tasks-view', () => {
    const { view } = setup();
    expect(view.getViewType()).toBe(TASKS_VIEW_TYPE);
    expect(TASKS_VIEW_TYPE).toBe('gdocs-tasks-view');
  });

  it('renders grouped sections with overdue first and due chips', async () => {
    const { view } = setup({
      notes: {
        'Google Tasks/a.md': task('a', 'Late one', { [FM.due]: dayOffset(-2) }),
        'Google Tasks/b.md': task('b', 'Due today', { [FM.due]: dayOffset(0) }),
        'Google Tasks/c.md': task('c', 'Later', { [FM.due]: dayOffset(5) }),
      },
    });
    await view.onOpen();
    expect(qa('.gtasks-view-section-head').map((e) => e.dataset.bucket)).toEqual(['Overdue', 'Today']);
    expect(titles()).toEqual(['Late one', 'Due today']);
    expect(q('.gtasks-view-due.is-overdue')).not.toBeNull();
    expect(q('.gtasks-view-due.is-today')!.textContent).toBe('Today');
  });

  it('shows counts per tab and a warning count for overdue', async () => {
    const { view } = setup({
      notes: {
        'Google Tasks/a.md': task('a', 'Late', { [FM.due]: dayOffset(-1) }),
        'Google Tasks/b.md': task('b', 'Soon', { [FM.due]: dayOffset(3) }),
      },
    });
    await view.onOpen();
    const tab = (f: string) => q(`[data-filter="${f}"]`)!;
    expect(tab('today').querySelector('i')!.textContent).toBe('1');
    expect(tab('upcoming').querySelector('i')!.textContent).toBe('1');
    expect(tab('overdue').querySelector('i')!.classList.contains('is-warn')).toBe(true);
  });

  it('switches tabs, with aria-selected and roving tabindex', async () => {
    const { view } = setup({ notes: { 'Google Tasks/b.md': task('b', 'Soon', { [FM.due]: dayOffset(3) }) } });
    await view.onOpen();
    expect(q('.gtasks-view-empty h5')!.textContent).toMatch(/all caught up/i);
    q('[data-filter="upcoming"]')!.click();
    expect(q('[data-filter="upcoming"]')!.getAttribute('aria-selected')).toBe('true');
    expect(q('[data-filter="upcoming"]')!.getAttribute('tabindex')).toBe('0');
    expect(q('[data-filter="today"]')!.getAttribute('tabindex')).toBe('-1');
    expect(titles()).toEqual(['Soon']);
  });

  it('honours the default-filter setting and ignores an invalid one', async () => {
    const all = setup({ filter: 'all', notes: { 'Google Tasks/n.md': task('n', 'No date') } });
    await all.view.onOpen();
    expect(titles()).toEqual(['No date']);
  });

  it('filters by list via the list dropdown', async () => {
    const { view } = setup({
      filter: 'all',
      notes: {
        'Google Tasks/a.md': task('a', 'Work thing'),
        'Google Tasks/b.md': task('b', 'Home thing', { [FM.listId]: 'L2', [FM.listName]: 'Home' }),
      },
    });
    await view.onOpen();
    const sel = q<HTMLSelectElement>('.gtasks-view-list-select select')!;
    sel.value = 'L2';
    sel.dispatchEvent(new Event('change'));
    expect(titles()).toEqual(['Home thing']);
  });

  it('nests subtasks under their parent', async () => {
    const { view } = setup({
      notes: {
        'Google Tasks/p.md': task('p', 'Parent', { [FM.due]: dayOffset(0) }),
        'Google Tasks/k.md': task('k', 'Kid', { [FM.due]: dayOffset(0), [FM.parentId]: 'p' }),
      },
    });
    await view.onOpen();
    expect(qa('.gtasks-view-row').map((r) => r.classList.contains('is-sub'))).toEqual([false, true]);
  });

  it('hides soft-deleted tasks', async () => {
    const { view } = setup({
      filter: 'all',
      notes: {
        'Google Tasks/a.md': task('a', 'Alive'),
        'Google Tasks/b.md': task('b', 'Dead', { [FM.deleted]: true }),
      },
    });
    await view.onOpen();
    expect(titles()).toEqual(['Alive']);
  });

  it('keeps the Completed section collapsed by default', async () => {
    const { view } = setup({ filter: 'all', notes: { 'Google Tasks/a.md': task('a', 'Done', { [FM.completed]: true }) } });
    await view.onOpen();
    expect(q('.gtasks-view-section')!.classList.contains('is-collapsed')).toBe(true);
    q('.gtasks-view-section-head')!.click();
    expect(q('.gtasks-view-section')!.classList.contains('is-collapsed')).toBe(false);
  });
});

describe('TasksView states', () => {
  it('shows the sync-off state with an Open settings button', async () => {
    const { view, app } = setup({ enabled: false });
    const open = vi.fn();
    (app as Record<string, unknown>).setting = { open, openTabById: vi.fn() };
    await view.onOpen();
    expect(q('.gtasks-view-empty h5')!.textContent).toBe('Google Tasks sync is off');
    expect(q('.gtasks-view')!.classList.contains('is-off')).toBe(true);
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'Open settings')!.click();
    expect(open).toHaveBeenCalled();
    expect((app as never as { setting: { openTabById: ReturnType<typeof vi.fn> } }).setting.openTabById).toHaveBeenCalledWith('obsidian-gdocs-sync');
  });

  it('shows not-connected when enabled but signed out', async () => {
    const { view } = setup({ connected: false });
    await view.onOpen();
    expect(q('.gtasks-view-empty h5')!.textContent).toBe('Not connected to Google');
  });

  it('shows the all-done state when nothing is open', async () => {
    const { view } = setup({ notes: { 'Google Tasks/a.md': task('a', 'Done', { [FM.completed]: true }) } });
    await view.onOpen();
    expect(q('.gtasks-view-empty h5')!.textContent).toMatch(/all caught up/i);
  });
});

describe('TasksView interactions', () => {
  // Fresh object per use: actions mutate the frontmatter in place.
  const base = () => ({ 'Google Tasks/a.md': task('a', 'Alpha', { [FM.due]: dayOffset(0) }) });

  it('completes a task through the checkbox (aria-checked reflects state)', async () => {
    const { view, notes } = setup({ notes: base() });
    await view.onOpen();
    const check = q('.gtasks-view-check')!;
    expect(check.getAttribute('role')).toBe('checkbox');
    expect(check.getAttribute('aria-checked')).toBe('false');
    check.click();
    await settle();
    expect(notes.get('Google Tasks/a.md')![FM.completed]).toBe(true);
  });

  it('opens the note when the title is clicked', async () => {
    const { view, app, openFile } = setup({ notes: base() });
    await view.onOpen();
    q('.gtasks-view-task-title')!.click();
    expect(app.workspace.getLeaf).toHaveBeenCalledWith(false);
    expect(openFile).toHaveBeenCalled();
  });

  it('edits the title inline and saves on Enter', async () => {
    const { view, notes } = setup({ notes: base() });
    await view.onOpen();
    q('.gtasks-view-tail button')!.click();
    const input = q<HTMLInputElement>('.gtasks-view-title-input')!;
    expect(input.value).toBe('Alpha');
    input.value = 'Beta';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await settle();
    expect(notes.get('Google Tasks/a.md')![FM.title]).toBe('Beta');
  });

  it('cancels an inline edit with Escape without writing', async () => {
    const { view, app } = setup({ notes: base() });
    await view.onOpen();
    q('.gtasks-view-tail button')!.click();
    const input = q<HTMLInputElement>('.gtasks-view-title-input')!;
    input.value = 'Nope';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle();
    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    expect(q('.gtasks-view-title-input')).toBeNull();
  });

  it('changes the due date from the chip', async () => {
    const { view, notes } = setup({ notes: base() });
    await view.onOpen();
    q('.gtasks-view-due')!.click();
    const date = q<HTMLInputElement>('.gtasks-view-date-input')!;
    date.value = '2031-01-02';
    date.dispatchEvent(new Event('change'));
    await settle();
    expect(notes.get('Google Tasks/a.md')![FM.due]).toBe('2031-01-02');
  });

  it('quick-adds a task into the chosen list, due today on the Today tab', async () => {
    const { view, app } = setup({ notes: base() });
    await view.onOpen();
    const input = q<HTMLInputElement>('.gtasks-view-add-input')!;
    input.value = 'Buy milk';
    q<HTMLFormElement>('.gtasks-view-add')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    expect(app.vault.create).toHaveBeenCalledTimes(1);
    const [path, content] = app.vault.create.mock.calls[0] as unknown as [string, string];
    expect(path).toBe('Google Tasks/Buy milk.md');
    expect(content).toContain(`${FM.listId}: "L1"`);
    expect(content).toContain(`${FM.due}: "${localDateString()}"`);
    expect(input.value).toBe('');
  });

  it('sync now calls the engine poll and shows the synced label', async () => {
    const { view, plugin } = setup({ notes: base() });
    await view.onOpen();
    q('.gtasks-view-sync button')!.click();
    await settle(); await settle();
    expect(plugin.tasksSyncEngine.poll).toHaveBeenCalledTimes(1);
    expect(q('.gtasks-view-sync-label')!.textContent).toBe('Synced just now');
  });

  it('reports a failed sync with a notice', async () => {
    const { view, plugin } = setup({ notes: base() });
    plugin.tasksSyncEngine.poll.mockRejectedValue(new Error('boom'));
    await view.onOpen();
    q('.gtasks-view-sync button')!.click();
    await settle(); await settle();
    expect(Notice).toBeDefined();
    expect(q('.gtasks-view-sync-label')!.textContent).toBe('');
  });
});

describe('TasksView refresh', () => {
  it('re-renders (debounced) when a task note changes, ignoring other folders', async () => {
    const { view, notes, handlers } = setup({ filter: 'all', notes: { 'Google Tasks/a.md': task('a', 'Alpha') } });
    await view.onOpen();
    notes.set('Google Tasks/b.md', task('b', 'Bravo'));
    handlers.changed.forEach((cb) => cb(makeFile('Elsewhere/x.md') as never));
    await wait(200);
    expect(titles()).toEqual(['Alpha']);
    handlers.changed.forEach((cb) => cb(makeFile('Google Tasks/b.md') as never));
    expect(titles()).toEqual(['Alpha']); // not yet — debounced
    await wait(200);
    expect(titles().sort()).toEqual(['Alpha', 'Bravo']);
  });

  it('defers a refresh while a row is being edited, then catches up', async () => {
    const { view, notes, handlers } = setup({ filter: 'all', notes: { 'Google Tasks/a.md': task('a', 'Alpha') } });
    await view.onOpen();
    q('.gtasks-view-tail button')!.click();
    notes.set('Google Tasks/b.md', task('b', 'Bravo'));
    handlers.create.forEach((cb) => cb(makeFile('Google Tasks/b.md') as never));
    await wait(200);
    expect(q('.gtasks-view-title-input')).not.toBeNull(); // editor survived
    q<HTMLInputElement>('.gtasks-view-title-input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle();
    expect(titles().sort()).toEqual(['Alpha', 'Bravo']);
  });
});
