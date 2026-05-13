import { describe, it, expect } from 'vitest';
import { GoogleDocsAPI } from '../../src/api/GoogleDocsAPI';

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
