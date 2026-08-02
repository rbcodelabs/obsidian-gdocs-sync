import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleTasksAPI, TasksScopeError } from '../../src/api/GoogleTasksAPI';

/** Build an API instance with a stubbed token store and an instant sleep. */
function makeApi(token = 'test-token') {
  const tokenStore = { getValidAccessToken: vi.fn().mockResolvedValue(token) } as never;
  const sleep = vi.fn().mockResolvedValue(undefined);
  const api = new GoogleTasksAPI(tokenStore, sleep);
  return { api, sleep };
}

function jsonResponse(body: unknown, init: Partial<Response> = {}) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
    ...init,
  };
}

describe('GoogleTasksAPI', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('listTaskLists returns items and hits the lists endpoint with auth', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ items: [{ id: 'L1', title: 'Personal', updated: 't' }] }));
    const { api } = makeApi('tok');

    const lists = await api.listTaskLists();

    expect(lists).toEqual([{ id: 'L1', title: 'Personal', updated: 't' }]);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toContain('/users/@me/lists');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
  });

  it('listTaskLists returns [] when the response has no items', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({}));
    const { api } = makeApi();
    expect(await api.listTaskLists()).toEqual([]);
  });

  it('listTasks passes through query options and follows pagination', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'T1' }], nextPageToken: 'p2' }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'T2' }] }));

    const { api } = makeApi();
    const tasks = await api.listTasks('L1', {
      showCompleted: true,
      showHidden: true,
      showDeleted: true,
      updatedMin: '2026-01-01T00:00:00Z',
    });

    expect(tasks.map((t) => t.id)).toEqual(['T1', 'T2']);
    const firstUrl = fetchSpy.mock.calls[0][0] as string;
    expect(firstUrl).toContain('/lists/L1/tasks');
    expect(firstUrl).toContain('showCompleted=true');
    expect(firstUrl).toContain('showHidden=true');
    expect(firstUrl).toContain('showDeleted=true');
    expect(firstUrl).toContain('updatedMin=2026-01-01T00%3A00%3A00Z');
    // Second page requested with the token
    expect(fetchSpy.mock.calls[1][0]).toContain('pageToken=p2');
  });

  it('insertTask POSTs the write fields to the list', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ id: 'newT', title: 'Hi', status: 'needsAction', updated: 't' }));
    const { api } = makeApi();

    const created = await api.insertTask('L1', { title: 'Hi' });

    expect(created.id).toBe('newT');
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toContain('/lists/L1/tasks');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ title: 'Hi' });
  });

  it('patchTask PATCHes the specific task', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ id: 'T1', title: 'Updated', status: 'completed', updated: 't' }));
    const { api } = makeApi();

    await api.patchTask('L1', 'T1', { status: 'completed' });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toContain('/lists/L1/tasks/T1');
    expect((init as RequestInit).method).toBe('PATCH');
  });

  it('deleteTask DELETEs and tolerates a 204 No Content', async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 204, headers: { get: () => null } });
    const { api } = makeApi();

    await expect(api.deleteTask('L1', 'T1')).resolves.toBeUndefined();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toContain('/lists/L1/tasks/T1');
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('retries on HTTP 429 with backoff, then succeeds', async () => {
    fetchSpy
      .mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => null }, text: async () => 'rate' })
      .mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => null }, text: async () => 'rate' })
      .mockResolvedValueOnce(jsonResponse({ items: [] }));

    const { api, sleep } = makeApi();
    const result = await api.listTaskLists();

    expect(result).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    // Two backoff sleeps before the successful third attempt.
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 500); // BASE_BACKOFF * 2^0
    expect(sleep).toHaveBeenNthCalledWith(2, 1000); // BASE_BACKOFF * 2^1
  });

  it('honours Retry-After header on 429', async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: (h: string) => (h === 'Retry-After' ? '3' : null) },
        text: async () => 'rate',
      })
      .mockResolvedValueOnce(jsonResponse({ items: [] }));

    const { api, sleep } = makeApi();
    await api.listTaskLists();

    expect(sleep).toHaveBeenCalledWith(3000); // 3 seconds from Retry-After
  });

  it('throws after exhausting 429 retries', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 429, headers: { get: () => null }, text: async () => 'rate' });
    const { api } = makeApi();

    await expect(api.listTaskLists()).rejects.toThrow(/rate limit/i);
    expect(fetchSpy).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  it('maps HTTP 403 to a TasksScopeError prompting reconnect', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      headers: { get: () => null },
      text: async () => 'insufficient scope',
    });
    const { api } = makeApi();

    await expect(api.listTaskLists()).rejects.toBeInstanceOf(TasksScopeError);
    await expect(api.listTaskLists()).rejects.toThrow(/reconnect/i);
  });

  it('throws a descriptive error on other non-ok responses', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      headers: { get: () => null },
      text: async () => 'boom',
    });
    const { api } = makeApi();

    await expect(api.listTaskLists()).rejects.toThrow(/Google Tasks API error 500.*boom/);
  });
});
