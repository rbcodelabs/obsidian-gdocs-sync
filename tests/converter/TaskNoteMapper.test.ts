import { describe, it, expect } from 'vitest';
import {
  FM,
  taskToFields,
  taskToNote,
  noteToFields,
  fieldsToWrite,
  canonicalizeFields,
  mergeFields,
  dueToDateOnly,
  dateOnlyToRfc3339,
  sanitizeFilename,
  disambiguateFilename,
  TaskFields,
} from '../../src/converter/TaskNoteMapper';
import type { GoogleTask, GoogleTaskList } from '../../src/api/GoogleTasksAPI';

const LIST: GoogleTaskList = { id: 'L1', title: 'Personal', updated: 't' };

function task(overrides: Partial<GoogleTask> = {}): GoogleTask {
  return {
    id: 'T1',
    title: 'Buy milk',
    status: 'needsAction',
    updated: '2026-08-02T10:00:00.000Z',
    ...overrides,
  };
}

describe('date helpers', () => {
  it('dueToDateOnly reduces an RFC3339 timestamp to YYYY-MM-DD', () => {
    expect(dueToDateOnly('2026-08-05T00:00:00.000Z')).toBe('2026-08-05');
  });
  it('dueToDateOnly returns empty string for undefined', () => {
    expect(dueToDateOnly(undefined)).toBe('');
  });
  it('dateOnlyToRfc3339 synthesizes midnight UTC', () => {
    expect(dateOnlyToRfc3339('2026-08-05')).toBe('2026-08-05T00:00:00.000Z');
  });
  it('dateOnlyToRfc3339 returns undefined for empty', () => {
    expect(dateOnlyToRfc3339('')).toBeUndefined();
  });
});

describe('taskToFields', () => {
  it('extracts the four mutable fields, mapping completed status to a boolean', () => {
    const f = taskToFields(task({ notes: 'note body', status: 'completed', due: '2026-08-05T00:00:00.000Z' }));
    expect(f).toEqual({ title: 'Buy milk', notes: 'note body', completed: true, due: '2026-08-05' });
  });
  it('defaults missing notes/due to empty strings', () => {
    expect(taskToFields(task())).toEqual({ title: 'Buy milk', notes: '', completed: false, due: '' });
  });
});

describe('taskToNote', () => {
  it('builds frontmatter with denormalized list name and body from notes', () => {
    const { frontmatter, body } = taskToNote(
      task({ notes: 'Get 2%', position: '0999', webViewLink: 'https://x' }),
      LIST,
      'HASH',
    );
    expect(frontmatter[FM.id]).toBe('T1');
    expect(frontmatter[FM.listId]).toBe('L1');
    expect(frontmatter[FM.listName]).toBe('Personal');
    expect(frontmatter[FM.title]).toBe('Buy milk');
    expect(frontmatter[FM.completed]).toBe(false);
    expect(frontmatter[FM.position]).toBe('0999');
    expect(frontmatter[FM.hash]).toBe('HASH');
    expect(frontmatter[FM.url]).toBe('https://x');
    expect(frontmatter[FM.deleted]).toBe(false);
    expect(body).toBe('Get 2%');
  });

  it('only writes optional due/parent fields when present', () => {
    const plain = taskToNote(task(), LIST, 'H').frontmatter;
    expect(plain[FM.due]).toBeUndefined();
    expect(plain[FM.parentId]).toBeUndefined();

    const rich = taskToNote(task({ due: '2026-08-05T00:00:00.000Z', parent: 'P1' }), LIST, 'H').frontmatter;
    expect(rich[FM.due]).toBe('2026-08-05');
    expect(rich[FM.parentId]).toBe('P1');
  });
});

describe('noteToFields', () => {
  it('reads mutable fields back from frontmatter + body', () => {
    const fm = {
      [FM.title]: 'Buy milk',
      [FM.completed]: true,
      [FM.due]: '2026-08-05',
    };
    expect(noteToFields(fm, '  the notes  ')).toEqual({
      title: 'Buy milk',
      notes: 'the notes',
      completed: true,
      due: '2026-08-05',
    });
  });

  it('treats a missing completed flag as false and missing due as empty', () => {
    expect(noteToFields({ [FM.title]: 'X' }, '')).toEqual({ title: 'X', notes: '', completed: false, due: '' });
  });

  it('normalizes a Date object due (YAML may parse bare dates as Date)', () => {
    const fm = { [FM.title]: 'X', [FM.due]: new Date('2026-08-05T00:00:00.000Z') };
    expect(noteToFields(fm, '').due).toBe('2026-08-05');
  });
});

