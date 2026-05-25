import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleDocsAPI } from '../../src/api/GoogleDocsAPI';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal GoogleDocsAPI instance with a stubbed token store. */
function makeApi(token = 'test-token'): GoogleDocsAPI {
  const tokenStore = { getValidAccessToken: vi.fn().mockResolvedValue(token) } as never;
  return new GoogleDocsAPI(tokenStore);
}

// ─── exportAsHtml ─────────────────────────────────────────────────────────────

describe('GoogleDocsAPI.exportAsHtml', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls the Drive export endpoint with the correct mimeType', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => '<html><body><p>Hello</p></body></html>',
    });

    const api = makeApi('my-token');
    await api.exportAsHtml('doc123');

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toContain('/files/doc123/export');
    expect(url).toContain('mimeType=text%2Fhtml');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer my-token',
    });
  });

  it('returns the raw HTML string from the response body', async () => {
    const html = '<html><body><h1>My Doc</h1><p>Content</p></body></html>';
    fetchSpy.mockResolvedValue({ ok: true, text: async () => html });

    const api = makeApi();
    const result = await api.exportAsHtml('docABC');

    expect(result).toBe(html);
  });

  it('throws a descriptive error on a non-ok response', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => '{"error":{"message":"Access denied."}}',
    });

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
    expect(fetchSpy).not.toHaveBeenCalled();
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
