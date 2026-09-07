import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from 'obsidian';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
export const MAX_BLOB_SIZE = 100 * 1024 * 1024;

export interface DriveAuth {
  assertCurrent(): void;
  getAccessToken(): Promise<string>;
  refreshAccessToken(): Promise<string>;
}
export interface ImmutableMetadata {
  name: string;
  mimeType: string;
  parents?: string[];
  appProperties: Record<string, string>;
}
export interface ReservedObject {
  id: string;
  identity: string;
  verifiedVersion?: string;
  sessionSecretKey?: string;
}
export interface DriveJournal {
  load(): Promise<Record<string, ReservedObject>>;
  save(entries: Record<string, ReservedObject>): Promise<void>;
}
export interface ImmutableCreate {
  operationKey: string;
  metadata: ImmutableMetadata;
  data: ArrayBuffer;
  sha256: string;
}
export interface DriveClientOptions {
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  sessions?: { load(key: string): Promise<string | null>; save(key: string, value: string): Promise<void>; remove(key: string): Promise<void> };
}
export class ImmutableDriveClient {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private auth: DriveAuth, private journal: DriveJournal, private options: DriveClientOptions = {}) {}

  async create(input: ImmutableCreate, signal: AbortSignal): Promise<string> {
    this.auth.assertCurrent();
    signal.throwIfAborted();
    if (input.data.byteLength > MAX_BLOB_SIZE) throw new Error('File exceeds the 100 MiB limit');
    if (await sha256Bytes(input.data) !== input.sha256) throw new Error('Input content hash mismatch');
    const identity = canonicalJson({ metadata: input.metadata, sha256: input.sha256, size: input.data.byteLength });
    const reserved: ReservedObject = await this.serial(async () => {
      const entries = await this.journal.load();
      this.auth.assertCurrent(); signal.throwIfAborted();
      const prior = entries[input.operationKey];
      if (prior) {
        if (prior.identity !== identity) throw new Error('Operation key reused for different immutable content');
        return prior;
      }
      const response = await this.request({ url: `${DRIVE}/files/generateIds?count=1&space=drive&type=files` }, signal);
      const id = response.json?.ids?.[0];
      if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) throw new Error('Drive returned an invalid generated ID');
      const entry = { id, identity };
      this.auth.assertCurrent(); signal.throwIfAborted();
      await this.journal.save({ ...entries, [input.operationKey]: entry });
      return entry;
    });
    signal.throwIfAborted();
    if (reserved.verifiedVersion) {
      await this.verify(reserved.id, input, signal, reserved.verifiedVersion);
      return reserved.id;
    }
    if (input.data.byteLength > 5 * 1024 * 1024) await this.uploadResumable(input, reserved, signal);
    else await this.uploadMultipart(input, reserved.id, signal);
    const verifiedVersion = await this.verify(reserved.id, input, signal);
    await this.serial(async () => {
      const entries = await this.journal.load();
      this.auth.assertCurrent(); signal.throwIfAborted();
      await this.journal.save({ ...entries, [input.operationKey]: { id: reserved.id, identity: reserved.identity, verifiedVersion } });
    });
    if (reserved.sessionSecretKey) await this.options.sessions?.remove(reserved.sessionSecretKey);
    return reserved.id;
  }

  private async uploadMultipart(input: ImmutableCreate, id: string, signal: AbortSignal): Promise<void> {
    const boundary = `geode_${crypto.randomUUID()}`;
    const body = concatenate([
      new TextEncoder().encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ id, ...input.metadata })}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
      new Uint8Array(input.data),
      new TextEncoder().encode(`\r\n--${boundary}--\r\n`),
    ]);
    await this.request({ url: `${UPLOAD}/files?uploadType=multipart&fields=id`, method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body }, signal, [409]);
  }

  private async uploadResumable(input: ImmutableCreate, reserved: ReservedObject, signal: AbortSignal): Promise<void> {
    const sessions = this.options.sessions;
    if (!sessions) throw new Error('Secure upload-session storage is required for large files');
    const size = input.data.byteLength;
    let url = reserved.sessionSecretKey ? await sessions.load(reserved.sessionSecretKey) : null;
    let offset = 0;
    if (url) {
      validateSessionUrl(url);
      const state = await this.request({ url, method: 'PUT', headers: { 'Content-Range': `bytes */${size}` }, body: new ArrayBuffer(0) }, signal, [308, 404]);
      if (state.status === 200 || state.status === 201) return;
      if (state.status === 404) url = null;
      else offset = resumeOffset(state, size);
    }
    if (!url) {
      const started = await this.request({ url: `${UPLOAD}/files?uploadType=resumable&fields=id`, method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Type': input.metadata.mimeType, 'X-Upload-Content-Length': String(size) }, body: JSON.stringify({ id: reserved.id, ...input.metadata }) }, signal, [409]);
      if (started.status === 409) return;
      url = started.headers.location;
      validateSessionUrl(url);
      const secretKey = `drive-upload-${reserved.id}`;
      await sessions.save(secretKey, url);
      this.auth.assertCurrent(); signal.throwIfAborted();
      reserved.sessionSecretKey = secretKey;
      await this.serial(async () => {
        const entries = await this.journal.load();
        this.auth.assertCurrent(); signal.throwIfAborted();
        await this.journal.save({ ...entries, [input.operationKey]: { ...reserved } });
      });
    }
    let recoveries = 0;
    while (offset < size) {
      signal.throwIfAborted();
      const end = Math.min(size, offset + 4 * 1024 * 1024);
      let response: RequestUrlResponse;
      try {
        response = await this.request({ url, method: 'PUT', headers: { 'Content-Range': `bytes ${offset}-${end - 1}/${size}`, 'Content-Type': input.metadata.mimeType }, body: input.data.slice(offset, end) }, signal, [308], false);
      } catch {
        signal.throwIfAborted();
        if (++recoveries > 3) throw new Error('Resumable upload interrupted; retry the same operation');
        await this.backoff(recoveries - 1, signal);
        response = await this.request({ url, method: 'PUT', headers: { 'Content-Range': `bytes */${size}` }, body: new ArrayBuffer(0) }, signal, [308]);
      }
      if (response.status === 200 || response.status === 201) return;
      const next = resumeOffset(response, size);
      if (next < offset || next > end) throw new Error('Invalid resumable upload range');
      if (next === offset && ++recoveries > 3) throw new Error('Resumable upload made no progress');
      offset = next;
    }
    throw new Error('Resumable upload did not confirm completion');
  }

  async verify(id: string, expected: Omit<ImmutableCreate, 'operationKey'>, signal: AbortSignal, expectedVersion?: string): Promise<string> {
    const response = await this.request({ url: `${DRIVE}/files/${encodeURIComponent(id)}?fields=id,name,mimeType,parents,appProperties,size,trashed,version` }, signal);
    const actual = response.json;
    if (!actual || typeof actual.version !== 'string' || (expectedVersion && actual.version !== expectedVersion) || actual.id !== id || actual.trashed || actual.name !== expected.metadata.name || actual.mimeType !== expected.metadata.mimeType ||
      canonicalJson(actual.parents ?? []) !== canonicalJson(expected.metadata.parents ?? []) ||
      canonicalJson(actual.appProperties ?? {}) !== canonicalJson(expected.metadata.appProperties) || Number(actual.size) !== expected.data.byteLength) {
      throw new Error('Immutable object integrity failure: metadata mismatch');
    }
    const bytes = (await this.request({ url: `${DRIVE}/files/${encodeURIComponent(id)}?alt=media` }, signal)).arrayBuffer;
    if (bytes.byteLength !== expected.data.byteLength || await sha256Bytes(bytes) !== expected.sha256) throw new Error('Immutable object integrity failure: content mismatch');
    return actual.version;
  }

  async request(params: RequestUrlParam, signal: AbortSignal, accepted: number[] = [], retry = true): Promise<RequestUrlResponse> {
    this.auth.assertCurrent();
    signal.throwIfAborted();
    let token = await this.auth.getAccessToken();
    this.auth.assertCurrent();
    let refreshed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      this.auth.assertCurrent();
      signal.throwIfAborted();
      let response: RequestUrlResponse;
      try {
        // signal is a Geode extension; the provider is only loaded on that host.
        const request: RequestUrlParam & { signal: AbortSignal } = { ...params, headers: { ...params.headers, Authorization: `Bearer ${token}` }, throw: false, signal };
        response = await requestUrl(request);
      } catch {
        this.auth.assertCurrent();
        signal.throwIfAborted();
        if (!retry || attempt === 3) throw new Error('Drive request interrupted; remote commit is unknown. Retry the same operation.');
        await this.backoff(attempt, signal);
        continue;
      }
      signal.throwIfAborted();
      this.auth.assertCurrent();
      if ((response.status >= 200 && response.status < 300) || accepted.includes(response.status)) return response;
      if (response.status === 401 && !refreshed) {
        token = await this.auth.refreshAccessToken();
        this.auth.assertCurrent();
        refreshed = true;
        continue;
      }
      const reason = (() => { try { return response.json?.error?.errors?.[0]?.reason; } catch { return undefined; } })();
      if (retry && (response.status === 429 || response.status >= 500 || (response.status === 403 && ['rateLimitExceeded', 'userRateLimitExceeded'].includes(reason))) && attempt < 3) {
        await this.backoff(attempt, signal, response.headers['retry-after']);
        continue;
      }
      throw new Error(`Drive request failed (${response.status}); ${response.status === 401 ? 'reconnect your Google account' : response.status === 403 ? 'check account permissions or quota' : 'retry when service is available'}`);
    }
    throw new Error('Drive retry limit reached');
  }

  private async backoff(attempt: number, signal: AbortSignal, retryAfter?: string): Promise<void> {
    const retryMs = retryAfter ? (/^\d+(\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now())) : 0;
    const ms = Math.max(Number.isFinite(retryMs) ? retryMs : 0, Math.min(30_000, 1000 * 2 ** attempt) + Math.floor((this.options.random ?? Math.random)() * 1000));
    if (this.options.sleep) return this.options.sleep(ms, signal);
    await new Promise<void>((resolve, reject) => {
      signal.throwIfAborted();
      const abort = () => { clearTimeout(timer); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

export async function sha256Bytes(bytes: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

function concatenate(parts: Uint8Array[]): ArrayBuffer {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result.buffer;
}

function validateSessionUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid resumable upload endpoint'); }
  if (url.origin !== 'https://www.googleapis.com' || url.pathname !== '/upload/drive/v3/files' || url.username || url.password || !url.searchParams.get('upload_id')) throw new Error('Invalid resumable upload endpoint');
}

function resumeOffset(response: RequestUrlResponse, size: number): number {
  const range = response.headers.range;
  if (!range) return 0;
  const match = /^bytes=0-(\d+)$/.exec(range);
  const offset = match ? Number(match[1]) + 1 : NaN;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) throw new Error('Invalid resumable upload range');
  return offset;
}
