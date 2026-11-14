import { describe, it, expect, afterEach } from 'vitest';
import { FM } from '../../src/converter/TaskNoteMapper';
import {
  TaskItem,
  readTasks,
  localDateString,
  bucketOf,
  matchesFilter,
  buildTree,
  groupTasks,
  countTasks,
  listsOf,
  dueLabel,
} from '../../src/tasks/TaskStore';

/**
 * QA edge cases for the Tasks data layer. Tests prefixed "KNOWN BUG" assert the
 * CORRECT behaviour and currently FAIL against the source; they are left in
 * place on purpose so the defect cannot be forgotten (see QA report).
 */

const TODAY = '2026-11-13';

function item(over: Partial<TaskItem> & { id: string }): TaskItem {
  return {
    path: `Google Tasks/${over.id}.md`,
    title: over.id,
    completed: false,
    due: '',
    listId: 'L1',
    listName: 'Work',
    parentId: '',
    position: '',
    ...over,
  };
}

function makeApp(files: Record<string, Record<string, unknown> | null | undefined>) {
  const list = Object.keys(files).map((path) => ({
    path,
    basename: path.split('/').pop()!.replace(/\.md$/, ''),
    extension: 'md',
  }));
  return {
    vault: { getMarkdownFiles: () => list },
    metadataCache: {
      getFileCache: (f: { path: string }) => {
        const fm = files[f.path];
        if (fm === null) return null; // not indexed yet
        if (fm === undefined) return { frontmatter: undefined }; // indexed, no frontmatter
        return { frontmatter: fm };
      },
    },
  };
}

const ids = (nodes: Array<{ task: TaskItem }>) => nodes.map((n) => n.task.id);

describe('completed tasks with no due date', () => {
  const done = item({ id: 'done', completed: true, due: '' });

  it('land in the Completed bucket, never No date', () => {
    expect(bucketOf(done, TODAY)).toBe('Completed');
  });

  it('appear only under the All filter', () => {
    for (const f of ['today', 'upcoming', 'overdue'] as const) {
      expect(matchesFilter(done, f, null, TODAY)).toBe(false);
    }
    expect(matchesFilter(done, 'all', null, TODAY)).toBe(true);
  });

  it('are not counted on any tab, and a completed overdue task does not count as overdue', () => {
    const completedOverdue = item({ id: 'co', completed: true, due: '2020-01-01' });
    expect(countTasks([done, completedOverdue], null, TODAY)).toEqual({ today: 0, upcoming: 0, overdue: 0 });
    expect(bucketOf(completedOverdue, TODAY)).toBe('Completed');
  });
});

