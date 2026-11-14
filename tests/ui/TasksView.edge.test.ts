import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TFile, noticeLog } from 'obsidian';
import { FM } from '../../src/converter/TaskNoteMapper';
import { TasksView, WIDE_BREAKPOINT } from '../../src/ui/TasksView';
import { localDateString } from '../../src/tasks/TaskStore';
import { DEFAULT_SETTINGS } from '../../src/types';

/**
 * QA edge cases for the Tasks view. Tests prefixed "FIXED" were KNOWN BUGs found by QA and are now fixed in the source.
 */

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
type Handler = (...a: never[]) => void;

interface SetupOpts {
  enabled?: boolean;
  connected?: boolean;
  notes?: Record<string, FM_>;
  filter?: unknown;
  folder?: string;
  leaves?: unknown[];
  /** Make vault.create resolve on a later tick and register the file only then (models real disk latency). */
  slowCreate?: boolean;
  withSettingHost?: boolean;
}

function setup(opts: SetupOpts = {}) {
  const notes = new Map<string, FM_>(Object.entries(opts.notes ?? {}));
  const handlers: Record<string, Handler[]> = {};
  const on = (event: string, cb: Handler) => { (handlers[event] ??= []).push(cb); return { event }; };
  const openFile = vi.fn();
  const getMarkdownFiles = vi.fn(() => [...notes.keys()].map(makeFile));
  const createdContent = new Map<string, string>();
  const settingHost = { open: vi.fn(), openTabById: vi.fn() };
  const app = {
    vault: {
      getMarkdownFiles,
      getAbstractFileByPath: (p: string) => (notes.has(p) ? makeFile(p) : null),
      getFolderByPath: () => ({}),
      createFolder: vi.fn(),
      create: vi.fn(async (p: string, content: string) => {
        if (opts.slowCreate) {
          await wait(20);
          if (notes.has(p)) throw new Error('File already exists.');
        }
        createdContent.set(p, content);
        notes.set(p, {});
        return makeFile(p);
      }),
      on,
    },
    metadataCache: {
      getFileCache: (f: TFile) => (notes.has(f.path) ? { frontmatter: notes.get(f.path) } : null),
      on,
    },
    fileManager: {
      processFrontMatter: vi.fn(async (f: TFile, cb: (fm: FM_) => void) => { cb(notes.get(f.path)!); }),
    },
    workspace: {
      getLeavesOfType: () => opts.leaves ?? [],
      getLeaf: vi.fn(() => ({ openFile })),
      on,
    },
    ...(opts.withSettingHost ? { setting: settingHost } : {}),
  };
  const plugin = {
    app,
    manifest: { id: 'obsidian-gdocs-sync' },
    settings: {
      ...DEFAULT_SETTINGS,
      enableTasksSync: opts.enabled ?? true,
      tasksFolder: opts.folder ?? DEFAULT_SETTINGS.tasksFolder,
      tasksViewDefaultFilter: ('filter' in opts ? opts.filter : 'today') as never,
    },
    tokenStore: { get: () => (opts.connected === false ? null : { accessToken: 'x' }) },
    tasksSyncEngine: { poll: vi.fn().mockResolvedValue(undefined) },
  };
  const leaf = { app } as never;
  const view = new TasksView(leaf, plugin as never);
  document.body.replaceChildren(view.contentEl);
  return { view, plugin, app, notes, handlers, openFile, getMarkdownFiles, createdContent, settingHost, leaf };
}

const task = (id: string, title: string, over: FM_ = {}): FM_ => ({
  [FM.id]: id, [FM.title]: title, [FM.completed]: false, [FM.listId]: 'L1', [FM.listName]: 'Work', ...over,
});

const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const titles = () => qa('.gtasks-view-task-title').map((e) => e.textContent);
const activeTab = () => q('.gtasks-view-tab[aria-selected="true"]')?.getAttribute('data-filter');
const submitAdd = () => q<HTMLFormElement>('.gtasks-view-add')!.dispatchEvent(new Event('submit', { cancelable: true }));
const typeAdd = (v: string) => { q<HTMLInputElement>('.gtasks-view-add-input')!.value = v; };
const fire = (h: Record<string, Handler[]>, ev: string, ...args: unknown[]) =>
  (h[ev] ?? []).forEach((cb) => (cb as (...a: unknown[]) => void)(...args));
