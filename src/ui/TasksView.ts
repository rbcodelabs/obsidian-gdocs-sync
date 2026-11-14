import { ItemView, DropdownComponent, Notice, TextComponent, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
import type { App } from 'obsidian';
import type { GDocsPluginSettings, TasksViewFilter } from '../types';
import {
  TaskItem,
  TaskNode,
  Bucket,
  readTasks,
  groupTasks,
  countTasks,
  listsOf,
  bucketOf,
  dueLabel,
  localDateString,
} from '../tasks/TaskStore';
import { TaskActions } from '../tasks/TaskActions';

export const TASKS_VIEW_TYPE = 'gdocs-tasks-view';

/** Width (px) at/above which the view switches from the sidebar to the one-line tab layout. */
export const WIDE_BREAKPOINT = 560;
const REFRESH_DEBOUNCE_MS = 150;
const ALL_LISTS = '*';
const NO_LIST = '';

const FILTERS: Array<{ id: TasksViewFilter; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'all', label: 'All' },
];

/** The slice of the plugin the view needs; keeps the view testable. */
export interface TasksViewPlugin {
  app: App;
  manifest: { id: string };
  settings: GDocsPluginSettings;
  tokenStore: { get(): unknown };
  tasksSyncEngine: { poll(): Promise<void> };
}

type SettingsHost = { open(): void; openTabById(id: string): void };

