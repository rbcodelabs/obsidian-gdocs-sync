import { describe, it, expect, vi } from 'vitest';
import { TFile } from 'obsidian';
import { FM, disambiguateFilename } from '../../src/converter/TaskNoteMapper';
import { TaskActions } from '../../src/tasks/TaskActions';

/**
 * QA edge cases for the Tasks write layer. Tests prefixed "FIXED" were KNOWN BUGs found by QA and are now fixed in the source.
 */

function makeFile(path: string): TFile {
  const f = new TFile();
  f.path = path;
  f.basename = path.split('/').pop()!.replace(/\.md$/, '');
  return f;
}

function makeApp(opts: { notes?: Record<string, Record<string, unknown>>; leaves?: unknown[]; folders?: string[] } = {}) {
  const fm = new Map(Object.entries(opts.notes ?? {}).map(([k, v]) => [k, { ...v }]));
  const created = new Map<string, string>();
  const folders = new Set(opts.folders ?? []);
  const app = {
    vault: {
      getFolderByPath: vi.fn((p: string) => (folders.has(p) ? { path: p } : null)),
      createFolder: vi.fn(async (p: string) => { folders.add(p); }),
      getAbstractFileByPath: vi.fn((p: string) => (fm.has(p) || created.has(p) ? makeFile(p) : null)),
      create: vi.fn(async (p: string, content: string) => {
        if (created.has(p) || fm.has(p)) throw new Error('File already exists.');
        created.set(p, content);
        return makeFile(p);
      }),
    },
    fileManager: {
      processFrontMatter: vi.fn(async (file: TFile, cb: (f: Record<string, unknown>) => void) => {
        const cur = fm.get(file.path) ?? {};
        cb(cur);
        fm.set(file.path, cur);
      }),
    },
    workspace: { getLeavesOfType: vi.fn(() => opts.leaves ?? []) },
  };
  return { app, fm, created, folders };
}

/** Minimal frontmatter reader for the notes quickAdd writes (JSON-quoted scalars). */
function readFm(content: string): Record<string, unknown> {
  const m = content.match(/^---\n([\s\S]*?)\n---\n/);
  expect(m, 'content must start with one frontmatter block').not.toBeNull();
  const out: Record<string, unknown> = {};
  for (const line of m![1].split('\n')) {
    const idx = line.indexOf(': ');
    const key = line.slice(0, idx);
    const raw = line.slice(idx + 2);
    out[key] = raw === 'true' ? true : raw === 'false' ? false : raw.startsWith('"') ? JSON.parse(raw) : raw;
  }
  return out;
}

const act = (app: ReturnType<typeof makeApp>['app'], folder = 'Google Tasks') => new TaskActions(app as never, () => folder);
const list = { listId: 'L1', listName: 'Work' };

describe('quickAdd input validation', () => {
  it.each([['empty', ''], ['spaces', '   '], ['tabs and newlines', '\t\n \r\n']])(
    'rejects an %s title before touching the vault',
    async (_label, title) => {
      const { app } = makeApp();
      await expect(act(app).quickAdd({ title, ...list })).rejects.toThrow(/title/i);
      expect(app.vault.createFolder).not.toHaveBeenCalled();
      expect(app.vault.create).not.toHaveBeenCalled();
    },
  );

  it.each([[''], ['/'], ['//']])('rejects with a clear error when tasksFolder is %j and creates nothing', async (folder) => {
    const { app } = makeApp();
    await expect(act(app, folder).quickAdd({ title: 'X', ...list })).rejects.toThrow(/folder/i);
    expect(app.vault.createFolder).not.toHaveBeenCalled();
    expect(app.vault.create).not.toHaveBeenCalled();
  });

  it('normalises a trailing slash on the folder and does not recreate an existing folder', async () => {
    const { app } = makeApp({ folders: ['Google Tasks'] });
    const path = await act(app, 'Google Tasks/').quickAdd({ title: 'X', ...list });
    expect(path).toBe('Google Tasks/X.md');
    expect(app.vault.getFolderByPath).toHaveBeenCalledWith('Google Tasks');
    expect(app.vault.createFolder).not.toHaveBeenCalled();
  });
});