const lastNotice = () => noticeLog[noticeLog.length - 1];

beforeEach(() => { document.body.replaceChildren(); noticeLog.length = 0; vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

// ─── Completed, undated ─────────────────────────────────────────────────────────

describe('completed tasks with no due date', () => {
  const notes = () => ({ 'Google Tasks/d.md': task('d', 'Done undated', { [FM.completed]: true }) });

  it('are hidden on Today and show up only under All, in a collapsed Completed section', async () => {
    const { view } = setup({ notes: notes() });
    await view.onOpen();
    expect(titles()).toEqual([]);
    qa('.gtasks-view-tab').find((t) => t.dataset.filter === 'all')!.click();
    expect(qa('.gtasks-view-section-head').map((h) => h.dataset.bucket)).toEqual(['Completed']);
    expect(q('.gtasks-view-section')!.classList.contains('is-collapsed')).toBe(true);
    expect(q('.gtasks-view-section-count')!.textContent).toBe('1');
  });

  it('can be expanded and re-opened, writing gtasks_completed=false', async () => {
    const { view, notes: n } = setup({ filter: 'all', notes: notes() });
    await view.onOpen();
    q('.gtasks-view-section-head')!.click();
    expect(q('.gtasks-view-section-head')!.getAttribute('aria-expanded')).toBe('true');
    const check = q('.gtasks-view-check')!;
    expect(check.getAttribute('aria-checked')).toBe('true');
    check.click();
    await settle();
    expect(n.get('Google Tasks/d.md')![FM.completed]).toBe(false);
  });
});

// ─── Settings robustness ────────────────────────────────────────────────────────

describe('unknown / corrupt tasksViewDefaultFilter', () => {
  it.each([['ALL'], ['tomorrow'], [''], [null], [undefined], [42], [{}]])('falls back to the Today tab for %j', async (bad) => {
    const { view } = setup({ filter: bad });
    await view.onOpen();
    expect(activeTab()).toBe('today');
  });

  it('honours every valid saved value', async () => {
    for (const f of ['today', 'upcoming', 'overdue', 'all']) {
      const { view } = setup({ filter: f });
      await view.onOpen();
      expect(activeTab()).toBe(f);
    }
  });
});

describe('tasksFolder misconfiguration', () => {
  it('renders an empty, usable view (no throw) when tasksFolder is blank', async () => {
    const { view } = setup({ folder: '', filter: 'all', notes: { 'Google Tasks/a.md': task('a', 'A') } });
    await expect(view.onOpen()).resolves.toBeUndefined();
    expect(titles()).toEqual([]);
    expect(q('.gtasks-view-empty h5')!.textContent).toBe('No tasks yet');
  });

  it('refuses quick-add with a notice, keeps the typed text, and creates nothing', async () => {
    const { view, app } = setup({ folder: '' });
    await view.onOpen();
    typeAdd('Buy milk');
    submitAdd();
    await settle();
    expect(app.vault.create).not.toHaveBeenCalled();
    expect(lastNotice()).toMatch(/folder is not configured/i);
    expect(q<HTMLInputElement>('.gtasks-view-add-input')!.value).toBe('Buy milk');
  });
});

// ─── Quick add ──────────────────────────────────────────────────────────────────

describe('quick-add edge cases', () => {
  it.each([[''], ['   '], ['\t\n']])('ignores a blank submit (%j) silently', async (v) => {
    const { view, app } = setup({ notes: { 'Google Tasks/a.md': task('a', 'A') } });
    await view.onOpen();
    typeAdd(v);
    submitAdd();
    await settle();
    expect(app.vault.create).not.toHaveBeenCalled();
    expect(noticeLog).toEqual([]);
  });

  it('turns a title full of illegal filename characters into a legal path', async () => {
    const { view, app } = setup({ notes: { 'Google Tasks/a.md': task('a', 'A') } });
    await view.onOpen();
    typeAdd('a/b\\c:d*e?"f"<g>|h');
    submitAdd();
    await settle();
    const [path] = app.vault.create.mock.calls[0] as unknown as [string];
    expect(path.startsWith('Google Tasks/')).toBe(true);
    expect(path.slice('Google Tasks/'.length, -3)).not.toMatch(/[/\\:*?"<>|]/);
  });

  it('keeps the typed text and shows a notice when the vault refuses to create the note', async () => {
    const { view, app } = setup({ notes: { 'Google Tasks/a.md': task('a', 'A') } });
    app.vault.create.mockRejectedValueOnce(new Error('disk full'));
    await view.onOpen();
    typeAdd('Important');
    submitAdd();
    await settle();
    expect(lastNotice()).toMatch(/disk full/);
    expect(q<HTMLInputElement>('.gtasks-view-add-input')!.value).toBe('Important');
    // and the form still works afterwards
    submitAdd();
    await settle();
    expect(app.vault.create).toHaveBeenCalledTimes(2);
  });

  it('creates the note with tomorrow on Upcoming, and with no due date on Overdue/All', async () => {
    // Updated for review item 5: Upcoming now defaults to tomorrow so the task stays visible.
    {
      const { view, createdContent } = setup({ filter: 'upcoming', notes: { 'Google Tasks/a.md': task('a', 'A') } });
      await view.onOpen();
      typeAdd('New on upcoming');
      submitAdd();
      await settle();
      expect([...createdContent.values()][0]).toContain(`${FM.due}: "${dayOffset(1)}"`);
    }
    for (const filter of ['overdue', 'all']) {
      const { view, createdContent } = setup({ filter, notes: { 'Google Tasks/a.md': task('a', 'A') } });
      await view.onOpen();
      typeAdd(`New on ${filter}`);
      submitAdd();
      await settle();
      const content = [...createdContent.values()][0];
      expect(content, filter).not.toContain(FM.due);
    }
  });

  it('adds with no list when nothing has synced yet (engine default list applies)', async () => {
    const { view, createdContent } = setup({ filter: 'all' });
    await view.onOpen();
    typeAdd('First ever');
    submitAdd();
    await settle();
    expect([...createdContent.values()][0]).not.toContain(FM.listId);
  });

  it('writes no list id when the chosen list vanished remotely between render and submit', async () => {
    const { view, notes, createdContent } = setup({
      filter: 'all',
      notes: {
        'Google Tasks/a.md': task('a', 'A'),
        'Google Tasks/b.md': task('b', 'B', { [FM.listId]: 'L2', [FM.listName]: 'Home' }),
      },
    });
    await view.onOpen();
    const select = q<HTMLSelectElement>('.gtasks-view-add-list select')!;
    select.value = 'L2';
    select.dispatchEvent(new Event('change'));
    notes.delete('Google Tasks/b.md'); // list L2 disappears; the view has not refreshed yet
    typeAdd('Orphan');
    submitAdd();
    await settle();
    const content = [...createdContent.values()][0];
    expect(content).not.toContain('"L2"');
    expect(content).not.toContain(FM.listId);
  });

  it('FIXED: a double submit (Enter pressed twice before the first write finishes) must create only one task', async () => {
    const { view, app } = setup({ slowCreate: true, notes: { 'Google Tasks/a.md': task('a', 'A') } });
    await view.onOpen();
    typeAdd('Pay rent');
    submitAdd();
    submitAdd();
    await wait(80);
    // Today: two create() calls -> a duplicate Google task, or a "File already exists" notice.
    expect(app.vault.create).toHaveBeenCalledTimes(1);
  });
});

// ─── Rapid / racing interactions ────────────────────────────────────────────────

describe('rapid toggles and stale rows', () => {
  const base = () => ({ 'Google Tasks/a.md': task('a', 'Alpha', { [FM.due]: dayOffset(0) }) });

  it('two clicks before the view re-renders both write the same value and never throw', async () => {
    const { view, notes, app } = setup({ notes: base() });
    await view.onOpen();
    const check = q('.gtasks-view-check')!;
    check.click();
    check.click();
    await settle();
    expect(app.fileManager.processFrontMatter).toHaveBeenCalledTimes(2);
    expect(notes.get('Google Tasks/a.md')![FM.completed]).toBe(true);
    expect(noticeLog).toEqual([]);
  });

  it('shows a notice and clears the completing animation when the note was deleted remotely', async () => {
    const { view, notes } = setup({ notes: base() });
    await view.onOpen();
    const check = q('.gtasks-view-check')!;
    notes.delete('Google Tasks/a.md');
    check.click();
    await settle();
    expect(lastNotice()).toMatch(/not found/i);
    expect(q('.gtasks-view-row')!.classList.contains('is-completing')).toBe(false);
  });

  it('reports a failed unsaved-editor flush instead of silently dropping the toggle', async () => {
    const leaves = [{ view: { file: { path: 'Google Tasks/a.md' }, save: vi.fn().mockRejectedValue(new Error('locked')) } }];
    const { view, app, notes } = setup({ notes: base(), leaves });
    await view.onOpen();
    q('.gtasks-view-check')!.click();
    await settle();
    expect(lastNotice()).toMatch(/locked/);
    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    expect(notes.get('Google Tasks/a.md')![FM.completed]).toBe(false);
  });

  it('only toggles the clicked task when two tasks share the same title', async () => {
    const { view, notes } = setup({
      notes: {
        'Google Tasks/Same.md': task('1', 'Same', { [FM.due]: dayOffset(0) }),
        'Google Tasks/Same (2).md': task('2', 'Same', { [FM.due]: dayOffset(0) }),
      },
    });
    await view.onOpen();
    expect(titles()).toEqual(['Same', 'Same']);
    qa('.gtasks-view-row')
      .find((r) => r.dataset.path === 'Google Tasks/Same (2).md')!
      .querySelector<HTMLElement>('.gtasks-view-check')!.click();
    await settle();
    expect(notes.get('Google Tasks/Same.md')![FM.completed]).toBe(false);
    expect(notes.get('Google Tasks/Same (2).md')![FM.completed]).toBe(true);
  });

  it('only the second of two rapid sync-now clicks is ignored (single poll in flight)', async () => {
    const { view, plugin } = setup({ notes: { 'Google Tasks/a.md': task('a', 'A') } });
    let release!: () => void;
    plugin.tasksSyncEngine.poll.mockReturnValue(new Promise<void>((r) => { release = r; }));
    await view.onOpen();
    const btn = q<HTMLButtonElement>('.gtasks-view-sync button')!;
    btn.click();
    btn.click();
    expect(plugin.tasksSyncEngine.poll).toHaveBeenCalledTimes(1);
    expect(q('.gtasks-view-sync-label')!.textContent).toBe('Syncing…');
    expect(btn.disabled).toBe(true);
    release();
    await settle(); await settle();
    expect(btn.disabled).toBe(false);
  });

  it('sync-now does nothing while sync is off', async () => {
    const { view, plugin } = setup({ enabled: false });
    await view.onOpen();
    q<HTMLButtonElement>('.gtasks-view-sync button')!.click();
    await settle();
    expect(plugin.tasksSyncEngine.poll).not.toHaveBeenCalled();
  });
});

// ─── View lifecycle ─────────────────────────────────────────────────────────────

describe('view closed while work is pending', () => {
  it('does not render after close when a metadata refresh was still debouncing', async () => {
    const { view, handlers, getMarkdownFiles } = setup({ notes: { 'Google Tasks/a.md': task('a', 'A') } });
    await view.onOpen();
    fire(handlers, 'changed', makeFile('Google Tasks/a.md'));
    await view.onClose();
    getMarkdownFiles.mockClear();
    await wait(300);
    expect(getMarkdownFiles).not.toHaveBeenCalled();
  });

  it('stops observing width on close', async () => {
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect = disconnect; });
    const { view } = setup();
    await view.onOpen();
    await view.onClose();
    expect(disconnect).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('FIXED: a sync that finishes after the view was closed must not schedule a re-render', async () => {
    const { view, plugin, getMarkdownFiles } = setup({ notes: { 'Google Tasks/a.md': task('a', 'A') } });
    let release!: () => void;
    plugin.tasksSyncEngine.poll.mockReturnValue(new Promise<void>((r) => { release = r; }));
    await view.onOpen();
    q<HTMLButtonElement>('.gtasks-view-sync button')!.click();
    await view.onClose();
    getMarkdownFiles.mockClear();
    release();
    await wait(300);
    expect(getMarkdownFiles).not.toHaveBeenCalled();
  });
});

describe('midnight rollover with the view left open', () => {
  /** Capture the 30 s interval the view registers so a tick can be driven by hand. */
  function captureTicks() {
    const ticks: Array<() => void> = [];
    vi.spyOn(window, 'setInterval').mockImplementation(((cb: () => void) => { ticks.push(cb); return 1; }) as never);
    return ticks;
  }

  it('FIXED: a task due "tomorrow" must move to Today after local midnight without user interaction', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 13, 23, 59, 40));
    const ticks = captureTicks();
    const { view } = setup({ notes: { 'Google Tasks/a.md': task('a', 'Due at midnight', { [FM.due]: '2026-11-14' }) } });
    await view.onOpen();
    expect(titles()).toEqual([]); // still tomorrow's task, hidden on Today

    vi.setSystemTime(new Date(2026, 10, 14, 0, 0, 40));
    ticks.forEach((t) => t()); // the only periodic work the view schedules
    expect(titles()).toEqual(['Due at midnight']);
  });

  it('FIXED: a task due today must become Overdue after local midnight without user interaction', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 13, 23, 59, 40));
    const ticks = captureTicks();
    const { view } = setup({ notes: { 'Google Tasks/a.md': task('a', 'Slipping', { [FM.due]: '2026-11-13' }) } });
    await view.onOpen();
    expect(qa('.gtasks-view-section-head').map((h) => h.dataset.bucket)).toEqual(['Today']);

    vi.setSystemTime(new Date(2026, 10, 14, 0, 0, 40));
    ticks.forEach((t) => t());
    expect(qa('.gtasks-view-section-head').map((h) => h.dataset.bucket)).toEqual(['Overdue']);
  });

  it('the synced-ago label ages without re-rendering rows', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 13, 10, 0, 0));
    const ticks = captureTicks();
    const { view } = setup({ notes: { 'Google Tasks/a.md': task('a', 'A', { [FM.due]: '2026-11-13' }) } });
    await view.onOpen();
    q<HTMLButtonElement>('.gtasks-view-sync button')!.click();
    await settle(); await settle();
    expect(q('.gtasks-view-sync-label')!.textContent).toBe('Synced just now');
    vi.setSystemTime(new Date(2026, 10, 13, 10, 1, 5));
    ticks.forEach((t) => t());
    expect(q('.gtasks-view-sync-label')!.textContent).toBe('Synced 1 min ago');
    vi.setSystemTime(new Date(2026, 10, 13, 10, 12, 0));
    ticks.forEach((t) => t());
    expect(q('.gtasks-view-sync-label')!.textContent).toBe('Synced 12 min ago');
  });
});

