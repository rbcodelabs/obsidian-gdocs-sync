import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleDocsAPI } from '../../src/api/GoogleDocsAPI';
import { requestUrl } from 'obsidian';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal GoogleDocsAPI instance with a stubbed token store. */
function makeApi(token = 'test-token'): GoogleDocsAPI {
  const tokenStore = { getValidAccessToken: vi.fn().mockResolvedValue(token) } as never;
  return new GoogleDocsAPI(tokenStore);
}

// ─── exportAsHtml ─────────────────────────────────────────────────────────────

describe('GoogleDocsAPI.exportAsHtml', () => {
  const requestUrlMock = vi.mocked(requestUrl);

  beforeEach(() => {
    requestUrlMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls the Drive export endpoint with the correct mimeType', async () => {
    requestUrlMock.mockResolvedValue({ status: 200, text: '<html><body><p>Hello</p></body></html>' } as never);

    const api = makeApi('my-token');
    await api.exportAsHtml('doc123');

    expect(requestUrlMock).toHaveBeenCalledOnce();
    const request = requestUrlMock.mock.calls[0][0] as Exclude<Parameters<typeof requestUrl>[0], string>;
    expect(request.url).toContain('/files/doc123/export');
    expect(request.url).toContain('mimeType=text%2Fhtml');
    expect(request.headers).toMatchObject({
      Authorization: 'Bearer my-token',
    });
    expect(request.throw).toBe(false);
  });

  it('returns the raw HTML string from the response body', async () => {
    const html = '<html><body><h1>My Doc</h1><p>Content</p></body></html>';
    requestUrlMock.mockResolvedValue({ status: 200, text: html } as never);

    const api = makeApi();
    const result = await api.exportAsHtml('docABC');

    expect(result).toBe(html);
  });

  it('throws a descriptive error on a non-ok response', async () => {
    requestUrlMock.mockResolvedValue({
      status: 403,
      text: '{"error":{"message":"Access denied."}}',
    } as never);

    const api = makeApi();
    await expect(api.exportAsHtml('docXYZ')).rejects.toThrow(
      /Google Drive export error 403.*Access denied/,
    );
  });

  it('throws when the token store rejects', async () => {
    const tokenStore = {
      getValidAccessToken: vi.fn().mockRejectedValue(new Error('No valid token')),
    } as never;
    const api = new GoogleDocsAPI(tokenStore);

    await expect(api.exportAsHtml('docXYZ')).rejects.toThrow('No valid token');
    expect(requestUrlMock).not.toHaveBeenCalled();
  });
});

describe('GoogleDocsAPI requests', () => {
  const requestUrlMock = vi.mocked(requestUrl);

  beforeEach(() => requestUrlMock.mockReset());

  it('uses requestUrl and returns its parsed JSON payload', async () => {
    const document = { documentId: 'doc1', title: 'Doc', body: { content: [] }, revisionId: 'r1' };
    requestUrlMock.mockResolvedValue({ status: 200, json: document, text: JSON.stringify(document) } as never);

    await expect(makeApi().getDocument('doc1')).resolves.toEqual(document);
    expect(requestUrlMock).toHaveBeenCalledWith(expect.objectContaining({
      url: expect.stringContaining('/documents/doc1'),
      throw: false,
    }));
  });

  it('preserves descriptive non-2xx errors', async () => {
    requestUrlMock.mockResolvedValue({ status: 500, text: 'boom' } as never);
    await expect(makeApi().getDocument('doc1')).rejects.toThrow(
      'Google API error 500 Internal Server Error: boom',
    );
  });
});

// ─── parseFolderId ────────────────────────────────────────────────────────────

describe('GoogleDocsAPI.parseFolderId', () => {
  it('extracts the folder ID from a standard Drive folder URL', () => {
    expect(GoogleDocsAPI.parseFolderId(
      'https://drive.google.com/drive/folders/1DcDs5ru25OpBoJFOdEPFbgLgj4IxdI_q',
    )).toBe('1DcDs5ru25OpBoJFOdEPFbgLgj4IxdI_q');
  });

  it('extracts the folder ID from a URL with a user index (u/0)', () => {
    expect(GoogleDocsAPI.parseFolderId(
      'https://drive.google.com/drive/u/0/folders/1DcDs5ru25OpBoJFOdEPFbgLgj4IxdI_q',
    )).toBe('1DcDs5ru25OpBoJFOdEPFbgLgj4IxdI_q');
  });

  it('returns a raw ID as-is when no URL structure is present', () => {
    expect(GoogleDocsAPI.parseFolderId('1DcDs5ru25OpBoJFOdEPFbgLgj4IxdI_q'))
      .toBe('1DcDs5ru25OpBoJFOdEPFbgLgj4IxdI_q');
  });

  it('trims whitespace from a raw ID', () => {
    expect(GoogleDocsAPI.parseFolderId('  abc123  ')).toBe('abc123');
  });

  it('handles IDs with hyphens and underscores', () => {
    expect(GoogleDocsAPI.parseFolderId(
      'https://drive.google.com/drive/folders/abc-123_XYZ',
    )).toBe('abc-123_XYZ');
  });
});
