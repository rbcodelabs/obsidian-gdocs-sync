import { describe, expect, it } from 'vitest';
import { managedPathExclusion } from '../../src/sync/managedPathExclusion';
import { DEFAULT_SETTINGS } from '../../src/types';

const note = (frontmatter: unknown) => new TextEncoder().encode(`---\n${JSON.stringify(frontmatter)}\n---\nSynthetic note`).buffer;
describe('existing Docs and Tasks ownership exclusion', () => {
  const settings = { ...DEFAULT_SETTINGS, syncFolders: ['Docs/'], folderMappings: [{ driveFolderId: 'synthetic', driveFolderName: 'Synthetic', obsidianFolder: 'Imported' }] };
  it.each(['Docs', 'Docs/new.md', 'Docs/attachment.png', 'Imported/new.md', 'Google Tasks/new.md'])('excludes managed folder path %s before first linking', path => {
    expect(managedPathExclusion(path, undefined, settings, JSON.parse)).toMatch(/Google Docs|Google Tasks/);
  });
  it.each([{ 'gdocs-id': 'synthetic' }, { gtasks_id: 'synthetic' }, { tags: ['gdocs-sync'] }, { tags: 'gdocs-sync' }])('excludes inbound bytes that would activate another writer: %j', frontmatter => {
    expect(managedPathExclusion('Inbox/new.md', note(frontmatter), settings, JSON.parse)).not.toBeNull();
  });
  it('does not confuse a neighboring folder or ordinary note with an owned path', () => {
    expect(managedPathExclusion('Docs-other/plain.md', note({ tags: ['ordinary'] }), settings, JSON.parse)).toBeNull();
  });
  it('blocks an unreadable frontmatter ownership decision visibly', () => {
    expect(managedPathExclusion('plain.md', note({}), settings, () => { throw new Error('invalid YAML'); })).toMatch(/ownership/i);
  });
});
