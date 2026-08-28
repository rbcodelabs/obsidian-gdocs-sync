import { TokenStore } from '../auth/TokenStore';
import { requestUrl } from 'obsidian';
import { headerRecord, isSuccessStatus, statusText } from './httpStatus';

// ─── Google Tasks API type definitions ───────────────────────────────────────
// @see https://developers.google.com/tasks/reference/rest

/** A Google Tasks list (a container of tasks). */
export interface GoogleTaskList {
  id: string;
  title: string;
  updated: string; // RFC 3339 timestamp
}

/**
 * A single Google Task.
 * Only the fields the plugin reads/writes are typed. `status` is the only
 * completion signal Google exposes: 'needsAction' | 'completed'.
 */
export interface GoogleTask {
  id: string;
  title: string;
  notes?: string;
  status: 'needsAction' | 'completed';
  due?: string; // RFC 3339 timestamp — Google stores date-only tasks at 00:00:00Z
  completed?: string; // RFC 3339 timestamp when completed
  updated: string; // RFC 3339 timestamp — bumps on any change (incl. reorder)
  position?: string; // lexicographic sort key within the list — read-only for us
  parent?: string; // parent task id for a subtask
  deleted?: boolean; // Google's soft-delete flag (returned when showDeleted=true)
  hidden?: boolean; // completed tasks are hidden by default in the Tasks UI
  selfLink?: string;
  webViewLink?: string;
}

/** Fields accepted when creating or patching a task. */
export interface TaskWriteFields {
  title?: string;
  notes?: string;
  status?: 'needsAction' | 'completed';
  due?: string;
  parent?: string;
}

export interface ListTasksOptions {
  showCompleted?: boolean;
  showHidden?: boolean;
  showDeleted?: boolean;
  updatedMin?: string; // RFC 3339 — only tasks modified since this time
  maxResults?: number;
}

/**
 * Thrown when a Tasks API call returns 403. The most common cause is a token
 * issued before the `tasks` scope was added — the user must reconnect. Callers
 * can branch on `instanceof TasksScopeError` to surface a reconnect prompt.
 */
export class TasksScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TasksScopeError';
  }
}

const TASKS_BASE = 'https://tasks.googleapis.com/tasks/v1';

// Retry tuning for HTTP 429 (rate limiting). tasks.googleapis.com enforces
// tight per-100-seconds burst quotas, so we back off exponentially rather than
// hammering. Base delay doubles each attempt: 500ms, 1000ms, 2000ms.
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

export class GoogleTasksAPI {
  constructor(
    private tokenStore: TokenStore,
    // Injectable sleep so tests don't wait on real timers during backoff.
    private sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  private async authHeaders(): Promise<HeadersInit> {
    const token = await this.tokenStore.getValidAccessToken();
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Perform an authenticated request with exponential backoff on HTTP 429.
   * A 403 is translated to TasksScopeError (usually a missing `tasks` scope).
   */
  private async request<T>(url: string, options: RequestInit = {}): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const headers = await this.authHeaders();
      const response = await requestUrl({
        url,
        method: options.method,
        body: options.body as string | ArrayBuffer | undefined,
        headers: { ...headerRecord(headers), ...headerRecord(options.headers) },
        throw: false,
      });

      if (response.status === 429) {
        // Rate limited — honour Retry-After if present, else exponential backoff.
        lastError = new Error('Google Tasks API rate limit (429)');
        if (attempt < MAX_RETRIES) {
          const retryAfterHeader = Object.entries(response.headers ?? {})
            .find(([name]) => name.toLowerCase() === 'retry-after')?.[1];
          const retryAfter = Number(retryAfterHeader);
          const delay = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : BASE_BACKOFF_MS * 2 ** attempt;
          await this.sleep(delay);
          continue;
        }
        throw lastError;
      }

      if (response.status === 403) {
        throw new TasksScopeError(
          `Google Tasks API returned 403 (Forbidden). Reconnect your Google ` +
            `account in plugin settings to grant Tasks access. Details: ${response.text}`,
        );
      }

      if (!isSuccessStatus(response.status)) {
        throw new Error(
          `Google Tasks API error ${response.status} ${statusText(response.status)}: ${response.text}`,
        );
      }

      // 204 No Content — e.g. DELETE — nothing to parse.
      if (response.status === 204) return undefined as unknown as T;
      return response.json as T;
    }

    // Exhausted retries (only reachable on repeated 429s).
    throw lastError ?? new Error('Google Tasks API request failed');
  }

  /** List all task lists for the authenticated user. */
  async listTaskLists(): Promise<GoogleTaskList[]> {
    const data = await this.request<{ items?: GoogleTaskList[] }>(
      `${TASKS_BASE}/users/@me/lists?maxResults=100`,
    );
    return data.items ?? [];
  }

  /**
   * List tasks in a list. By default returns incomplete tasks only (matching
   * Google's default); pass showCompleted/showHidden to include finished tasks,
   * and updatedMin for incremental polling.
   */
  async listTasks(
    listId: string,
    options: ListTasksOptions = {},
  ): Promise<GoogleTask[]> {
    const params = new URLSearchParams({ maxResults: String(options.maxResults ?? 100) });
    if (options.showCompleted !== undefined) params.set('showCompleted', String(options.showCompleted));
    if (options.showHidden !== undefined) params.set('showHidden', String(options.showHidden));
    if (options.showDeleted !== undefined) params.set('showDeleted', String(options.showDeleted));
    if (options.updatedMin) params.set('updatedMin', options.updatedMin);

    const items: GoogleTask[] = [];
    let pageToken: string | undefined;
    do {
      if (pageToken) params.set('pageToken', pageToken);
      const data = await this.request<{ items?: GoogleTask[]; nextPageToken?: string }>(
        `${TASKS_BASE}/lists/${encodeURIComponent(listId)}/tasks?${params.toString()}`,
      );
      if (data.items) items.push(...data.items);
      pageToken = data.nextPageToken;
    } while (pageToken);

    return items;
  }

  /** Create a new task in the given list. */
  async insertTask(listId: string, fields: TaskWriteFields): Promise<GoogleTask> {
    return this.request<GoogleTask>(
      `${TASKS_BASE}/lists/${encodeURIComponent(listId)}/tasks`,
      { method: 'POST', body: JSON.stringify(fields) },
    );
  }

  /** Patch (partial update) an existing task. */
  async patchTask(
    listId: string,
    taskId: string,
    fields: TaskWriteFields,
  ): Promise<GoogleTask> {
    return this.request<GoogleTask>(
      `${TASKS_BASE}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
      { method: 'PATCH', body: JSON.stringify(fields) },
    );
  }

  /** Permanently delete a task from a list. */
  async deleteTask(listId: string, taskId: string): Promise<void> {
    await this.request<void>(
      `${TASKS_BASE}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
      { method: 'DELETE' },
    );
  }
}
