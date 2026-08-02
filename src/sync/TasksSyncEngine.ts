import { Plugin, TFile, Notice } from 'obsidian';
import { GDocsPluginSettings } from '../types';
import {
  GoogleTasksAPI,
  GoogleTask,
  GoogleTaskList,
  TasksScopeError,
} from '../api/GoogleTasksAPI';
import { TokenStore } from '../auth/TokenStore';
import { FileWatcher } from './FileWatcher';
import { TasksPoller } from './TasksPoller';
import {
  FM,
  TaskFields,
  taskToFields,
  taskToNote,
  noteToFields,
  fieldsToWrite,
  canonicalizeFields,
  mergeFields,
  sanitizeFilename,
  disambiguateFilename,
  TaskFrontmatter,
} from '../converter/TaskNoteMapper';

type PluginWithSettings = Plugin & {
  settings: GDocsPluginSettings;
  saveSettings(): Promise<void>;
};

/** In-memory record for a synced task note, keyed by vault path. */
interface TaskRef {
  listId: string;
  taskId: string;
  /** Field snapshot at last successful sync — the base for 3-way merge. */
  base: TaskFields;
}

// Strip a leading YAML frontmatter block, returning just the note body.
function stripFrontmatter(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  return match ? match[1].trimStart() : content;
}

