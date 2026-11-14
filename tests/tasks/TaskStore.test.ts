import { describe, it, expect } from 'vitest';
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

function makeApp(files: Record<string, Record<string, unknown> | null>) {
  const list = Object.keys(files).map((path) => ({ path, basename: path.split('/').pop()!.replace(/\.md$/, ''), extension: 'md' }));
  return {
    vault: { getMarkdownFiles: () => list },
    metadataCache: {
      getFileCache: (f: { path: string }) => (files[f.path] ? { frontmatter: files[f.path] } : null),
    },
  };
}

describe('localDateString', () => {
  it('uses the local calendar date, not UTC', () => {
    // 23:30 local on Nov 13 is already Nov 14 in UTC for any zone behind UTC;
    // the local components must win either way.
    const d = new Date(2026, 10, 13, 23, 30);
    expect(localDateString(d)).toBe('2026-11-13');
    const early = new Date(2026, 10, 13, 0, 5);
    expect(localDateString(early)).toBe('2026-11-13');
  });
});

describe('readTasks', () => {
  it('maps frontmatter to task items and only reads the tasks folder', () => {
    const app = makeApp({
      'Google Tasks/A.md': {
        [FM.id]: 'a', [FM.title]: 'Alpha', [FM.completed]: false, [FM.due]: '2026-11-14',
        [FM.listId]: 'L1', [FM.listName]: 'Work', [FM.position]: '0001', [FM.parentId]: 'p',
      },
      'Elsewhere/B.md': { [FM.id]: 'b', [FM.title]: 'Nope' },
      'Google Tasks Archive/C.md': { [FM.id]: 'c', [FM.title]: 'Prefix lookalike' },
    });
    const tasks = readTasks(app as never, 'Google Tasks/');
    expect(tasks).toEqual([
      {
        id: 'a', path: 'Google Tasks/A.md', title: 'Alpha', completed: false, due: '2026-11-14',
        listId: 'L1', listName: 'Work', parentId: 'p', position: '0001',
      },
    ]);
  });

  it('skips soft-deleted notes and notes without task frontmatter', () => {
    const app = makeApp({
      'Google Tasks/Gone.md': { [FM.id]: 'g', [FM.title]: 'Gone', [FM.deleted]: true },
      'Google Tasks/Plain.md': { foo: 'bar' },
      'Google Tasks/Uncached.md': null,
      'Google Tasks/Ok.md': { [FM.id]: 'o', [FM.title]: 'Ok', [FM.deleted]: false },
    });
    expect(readTasks(app as never, 'Google Tasks').map((t) => t.id)).toEqual(['o']);
  });

  it('keeps a not-yet-pushed quick-add note (no id) keyed by its path, title falling back to basename', () => {
    const app = makeApp({
      'Google Tasks/New.md': { [FM.listId]: 'L1', [FM.listName]: 'Work' },
    });
    const [t] = readTasks(app as never, 'Google Tasks');
    expect(t.id).toBe('Google Tasks/New.md');
    expect(t.title).toBe('New');
  });

  it('normalises due values (ISO timestamp, Date object) to date-only', () => {
    const app = makeApp({
      'Google Tasks/A.md': { [FM.id]: 'a', [FM.title]: 'A', [FM.due]: '2026-11-20T00:00:00.000Z' },
      'Google Tasks/B.md': { [FM.id]: 'b', [FM.title]: 'B', [FM.due]: new Date('2026-11-21T00:00:00.000Z') },
    });
    expect(readTasks(app as never, 'Google Tasks').map((t) => t.due)).toEqual(['2026-11-20', '2026-11-21']);
  });
});

describe('bucketOf (date-only comparison)', () => {
  it('buckets by calendar day regardless of time of day', () => {
    expect(bucketOf(item({ id: 'a', due: '2026-11-12' }), TODAY)).toBe('Overdue');
    expect(bucketOf(item({ id: 'a', due: '2026-11-13' }), TODAY)).toBe('Today');
    expect(bucketOf(item({ id: 'a', due: '2026-11-14' }), TODAY)).toBe('Upcoming');
    expect(bucketOf(item({ id: 'a', due: '' }), TODAY)).toBe('No date');
    expect(bucketOf(item({ id: 'a', due: '2026-11-01', completed: true }), TODAY)).toBe('Completed');
  });

  it('compares across month and year boundaries lexically-correctly', () => {
    expect(bucketOf(item({ id: 'a', due: '2026-12-01' }), '2026-11-30')).toBe('Upcoming');
    expect(bucketOf(item({ id: 'a', due: '2026-12-31' }), '2027-01-01')).toBe('Overdue');
  });
});

