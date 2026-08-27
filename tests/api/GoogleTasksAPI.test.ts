import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleTasksAPI, TasksScopeError } from '../../src/api/GoogleTasksAPI';
import { requestUrl } from 'obsidian';

/** Build an API instance with a stubbed token store and an instant sleep. */
function makeApi(token = 'test-token') {
  const tokenStore = { getValidAccessToken: vi.fn().mockResolvedValue(token) } as never;
  const sleep = vi.fn().mockResolvedValue(undefined);
  const api = new GoogleTasksAPI(tokenStore, sleep);
  return { api, sleep };
}

function jsonResponse(body: unknown, init: Record<string, unknown> = {}) {
  return {
    status: 200,
    headers: {},
    json: body,
    text: JSON.stringify(body),
    ...init,
  };
}

describe('GoogleTasksAPI', () => {
  const requestUrlMock = vi.mocked(requestUrl);

  beforeEach(() => {
    requestUrlMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('listTaskLists returns items and hits the lists endpoint with auth', async () => {
    requestUrlMock.mockResolvedValue(jsonResponse({ items: [{ id: 'L1', title: 'Personal', updated: 't' }] }) as never);
    const { api } = makeApi('tok');

    const lists = await api.listTaskLists();

    expect(lists).toEqual([{ id: 'L1', title: 'Personal', updated: 't' }]);
    const request = requestUrlMock.mock.calls[0][0] as Exclude<Parameters<typeof requestUrl>[0], string>;
    expect(request.url).toContain('/users/@me/lists');
    expect(request.headers).toMatchObject({ Authorization: 'Bearer tok' });
    expect(request.throw).toBe(false);
  });

  it('listTaskLists returns [] when the response has no items', async () => {
    requestUrlMock.mockResolvedValue(jsonResponse({}) as never);
    const { api } = makeApi();
    expect(await api.listTaskLists()).toEqual([]);
  });

  it('listTasks passes through query options and follows pagination', async () => {
    requestUrlMock
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
    const firstUrl = (requestUrlMock.mock.calls[0][0] as { url: string }).url;
    expect(firstUrl).toContain('/lists/L1/tasks');
    expect(firstUrl).toContain('showCompleted=true');
    expect(firstUrl).toContain('showHidden=true');
    expect(firstUrl).toContain('showDeleted=true');
    expect(firstUrl).toContain('updatedMin=2026-01-01T00%3A00%3A00Z');
    // Second page requested with the token
    expect((requestUrlMock.mock.calls[1][0] as { url: string }).url).toContain('pageToken=p2');
  });

  it('insertTask POSTs the write fields to the list', async () => {
    requestUrlMock.mockResolvedValue(jsonResponse({ id: 'newT', title: 'Hi', status: 'needsAction', updated: 't' }) as never);
    const { api } = makeApi();

    const created = await api.insertTask('L1', { title: 'Hi' });

    expect(created.id).toBe('newT');
    const request = requestUrlMock.mock.calls[0][0] as { url: string; method?: string; body?: string };
    expect(request.url).toContain('/lists/L1/tasks');
    expect(request.method).toBe('POST');
    expect(JSON.parse(request.body as string)).toEqual({ title: 'Hi' });
  });

  it('patchTask PATCHes the specific task', async () => {
    requestUrlMock.mockResolvedValue(jsonResponse({ id: 'T1', title: 'Updated', status: 'completed', updated: 't' }) as never);
    const { api } = makeApi();

    await api.patchTask('L1', 'T1', { status: 'completed' });

    const request = requestUrlMock.mock.calls[0][0] as { url: string; method?: string };
    expect(request.url).toContain('/lists/L1/tasks/T1');
    expect(request.method).toBe('PATCH');
  });

  it('deleteTask DELETEs and tolerates a 204 No Content', async () => {
    requestUrlMock.mockResolvedValue({ status: 204, headers: {} } as never);
    const { api } = makeApi();

    await expect(api.deleteTask('L1', 'T1')).resolves.toBeUndefined();
    const request = requestUrlMock.mock.calls[0][0] as { url: string; method?: string };
    expect(request.url).toContain('/lists/L1/tasks/T1');
    expect(request.method).toBe('DELETE');
  });

  it('retries on HTTP 429 with backoff, then succeeds', async () => {
    requestUrlMock
      .mockResolvedValueOnce({ status: 429, headers: {}, text: 'rate' } as never)
      .mockResolvedValueOnce({ status: 429, headers: {}, text: 'rate' } as never)
      .mockResolvedValueOnce(jsonResponse({ items: [] }));

    const { api, sleep } = makeApi();
    const result = await api.listTaskLists();

    expect(result).toEqual([]);
    expect(requestUrlMock).toHaveBeenCalledTimes(3);
    // Two backoff sleeps before the successful third attempt.
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 500); // BASE_BACKOFF * 2^0
    expect(sleep).toHaveBeenNthCalledWith(2, 1000); // BASE_BACKOFF * 2^1
  });

  it('honours Retry-After header on 429', async () => {
    requestUrlMock
      .mockResolvedValueOnce({
        status: 429,
        headers: { 'retry-after': '3' },
        text: 'rate',
      } as never)
      .mockResolvedValueOnce(jsonResponse({ items: [] }));

    const { api, sleep } = makeApi();
    await api.listTaskLists();

    expect(sleep).toHaveBeenCalledWith(3000); // 3 seconds from Retry-After
  });

  it('throws after exhausting 429 retries', async () => {
    requestUrlMock.mockResolvedValue({ status: 429, headers: {}, text: 'rate' } as never);
    const { api } = makeApi();

    await expect(api.listTaskLists()).rejects.toThrow(/rate limit/i);
    expect(requestUrlMock).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  it('maps HTTP 403 to a TasksScopeError prompting reconnect', async () => {
    requestUrlMock.mockResolvedValue({
      status: 403,
      headers: {},
      text: 'insufficient scope',
    } as never);
    const { api } = makeApi();

    await expect(api.listTaskLists()).rejects.toBeInstanceOf(TasksScopeError);
    await expect(api.listTaskLists()).rejects.toThrow(/reconnect/i);
  });

  it('throws a descriptive error on other non-ok responses', async () => {
    requestUrlMock.mockResolvedValue({
      status: 500,
      headers: {},
      text: 'boom',
    } as never);
    const { api } = makeApi();

    await expect(api.listTaskLists()).rejects.toThrow('Google Tasks API error 500 Internal Server Error: boom');
  });
});
