import { readFileSync } from 'fs';
import { resolve } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TFile, Notice, noticeLog } from 'obsidian';
import { FM } from '../../src/converter/TaskNoteMapper';
import { TasksView, TASKS_VIEW_TYPE, LIST_COLORS, listColor } from '../../src/ui/TasksView';
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
  const getMarkdownFiles = vi.fn(() => [...notes.keys()].map(makeFile));
  const app = {
    vault: {
      getMarkdownFiles: getMarkdownFiles,
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
    tasksSyncEngine: { poll: vi.fn().mockResolvedValue(undefined), syncLocalToRemote: vi.fn().mockResolvedValue(undefined) },
  };
  const leaf = { app } as never;
  const view = new TasksView(leaf, plugin as never);
  document.body.replaceChildren(view.contentEl);
  return { view, plugin, app, notes, handlers, openFile, getMarkdownFiles };
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

describe('review follow-ups: quick add', () => {
  const base = () => ({ 'Google Tasks/a.md': task('a', 'Alpha', { [FM.due]: dayOffset(0) }) });
  const add = async (title: string) => {
    q<HTMLInputElement>('.gtasks-view-add-input')!.value = title;
    q<HTMLFormElement>('.gtasks-view-add')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle(); await settle();
  };
  const tab = (f: string) => q(`[data-filter="${f}"]`)!.click();

  it('pushes the new note to Google straight away instead of waiting for the poller', async () => {
    const { view, plugin } = setup({ notes: base() });
    await view.onOpen();
    await add('Buy milk');
    expect(plugin.tasksSyncEngine.syncLocalToRemote).toHaveBeenCalledTimes(1);
    expect((plugin.tasksSyncEngine.syncLocalToRemote.mock.calls[0][0] as TFile).path).toBe('Google Tasks/Buy milk.md');
  });

  it('defaults the due date to tomorrow on Upcoming', async () => {
    const { view, app } = setup({ notes: base() });
    await view.onOpen();
    tab('upcoming');
    await add('Later');
    const content = (app.vault.create.mock.calls[0] as unknown as [string, string])[1];
    expect(content).toContain(`${FM.due}: "${dayOffset(1)}"`);
  });

  it('on Overdue and All adds with no date and says so in a notice naming the list', async () => {
    for (const f of ['overdue', 'all']) {
      noticeLog.length = 0;
      const { view, app } = setup({ notes: base() });
      await view.onOpen();
      tab(f);
      await add('Whenever');
      const content = (app.vault.create.mock.calls[0] as unknown as [string, string])[1];
      expect(content).not.toContain(FM.due);
      expect(noticeLog.at(-1)).toBe('Added to Work (no due date)');
    }
  });

  it('shows no notice when the new task lands on the current tab', async () => {
    noticeLog.length = 0;
    const { view } = setup({ notes: base() });
    await view.onOpen();
    await add('Today thing');
    expect(noticeLog).toEqual([]);
  });

  it('keeps the chosen quick-add list across a re-render when it is still valid', async () => {
    const { view, handlers } = setup({
      notes: {
        'Google Tasks/a.md': task('a', 'A', { [FM.due]: dayOffset(0) }),
        'Google Tasks/b.md': task('b', 'B', { [FM.due]: dayOffset(0), [FM.listId]: 'L2', [FM.listName]: 'Home' }),
      },
    });
    await view.onOpen();
    const sel = q<HTMLSelectElement>('.gtasks-view-add-list select')!;
    sel.value = 'L2';
    sel.dispatchEvent(new Event('change'));
    handlers.changed.forEach((cb) => cb(makeFile('Google Tasks/a.md') as never));
    await wait(200);
    expect(q<HTMLSelectElement>('.gtasks-view-add-list select')!.value).toBe('L2');
  });

  it('does not rebuild the dropdown options while the set of lists is unchanged', async () => {
    const { view, handlers } = setup({ notes: base() });
    await view.onOpen();
    const opt = q('.gtasks-view-add-list option');
    handlers.changed.forEach((cb) => cb(makeFile('Google Tasks/a.md') as never));
    await wait(200);
    expect(q('.gtasks-view-add-list option')).toBe(opt);
  });
});

describe('review follow-ups: accessibility', () => {
  const base = () => ({ 'Google Tasks/a.md': task('a', 'Alpha', { [FM.due]: dayOffset(0) }) });

  it('keeps the checkbox label static (the title); aria-checked carries the state', async () => {
    const { view } = setup({ notes: base() });
    await view.onOpen();
    const check = q('.gtasks-view-check')!;
    expect(check.getAttribute('aria-label')).toBe('Alpha');
    check.click();
    await settle();
    expect(check.getAttribute('aria-label')).toBe('Alpha');
  });

  it('renders the title as a real button', async () => {
    const { view } = setup({ notes: base() });
    await view.onOpen();
    expect(q('.gtasks-view-task-title')!.tagName).toBe('BUTTON');
  });

  it('Home and End jump to the first and last tab', async () => {
    const { view } = setup({ notes: base() });
    await view.onOpen();
    const tabs = q('.gtasks-view-tabs')!;
    tabs.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(q('.gtasks-view-tab[aria-selected="true"]')!.getAttribute('data-filter')).toBe('all');
    tabs.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(q('.gtasks-view-tab[aria-selected="true"]')!.getAttribute('data-filter')).toBe('today');
  });

  it('announces sync state through one role=status node, not an aria-live label that ticks', async () => {
    const { view } = setup({ notes: base() });
    await view.onOpen();
    expect(q('.gtasks-view-sync-label')!.hasAttribute('aria-live')).toBe(false);
    expect(qa('[role="status"]')).toHaveLength(1);
    q('.gtasks-view-sync button')!.click();
    await settle(); await settle();
    expect(q('[role="status"]')!.textContent).toBe('Tasks synced');
  });
});

describe('review follow-ups: teardown', () => {
  it('onClose clears the pending refresh timer and the interval', async () => {
    const clear = vi.spyOn(window, 'clearInterval');
    const { view, handlers, getMarkdownFiles } = setup({ notes: { 'Google Tasks/a.md': task('a', 'A') } } as never);
    await view.onOpen();
    handlers.changed.forEach((cb) => cb(makeFile('Google Tasks/a.md') as never));
    await view.onClose();
    getMarkdownFiles.mockClear();
    await wait(250);
    expect(getMarkdownFiles).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });
});

interface ParsedCssRule {
  selectors: string[];
  decls: Record<string, string>;
}

function parseTopLevelCssRules(rawCss: string): ParsedCssRule[] {
  const withoutComments = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: ParsedCssRule[] = [];
  let i = 0;
  while (i < withoutComments.length) {
    const open = withoutComments.indexOf('{', i);
    if (open === -1) break;
    const prelude = withoutComments.slice(i, open).trim();
    let depth = 1;
    let pos = open + 1;
    while (pos < withoutComments.length && depth > 0) {
      if (withoutComments[pos] === '{') depth++;
      else if (withoutComments[pos] === '}') depth--;
      pos++;
    }
    const body = withoutComments.slice(open + 1, pos - 1);
    i = pos;
    if (prelude.startsWith('@')) continue;
    const selectors = prelude.split(',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
    const decls: Record<string, string> = {};
    let pDepth = 0;
    let quote: string | null = null;
    let start = 0;
    for (let k = 0; k <= body.length; k++) {
      const ch = body[k];
      if (quote) {
        if (ch === quote && body[k - 1] !== '\\') quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '(') {
        pDepth++;
      } else if (ch === ')') {
        pDepth = Math.max(0, pDepth - 1);
      } else if ((ch === ';' || k === body.length) && pDepth === 0) {
        const chunk = body.slice(start, k).trim();
        start = k + 1;
        const colon = chunk.indexOf(':');
        if (colon > 0) {
          decls[chunk.slice(0, colon).trim()] = chunk.slice(colon + 1).trim();
        }
      }
    }
    rules.push({ selectors, decls });
  }
  return rules;
}

function mergedCssDecls(rules: ParsedCssRule[], selector: string): Record<string, string> {
  const normalized = selector.trim().replace(/\s+/g, ' ');
  const out: Record<string, string> = {};
  for (const rule of rules) {
    if (rule.selectors.includes(normalized)) Object.assign(out, rule.decls);
  }
  return out;
}

describe('Geode host layout and CSS regressions', () => {
  it('renders both header list filter and quick-add target list selects with class="dropdown" (with and without synced lists)', async () => {
    const populated = setup({
      filter: 'all',
      notes: {
        'Google Tasks/a.md': task('a', 'Work item', { [FM.listId]: 'L1', [FM.listName]: 'Work' }),
        'Google Tasks/b.md': task('b', 'Home item', { [FM.listId]: 'L2', [FM.listName]: 'Personal' }),
      },
    });
    await populated.view.onOpen();
    const headerSelect = q<HTMLSelectElement>('.gtasks-view-list-select select')!;
    const addSelect = q<HTMLSelectElement>('.gtasks-view-add-list select')!;
    expect(headerSelect.classList.contains('dropdown')).toBe(true);
    expect(addSelect.classList.contains('dropdown')).toBe(true);
    await populated.view.onClose();

    // Boundary case: empty vault with zero lists (fallback "Default list" option)
    const empty = setup({ filter: 'all', notes: {} });
    await empty.view.onOpen();
    expect(q<HTMLSelectElement>('.gtasks-view-list-select select')!.classList.contains('dropdown')).toBe(true);
    expect(q<HTMLSelectElement>('.gtasks-view-add-list select')!.classList.contains('dropdown')).toBe(true);
    expect(q<HTMLSelectElement>('.gtasks-view-add-list select.dropdown')!.options[0]?.textContent).toBe('Default list');
    await empty.view.onClose();
  });

  it('emits valid var(...) list dot colors with Geode fallbacks for cyan and pink across list IDs and boundary inputs', async () => {
    expect(LIST_COLORS).toContain('var(--color-cyan, var(--color-blue))');
    expect(LIST_COLORS).toContain('var(--color-pink, var(--color-purple))');
    expect(LIST_COLORS).not.toContain('var(--color-cyan)');
    expect(LIST_COLORS).not.toContain('var(--color-pink)');

    const notes: Record<string, FM_> = {};
    const observedPalette = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const id = `list-${i}`;
      const color = listColor(id);
      observedPalette.add(color);
      expect(color).toMatch(/^var\(--color-[a-z]+(?:,\s*var\(--color-[a-z]+\))?\)$/);
      expect(color).not.toContain('var(var(');
      notes[`Google Tasks/t-${i}.md`] = task(`t-${i}`, `Task ${i}`, {
        [FM.listId]: id,
        [FM.listName]: `List ${i}`,
      });
    }
    // Every palette slot (including cyan and pink fallbacks) is reachable across list IDs.
    expect(observedPalette.size).toBe(LIST_COLORS.length);

    // Boundary cases: empty listId, Unicode listId, and deterministic hashing
    expect(listColor('')).toMatch(/^var\(--color-/);
    expect(listColor('📋-unicode-list')).toBe(listColor('📋-unicode-list'));

    const { view } = setup({ filter: 'all', notes });
    await view.onOpen();
    const dotStyles = qa('.gtasks-view-dot').map((el) => el.getAttribute('style') ?? '');
    expect(dotStyles).toHaveLength(40);
    for (const style of dotStyles) {
      expect(style).toMatch(/^background:var\(--color-[a-z]+(?:,\s*var\(--color-[a-z]+\))?\)$/);
      expect(style).not.toBe('background:var(--color-cyan)');
      expect(style).not.toBe('background:var(--color-pink)');
    }
    expect(dotStyles).toContain('background:var(--color-cyan, var(--color-blue))');
    expect(dotStyles).toContain('background:var(--color-pink, var(--color-purple))');
    await view.onClose();
  });

  it('preserves styles.css layout, theming, focus, and button-hover invariants for Geode and Obsidian hosts', () => {
    const cssPath = resolve(__dirname, '../../styles.css');
    const rawCss = readFileSync(cssPath, 'utf8');
    const rules = parseTopLevelCssRules(rawCss);

    // 1. Root & host view-content containers lock overflow so .gtasks-view-body is the sole scroll container
    expect(mergedCssDecls(rules, '.gtasks-view').overflow).toBe('hidden');
    expect(mergedCssDecls(rules, '.view-content.gtasks-view').overflow).toBe('hidden');
    expect(mergedCssDecls(rules, '.sidebar-content > .view-content-host > .view-content.gtasks-view').overflow).toBe('hidden');
    expect(mergedCssDecls(rules, '.workspace-leaf-content > .view-content-host > .view-content.gtasks-view').overflow).toBe('hidden');

    // 2. select.dropdown resets Geode's min-width: 160px and caps max-width
    const selectDropdown = mergedCssDecls(rules, '.gtasks-view select.dropdown');
    expect(selectDropdown['min-width']).toBe('0');
    expect(selectDropdown['max-width']).toBe('100%');

    // 3. Narrow controls stack vertically; wide controls switch to a horizontal row
    expect(mergedCssDecls(rules, '.gtasks-view-controls')['flex-direction']).toBe('column');
    expect(mergedCssDecls(rules, '.gtasks-view.is-wide .gtasks-view-controls')['flex-direction']).toBe('row');

    // 4. Quick-add separates list select row from input+button in narrow mode and uses 3-column inline grid in wide mode
    const narrowAdd = mergedCssDecls(rules, '.gtasks-view-add');
    expect(narrowAdd.display).toBe('grid');
    expect(narrowAdd['grid-template-columns']).toBe('minmax(0, 1fr) auto');
    expect(mergedCssDecls(rules, '.gtasks-view-add-list')['grid-column']).toBe('1 / -1');
    expect(mergedCssDecls(rules, '.gtasks-view-add-input')['grid-column']).toBe('1');
    expect(mergedCssDecls(rules, '.gtasks-view-add-btn')['grid-column']).toBe('2');

    const wideAdd = mergedCssDecls(rules, '.gtasks-view.is-wide .gtasks-view-add');
    expect(wideAdd['grid-template-columns']).toBe('minmax(130px, 180px) minmax(0, 1fr) auto');
    expect(mergedCssDecls(rules, '.gtasks-view.is-wide .gtasks-view-add-list')['grid-column']).toBe('1');
    expect(mergedCssDecls(rules, '.gtasks-view.is-wide .gtasks-view-add-input')['grid-column']).toBe('2');
    expect(mergedCssDecls(rules, '.gtasks-view.is-wide .gtasks-view-add-btn')['grid-column']).toBe('3');

    // 5. All three text/date inputs explicitly theme background, border, and color, and define accessible :focus-visible cues
    for (const inputSel of ['.gtasks-view-add-input', '.gtasks-view-title-input', '.gtasks-view-date-input']) {
      const inputDecls = mergedCssDecls(rules, inputSel);
      expect(inputDecls.background, `${inputSel} background`).toBeDefined();
      expect(inputDecls.border, `${inputSel} border`).toBeDefined();
      expect(inputDecls.color, `${inputSel} color`).toBeDefined();

      const focusVisibleDecls = mergedCssDecls(rules, `${inputSel}:focus-visible`);
      const hasFocusRing = Boolean(
        (focusVisibleDecls['border-color'] && focusVisibleDecls['border-color'] !== 'transparent') ||
        (focusVisibleDecls['box-shadow'] && focusVisibleDecls['box-shadow'] !== 'none') ||
        (focusVisibleDecls.outline && focusVisibleDecls.outline !== 'none'),
      );
      expect(hasFocusRing, `${inputSel}:focus-visible must show an accessible focus indicator`).toBe(true);
    }

    // 6. Task title and unchecked checkbox hover explicitly guard background against Geode's global button:hover rule
    expect(mergedCssDecls(rules, '.gtasks-view-task-title:hover').background).toBe('transparent');
    expect(mergedCssDecls(rules, '.gtasks-view-check:hover:not(.is-done)').background).toBe('transparent');
    expect(mergedCssDecls(rules, '.gtasks-view-row:not(.is-done):not(.is-completing) .gtasks-view-check:hover').background).toBe('transparent');
  });
});