describe('round trip: task -> note -> fields', () => {
  it('preserves the mutable fields through a full round trip', () => {
    const original = task({ notes: 'body text', status: 'completed', due: '2026-08-05T00:00:00.000Z' });
    const { frontmatter, body } = taskToNote(original, LIST, 'H');
    const back = noteToFields(frontmatter, body);
    expect(back).toEqual(taskToFields(original));
  });
});

describe('fieldsToWrite', () => {
  it('maps completed boolean to status and date-only due to RFC3339', () => {
    const fields: TaskFields = { title: 'T', notes: 'N', completed: true, due: '2026-08-05' };
    expect(fieldsToWrite(fields)).toEqual({
      title: 'T',
      notes: 'N',
      status: 'completed',
      due: '2026-08-05T00:00:00.000Z',
    });
  });
  it('omits due when unset and maps needsAction', () => {
    expect(fieldsToWrite({ title: 'T', notes: '', completed: false, due: '' })).toEqual({
      title: 'T',
      notes: '',
      status: 'needsAction',
      due: undefined,
    });
  });
});

describe('canonicalizeFields', () => {
  it('is stable regardless of object construction order and ignores non-mutable data', () => {
    const a = canonicalizeFields({ title: 'T', notes: 'N', completed: false, due: '' });
    const b = canonicalizeFields({ due: '', completed: false, notes: 'N', title: 'T' } as TaskFields);
    expect(a).toBe(b);
  });
  it('changes when any mutable field changes', () => {
    const base = canonicalizeFields({ title: 'T', notes: 'N', completed: false, due: '' });
    expect(canonicalizeFields({ title: 'T2', notes: 'N', completed: false, due: '' })).not.toBe(base);
    expect(canonicalizeFields({ title: 'T', notes: 'N', completed: true, due: '' })).not.toBe(base);
  });
});

describe('mergeFields (3-way)', () => {
  const base: TaskFields = { title: 'T', notes: 'N', completed: false, due: '' };

  it('returns base when nothing changed', () => {
    const { merged, conflicted } = mergeFields(base, base, base);
    expect(merged).toEqual(base);
    expect(conflicted).toBe(false);
  });

  it('takes the remote value when only remote changed a field', () => {
    const remote = { ...base, completed: true };
    const { merged, conflicted } = mergeFields(base, base, remote);
    expect(merged.completed).toBe(true);
    expect(conflicted).toBe(false);
  });

  it('takes the local value when only local changed a field', () => {
    const local = { ...base, title: 'Renamed' };
    const { merged, conflicted } = mergeFields(base, local, base);
    expect(merged.title).toBe('Renamed');
    expect(conflicted).toBe(false);
  });

  it('merges non-overlapping edits from both sides without conflict', () => {
    const local = { ...base, title: 'Renamed' }; // local edits title
    const remote = { ...base, completed: true }; // remote edits completed
    const { merged, conflicted } = mergeFields(base, local, remote);
    expect(merged).toEqual({ title: 'Renamed', notes: 'N', completed: true, due: '' });
    expect(conflicted).toBe(false);
  });

  it('flags a conflict and keeps local when both change the SAME field differently', () => {
    const local = { ...base, title: 'LocalName' };
    const remote = { ...base, title: 'RemoteName' };
    const { merged, conflicted } = mergeFields(base, local, remote);
    expect(merged.title).toBe('LocalName');
    expect(conflicted).toBe(true);
  });
});

describe('filename helpers', () => {
  it('sanitizes unsafe characters', () => {
    expect(sanitizeFilename('Pay: rent/utilities?')).toBe('Pay- rent-utilities-');
  });
  it('falls back to a default for empty titles', () => {
    expect(sanitizeFilename('   ')).toBe('Untitled Task');
  });
  it('strips leading dots to avoid hidden files', () => {
    expect(sanitizeFilename('...secret')).toBe('secret');
  });
  it('disambiguate appends a deterministic id-derived suffix', () => {
    const a = disambiguateFilename('Buy milk', 'abcdef123456');
    expect(a).toBe('Buy milk (123456)');
    // Deterministic — same inputs, same output.
    expect(disambiguateFilename('Buy milk', 'abcdef123456')).toBe(a);
  });
});
