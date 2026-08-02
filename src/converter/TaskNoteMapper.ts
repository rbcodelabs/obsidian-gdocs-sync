import { GoogleTask, GoogleTaskList, TaskWriteFields } from '../api/GoogleTasksAPI';

// ─── Frontmatter keys ─────────────────────────────────────────────────────────
// Centralised so the mapper, sync engine, and tests never drift on key spelling.
// NOTE: underscores (not hyphens) are intentional — Obsidian Bases parses a
// hyphen in a property reference as subtraction, so `gtasks_completed` works in
// Base filters/formulas/groupBy where `gtasks-completed` would not. This matches
// the existing Linear→Bases pipeline convention in the vault.
export const FM = {
  id: 'gtasks_id',
  listId: 'gtasks_list_id',
  listName: 'gtasks_list_name',
  title: 'gtasks_title',
  completed: 'gtasks_completed',
  due: 'gtasks_due',
  position: 'gtasks_position',
  parentId: 'gtasks_parent_id',
  updated: 'gtasks_updated',
  hash: 'gtasks_hash',
  url: 'gtasks_url',
  deleted: 'gtasks_deleted',
} as const;

/**
 * The four mutable fields that participate in two-way sync and conflict
 * detection. Everything else in the frontmatter is either Google-owned and
 * read-only (position, parent, updated) or bookkeeping (hash, url).
 */
export interface TaskFields {
  title: string;
  notes: string;
  completed: boolean;
  due: string; // date-only 'YYYY-MM-DD', or '' when unset
}

export type TaskFrontmatter = Record<string, unknown>;

// ─── Date helpers ──────────────────────────────────────────────────────────────

/**
 * Google returns `due` as an RFC 3339 timestamp but only the date component is
 * meaningful (Tasks has no time-of-day). Reduce to 'YYYY-MM-DD' for storage.
 */
export function dueToDateOnly(due: string | undefined): string {
  if (!due) return '';
  const t = due.indexOf('T');
  return t === -1 ? due : due.slice(0, t);
}

/**
 * Convert a stored 'YYYY-MM-DD' back to the RFC 3339 form Google expects.
 * We deliberately synthesize midnight UTC and never a real time-of-day — the
 * API ignores the time part, and inventing one would cause spurious diffs.
 */
export function dateOnlyToRfc3339(dateOnly: string | undefined): string | undefined {
  if (!dateOnly) return undefined;
  return `${dateOnly}T00:00:00.000Z`;
}

// ─── Canonicalisation for hashing ──────────────────────────────────────────────

/**
 * Produce a stable string capturing ONLY the four mutable fields, for hashing.
 * Field-by-field ordering is fixed so the hash is deterministic and a change to
 * any single field (title/notes/completed/due) flips it — while a remote-only
 * `updated`/`position` bump (from a reorder) does NOT, avoiding false conflicts.
 */
export function canonicalizeFields(fields: TaskFields): string {
  return JSON.stringify({
    title: fields.title,
    notes: fields.notes,
    completed: fields.completed,
    due: fields.due,
  });
}

// ─── Google Task → note ────────────────────────────────────────────────────────

/** Extract the four mutable fields from a Google Task resource. */
export function taskToFields(task: GoogleTask): TaskFields {
  return {
    title: task.title ?? '',
    notes: task.notes ?? '',
    completed: task.status === 'completed',
    due: dueToDateOnly(task.due),
  };
}

/**
 * Build the frontmatter object + markdown body for a note mirroring a task.
 * `fieldsHash` is the sha256 of canonicalizeFields(...) computed by the caller
 * (hashing is async via Web Crypto, kept out of this pure mapper).
 */
