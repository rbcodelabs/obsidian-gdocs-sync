import type { App, TFile } from 'obsidian';
import { FM, dueToDateOnly } from '../converter/TaskNoteMapper';

/**
 * Pure read model for the Tasks view. Notes stay the source of truth: this
 * module only reads frontmatter through the metadata cache and never touches
 * the DOM, so it is fully unit-testable.
 */

export interface TaskItem {
  /** Google task id, or the note path for a quick-added note not yet pushed. */
  id: string;
  path: string;
  title: string;
  completed: boolean;
  /** Date-only 'YYYY-MM-DD', or '' when unset. */
  due: string;
  listId: string;
  listName: string;
  parentId: string;
  position: string;
}

export type Bucket = 'Overdue' | 'Today' | 'Upcoming' | 'No date' | 'Completed';
export type TaskFilter = 'today' | 'upcoming' | 'overdue' | 'all';

export const BUCKET_ORDER: readonly Bucket[] = ['Overdue', 'Today', 'Upcoming', 'No date', 'Completed'];

export interface TaskNode {
  task: TaskItem;
  children: TaskItem[];
}

export interface TaskGroup {
  bucket: Bucket;
  nodes: TaskNode[];
  /** Number of top-level rows in this group. */
  count: number;
}

export interface TaskCounts {
  today: number;
  upcoming: number;
  overdue: number;
}

export interface TaskList {
  id: string;
  name: string;
}

type AppReader = Pick<App, 'vault' | 'metadataCache'>;

// ─── Dates ───────────────────────────────────────────────────────────────────

/**
 * 'YYYY-MM-DD' for the user's LOCAL calendar day. Due dates are date-only, so
 * they must be compared with the local date, never `toISOString()` (UTC), which
 * flips to tomorrow in the evening for anyone west of Greenwich.
 */
export function localDateString(now: Date = new Date()): string {
  const y = String(now.getFullYear()).padStart(4, '0');
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Whole calendar days from `from` to `to` (both 'YYYY-MM-DD'). DST-safe via UTC math. */
function dayDiff(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

export function dueLabel(due: string, today: string, locale?: string): string {
  if (!due) return '';
  const diff = dayDiff(today, due);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  const [y, m, d] = due.split('-').map(Number);
  // Noon avoids any midnight/DST edge when formatting in the local zone.
  return new Date(y, m - 1, d, 12).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

// ─── Reading ─────────────────────────────────────────────────────────────────

function str(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function normaliseDue(value: unknown): string {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return dueToDateOnly(String(value));
}

function inFolder(path: string, folder: string): boolean {
  const f = folder.replace(/\/+$/, '');
  return f.length > 0 && path.startsWith(f + '/');
}

/** Read every live (non soft-deleted) task note under `folder`. */
export function readTasks(app: AppReader, folder: string): TaskItem[] {
  const tasks: TaskItem[] = [];
  for (const file of app.vault.getMarkdownFiles() as TFile[]) {
    if (!inFolder(file.path, folder)) continue;
    const fm = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
    if (!fm) continue;
    // Not a task note at all (no gtasks_* identity) — leave it alone.
    if (fm[FM.id] === undefined && fm[FM.title] === undefined && fm[FM.listId] === undefined) continue;
    if (fm[FM.deleted] === true) continue;

    tasks.push({
      id: str(fm[FM.id]) || file.path,
      path: file.path,
      title: str(fm[FM.title]).trim() || file.basename,
      completed: fm[FM.completed] === true,
      due: normaliseDue(fm[FM.due]),
      listId: str(fm[FM.listId]),
      listName: str(fm[FM.listName]),
      parentId: str(fm[FM.parentId]),
      position: str(fm[FM.position]),
    });
  }
  return tasks;
}

// ─── Bucketing and filtering ─────────────────────────────────────────────────

export function bucketOf(task: TaskItem, today: string): Bucket {
  if (task.completed) return 'Completed';
  if (!task.due) return 'No date';
  if (task.due < today) return 'Overdue';
  if (task.due === today) return 'Today';
  return 'Upcoming';
}

export function matchesFilter(
  task: TaskItem,
  filter: TaskFilter,
  listId: string | null,
  today: string,
): boolean {
  if (listId && task.listId !== listId) return false;
  if (filter === 'all') return true;
  const b = bucketOf(task, today);
  if (b === 'Completed') return false;
  if (filter === 'today') return b === 'Today' || b === 'Overdue';
  if (filter === 'upcoming') return b === 'Upcoming';
  return b === 'Overdue';
}

export function countTasks(tasks: TaskItem[], listId: string | null, today: string): TaskCounts {
  return {
    today: tasks.filter((t) => matchesFilter(t, 'today', listId, today)).length,
    upcoming: tasks.filter((t) => matchesFilter(t, 'upcoming', listId, today)).length,
    overdue: tasks.filter((t) => matchesFilter(t, 'overdue', listId, today)).length,
  };
}

// ─── Tree ────────────────────────────────────────────────────────────────────

/**
 * Google positions are zero-padded numeric strings; compare by length then
 * lexically so an unpadded '9' still sorts before '10'.
 */
function comparePosition(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareTasks(a: TaskItem, b: TaskItem): number {
  // Dated before undated, earlier dates first, then Google's own order.
  if (a.due !== b.due) {
    if (!a.due) return 1;
    if (!b.due) return -1;
    return a.due < b.due ? -1 : 1;
  }
  return comparePosition(a.position, b.position) || a.title.localeCompare(b.title);
}

/**
 * Nest subtasks under their parent. A subtask whose parent is not in `tasks`
 * (filtered out, other list, or missing) is promoted to top level so it never
 * silently disappears.
 */
export function buildTree(tasks: TaskItem[]): TaskNode[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const kids = new Map<string, TaskItem[]>();
  const roots: TaskItem[] = [];
  for (const t of tasks) {
    if (t.parentId && t.parentId !== t.id && byId.has(t.parentId)) {
      const list = kids.get(t.parentId) ?? [];
      list.push(t);
      kids.set(t.parentId, list);
    } else {
      roots.push(t);
    }
  }
  return roots
    .sort(compareTasks)
    .map((task) => ({
      task,
      children: (kids.get(task.id) ?? []).sort((a, b) => comparePosition(a.position, b.position) || a.title.localeCompare(b.title)),
    }));
}

/** Filter, bucket (by the parent's bucket) and nest, in section order. */
export function groupTasks(
  tasks: TaskItem[],
  filter: TaskFilter,
  listId: string | null,
  today: string,
): TaskGroup[] {
  const visible = tasks.filter((t) => matchesFilter(t, filter, listId, today));
  const tree = buildTree(visible);
  const groups: TaskGroup[] = [];
  for (const bucket of BUCKET_ORDER) {
    const nodes = tree.filter((n) => bucketOf(n.task, today) === bucket);
    if (nodes.length > 0) groups.push({ bucket, nodes, count: nodes.length });
  }
  return groups;
}

export function listsOf(tasks: TaskItem[]): TaskList[] {
  const seen = new Map<string, string>();
  for (const t of tasks) {
    if (t.listId && !seen.has(t.listId)) seen.set(t.listId, t.listName || t.listId);
  }
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}
