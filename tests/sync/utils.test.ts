import { describe, it, expect } from 'vitest';
import { stripFrontmatter, parseDocId } from '../../src/sync/SyncEngine';

describe('stripFrontmatter', () => {
  it('strips YAML frontmatter block', () => {
    const input = '---\ntitle: My Note\ntags: [foo]\n---\nHello world';
    expect(stripFrontmatter(input)).toBe('Hello world');
  });

  it('returns the full string when no frontmatter is present', () => {
    expect(stripFrontmatter('Just a normal note')).toBe('Just a normal note');
  });

  it('handles frontmatter with a blank line after the closing ---', () => {
    const input = '---\ngdocs-id: abc\n---\n\nBody text here';
    expect(stripFrontmatter(input)).toBe('Body text here');
  });

  it('returns empty string when note body is empty after frontmatter', () => {
    const input = '---\ntitle: Empty\n---\n';
    expect(stripFrontmatter(input)).toBe('');
  });

  it('does not strip a --- that appears mid-document', () => {
    const input = 'Some text\n---\nMore text';
    expect(stripFrontmatter(input)).toBe('Some text\n---\nMore text');
  });
});

describe('parseDocId', () => {
  it('extracts the document ID from a full Google Docs URL', () => {
    expect(parseDocId(
      'https://docs.google.com/document/d/1UQ9DeAID5wsCzDRlnZOpOliHU2aAnUB4fbsZ8n2Zd20/edit',
    )).toBe('1UQ9DeAID5wsCzDRlnZOpOliHU2aAnUB4fbsZ8n2Zd20');
  });

  it('extracts the document ID from a URL with extra query params', () => {
    expect(parseDocId(
      'https://docs.google.com/document/d/abc123XYZ/edit?usp=sharing',
    )).toBe('abc123XYZ');
  });

  it('returns a raw document ID as-is', () => {
    expect(parseDocId('1UQ9DeAID5wsCzDRlnZOpOliHU2aAnUB4fbsZ8n2Zd20'))
      .toBe('1UQ9DeAID5wsCzDRlnZOpOliHU2aAnUB4fbsZ8n2Zd20');
  });

  it('trims whitespace from a raw ID', () => {
    expect(parseDocId('  abc123  ')).toBe('abc123');
  });

  it('handles IDs with hyphens and underscores', () => {
    expect(parseDocId(
      'https://docs.google.com/document/d/abc-123_XYZ/edit',
    )).toBe('abc-123_XYZ');
  });
});