describe('matchesFilter', () => {
  const tasks = [
    item({ id: 'over', due: '2026-11-10' }),
    item({ id: 'today', due: TODAY }),
    item({ id: 'soon', due: '2026-11-20' }),
    item({ id: 'nodate' }),
    item({ id: 'done', due: '2026-11-10', completed: true }),
  ];
  const ids = (f: Parameters<typeof matchesFilter>[1], list: string | null = null) =>
    tasks.filter((t) => matchesFilter(t, f, list, TODAY)).map((t) => t.id);

  it('today = overdue + today (open only)', () => expect(ids('today')).toEqual(['over', 'today']));
  it('upcoming', () => expect(ids('upcoming')).toEqual(['soon']));
  it('overdue', () => expect(ids('overdue')).toEqual(['over']));
  it('all includes no-date and completed', () => expect(ids('all')).toEqual(['over', 'today', 'soon', 'nodate', 'done']));
  it('filters by list id', () => {
    const other = item({ id: 'x', due: TODAY, listId: 'L2' });
    expect(matchesFilter(other, 'today', 'L1', TODAY)).toBe(false);
    expect(matchesFilter(other, 'today', 'L2', TODAY)).toBe(true);
  });
});

describe('buildTree', () => {
  it('nests subtasks under their parent ordered by position', () => {
    const tree = buildTree([
      item({ id: 'p', position: '2' }),
      item({ id: 'k2', parentId: 'p', position: '00000002' }),
      item({ id: 'k1', parentId: 'p', position: '00000001' }),
      item({ id: 'q', position: '1' }),
    ]);
    expect(tree.map((n) => n.task.id)).toEqual(['q', 'p']);
    expect(tree[1].children.map((c) => c.id)).toEqual(['k1', 'k2']);
  });

  it('promotes subtasks whose parent is missing to top level', () => {
    const tree = buildTree([item({ id: 'orphan', parentId: 'ghost' })]);
    expect(tree.map((n) => n.task.id)).toEqual(['orphan']);
  });

  it('orders numeric position strings by length then value', () => {
    const tree = buildTree([item({ id: 'b', position: '10' }), item({ id: 'a', position: '9' })]);
    expect(tree.map((n) => n.task.id)).toEqual(['a', 'b']);
  });
});

describe('groupTasks', () => {
  const tasks = [
    item({ id: 'o', due: '2026-11-10' }),
    item({ id: 't', due: TODAY }),
    item({ id: 'kid', due: TODAY, parentId: 't' }),
    item({ id: 'u', due: '2026-11-20' }),
    item({ id: 'n' }),
    item({ id: 'd', completed: true }),
  ];

  it('returns sections in fixed order, omitting empty ones', () => {
    const groups = groupTasks(tasks, 'all', null, TODAY);
    expect(groups.map((g) => g.bucket)).toEqual(['Overdue', 'Today', 'Upcoming', 'No date', 'Completed']);
    expect(groupTasks(tasks, 'today', null, TODAY).map((g) => g.bucket)).toEqual(['Overdue', 'Today']);
  });

  it('keeps subtasks under the parent rather than as separate rows', () => {
    const today = groupTasks(tasks, 'today', null, TODAY).find((g) => g.bucket === 'Today')!;
    expect(today.nodes).toHaveLength(1);
    expect(today.nodes[0].children.map((c) => c.id)).toEqual(['kid']);
  });
});

describe('countTasks', () => {
  it('counts open tasks per tab, honouring the list filter', () => {
    const tasks = [
      item({ id: 'o', due: '2026-11-10' }),
      item({ id: 't', due: TODAY }),
      item({ id: 'u', due: '2026-11-20' }),
      item({ id: 'w', due: '2026-11-21', listId: 'L2' }),
      item({ id: 'd', due: '2026-11-10', completed: true }),
    ];
    expect(countTasks(tasks, null, TODAY)).toEqual({ today: 2, upcoming: 2, overdue: 1 });
    expect(countTasks(tasks, 'L2', TODAY)).toEqual({ today: 0, upcoming: 1, overdue: 0 });
  });
});

describe('listsOf', () => {
  it('returns distinct lists sorted by name', () => {
    const lists = listsOf([
      item({ id: 'a', listId: 'L2', listName: 'Home' }),
      item({ id: 'b', listId: 'L1', listName: 'Work' }),
      item({ id: 'c', listId: 'L2', listName: 'Home' }),
      item({ id: 'd', listId: '', listName: '' }),
    ]);
    expect(lists).toEqual([{ id: 'L2', name: 'Home' }, { id: 'L1', name: 'Work' }]);
  });
});

describe('dueLabel', () => {
  it('uses relative words near today and a short date otherwise', () => {
    expect(dueLabel('2026-11-13', TODAY)).toBe('Today');
    expect(dueLabel('2026-11-14', TODAY)).toBe('Tomorrow');
    expect(dueLabel('2026-11-12', TODAY)).toBe('Yesterday');
    expect(dueLabel('2026-11-20', TODAY, 'en-US')).toBe('Nov 20');
    expect(dueLabel('2026-12-31', TODAY, 'en-US')).toBe('Dec 31');
  });

  it('is DST-safe across a daylight-saving change', () => {
    expect(dueLabel('2026-03-09', '2026-03-08')).toBe('Tomorrow');
    expect(dueLabel('2026-11-02', '2026-11-01')).toBe('Tomorrow');
  });
});