describe('subtask / parent relationships', () => {
  it('promotes a subtask whose parent lives in another list when filtering by list', () => {
    const parent = item({ id: 'p', listId: 'L2', listName: 'Home' });
    const child = item({ id: 'c', parentId: 'p', listId: 'L1' });
    const groups = groupTasks([parent, child], 'all', 'L1', TODAY);
    expect(groups).toHaveLength(1);
    expect(ids(groups[0].nodes)).toEqual(['c']);
    expect(groups[0].nodes[0].children).toEqual([]);
  });

  it('promotes an open subtask when its parent is completed and the tab is not All', () => {
    const parent = item({ id: 'p', completed: true });
    const child = item({ id: 'c', parentId: 'p', due: TODAY });
    const groups = groupTasks([parent, child], 'today', null, TODAY);
    expect(groups.map((g) => g.bucket)).toEqual(['Today']);
    expect(ids(groups[0].nodes)).toEqual(['c']);
  });

  it('promotes a subtask whose parent has no due date out of the Today tab', () => {
    const parent = item({ id: 'p', due: '' });
    const child = item({ id: 'c', parentId: 'p', due: TODAY });
    const groups = groupTasks([parent, child], 'today', null, TODAY);
    expect(ids(groups[0].nodes)).toEqual(['c']);
  });

  it('promotes a subtask whose parent note was soft-deleted (readTasks drops the parent)', () => {
    const app = makeApp({
      'Google Tasks/p.md': { [FM.id]: 'p', [FM.title]: 'Parent', [FM.deleted]: true },
      'Google Tasks/c.md': { [FM.id]: 'c', [FM.title]: 'Child', [FM.parentId]: 'p', [FM.listId]: 'L1' },
    });
    const tasks = readTasks(app as never, 'Google Tasks');
    expect(tasks.map((t) => t.id)).toEqual(['c']);
    const groups = groupTasks(tasks, 'all', null, TODAY);
    expect(ids(groups[0].nodes)).toEqual(['c']);
  });

  it('treats a self-referencing parent id as a top-level task', () => {
    const t = item({ id: 'x', parentId: 'x' });
    expect(ids(buildTree([t]))).toEqual(['x']);
  });

  it('shows both copies when two notes carry the same Google id (sync-conflict copy)', () => {
    const a = item({ id: 'dup', path: 'Google Tasks/a.md', title: 'A' });
    const b = item({ id: 'dup', path: 'Google Tasks/b.md', title: 'B' });
    const tree = buildTree([a, b]);
    expect(tree.map((n) => n.task.path).sort()).toEqual(['Google Tasks/a.md', 'Google Tasks/b.md']);
  });

  it('KNOWN BUG: a parent-id cycle (A<->B) must not make both tasks vanish', () => {
    // Reachable only by hand-editing gtasks_parent_id, but buildTree's own contract
    // says a subtask "never silently disappears".
    const a = item({ id: 'a', parentId: 'b' });
    const b = item({ id: 'b', parentId: 'a' });
    const visible = buildTree([a, b]).flatMap((n) => [n.task.id, ...n.children.map((c) => c.id)]);
    expect(visible.sort()).toEqual(['a', 'b']);
  });

  it('KNOWN BUG: a third nesting level (grandchild) must not silently disappear', () => {
    // Google only allows one level, but a hand-edited parent id produces this and
    // buildTree renders only roots and their direct children.
    const a = item({ id: 'a' });
    const b = item({ id: 'b', parentId: 'a' });
    const c = item({ id: 'c', parentId: 'b' });
    const visible = buildTree([a, b, c]).flatMap((n) => [n.task.id, ...n.children.map((x) => x.id)]);
    expect(visible.sort()).toEqual(['a', 'b', 'c']);
  });

  it('KNOWN BUG: an OPEN subtask of a COMPLETED parent must stay visible under the All tab', () => {
    // Today it is nested inside the (collapsed-by-default) Completed section, so the
    // view can claim "You're all caught up" while an open task exists.
    const parent = item({ id: 'p', completed: true, due: '2026-11-01' });
    const child = item({ id: 'c', parentId: 'p', completed: false, due: TODAY });
    const groups = groupTasks([parent, child], 'all', null, TODAY);
    const openGroups = groups.filter((g) => g.bucket !== 'Completed');
    const surfaced = openGroups.flatMap((g) => g.nodes.flatMap((n) => [n.task.id, ...n.children.map((x) => x.id)]));
    expect(surfaced).toContain('c');
  });
});

describe('ordering', () => {
  it('sorts dated before undated, then position, then title, without throwing on blanks', () => {
    const tasks = [
      item({ id: 'nodate-b', title: 'b' }),
      item({ id: 'nodate-a', title: 'a' }),
      item({ id: 'dated', due: '2026-12-01' }),
      item({ id: 'sooner', due: '2026-11-20' }),
    ];
    expect(ids(buildTree(tasks))).toEqual(['sooner', 'dated', 'nodate-a', 'nodate-b']);
  });

  it('keeps identical titles in a deterministic order by position', () => {
    const tasks = [
      item({ id: 'x2', title: 'Same', position: '00000000000000000002' }),
      item({ id: 'x1', title: 'Same', position: '00000000000000000001' }),
    ];
    expect(ids(buildTree(tasks))).toEqual(['x1', 'x2']);
  });

  it('sorts mixed padded and unpadded positions numerically for subtasks', () => {
    const p = item({ id: 'p' });
    const kids = ['10', '9', '00000000000000000100'].map((pos, i) => item({ id: `k${i}`, parentId: 'p', position: pos }));
    const order = buildTree([p, ...kids])[0].children.map((c) => c.position);
    expect(order).toEqual(['9', '10', '00000000000000000100']);
  });
});