export function taskToNote(
  task: GoogleTask,
  list: GoogleTaskList,
  fieldsHash: string,
): { frontmatter: TaskFrontmatter; body: string } {
  const fields = taskToFields(task);

  const frontmatter: TaskFrontmatter = {
    [FM.id]: task.id,
    [FM.listId]: list.id,
    [FM.listName]: list.title,
    [FM.title]: fields.title,
    [FM.completed]: fields.completed,
    [FM.position]: task.position ?? '',
    [FM.updated]: task.updated,
    [FM.hash]: fieldsHash,
    [FM.url]: task.webViewLink ?? '',
    [FM.deleted]: false,
  };

  // Optional fields — only written when present to keep frontmatter tidy.
  if (fields.due) frontmatter[FM.due] = fields.due;
  if (task.parent) frontmatter[FM.parentId] = task.parent;

  return { frontmatter, body: fields.notes };
}

// ─── Note → Google Task ─────────────────────────────────────────────────────────

/**
 * Read the four mutable fields back out of a note's frontmatter + body.
 * Frontmatter is authoritative for title/completed/due (this is what Bases
 * property cells edit); the body is the task's notes.
 */
export function noteToFields(
  frontmatter: TaskFrontmatter | undefined,
  body: string,
): TaskFields {
  const fm = frontmatter ?? {};
  return {
    title: String(fm[FM.title] ?? '').trim(),
    notes: body.trim(),
    completed: fm[FM.completed] === true,
    due: normalizeDue(fm[FM.due]),
  };
}

/** Coerce whatever the YAML parser produced for `due` into 'YYYY-MM-DD' | ''. */
function normalizeDue(value: unknown): string {
  if (!value) return '';
  // YAML may parse a bare date into a Date object; normalise to date-only.
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return dueToDateOnly(String(value));
}

/** Map local fields into the write shape the Tasks API accepts. */
export function fieldsToWrite(fields: TaskFields): TaskWriteFields {
  return {
    title: fields.title,
    notes: fields.notes,
    status: fields.completed ? 'completed' : 'needsAction',
    due: dateOnlyToRfc3339(fields.due),
  };
}

// ─── 3-way field merge (conflict resolution) ────────────────────────────────────

export interface FieldMergeResult {
  merged: TaskFields;
  /** True when at least one field changed on BOTH sides to different values. */
  conflicted: boolean;
}

/**
 * Merge local and remote field states against a common base, field by field:
 *   - unchanged on both, or changed identically → that value
 *   - changed only remotely → take remote
 *   - changed only locally  → take local
 *   - changed on both to different values → LOCAL wins (never silently clobber
 *     the user's edit), and the result is flagged `conflicted`.
 *
 * Operating per-field means a spurious remote bump to one field (e.g. a reorder
 * touching nothing we track) can't mask or override a genuine local edit to a
 * different field — the core reason we don't use whole-note last-write-wins.
 */
export function mergeFields(
  base: TaskFields,
  local: TaskFields,
  remote: TaskFields,
): FieldMergeResult {
  let conflicted = false;

  function pick<K extends keyof TaskFields>(key: K): TaskFields[K] {
    const b = base[key];
    const l = local[key];
    const r = remote[key];
    if (l === r) return l; // agree (incl. both changed identically)
    if (l === b) return r; // only remote changed
    if (r === b) return l; // only local changed
    conflicted = true; // both diverged → local wins
    return l;
  }

  return {
    merged: {
      title: pick('title'),
      notes: pick('notes'),
      completed: pick('completed'),
      due: pick('due'),
    },
    conflicted,
  };
}

// ─── Filename ───────────────────────────────────────────────────────────────────

/**
 * Sanitize a task title into a safe vault filename (no extension).
 * Task titles are short and generic, so collisions are likely — the caller
 * appends an id-derived suffix via {@link disambiguateFilename} when needed.
 */
export function sanitizeFilename(title: string): string {
  const cleaned = title
    .replace(/[/\\:*?"<>|#^[\]]/g, '-') // OS- and Obsidian-unsafe chars
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '') // no leading dots (hidden files)
    .slice(0, 120);
  return cleaned || 'Untitled Task';
}

/**
 * Append a short, stable suffix derived from the task id to disambiguate a
 * filename collision. Deterministic so the same task always resolves to the
 * same name across syncs.
 */
export function disambiguateFilename(base: string, taskId: string): string {
  const suffix = taskId.replace(/[^a-zA-Z0-9]/g, '').slice(-6) || 'task';
  return `${base} (${suffix})`;
}