// sha256 via Web Crypto (available in Electron/browser context)
async function sha256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class TasksSyncEngine {
  private poller: TasksPoller;

  // path → { listId, taskId, base fields } for every synced note. Maintained
  // eagerly so the 'delete' handler can resolve a task id AFTER the metadata
  // cache has already evicted the deleted file.
  private taskRefs: Map<string, TaskRef> = new Map();
  private taskIdToPath: Map<string, string> = new Map();

  // Per-list incremental cursor (RFC 3339). Undefined = never polled (full pull).
  private listCursors: Map<string, string> = new Map();
  // List IDs seen on the previous list-of-lists fetch (to detect list deletion).
  private knownListIds: Set<string> = new Set();

  // Dedup concurrent syncs of the same note/task.
  private syncQueue: Map<string, Promise<void>> = new Map();

  // Avoid spamming the reconnect notice on every failed poll.
  private scopeErrorNotified = false;
  private handlersRegistered = false;

  constructor(
    private plugin: PluginWithSettings,
    private api: GoogleTasksAPI,
    private tokenStore: TokenStore,
    private fileWatcher: FileWatcher,
  ) {
    this.poller = new TasksPoller(
      () => this.poll(),
      this.plugin.settings.tasksPollIntervalSeconds,
    );
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.registerHandlers();

    // Initial full import, then start incremental polling.
    try {
      await this.importAllLists();
    } catch (err) {
      this.reportError('Initial Google Tasks import failed', err);
    }

    this.fileWatcher.start(); // idempotent — shared with Docs sync
    this.poller.start();
  }

  stop(): void {
    this.poller.stop();
  }

  private registerHandlers(): void {
    if (this.handlersRegistered) return;
    this.handlersRegistered = true;

    // Local edits to a task note → push to Google.
    this.fileWatcher.addHandler(
      (file) => this.isTaskFile(file),
      (file) => this.syncLocalToRemote(file),
    );

    // Local deletion of a task note → delete the task remotely.
    this.plugin.registerEvent(
      this.plugin.app.vault.on('delete', (abstractFile) => {
        if (abstractFile instanceof TFile) {
          void this.handleDelete(abstractFile.path);
        }
      }),
    );

    // Rename keeps the same task; just remap our in-memory keys so a later
    // delete still resolves and the modify handler keeps working.
    this.plugin.registerEvent(
      this.plugin.app.vault.on('rename', (abstractFile, oldPath) => {
        if (abstractFile instanceof TFile) {
          this.handleRename(oldPath, abstractFile.path);
        }
      }),
    );
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private get tasksFolder(): string {
    return this.plugin.settings.tasksFolder.replace(/\/$/, '');
  }

  private isTaskFile(file: TFile): boolean {
    if (file.extension !== 'md') return false;
    const folder = this.tasksFolder;
    return folder.length > 0 && file.path.startsWith(folder + '/');
  }

  /** Filter the account's lists down to the ones the user chose to sync. */
  private selectSyncedLists(lists: GoogleTaskList[]): GoogleTaskList[] {
    const chosen = this.plugin.settings.syncedTaskListIds;
    if (!chosen || chosen.length === 0) return lists; // empty = all
    const set = new Set(chosen);
    return lists.filter((l) => set.has(l.id));
  }

  private async ensureFolder(): Promise<void> {
    const folder = this.tasksFolder;
    if (folder && !this.plugin.app.vault.getFolderByPath(folder)) {
      await this.plugin.app.vault.createFolder(folder);
    }
  }

  private reportError(context: string, err: unknown): void {
    if (err instanceof TasksScopeError) {
      if (!this.scopeErrorNotified) {
        this.scopeErrorNotified = true;
        new Notice(
          'Google Tasks: reconnect your Google account in plugin settings to enable Tasks sync.',
          0,
        );
      }
      console.error(`[TasksSyncEngine] ${context} (scope):`, err);
      return;
    }
    console.error(`[TasksSyncEngine] ${context}:`, err);
  }

  // ─── Full import ────────────────────────────────────────────────────────────

  /** Import (create/update) notes for every task in every synced list. */
  async importAllLists(): Promise<{ imported: number; updated: number }> {
    const lists = await this.api.listTaskLists();
    const synced = this.selectSyncedLists(lists);
    this.knownListIds = new Set(synced.map((l) => l.id));

    await this.ensureFolder();

    let imported = 0;
    let updated = 0;
    const cursorStart = new Date().toISOString();

    for (const list of synced) {
      // Pull everything (incl. completed + hidden) for the initial baseline.
      const tasks = await this.api.listTasks(list.id, {
        showCompleted: true,
        showHidden: true,
      });
      for (const task of tasks) {
        const result = await this.upsertTaskNote(task, list);
        if (result === 'created') imported++;
        else if (result === 'updated') updated++;
      }
      this.listCursors.set(list.id, cursorStart);
    }

    this.scopeErrorNotified = false; // recovered
    return { imported, updated };
  }

  // ─── Incremental poll ─────────────────────────────────────────────────────────

  async poll(): Promise<void> {
    if (!this.plugin.settings.enableTasksSync) return;

    let lists: GoogleTaskList[];
    try {
      lists = await this.api.listTaskLists();
    } catch (err) {
      this.reportError('Poll: listTaskLists failed', err);
      return;
    }

    const synced = this.selectSyncedLists(lists);
    const currentIds = new Set(synced.map((l) => l.id));

    // Detect whole-list deletion: a previously-synced list that vanished.
    for (const knownId of this.knownListIds) {
      if (!currentIds.has(knownId)) {
        console.warn(`[TasksSyncEngine] Tasks list ${knownId} no longer exists; stopping polling for it.`);
        this.listCursors.delete(knownId);
        new Notice('Google Tasks: a synced task list was removed in Google. Its notes were left untouched.');
      }
    }
    this.knownListIds = currentIds;

    const cursorStart = new Date().toISOString();

    for (const list of synced) {
      const updatedMin = this.listCursors.get(list.id);
      try {
        const tasks = await this.api.listTasks(list.id, {
          showCompleted: true,
          showHidden: true,
          showDeleted: true,
          updatedMin,
        });
        for (const task of tasks) {
          if (task.deleted) {
            await this.handleRemoteDelete(task.id);
          } else {
            await this.upsertTaskNote(task, list);
          }
        }
        this.listCursors.set(list.id, cursorStart);
      } catch (err) {
        this.reportError(`Poll: list ${list.title} failed`, err);
      }
    }

    // Push any notes the user created locally that aren't linked yet.
    await this.pushNewLocalNotes(synced);
  }

  // ─── Remote → local (create/update a note) ──────────────────────────────────

  /**
   * Create the note for a task, or reconcile an existing one.
   * Returns what happened so callers can count.
   */
  private async upsertTaskNote(
    task: GoogleTask,
    list: GoogleTaskList,
  ): Promise<'created' | 'updated' | 'unchanged'> {
    const existingPath = this.taskIdToPath.get(task.id) ?? this.findPathByTaskId(task.id);

    if (!existingPath) {
      return this.createTaskNote(task, list);
    }

    const file = this.plugin.app.vault.getAbstractFileByPath(existingPath);
    if (!(file instanceof TFile)) {
      // Stale mapping — recreate.
      this.forgetPath(existingPath);
      return this.createTaskNote(task, list);
    }

    return this.reconcileExisting(file, task, list);
  }

  private async createTaskNote(
    task: GoogleTask,
    list: GoogleTaskList,
  ): Promise<'created'> {
    await this.ensureFolder();

    const fields = taskToFields(task);
    const hash = await sha256(canonicalizeFields(fields));
    const { frontmatter, body } = taskToNote(task, list, hash);

    const path = await this.uniquePath(fields.title, task.id);
    const content = this.buildNoteContent(frontmatter, body);
    const file = await this.plugin.app.vault.create(path, content);

    this.remember(file.path, list.id, task.id, fields);
    return 'created';
  }

  private async reconcileExisting(
    file: TFile,
    task: GoogleTask,
    list: GoogleTaskList,
  ): Promise<'updated' | 'unchanged'> {
    const key = file.path;
    const existing = this.syncQueue.get(key);
    if (existing) {
      await existing;
      return 'unchanged';
    }

    const task$ = this._reconcileExisting(file, task, list);
    const wrapped = task$.then(() => undefined);
    this.syncQueue.set(key, wrapped);
    try {
      return await task$;
    } finally {
      this.syncQueue.delete(key);
    }
  }

  private async _reconcileExisting(
    file: TFile,
    task: GoogleTask,
    list: GoogleTaskList,
  ): Promise<'updated' | 'unchanged'> {
    const remoteFields = taskToFields(task);
    const remoteHash = await sha256(canonicalizeFields(remoteFields));

    const localFields = await this.readLocalFields(file);
    const localHash = await sha256(canonicalizeFields(localFields));

    const ref = this.taskRefs.get(file.path);
    const base = ref?.base ?? localFields; // no session base → treat local as base (remote wins on diffs)

    // Fast path: mutable fields identical on both sides → only sync metadata.
    if (localHash === remoteHash) {
      await this.writeFrontmatterMeta(file, task, list, remoteHash);
      this.remember(file.path, list.id, task.id, remoteFields);
      return 'unchanged';
    }

    // 3-way merge, field by field. Local wins on genuine conflicts.
    const { merged, conflicted } = mergeFields(base, localFields, remoteFields);
    const mergedHash = await sha256(canonicalizeFields(merged));

    // If the merge differs from remote, push the merged result back to Google.
    if (mergedHash !== remoteHash) {
      try {
        const updated = await this.api.patchTask(list.id, task.id, fieldsToWrite(merged));
        task = updated; // adopt server-canonical timestamps/position
      } catch (err) {
        this.reportError(`Push merged fields for "${merged.title}" failed`, err);
      }
    }

    // Write the merged result into the note (frontmatter + body).
    await this.writeMergedNote(file, task, list, merged, mergedHash);
    this.remember(file.path, list.id, task.id, merged);

    if (conflicted) {
      new Notice(`Google Tasks: merged concurrent edits to "${merged.title}" (local kept on conflict).`);
    }
    return 'updated';
  }

  // ─── Local → remote (push edits) ─────────────────────────────────────────────

  async syncLocalToRemote(file: TFile): Promise<void> {
    if (!this.plugin.settings.enableTasksSync) return;
    if (!this.isTaskFile(file)) return;

    const key = file.path;
    const existing = this.syncQueue.get(key);
    if (existing) return existing;

    const task = this._syncLocalToRemote(file);
    this.syncQueue.set(key, task);
    try {
      await task;
    } finally {
      this.syncQueue.delete(key);
    }
  }

  private async _syncLocalToRemote(file: TFile): Promise<void> {
    const cache = this.plugin.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter as TaskFrontmatter | undefined;
    const taskId = fm?.[FM.id] as string | undefined;
    const listId = fm?.[FM.listId] as string | undefined;

    const localFields = await this.readLocalFields(file, fm);
    const localHash = await sha256(canonicalizeFields(localFields));

    // New note the user authored in the tasks folder — create a real task.
    if (!taskId || !listId) {
      await this.createRemoteFromNote(file, localFields);
      return;
    }

    // Skip if the mutable fields are unchanged since the last sync.
    const storedHash = fm?.[FM.hash] as string | undefined;
    if (storedHash && storedHash === localHash) return;

    try {
      const updated = await this.api.patchTask(listId, taskId, fieldsToWrite(localFields));
      const newHash = await sha256(canonicalizeFields(taskToFields(updated)));
      await this.writeFrontmatterMeta(file, updated, undefined, newHash);
      this.remember(file.path, listId, taskId, taskToFields(updated));
    } catch (err) {
      this.reportError(`Push "${localFields.title}" failed`, err);
    }
  }

  private async createRemoteFromNote(file: TFile, localFields: TaskFields): Promise<void> {
    const targetListId = await this.defaultListId();
    if (!targetListId) {
      this.reportError('Create task from note', new Error('No synced task list available to create the task in.'));
      return;
    }

    // A brand-new note may have no title in frontmatter yet — use the filename.
    const fields: TaskFields = {
      ...localFields,
      title: localFields.title || file.basename,
    };

    try {
      const lists = await this.api.listTaskLists();
      const list = lists.find((l) => l.id === targetListId);
      const created = await this.api.insertTask(targetListId, fieldsToWrite(fields));
      const hash = await sha256(canonicalizeFields(taskToFields(created)));
      await this.writeFrontmatterMeta(
        file,
        created,
        list ?? { id: targetListId, title: '', updated: '' },
        hash,
      );
      this.remember(file.path, targetListId, created.id, taskToFields(created));
      new Notice(`Google Tasks: created "${fields.title}".`);
    } catch (err) {
      this.reportError(`Create task "${fields.title}" failed`, err);
    }
  }

  private async defaultListId(): Promise<string | undefined> {
    const chosen = this.plugin.settings.syncedTaskListIds;
    if (chosen && chosen.length > 0) return chosen[0];
    try {
      const lists = await this.api.listTaskLists();
      return lists[0]?.id;
    } catch {
      return undefined;
    }
  }

  private async pushNewLocalNotes(lists: GoogleTaskList[]): Promise<void> {
    if (lists.length === 0) return;
    const folder = this.tasksFolder;
    if (!folder) return;

    for (const file of this.plugin.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(folder + '/')) continue;
      const cache = this.plugin.app.metadataCache.getFileCache(file);
      const taskId = cache?.frontmatter?.[FM.id];
      if (taskId) continue; // already linked
      await this.syncLocalToRemote(file);
    }
  }

  // ─── Deletion ─────────────────────────────────────────────────────────────────

  /** Local note deleted → delete the corresponding task in Google. */
  private async handleDelete(path: string): Promise<void> {
    if (!this.plugin.settings.enableTasksSync) return;
    const ref = this.taskRefs.get(path);
    if (!ref) return; // not a tracked task note
    this.forgetPath(path);
    try {
      await this.api.deleteTask(ref.listId, ref.taskId);
    } catch (err) {
      this.reportError(`Delete task for ${path} failed`, err);
    }
  }

  /** Remote task deleted → soft-delete the note (never hard-delete from a remote signal). */
  private async handleRemoteDelete(taskId: string): Promise<void> {
    const path = this.taskIdToPath.get(taskId) ?? this.findPathByTaskId(taskId);
    if (!path) return;
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      this.forgetPath(path);
      return;
    }
    await this.plugin.app.fileManager.processFrontMatter(file, (front) => {
      front[FM.deleted] = true;
    });
    this.forgetPath(path); // stop tracking; note is kept but archived
  }

  private handleRename(oldPath: string, newPath: string): void {
    const ref = this.taskRefs.get(oldPath);
    if (!ref) return;
    this.taskRefs.delete(oldPath);
    this.taskRefs.set(newPath, ref);
    this.taskIdToPath.set(ref.taskId, newPath);
  }

  // ─── Note I/O helpers ───────────────────────────────────────────────────────

  private async readLocalFields(file: TFile, fmOverride?: TaskFrontmatter): Promise<TaskFields> {
    const raw = await this.plugin.app.vault.read(file);
    const body = stripFrontmatter(raw);
    const fm = fmOverride ?? (this.plugin.app.metadataCache.getFileCache(file)?.frontmatter as TaskFrontmatter | undefined);
    return noteToFields(fm, body);
  }

  private buildNoteContent(frontmatter: TaskFrontmatter, body: string): string {
    const lines = ['---'];
    for (const [key, value] of Object.entries(frontmatter)) {
      lines.push(`${key}: ${this.yamlScalar(value)}`);
    }
    lines.push('---', '');
    return lines.join('\n') + body;
  }

  private yamlScalar(value: unknown): string {
    if (typeof value === 'boolean' || typeof value === 'number') return String(value);
    const s = String(value ?? '');
    // Quote strings that could be misparsed (colons, leading special chars, empty).
    if (s === '' || /[:#\[\]{}&*!|>'"%@`]/.test(s) || /^[\s-]/.test(s)) {
      return JSON.stringify(s);
    }
    return s;
  }

  /** Update only the sync-metadata frontmatter fields (not the user-editable body). */
  private async writeFrontmatterMeta(
    file: TFile,
    task: GoogleTask,
    list: GoogleTaskList | undefined,
    hash: string,
  ): Promise<void> {
    await this.plugin.app.fileManager.processFrontMatter(file, (front) => {
      front[FM.id] = task.id;
      if (list) {
        front[FM.listId] = list.id;
        if (list.title) front[FM.listName] = list.title;
      }
      front[FM.title] = task.title ?? '';
      front[FM.completed] = task.status === 'completed';
      front[FM.position] = task.position ?? '';
      front[FM.updated] = task.updated;
      front[FM.hash] = hash;
      if (task.webViewLink) front[FM.url] = task.webViewLink;
      if (task.parent) front[FM.parentId] = task.parent;
      const due = taskToFields(task).due;
      if (due) front[FM.due] = due;
      else delete front[FM.due];
      if (front[FM.deleted] === undefined) front[FM.deleted] = false;
    });
  }

  /** Write merged fields to both frontmatter and body. */
  private async writeMergedNote(
    file: TFile,
    task: GoogleTask,
    list: GoogleTaskList,
    merged: TaskFields,
    hash: string,
  ): Promise<void> {
    // Body (task notes) first — a plain modify.
    const raw = await this.plugin.app.vault.read(file);
    const fmMatch = raw.match(/^(---\n[\s\S]*?\n---\n?)/);
    const frontmatterBlock = fmMatch ? fmMatch[1] : '';
    await this.plugin.app.vault.modify(file, frontmatterBlock + merged.notes);

    // Then the frontmatter fields via the safe processor.
    await this.plugin.app.fileManager.processFrontMatter(file, (front) => {
      front[FM.id] = task.id;
      front[FM.listId] = list.id;
      if (list.title) front[FM.listName] = list.title;
      front[FM.title] = merged.title;
      front[FM.completed] = merged.completed;
      front[FM.position] = task.position ?? '';
      front[FM.updated] = task.updated;
      front[FM.hash] = hash;
      if (task.webViewLink) front[FM.url] = task.webViewLink;
      if (task.parent) front[FM.parentId] = task.parent;
      if (merged.due) front[FM.due] = merged.due;
      else delete front[FM.due];
      if (front[FM.deleted] === undefined) front[FM.deleted] = false;
    });
  }

  // ─── Path / ref bookkeeping ─────────────────────────────────────────────────

  private async uniquePath(title: string, taskId: string): Promise<string> {
    const folder = this.tasksFolder;
    const base = sanitizeFilename(title);
    let candidate = `${folder}/${base}.md`;
    if (!this.plugin.app.vault.getAbstractFileByPath(candidate)) return candidate;
    // Collision — append an id-derived suffix (deterministic per task).
    candidate = `${folder}/${disambiguateFilename(base, taskId)}.md`;
    let n = 2;
    while (this.plugin.app.vault.getAbstractFileByPath(candidate)) {
      candidate = `${folder}/${disambiguateFilename(base, taskId)} ${n}.md`;
      n++;
    }
    return candidate;
  }

  private remember(path: string, listId: string, taskId: string, base: TaskFields): void {
    this.taskRefs.set(path, { listId, taskId, base });
    this.taskIdToPath.set(taskId, path);
  }

  private forgetPath(path: string): void {
    const ref = this.taskRefs.get(path);
    if (ref) this.taskIdToPath.delete(ref.taskId);
    this.taskRefs.delete(path);
  }

  /** Fallback lookup by scanning frontmatter when the in-memory map misses. */
  private findPathByTaskId(taskId: string): string | undefined {
    for (const file of this.plugin.app.vault.getMarkdownFiles()) {
      const cache = this.plugin.app.metadataCache.getFileCache(file);
      if (cache?.frontmatter?.[FM.id] === taskId) return file.path;
    }
    return undefined;
  }
}