describe('readTasks hardening', () => {
  const FOLDER = 'Google Tasks';

  it('returns nothing, without throwing, for an empty tasksFolder', () => {
    const app = makeApp({ 'Google Tasks/a.md': { [FM.id]: 'a', [FM.title]: 'A' } });
    expect(readTasks(app as never, '')).toEqual([]);
    expect(readTasks(app as never, '/')).toEqual([]);
  });

  it('does not match a sibling folder that merely shares the prefix', () => {
    const app = makeApp({
      'Google Tasks Archive/old.md': { [FM.id]: 'old', [FM.title]: 'Old' },
      'Google Tasks/new.md': { [FM.id]: 'new', [FM.title]: 'New' },
    });
    expect(readTasks(app as never, FOLDER).map((t) => t.id)).toEqual(['new']);
  });

  it('tolerates trailing slashes on the folder setting', () => {
    const app = makeApp({ 'Google Tasks/a.md': { [FM.id]: 'a', [FM.title]: 'A' } });
    expect(readTasks(app as never, 'Google Tasks///').map((t) => t.id)).toEqual(['a']);
  });

  it('skips notes whose cache is cold (null) or that have no frontmatter at all', () => {
    const app = makeApp({
      'Google Tasks/cold.md': null,
      'Google Tasks/plain.md': undefined,
      'Google Tasks/ok.md': { [FM.id]: 'ok', [FM.title]: 'OK' },
    });
    expect(readTasks(app as never, FOLDER).map((t) => t.id)).toEqual(['ok']);
  });

  it('falls back to the file name for blank, whitespace-only or null titles', () => {
    const app = makeApp({
      'Google Tasks/Blank.md': { [FM.id]: '1', [FM.title]: '' },
      'Google Tasks/Spaces.md': { [FM.id]: '2', [FM.title]: '   ' },
      'Google Tasks/Nulled.md': { [FM.id]: '3', [FM.title]: null },
    });
    expect(readTasks(app as never, FOLDER).map((t) => t.title)).toEqual(['Blank', 'Spaces', 'Nulled']);
  });

  it('stringifies a numeric YAML title instead of dropping the task', () => {
    const app = makeApp({ 'Google Tasks/n.md': { [FM.id]: 'n', [FM.title]: 2024 } });
    expect(readTasks(app as never, FOLDER)[0].title).toBe('2024');
  });

  it('only treats a boolean true as completed (a quoted "true" is still open)', () => {
    const app = makeApp({
      'Google Tasks/a.md': { [FM.id]: 'a', [FM.title]: 'A', [FM.completed]: 'true' },
      'Google Tasks/b.md': { [FM.id]: 'b', [FM.title]: 'B', [FM.completed]: true },
    });
    const byId = Object.fromEntries(readTasks(app as never, FOLDER).map((t) => [t.id, t.completed]));
    expect(byId).toEqual({ a: false, b: true });
  });

  it('treats an empty/null due as no date', () => {
    const app = makeApp({
      'Google Tasks/a.md': { [FM.id]: 'a', [FM.title]: 'A', [FM.due]: '' },
      'Google Tasks/b.md': { [FM.id]: 'b', [FM.title]: 'B', [FM.due]: null },
    });
    expect(readTasks(app as never, FOLDER).map((t) => t.due)).toEqual(['', '']);
  });

  it('keeps a note that only carries gtasks_list_id (identity via list)', () => {
    const app = makeApp({ 'Google Tasks/l.md': { [FM.listId]: 'L9' } });
    const [t] = readTasks(app as never, FOLDER);
    expect(t.listId).toBe('L9');
    expect(t.id).toBe('Google Tasks/l.md');
  });

  it('reads a large vault quickly (5,000 task notes plus 5,000 unrelated notes)', () => {
    const files: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < 5000; i++) {
      files[`Google Tasks/t${i}.md`] = { [FM.id]: `id${i}`, [FM.title]: `Task ${i}`, [FM.due]: '2026-11-14' };
      files[`Notes/n${i}.md`] = { title: `n${i}` };
    }
    const app = makeApp(files);
    const start = performance.now();
    const tasks = readTasks(app as never, FOLDER);
    const groups = groupTasks(tasks, 'all', null, TODAY);
    const elapsed = performance.now() - start;
    expect(tasks).toHaveLength(5000);
    expect(groups[0].count).toBe(5000);
    expect(elapsed).toBeLessThan(2000); // generous: environment-sensitive
  });
});

describe('listsOf / list filter edge cases', () => {
  it('uses the id as the label when a list has no name and keeps the first name seen', () => {
    const lists = listsOf([
      item({ id: 'a', listId: 'L1', listName: '' }),
      item({ id: 'b', listId: 'L2', listName: 'First' }),
      item({ id: 'c', listId: 'L2', listName: 'Renamed' }),
    ]);
    expect(lists).toEqual([{ id: 'L2', name: 'First' }, { id: 'L1', name: 'L1' }]); // sorted by name
  });

  it('omits tasks that have no list from the list dropdown', () => {
    expect(listsOf([item({ id: 'a', listId: '', listName: '' })])).toEqual([]);
  });

  it('hides a list-less (unsynced quick-add) task when a specific list is selected, shows it under All lists', () => {
    const t = item({ id: 'q', listId: '', listName: '' });
    expect(matchesFilter(t, 'all', 'L1', TODAY)).toBe(false);
    expect(matchesFilter(t, 'all', null, TODAY)).toBe(true);
  });
});