// ─── Subtasks / lists ───────────────────────────────────────────────────────────

describe('subtask and list edge cases in the rendered view', () => {
  it('renders a subtask as a top-level row when its parent is soft-deleted', async () => {
    const { view } = setup({
      filter: 'all',
      notes: {
        'Google Tasks/p.md': task('p', 'Parent', { [FM.deleted]: true }),
        'Google Tasks/c.md': task('c', 'Orphan child', { [FM.parentId]: 'p' }),
      },
    });
    await view.onOpen();
    expect(titles()).toEqual(['Orphan child']);
    expect(q('.gtasks-view-row')!.classList.contains('is-sub')).toBe(false);
  });

  it('renders a subtask as a top-level row when its parent is in another list that is filtered out', async () => {
    const { view } = setup({
      filter: 'all',
      notes: {
        'Google Tasks/p.md': task('p', 'Parent', { [FM.listId]: 'L2', [FM.listName]: 'Home' }),
        'Google Tasks/c.md': task('c', 'Child', { [FM.parentId]: 'p' }),
      },
    });
    await view.onOpen();
    const select = q<HTMLSelectElement>('.gtasks-view-list-select select')!;
    select.value = 'L1';
    select.dispatchEvent(new Event('change'));
    expect(titles()).toEqual(['Child']);
    expect(q('.gtasks-view-row')!.classList.contains('is-sub')).toBe(false);
  });

  it('resets the list filter to All lists when the selected list disappears remotely', async () => {
    const { view, notes, handlers } = setup({
      filter: 'all',
      notes: {
        'Google Tasks/a.md': task('a', 'Work task'),
        'Google Tasks/b.md': task('b', 'Home task', { [FM.listId]: 'L2', [FM.listName]: 'Home' }),
      },
    });
    await view.onOpen();
    const select = q<HTMLSelectElement>('.gtasks-view-list-select select')!;
    select.value = 'L2';
    select.dispatchEvent(new Event('change'));
    expect(titles()).toEqual(['Home task']);

    notes.get('Google Tasks/b.md')![FM.deleted] = true; // sync marks the removed list's tasks deleted
    fire(handlers, 'changed', makeFile('Google Tasks/b.md'));
    await wait(250);
    expect(q<HTMLSelectElement>('.gtasks-view-list-select select')!.value).toBe('*');
    expect(titles()).toEqual(['Work task']);
  });

  it('shows two lists with the same display name as separate, id-keyed options', async () => {
    const { view } = setup({
      filter: 'all',
      notes: {
        'Google Tasks/a.md': task('a', 'A', { [FM.listId]: 'L1', [FM.listName]: 'Work' }),
        'Google Tasks/b.md': task('b', 'B', { [FM.listId]: 'L2', [FM.listName]: 'Work' }),
      },
    });
    await view.onOpen();
    const opts = [...q<HTMLSelectElement>('.gtasks-view-list-select select')!.options].map((o) => o.value);
    expect(opts).toEqual(['*', 'L1', 'L2']);
  });
});