describe('quickAdd filenames', () => {
  it('replaces every OS/Obsidian-illegal character and never leaves a path separator in the file name', async () => {
    const { app } = makeApp();
    const path = await act(app).quickAdd({ title: 'a/b\\c:d*e?f"g<h>i|j#k^l[m]n', ...list });
    const name = path.slice('Google Tasks/'.length);
    expect(name.endsWith('.md')).toBe(true);
    expect(name.slice(0, -3)).not.toMatch(/[/\\:*?"<>|#^[\]]/);
  });

  it('keeps a title made only of illegal characters creatable (non-empty file name)', async () => {
    const { app } = makeApp();
    const path = await act(app).quickAdd({ title: '???', ...list });
    expect(path.slice('Google Tasks/'.length, -3).length).toBeGreaterThan(0);
  });

  it.each([['...'], ['.'], ['..']])('falls back to "Untitled Task" for the dot-only title %j', async (title) => {
    const { app } = makeApp();
    expect(await act(app).quickAdd({ title, ...list })).toBe('Google Tasks/Untitled Task.md');
  });

  it('strips leading dots so the note is not hidden', async () => {
    const { app } = makeApp();
    expect(await act(app).quickAdd({ title: '.secret', ...list })).toBe('Google Tasks/secret.md');
  });

  it('truncates a very long title in the file name but keeps the full title in frontmatter', async () => {
    const { app, created } = makeApp();
    const title = 'x'.repeat(1000);
    const path = await act(app).quickAdd({ title, ...list });
    expect(path.length).toBeLessThanOrEqual('Google Tasks/'.length + 120 + 3);
    expect(readFm(created.get(path)!)[FM.title]).toBe(title);
  });

  it('collapses a multi-line title into a single-line file name', async () => {
    const { app } = makeApp();
    const path = await act(app).quickAdd({ title: 'line one\nline two', ...list });
    expect(path).toBe('Google Tasks/line one line two.md');
  });

  it('creates three distinct notes for three identical titles added back to back', async () => {
    const { app } = makeApp();
    const a = act(app);
    const paths = [await a.quickAdd({ title: 'Dup', ...list }), await a.quickAdd({ title: 'Dup', ...list }), await a.quickAdd({ title: 'Dup', ...list })];
    expect(new Set(paths).size).toBe(3);
    expect(paths[0]).toBe('Google Tasks/Dup.md');
  });

  it('numbers past an already-taken disambiguated name', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      const nonce = Date.now().toString(36);
      const taken = `Google Tasks/${disambiguateFilename('Dup', nonce)}.md`;
      const { app } = makeApp({ notes: { 'Google Tasks/Dup.md': {}, [taken]: {} } });
      const path = await act(app).quickAdd({ title: 'Dup', ...list });
      expect(path).toBe(`Google Tasks/${disambiguateFilename('Dup', nonce)} 2.md`);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('surfaces a vault.create failure and does not report a path', async () => {
    const { app } = makeApp();
    app.vault.create.mockRejectedValueOnce(new Error('disk full'));
    await expect(act(app).quickAdd({ title: 'X', ...list })).rejects.toThrow('disk full');
  });
});

describe('quickAdd frontmatter integrity', () => {
  const nasty = [
    'He said "hi"',
    'back\\slash',
    'colon: in title',
    '# not a comment',
    '- not a list',
    'yes',
    'null',
    '---',
    'emoji 🚀 and 日本語',
    'tab\there',
    'multi\nline\ntitle',
    '{braces} [brackets] & *anchor !tag |pipe >fold',
  ];

  it.each(nasty.map((t) => [t]))('round-trips the title %j exactly and keeps a single frontmatter block', async (title) => {
    const { app, created } = makeApp();
    const path = await act(app).quickAdd({ title, listId: 'L"1', listName: 'Wo"rk', due: '2026-11-13' });
    const content = created.get(path)!;
    // exactly one opening and one closing fence, and the body starts after the second
    expect(content.match(/^---$/gm)).toHaveLength(2);
    const parsed = readFm(content);
    expect(parsed[FM.title]).toBe(title);
    expect(parsed[FM.listId]).toBe('L"1');
    expect(parsed[FM.listName]).toBe('Wo"rk');
    expect(parsed[FM.completed]).toBe(false);
    expect(parsed[FM.due]).toBe('2026-11-13');
  });

  it('omits list keys entirely when no list is known, so the engine default applies', async () => {
    const { app, created } = makeApp();
    const path = await act(app).quickAdd({ title: 'X', listId: '', listName: '' });
    const parsed = readFm(created.get(path)!);
    expect(parsed).not.toHaveProperty(FM.listId);
    expect(parsed).not.toHaveProperty(FM.listName);
  });

  it('trims the title before writing it', async () => {
    const { app, created } = makeApp();
    const path = await act(app).quickAdd({ title: '  padded  ', ...list });
    expect(readFm(created.get(path)!)[FM.title]).toBe('padded');
  });
});

describe('write path failure modes', () => {
  const PATH = 'Google Tasks/A.md';

  it('rejects when the target is a folder rather than a file', async () => {
    const { app } = makeApp();
    app.vault.getAbstractFileByPath.mockReturnValueOnce({ path: PATH, children: [] } as never);
    await expect(act(app).setCompleted(PATH, true)).rejects.toThrow(/not found/i);
    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
  });

  it('propagates a processFrontMatter failure (e.g. invalid YAML in the note) to the caller', async () => {
    const { app } = makeApp({ notes: { [PATH]: {} } });
    app.fileManager.processFrontMatter.mockRejectedValueOnce(new Error('YAMLParseError: bad indentation'));
    await expect(act(app).setCompleted(PATH, true)).rejects.toThrow(/YAMLParseError/);
  });

  it('is idempotent: completing an already completed task leaves it completed', async () => {
    const { app, fm } = makeApp({ notes: { [PATH]: { [FM.completed]: true } } });
    await act(app).setCompleted(PATH, true);
    await act(app).setCompleted(PATH, true);
    expect(fm.get(PATH)![FM.completed]).toBe(true);
  });

  it('clearing a due date on a task that has none is a harmless no-op', async () => {
    const { app, fm } = makeApp({ notes: { [PATH]: { [FM.id]: 'a' } } });
    await expect(act(app).setDue(PATH, null)).resolves.toBeUndefined();
    expect(fm.get(PATH)).not.toHaveProperty(FM.due);
  });

  it('applies two racing toggles in call order (last write wins, nothing lost or thrown)', async () => {
    const { app, fm } = makeApp({ notes: { [PATH]: { [FM.completed]: false } } });
    const a = act(app);
    await Promise.all([a.setCompleted(PATH, true), a.setCompleted(PATH, false)]);
    expect(fm.get(PATH)![FM.completed]).toBe(false);
    expect(app.fileManager.processFrontMatter).toHaveBeenCalledTimes(2);
  });

  it('rename trims surrounding whitespace and ignores a tab/newline-only title', async () => {
    const { app, fm } = makeApp({ notes: { [PATH]: { [FM.title]: 'Old' } } });
    await act(app).rename(PATH, ' \t\n');
    expect(fm.get(PATH)![FM.title]).toBe('Old');
    await act(app).rename(PATH, '  New  ');
    expect(fm.get(PATH)![FM.title]).toBe('New');
  });

  it('FIXED: setDue must reject a calendar-impossible date that passes the YYYY-MM-DD shape check', async () => {
    // The UI uses <input type=date> so it cannot produce these, but the action layer
    // is the last line of defence before the value is pushed to Google.
    for (const bad of ['2026-13-45', '2026-02-30', '0000-00-00']) {
      const { app, fm } = makeApp({ notes: { [PATH]: { [FM.id]: 'a' } } });
      await expect(act(app).setDue(PATH, bad), `setDue(${bad})`).rejects.toThrow();
      expect(fm.get(PATH)).not.toHaveProperty(FM.due);
    }
  });
});

describe('dirty-editor guard edge cases', () => {
  const PATH = 'Google Tasks/A.md';

  it('saves every editor open on the same note (split panes), not just the first', async () => {
    const save1 = vi.fn().mockResolvedValue(undefined);
    const save2 = vi.fn().mockResolvedValue(undefined);
    const leaves = [
      { view: { file: { path: PATH }, save: save1 } },
      { view: { file: { path: PATH }, save: save2 } },
    ];
    const { app } = makeApp({ notes: { [PATH]: {} }, leaves });
    await act(app).setCompleted(PATH, true);
    expect(save1).toHaveBeenCalledTimes(1);
    expect(save2).toHaveBeenCalledTimes(1);
  });

  it('tolerates deferred / non-editor markdown leaves that expose no file or save()', async () => {
    const leaves = [{ view: {} }, { view: { file: null } }, { view: { file: { path: PATH } } }];
    const { app, fm } = makeApp({ notes: { [PATH]: {} }, leaves });
    await act(app).setCompleted(PATH, true);
    expect(fm.get(PATH)![FM.completed]).toBe(true);
  });

  it('names the note in the error and writes nothing if any one of several editors cannot save', async () => {
    const leaves = [
      { view: { file: { path: PATH }, save: vi.fn().mockResolvedValue(undefined) } },
      { view: { file: { path: PATH }, save: vi.fn().mockRejectedValue(new Error('EACCES')) } },
    ];
    const { app } = makeApp({ notes: { [PATH]: {} }, leaves });
    await expect(act(app).setCompleted(PATH, true)).rejects.toThrow(/Google Tasks\/A\.md.*EACCES/);
    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
  });
});