describe('dueLabel calendar edges', () => {
  it('returns empty for no due date', () => {
    expect(dueLabel('', TODAY)).toBe('');
  });

  it('says Tomorrow / Yesterday across a year boundary', () => {
    expect(dueLabel('2027-01-01', '2026-12-31')).toBe('Tomorrow');
    expect(dueLabel('2026-12-31', '2027-01-01')).toBe('Yesterday');
  });

  it('handles leap day correctly', () => {
    expect(dueLabel('2028-02-29', '2028-02-28')).toBe('Tomorrow');
    expect(dueLabel('2028-03-01', '2028-02-29')).toBe('Tomorrow');
    expect(dueLabel('2027-03-01', '2027-02-28')).toBe('Tomorrow'); // no Feb 29 in 2027
  });

  it('does not say Today/Tomorrow for dates two or more days away', () => {
    expect(dueLabel('2026-11-15', TODAY)).not.toMatch(/Today|Tomorrow|Yesterday/);
  });

  it('KNOWN BUG: a hand-edited, non-date due value must not render as "Invalid Date"', () => {
    // gtasks_due: tomorrow  (or "next friday", "TBD") flows straight to the chip text.
    for (const garbage of ['tomorrow', 'TBD', '2026-13-45', 'abc']) {
      expect(dueLabel(garbage, TODAY)).not.toMatch(/Invalid/i);
    }
  });
});

describe('localDateString rollover', () => {
  const realTz = process.env.TZ;
  afterEach(() => {
    if (realTz === undefined) delete process.env.TZ;
    else process.env.TZ = realTz;
  });

  it('flips exactly at local midnight', () => {
    expect(localDateString(new Date(2026, 10, 13, 23, 59, 59, 999))).toBe('2026-11-13');
    expect(localDateString(new Date(2026, 10, 14, 0, 0, 0, 0))).toBe('2026-11-14');
  });

  it('handles New Year and leap-day rollover', () => {
    expect(localDateString(new Date(2026, 11, 31, 23, 59, 59))).toBe('2026-12-31');
    expect(localDateString(new Date(2027, 0, 1, 0, 0, 0))).toBe('2027-01-01');
    expect(localDateString(new Date(2028, 1, 29, 12))).toBe('2028-02-29');
  });

  it('zero-pads single-digit months and days', () => {
    expect(localDateString(new Date(2026, 0, 5, 12))).toBe('2026-01-05');
  });

  it('uses the local date on a US spring-forward day late in the evening (UTC is already tomorrow)', () => {
    process.env.TZ = 'America/New_York';
    // Skip meaningfully-failing silently: the zone switch must really have taken effect.
    const probe = new Date(2026, 2, 8, 12); // 2026-03-08 DST start in New York
    expect(probe.getTimezoneOffset()).toBe(240); // EDT (UTC-4) after the jump
    const lateEvening = new Date(2026, 2, 8, 23, 30); // 03:30 UTC on the 9th
    expect(lateEvening.toISOString().slice(0, 10)).toBe('2026-03-09');
    expect(localDateString(lateEvening)).toBe('2026-03-08');
  });

  it('computes day differences correctly across the New York fall-back day (25-hour day)', () => {
    process.env.TZ = 'America/New_York';
    // 2026-11-01 is the fall-back day; Tomorrow must still be exactly one calendar day away.
    expect(dueLabel('2026-11-02', '2026-11-01')).toBe('Tomorrow');
    expect(dueLabel('2026-11-01', '2026-10-31')).toBe('Tomorrow');
  });

  it('computes the same day boundaries for a far-east zone (Auckland, UTC+13 in DST)', () => {
    process.env.TZ = 'Pacific/Auckland';
    const lateEvening = new Date(2026, 11, 1, 23, 30);
    expect(localDateString(lateEvening)).toBe('2026-12-01');
    expect(lateEvening.toISOString().slice(0, 10)).toBe('2026-12-01'); // UTC is still the 1st (10:30Z)
    const earlyMorning = new Date(2026, 11, 2, 0, 30); // 11:30Z on the 1st
    expect(earlyMorning.toISOString().slice(0, 10)).toBe('2026-12-01');
    expect(localDateString(earlyMorning)).toBe('2026-12-02');
  });
});