// ─── Rendering robustness ───────────────────────────────────────────────────────

describe('long and awkward titles', () => {
  it('renders a 5,000-character title in full (CSS handles wrapping) with the full aria-label', async () => {
    const long = 'word '.repeat(1000).trim();
    const { view } = setup({ filter: 'all', notes: { 'Google Tasks/long.md': task('l', long) } });
    await view.onOpen();
    const el = q('.gtasks-view-task-title')!;
    expect(el.textContent).toBe(long);
    expect(el.getAttribute('aria-label')).toBe(`Open note: ${long}`);
  });

  it('treats a title containing HTML as text, never markup', async () => {
    const { view } = setup({ filter: 'all', notes: { 'Google Tasks/x.md': task('x', '<img src=x onerror=alert(1)> & <b>bold</b>') } });
    await view.onOpen();
    expect(q('.gtasks-view-task-title img')).toBeNull();
    expect(q('.gtasks-view-task-title b')).toBeNull();
    expect(q('.gtasks-view-task-title')!.textContent).toContain('<img');
  });
});

// ─── Inline editing ─────────────────────────────────────────────────────────────

describe('inline edit edge cases', () => {
  const base = () => ({ 'Google Tasks/a.md': task('a', 'Alpha', { [FM.due]: dayOffset(0) }) });
  const enterEdit = () => q('.gtasks-view-tail button')!.click();
  const enter = (el: HTMLElement) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

  it('saving with nothing changed performs no write (no needless push to Google)', async () => {
    const { view, app } = setup({ notes: base() });
    await view.onOpen();
    enterEdit();
    enter(q('.gtasks-view-title-input')!);
    await settle();
    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    expect(q('.gtasks-view-title-input')).toBeNull();
  });

  it('a blank title is ignored but a changed due date is still saved', async () => {
    const { view, notes } = setup({ notes: base() });
    await view.onOpen();
    enterEdit();
    const title = q<HTMLInputElement>('.gtasks-view-title-input')!;
    const date = q<HTMLInputElement>('.gtasks-view-date-input')!;
    title.value = '   ';
    date.value = '2031-05-06';
    enter(title);
    await settle();
    expect(notes.get('Google Tasks/a.md')![FM.title]).toBe('Alpha');
    expect(notes.get('Google Tasks/a.md')![FM.due]).toBe('2031-05-06');
  });

  it('clearing the date input removes gtasks_due', async () => {
    const { view, notes } = setup({ filter: 'all', notes: base() });
    await view.onOpen();
    q('.gtasks-view-due')!.click();
    const date = q<HTMLInputElement>('.gtasks-view-date-input')!;
    date.value = '';
    date.dispatchEvent(new Event('change'));
    await settle();
    expect(notes.get('Google Tasks/a.md')).not.toHaveProperty(FM.due);
  });

  it('shows a notice and closes the editor when the note disappeared mid-edit', async () => {
    const { view, notes } = setup({ notes: base() });
    await view.onOpen();
    enterEdit();
    const title = q<HTMLInputElement>('.gtasks-view-title-input')!;
    title.value = 'Too late';
    notes.delete('Google Tasks/a.md');
    enter(title);
    await settle();
    expect(lastNotice()).toMatch(/not found/i);
    expect(q('.gtasks-view-title-input')).toBeNull();
  });

  it('saves only once when Enter and the resulting focus loss both fire', async () => {
    const { view, app } = setup({ notes: base() });
    await view.onOpen();
    enterEdit();
    const title = q<HTMLInputElement>('.gtasks-view-title-input')!;
    title.value = 'Beta';
    const row = q('.gtasks-view-row')!;
    enter(title);
    row.dispatchEvent(new Event('focusout'));
    await wait(20);
    expect(app.fileManager.processFrontMatter).toHaveBeenCalledTimes(1);
  });

  it('F2 on the title starts editing and Escape in the date field cancels without writing', async () => {
    const { view, app } = setup({ notes: base() });
    await view.onOpen();
    q('.gtasks-view-task-title')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2' }));
    expect(q('.gtasks-view-title-input')).not.toBeNull();
    q<HTMLInputElement>('.gtasks-view-title-input')!.value = 'Nope';
    q('.gtasks-view-date-input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle();
    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    expect(q('.gtasks-view-title-input')).toBeNull();
  });
});

// ─── Opening notes, keyboard, settings ─────────────────────────────────────────

describe('navigation and keyboard', () => {
  const base = () => ({ 'Google Tasks/a.md': task('a', 'Alpha', { [FM.due]: dayOffset(0) }) });

  it('opens in a new tab on cmd/ctrl-click and on Enter with a modifier', async () => {
    const { view, app } = setup({ notes: base() });
    await view.onOpen();
    q('.gtasks-view-task-title')!.dispatchEvent(new MouseEvent('click', { metaKey: true, bubbles: true }));
    expect(app.workspace.getLeaf).toHaveBeenLastCalledWith('tab');
    q('.gtasks-view-task-title')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));
    expect(app.workspace.getLeaf).toHaveBeenLastCalledWith('tab');
  });

  it('notifies instead of throwing when the note was deleted before it was opened', async () => {
    const { view, notes, openFile } = setup({ notes: base() });
    await view.onOpen();
    notes.delete('Google Tasks/a.md');
    q('.gtasks-view-task-title')!.click();
    expect(openFile).not.toHaveBeenCalled();
    expect(lastNotice()).toMatch(/no longer exists/i);
  });

  it('arrow keys wrap around the filter tabs in both directions', async () => {
    const { view } = setup();
    await view.onOpen();
    const tabs = q('.gtasks-view-tabs')!;
    tabs.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(activeTab()).toBe('all');
    tabs.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(activeTab()).toBe('today');
  });

  it('ignores unrelated keys on the tab list', async () => {
    const { view } = setup();
    await view.onOpen();
    q('.gtasks-view-tabs')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(activeTab()).toBe('today');
  });

  it('keeps a section collapsed/expanded across a refresh', async () => {
    const { view, handlers, notes } = setup({
      filter: 'all',
      notes: { 'Google Tasks/d.md': task('d', 'Done', { [FM.completed]: true }) },
    });
    await view.onOpen();
    q('.gtasks-view-section-head')!.click(); // expand Completed
    notes.set('Google Tasks/e.md', task('e', 'Done too', { [FM.completed]: true }));
    fire(handlers, 'create', makeFile('Google Tasks/e.md'));
    await wait(250);
    expect(q('.gtasks-view-section-head')!.getAttribute('aria-expanded')).toBe('true');
    expect(titles().sort()).toEqual(['Done', 'Done too']);
  });
});