function isFilter(v: unknown): v is TasksViewFilter {
  return v === 'today' || v === 'upcoming' || v === 'overdue' || v === 'all';
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Focused task hub over the synced Google Tasks notes. Reads the metadata cache,
 * writes through {@link TaskActions}; the existing sync engine does the rest.
 */
export class TasksView extends ItemView {
  private filter: TasksViewFilter;
  private listId = ALL_LISTS;
  private quickAddListId: string | null = null;
  private collapsed = new Set<Bucket>(['Completed']);
  private editingPath: string | null = null;
  private refreshPending = false;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSyncedAt: number | null = null;
  private syncing = false;
  private actions: TaskActions;
  private resizeObserver: ResizeObserver | null = null;

  private rootEl!: HTMLElement;
  private headerEl!: HTMLElement;
  private syncLabelEl!: HTMLElement;
  private syncBtnEl!: HTMLButtonElement;
  private listDropdown!: DropdownComponent;
  private tabsEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private addFormEl!: HTMLFormElement;
  private addList!: DropdownComponent;
  private addInput!: TextComponent;

  constructor(leaf: WorkspaceLeaf, private plugin: TasksViewPlugin) {
    super(leaf);
    const saved = plugin.settings.tasksViewDefaultFilter;
    this.filter = isFilter(saved) ? saved : 'today';
    this.actions = new TaskActions(this.app, () => this.plugin.settings.tasksFolder);
  }

  getViewType(): string { return TASKS_VIEW_TYPE; }
  getDisplayText(): string { return 'Google Tasks'; }
  getIcon(): string { return 'list-checks'; }

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass('gtasks-view');
    this.rootEl = root;

    this.buildHeader(root);
    this.bodyEl = root.createDiv({ cls: 'gtasks-view-body' });
    this.buildQuickAdd(root);

    this.registerEvents();
    this.observeWidth();
    // Keep "Synced N min ago" fresh without re-rendering rows.
    this.registerInterval(window.setInterval(() => this.renderSyncLabel(), 30_000));

    this.render();
  }

  async onClose(): Promise<void> {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  /** Focus the quick-add input (used by the quick-add command). */
  focusQuickAdd(): void {
    this.addInput?.inputEl.focus();
  }

  // ─── data ──────────────────────────────────────────────────────────────────

  private get enabled(): boolean {
    return this.plugin.settings.enableTasksSync && this.plugin.tokenStore.get() !== null;
  }

  private tasks(): TaskItem[] {
    return readTasks(this.app, this.plugin.settings.tasksFolder);
  }

  private inTasksFolder(path: string): boolean {
    const folder = this.plugin.settings.tasksFolder.replace(/\/+$/, '');
    return folder.length > 0 && path.startsWith(folder + '/');
  }

  private registerEvents(): void {
    const onChange = (path: string) => { if (this.inTasksFolder(path)) this.scheduleRefresh(); };
    this.registerEvent(this.app.metadataCache.on('changed', (file) => onChange(file.path)));
    // Settings can flip sync on/off while the view is in the background.
    this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
      if (leaf === this.leaf) this.scheduleRefresh();
    }));
    this.registerEvent(this.app.vault.on('create', (f) => onChange(f.path)));
    this.registerEvent(this.app.vault.on('delete', (f) => onChange(f.path)));
    this.registerEvent(this.app.vault.on('rename', (f, oldPath) => {
      if (this.inTasksFolder(f.path) || this.inTasksFolder(oldPath)) this.scheduleRefresh();
    }));
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      // Re-rendering would destroy the inline editor mid-typing; catch up after.
      if (this.editingPath !== null) { this.refreshPending = true; return; }
      this.render();
    }, REFRESH_DEBOUNCE_MS);
  }

  private observeWidth(): void {
    const apply = (width: number) => this.rootEl.toggleClass('is-wide', width >= WIDE_BREAKPOINT);
    if (typeof ResizeObserver === 'undefined') return;
    this.resizeObserver = new ResizeObserver((entries) => {
      for (const e of entries) apply(e.contentRect.width);
    });
    this.resizeObserver.observe(this.rootEl);
    apply(this.rootEl.clientWidth);
  }

  // ─── static skeleton ───────────────────────────────────────────────────────

  private buildHeader(root: HTMLElement): void {
    const header = (this.headerEl = root.createDiv({ cls: 'gtasks-view-header' }));
    const titleRow = header.createDiv({ cls: 'gtasks-view-title-row' });
    titleRow.createEl('h4', { cls: 'gtasks-view-title', text: 'Tasks' });

    const sync = titleRow.createDiv({ cls: 'gtasks-view-sync' });
    this.syncLabelEl = sync.createSpan({ cls: 'gtasks-view-sync-label', attr: { 'aria-live': 'polite' } });
    this.syncBtnEl = sync.createEl('button', {
      cls: 'gtasks-view-icon-btn clickable-icon',
      attr: { 'aria-label': 'Sync now', title: 'Sync now', type: 'button' },
    });
    setIcon(this.syncBtnEl, 'refresh-cw');
    this.syncBtnEl.addEventListener('click', () => void this.syncNow());

    const controls = header.createDiv({ cls: 'gtasks-view-controls' });
    this.tabsEl = controls.createDiv({ cls: 'gtasks-view-tabs', attr: { role: 'tablist', 'aria-label': 'Filter tasks' } });
    this.tabsEl.addEventListener('keydown', (e) => this.onTabKey(e));

    const listWrap = controls.createDiv({ cls: 'gtasks-view-list-select' });
    this.listDropdown = new DropdownComponent(listWrap);
    this.listDropdown.selectEl.setAttribute('aria-label', 'List');
    this.listDropdown.onChange((v) => { this.listId = v; this.render(); });
  }

  private buildQuickAdd(root: HTMLElement): void {
    const form = (this.addFormEl = root.createEl('form', { cls: 'gtasks-view-add', attr: { autocomplete: 'off' } }));
    const listWrap = form.createDiv({ cls: 'gtasks-view-add-list' });
    this.addList = new DropdownComponent(listWrap);
    this.addList.selectEl.setAttribute('aria-label', 'List for new task');
    this.addList.onChange((v) => { this.quickAddListId = v; });

    this.addInput = new TextComponent(form);
    this.addInput.inputEl.addClass('gtasks-view-add-input');
    this.addInput.inputEl.setAttribute('aria-label', 'New task title');
    this.addInput.setPlaceholder('Add a task…');

    const btn = form.createEl('button', {
      cls: 'gtasks-view-icon-btn gtasks-view-add-btn mod-cta',
      attr: { type: 'submit', 'aria-label': 'Add task', title: 'Add task' },
    });
    setIcon(btn, 'plus');
    form.addEventListener('submit', (e) => { e.preventDefault(); void this.submitQuickAdd(); });
  }

  // ─── render ────────────────────────────────────────────────────────────────

  private render(): void {
    this.refreshPending = false;
    const enabled = this.enabled;
    this.rootEl.toggleClass('is-off', !enabled);

    const tasks = enabled ? this.tasks() : [];
    const lists = listsOf(tasks);
    if (this.listId !== ALL_LISTS && !lists.some((l) => l.id === this.listId)) this.listId = ALL_LISTS;
    const today = localDateString();
    const listFilter = this.listId === ALL_LISTS ? null : this.listId;

    this.renderSyncLabel();
    this.renderListControls(lists);
    this.renderTabs(countTasks(tasks, listFilter, today));

    const focus = this.captureFocus();
    this.bodyEl.empty();
    if (!enabled) {
      this.renderDisabled();
    } else {
      this.renderBody(tasks, listFilter, today);
    }
    this.restoreFocus(focus);
  }

  private renderListControls(lists: Array<{ id: string; name: string }>): void {
    const sel = this.listDropdown.selectEl;
    sel.empty();
    this.listDropdown.addOption(ALL_LISTS, 'All lists');
    for (const l of lists) this.listDropdown.addOption(l.id, l.name);
    this.listDropdown.setValue(this.listId);

    const add = this.addList.selectEl;
    add.empty();
    if (lists.length === 0) this.addList.addOption(NO_LIST, 'Default list');
    for (const l of lists) this.addList.addOption(l.id, l.name);
    const preferred =
      this.listId !== ALL_LISTS ? this.listId : this.quickAddListId && lists.some((l) => l.id === this.quickAddListId)
        ? this.quickAddListId
        : lists[0]?.id ?? NO_LIST;
    this.addList.setValue(preferred);
    this.quickAddListId = preferred;
    this.addInput.setPlaceholder(this.filter === 'today' ? 'Add a task for today…' : 'Add a task…');
  }

  private renderTabs(counts: { today: number; upcoming: number; overdue: number }): void {
    this.tabsEl.empty();
    for (const f of FILTERS) {
      const selected = f.id === this.filter;
      const tab = this.tabsEl.createEl('button', {
        cls: 'gtasks-view-tab' + (selected ? ' is-active' : ''),
        attr: {
          role: 'tab',
          type: 'button',
          'aria-selected': String(selected),
          tabindex: selected ? '0' : '-1',
          'data-filter': f.id,
        },
      });
      tab.createSpan({ text: f.label });
      if (f.id !== 'all') {
        const n = counts[f.id];
        const warn = f.id === 'overdue' && n > 0;
        // Counts are hidden in the narrow sidebar via CSS, except a non-zero overdue count.
        tab.createEl('i', { cls: 'gtasks-view-tab-count' + (warn ? ' is-warn' : ''), text: String(n) });
      }
      tab.addEventListener('click', () => this.setFilter(f.id));
    }
  }

  private setFilter(f: TasksViewFilter): void {
    this.filter = f;
    this.render();
  }

  private onTabKey(e: KeyboardEvent): void {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const idx = FILTERS.findIndex((f) => f.id === this.filter);
    const next = FILTERS[(idx + dir + FILTERS.length) % FILTERS.length];
    this.setFilter(next.id);
    this.tabsEl.querySelector<HTMLElement>(`[data-filter="${next.id}"]`)?.focus();
  }

  private renderSyncLabel(): void {
    if (!this.syncLabelEl) return;
    if (this.syncing) {
      this.syncLabelEl.setText('Syncing…');
    } else if (this.lastSyncedAt === null) {
      this.syncLabelEl.setText('');
    } else {
      const mins = Math.floor((Date.now() - this.lastSyncedAt) / 60_000);
      this.syncLabelEl.setText(mins < 1 ? 'Synced just now' : mins === 1 ? 'Synced 1 min ago' : `Synced ${mins} min ago`);
    }
    this.syncBtnEl.toggleClass('is-spinning', this.syncing);
    this.syncBtnEl.disabled = this.syncing;
  }

  private renderDisabled(): void {
    const connected = this.plugin.tokenStore.get() !== null;
    const empty = this.bodyEl.createDiv({ cls: 'gtasks-view-empty' });
    const art = empty.createDiv({ cls: 'gtasks-view-empty-art' });
    setIcon(art, 'alert-circle');
    empty.createEl('h5', { text: connected ? 'Google Tasks sync is off' : 'Not connected to Google' });
    empty.createEl('p', {
      text: connected
        ? 'Turn on Tasks sync in the plugin settings to see your lists here.'
        : 'Connect your Google account and turn on Tasks sync to see your lists here.',
    });
    const btn = empty.createEl('button', { cls: 'mod-cta', text: 'Open settings', attr: { type: 'button' } });
    btn.addEventListener('click', () => this.openSettings());
  }

  private renderBody(tasks: TaskItem[], listFilter: string | null, today: string): void {
    const groups = groupTasks(tasks, this.filter, listFilter, today);
    const anyOpen = groups.some((g) => g.bucket !== 'Completed');

    if (!anyOpen) {
      const empty = this.bodyEl.createDiv({ cls: 'gtasks-view-empty' });
      const art = empty.createDiv({ cls: 'gtasks-view-empty-art' });
      setIcon(art, 'check');
      if (this.filter === 'all' && tasks.length === 0) {
        empty.createEl('h5', { text: 'No tasks yet' });
        empty.createEl('p', { text: 'Add a task below, or sync to pull in your Google Tasks.' });
      } else {
        empty.createEl('h5', { text: "You're all caught up" });
        empty.createEl('p', {
          text: `Nothing ${this.filter === 'all' ? 'open' : this.filter === 'today' ? 'due today' : this.filter} here. Add a task below or enjoy the quiet.`,
        });
      }
    }

    for (const group of groups) {
      const isCollapsed = this.collapsed.has(group.bucket);
      const sec = this.bodyEl.createDiv({ cls: 'gtasks-view-section' + (isCollapsed ? ' is-collapsed' : '') });
      const head = sec.createEl('button', {
        cls: 'gtasks-view-section-head' + (group.bucket === 'Overdue' ? ' is-overdue' : ''),
        attr: { type: 'button', 'aria-expanded': String(!isCollapsed), 'data-bucket': group.bucket },
      });
      const caret = head.createSpan({ cls: 'gtasks-view-caret' });
      setIcon(caret, 'chevron-down');
      head.createSpan({ text: group.bucket });
      head.createSpan({ cls: 'gtasks-view-section-count', text: String(group.count) });
      head.addEventListener('click', () => {
        if (this.collapsed.has(group.bucket)) this.collapsed.delete(group.bucket);
        else this.collapsed.add(group.bucket);
        this.render();
      });

      const rows = sec.createDiv({ cls: 'gtasks-view-rows', attr: { role: 'list' } });
      for (const node of group.nodes) this.renderNode(rows, node, today);
    }
  }

  private renderNode(parent: HTMLElement, node: TaskNode, today: string): void {
    this.renderRow(parent, node.task, today, false);
    for (const child of node.children) this.renderRow(parent, child, today, true);
  }

  private renderRow(parent: HTMLElement, task: TaskItem, today: string, isSub: boolean): void {
    const bucket = bucketOf(task, today);
    const editing = this.editingPath === task.path;
    const row = parent.createDiv({
      cls: ['gtasks-view-row', task.completed ? 'is-done' : '', isSub ? 'is-sub' : '', editing ? 'is-editing' : '']
        .filter(Boolean).join(' '),
      attr: { role: 'listitem', 'data-path': task.path },
    });

    const check = row.createEl('button', {
      cls: 'gtasks-view-check',
      attr: {
        type: 'button',
        role: 'checkbox',
        'aria-checked': String(task.completed),
        'aria-label': `${task.completed ? 'Mark incomplete' : 'Complete'}: ${task.title}`,
      },
    });
    setIcon(check, 'check');
    check.addEventListener('click', () => void this.toggle(row, task));

    const main = row.createDiv({ cls: 'gtasks-view-main' });
    if (editing) {
      this.renderEditor(row, main, task);
      return;
    }

    const title = main.createEl('span', {
      cls: 'gtasks-view-task-title',
      text: task.title,
      attr: { tabindex: '0', role: 'link', 'aria-label': `Open note: ${task.title}` },
    });
    title.addEventListener('click', (e) => this.openNote(task, e.metaKey || e.ctrlKey));
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.openNote(task, e.metaKey || e.ctrlKey);
      else if (e.key === 'F2') this.startEdit(task);
    });

    const meta = main.createDiv({ cls: 'gtasks-view-meta' });
    if (task.due) {
      const cls = bucket === 'Overdue' ? ' is-overdue' : bucket === 'Today' ? ' is-today' : '';
      const chip = meta.createEl('button', {
        cls: 'gtasks-view-due' + cls,
        text: dueLabel(task.due, today),
        attr: { type: 'button', 'aria-label': `Due ${task.due}. Change due date` },
      });
      chip.addEventListener('click', () => this.startEdit(task, true));
    }
    if (task.listName) {
      const lst = meta.createSpan({ cls: 'gtasks-view-list' });
      lst.createSpan({ cls: 'gtasks-view-dot', attr: { style: `background:${listColor(task.listId)}` } });
      lst.createSpan({ cls: 'gtasks-view-list-name', text: task.listName });
    }

    const tail = row.createDiv({ cls: 'gtasks-view-tail' });
    const edit = tail.createEl('button', {
      cls: 'gtasks-view-icon-btn clickable-icon',
      attr: { type: 'button', 'aria-label': `Edit ${task.title}`, title: 'Edit' },
    });
    setIcon(edit, 'pencil');
    edit.addEventListener('click', () => this.startEdit(task));
    const open = tail.createEl('button', {
      cls: 'gtasks-view-icon-btn clickable-icon',
      attr: { type: 'button', 'aria-label': `Open note for ${task.title}`, title: 'Open note' },
    });
    setIcon(open, 'external-link');
    open.addEventListener('click', (e) => this.openNote(task, e.metaKey || e.ctrlKey));
  }

  // ─── inline edit ───────────────────────────────────────────────────────────

  private startEdit(task: TaskItem, focusDate = false): void {
    this.editingPath = task.path;
    this.render();
    const row = this.bodyEl.querySelector<HTMLElement>(`[data-path="${cssEscape(task.path)}"]`);
    row?.querySelector<HTMLElement>(focusDate ? '.gtasks-view-date-input' : '.gtasks-view-title-input')?.focus();
  }

  private renderEditor(row: HTMLElement, main: HTMLElement, task: TaskItem): void {
    const title = main.createEl('input', {
      cls: 'gtasks-view-title-input',
      type: 'text',
      attr: { 'aria-label': 'Task title' },
    });
    title.value = task.title;
    const date = main.createEl('input', {
      cls: 'gtasks-view-date-input',
      type: 'date',
      attr: { 'aria-label': 'Due date' },
    });
    date.value = task.due;

    let finished = false;
    const finish = async (save: boolean) => {
      if (finished) return;
      finished = true;
      if (save) {
        try {
          if (title.value.trim() && title.value.trim() !== task.title) await this.actions.rename(task.path, title.value);
          if (date.value !== task.due) await this.actions.setDue(task.path, date.value || null);
        } catch (err) {
          new Notice(`Google Tasks: ${(err as Error).message}`);
        }
      }
      this.editingPath = null;
      this.render();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); void finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); void finish(false); }
    };
    title.addEventListener('keydown', onKey);
    date.addEventListener('keydown', onKey);
    date.addEventListener('change', () => void finish(true));
    // Save when focus leaves the whole row (tabbing title -> date must not save early).
    row.addEventListener('focusout', () => {
      setTimeout(() => { if (!row.contains(document.activeElement)) void finish(true); }, 0);
    });
  }

  // ─── actions ───────────────────────────────────────────────────────────────

  private async toggle(row: HTMLElement, task: TaskItem): Promise<void> {
    if (!prefersReducedMotion()) row.addClass('is-completing');
    try {
      await this.actions.setCompleted(task.path, !task.completed);
    } catch (err) {
      row.removeClass('is-completing');
      new Notice(`Google Tasks: ${(err as Error).message}`);
    }
  }

  private openNote(task: TaskItem, newTab: boolean): void {
    const file = this.app.vault.getAbstractFileByPath(task.path);
    if (!(file instanceof TFile)) {
      new Notice('Google Tasks: that note no longer exists.');
      return;
    }
    void this.app.workspace.getLeaf(newTab ? 'tab' : false).openFile(file);
  }

  private async submitQuickAdd(): Promise<void> {
    const title = this.addInput.inputEl.value.trim();
    if (!title) return;
    const lists = listsOf(this.tasks());
    const listId = this.addList.getValue();
    const list = lists.find((l) => l.id === listId);
    try {
      await this.actions.quickAdd({
        title,
        listId: list?.id ?? NO_LIST,
        listName: list?.name ?? '',
        due: this.filter === 'today' ? localDateString() : undefined,
      });
      this.addInput.setValue('');
      this.scheduleRefresh();
    } catch (err) {
      new Notice(`Google Tasks: ${(err as Error).message}`);
    }
  }

  private async syncNow(): Promise<void> {
    if (this.syncing || !this.enabled) return;
    this.syncing = true;
    this.renderSyncLabel();
    try {
      await this.plugin.tasksSyncEngine.poll();
      this.lastSyncedAt = Date.now();
    } catch (err) {
      new Notice(`Google Tasks sync failed: ${(err as Error).message}`);
    } finally {
      this.syncing = false;
      this.renderSyncLabel();
      this.scheduleRefresh();
    }
  }

  private openSettings(): void {
    const setting = (this.app as unknown as { setting?: SettingsHost }).setting;
    if (!setting) {
      new Notice('Open Settings and choose Google Docs Sync.');
      return;
    }
    setting.open();
    setting.openTabById(this.plugin.manifest.id);
  }

  // ─── focus preservation across re-renders ───────────────────────────────────

  private captureFocus(): { path: string; cls: string } | { bucket: string } | null {
    const a = document.activeElement as HTMLElement | null;
    if (!a || !this.bodyEl.contains(a)) return null;
    const row = a.closest<HTMLElement>('[data-path]');
    if (row?.dataset.path) {
      const cls = ['gtasks-view-check', 'gtasks-view-task-title', 'gtasks-view-due'].find((c) => a.classList.contains(c));
      return cls ? { path: row.dataset.path, cls } : null;
    }
    const head = a.closest<HTMLElement>('[data-bucket]');
    return head?.dataset.bucket ? { bucket: head.dataset.bucket } : null;
  }

  private restoreFocus(f: { path: string; cls: string } | { bucket: string } | null): void {
    if (!f) return;
    const sel = 'path' in f
      ? `[data-path="${cssEscape(f.path)}"] .${f.cls}`
      : `[data-bucket="${cssEscape(f.bucket)}"]`;
    this.bodyEl.querySelector<HTMLElement>(sel)?.focus();
  }
}

/** Stable per-list dot colour from Obsidian's own palette variables. */
const LIST_COLORS = ['--color-blue', '--color-green', '--color-orange', '--color-purple', '--color-cyan', '--color-pink', '--color-yellow'];
function listColor(listId: string): string {
  let h = 0;
  for (let i = 0; i < listId.length; i++) h = (h * 31 + listId.charCodeAt(i)) >>> 0;
  return `var(${LIST_COLORS[h % LIST_COLORS.length]})`;
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
}
