import type { App, TFile } from 'obsidian';
import { FM, sanitizeFilename, disambiguateFilename } from '../converter/TaskNoteMapper';

/**
 * Writes made from the Tasks view. Everything goes through
 * `fileManager.processFrontMatter`, so the existing FileWatcher (2s debounce)
 * and TasksSyncEngine push the change to Google — nothing here talks to the API.
 *
 * Push-loop safety: a UI edit changes the mutable fields, so the engine's hash
 * check fails once and it PATCHes; its write-back stores the new hash, so the
 * follow-up `modify` event it triggers compares equal and is skipped.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export interface QuickAddInput {
  title: string;
  listId: string;
  listName: string;
  /** Date-only 'YYYY-MM-DD'. */
  due?: string;
}

type EditorView = { file?: { path: string } | null; save?: () => Promise<void> };

export class TaskActions {
  constructor(
    private app: App,
    private getFolder: () => string,
  ) {}

  setCompleted(path: string, completed: boolean): Promise<void> {
    return this.write(path, (fm) => { fm[FM.completed] = completed; });
  }

  /** `null` clears the due date. */
  setDue(path: string, due: string | null): Promise<void> {
    if (due !== null && !DATE_ONLY.test(due)) {
      return Promise.reject(new Error('Due date must be YYYY-MM-DD.'));
    }
    return this.write(path, (fm) => {
      if (due) fm[FM.due] = due;
      else delete fm[FM.due];
    });
  }

  /** Blank titles are ignored — a task with no title is not valid in Google. */
  async rename(path: string, title: string): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed) return;
    await this.write(path, (fm) => { fm[FM.title] = trimmed; });
  }

  /**
   * Create a new task note. The sync engine sees a note with no `gtasks_id`
   * and inserts it into Google on the next poll or debounced modify.
   * NOTE: the engine currently creates such tasks in the first synced list, so
   * `listId` is carried as frontmatter but is not guaranteed to be honoured.
   */
  async quickAdd(input: QuickAddInput): Promise<string> {
    const title = input.title.trim();
    if (!title) throw new Error('A task needs a title.');
    const folder = this.getFolder().replace(/\/+$/, '');
    if (!folder) throw new Error('Tasks folder is not configured.');

    if (!this.app.vault.getFolderByPath(folder)) {
      await this.app.vault.createFolder(folder);
    }

    const path = this.freePath(folder, title);
    const lines = ['---'];
    // No list known yet (nothing synced) — leave it out and let the engine pick its default.
    if (input.listId) {
      lines.push(`${FM.listId}: ${JSON.stringify(input.listId)}`);
      lines.push(`${FM.listName}: ${JSON.stringify(input.listName)}`);
    }
    lines.push(`${FM.title}: ${JSON.stringify(title)}`, `${FM.completed}: false`);
    if (input.due) lines.push(`${FM.due}: ${JSON.stringify(input.due)}`);
    lines.push('---', '');
    // JSON strings are valid YAML double-quoted scalars, so no escaping rules to drift.
    await this.app.vault.create(path, lines.join('\n'));
    return path;
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  private freePath(folder: string, title: string): string {
    const base = sanitizeFilename(title);
    const exists = (p: string) => this.app.vault.getAbstractFileByPath(p) !== null;
    let candidate = `${folder}/${base}.md`;
    if (!exists(candidate)) return candidate;
    // Collision — same id-suffix scheme the sync engine uses, with a local nonce
    // since the Google id does not exist yet.
    const nonce = Date.now().toString(36);
    candidate = `${folder}/${disambiguateFilename(base, nonce)}.md`;
    let n = 2;
    while (exists(candidate)) {
      candidate = `${folder}/${disambiguateFilename(base, nonce)} ${n}.md`;
      n++;
    }
    return candidate;
  }

  private async write(path: string, mutate: (fm: Record<string, unknown>) => void): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || !('extension' in file)) throw new Error(`Task note not found: ${path}`);
    await this.flushOpenEditors(path);
    await this.app.fileManager.processFrontMatter(file as TFile, mutate);
  }

  /**
   * processFrontMatter rewrites the file on disk and (on Geode) does not protect
   * a note that is open in an editor with unsaved edits — a later editor save
   * could clobber the change. Flush any editor open on this note first; if it
   * cannot be saved, abort the write rather than risk losing either side.
   */
  private async flushOpenEditors(path: string): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view as unknown as EditorView;
      if (view.file?.path !== path || typeof view.save !== 'function') continue;
      try {
        await view.save();
      } catch (err) {
        throw new Error(`Could not save unsaved edits in "${path}" first: ${(err as Error).message}`);
      }
    }
  }
}