describe('sync-off and not-connected transitions', () => {
  it('picks up Tasks sync being switched on while the view is in the background', async () => {
    const { view, plugin, handlers, leaf } = setup({ enabled: false, filter: 'all', notes: { 'Google Tasks/a.md': task('a', 'Alpha') } });
    await view.onOpen();
    expect(q('.gtasks-view-empty h5')!.textContent).toMatch(/sync is off/i);
    plugin.settings.enableTasksSync = true;
    fire(handlers, 'active-leaf-change', leaf);
    await wait(250);
    expect(titles()).toEqual(['Alpha']);
    expect(q('.gtasks-view')!.classList.contains('is-off')).toBe(false);
  });

  it('ignores active-leaf-change for other leaves', async () => {
    const { view, plugin, handlers, getMarkdownFiles } = setup({ enabled: false });
    await view.onOpen();
    plugin.settings.enableTasksSync = true;
    getMarkdownFiles.mockClear();
    fire(handlers, 'active-leaf-change', { other: true });
    await wait(250);
    expect(getMarkdownFiles).not.toHaveBeenCalled();
  });

  it('drops back to the not-connected state when the account is disconnected', async () => {
    const { view, plugin, handlers, leaf } = setup({ filter: 'all', notes: { 'Google Tasks/a.md': task('a', 'Alpha') } });
    await view.onOpen();
    expect(titles()).toEqual(['Alpha']);
    plugin.tokenStore.get = () => null;
    fire(handlers, 'active-leaf-change', leaf);
    await wait(250);
    expect(q('.gtasks-view-empty h5')!.textContent).toBe('Not connected to Google');
    expect(titles()).toEqual([]);
    expect(q('.gtasks-view')!.classList.contains('is-off')).toBe(true);
  });

  it('opens the plugin settings tab when the host exposes the settings API', async () => {
    const { view, settingHost } = setup({ enabled: false, withSettingHost: true });
    await view.onOpen();
    q<HTMLButtonElement>('.gtasks-view-empty button')!.click();
    expect(settingHost.open).toHaveBeenCalledTimes(1);
    expect(settingHost.openTabById).toHaveBeenCalledWith('obsidian-gdocs-sync');
  });

  it('falls back to a notice when the host exposes no settings API', async () => {
    const { view } = setup({ enabled: false, withSettingHost: false });
    await view.onOpen();
    q<HTMLButtonElement>('.gtasks-view-empty button')!.click();
    expect(lastNotice()).toMatch(/Open Settings/);
  });
});

describe('sidebar vs tab width', () => {
  function stubObserver() {
    let cb!: (entries: Array<{ contentRect: { width: number } }>) => void;
    vi.stubGlobal('ResizeObserver', class {
      constructor(c: typeof cb) { cb = c; }
      observe() {}
      disconnect() {}
    });
    return (width: number) => cb([{ contentRect: { width } }]);
  }
  afterEach(() => vi.unstubAllGlobals());

  it('switches to the wide layout exactly at the breakpoint and back below it', async () => {
    const resize = stubObserver();
    const { view } = setup();
    await view.onOpen();
    const root = q('.gtasks-view')!;
    expect(root.classList.contains('is-wide')).toBe(false);
    resize(WIDE_BREAKPOINT - 1);
    expect(root.classList.contains('is-wide')).toBe(false);
    resize(WIDE_BREAKPOINT);
    expect(root.classList.contains('is-wide')).toBe(true);
    resize(240);
    expect(root.classList.contains('is-wide')).toBe(false);
  });

  it('still renders when the host has no ResizeObserver', async () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const { view } = setup({ notes: { 'Google Tasks/a.md': task('a', 'A', { [FM.due]: dayOffset(0) }) } });
    await expect(view.onOpen()).resolves.toBeUndefined();
    expect(titles()).toEqual(['A']);
  });
});
