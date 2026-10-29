import { describe, expect, it } from 'vitest';
import { makePlan, makePlanTask, makeTask } from '../test/fixtures.js';
import {
  canDrop,
  canRework,
  changeLines,
  type DraftTask,
  type ExistingTask,
  existingFromPlan,
  exportJson,
  type FirstPlanDraft,
  findCycle,
  globStem,
  globsOverlap,
  importFirstPlan,
  importRevision,
  MAX_IMPORT_BYTES,
  newTask,
  nextKey,
  normalizeFirstPlan,
  normalizeRevision,
  type RevisionDraft,
  revisionChanges,
  scopeGlobProblem,
  validateFirstPlan,
  validateRevision,
} from './plan-draft.js';

function task(key: string, over: Partial<DraftTask> = {}): DraftTask {
  return {
    ...newTask(key),
    summary: `Do the ${key} work`,
    acceptance_criteria: ['tests pass'],
    scope: { write: [`${key}/**`], read: [] },
    ...over,
  };
}

function plan(tasks: DraftTask[], over: Partial<FirstPlanDraft> = {}): FirstPlanDraft {
  return { objective: 'Ship subscriptions', summary: 'Split by area', tasks, ...over };
}

const paths = (issues: { path: string }[]) => issues.map((i) => i.path);
const messages = (issues: { message: string }[]) => issues.map((i) => i.message).join('\n');

describe('globs', () => {
  it('takes the fixed prefix before the first wildcard, lower-cased', () => {
    expect(globStem('backend/src/**')).toBe('backend/src/');
    expect(globStem('Front/*.ts')).toBe('front/');
    expect(globStem('a/b?c')).toBe('a/b');
    expect(globStem('{a,b}/x')).toBe('');
    expect(globStem('docs\\guide.md')).toBe('docs/guide.md');
  });

  it('overlaps when one prefix starts with the other', () => {
    expect(globsOverlap(['backend/**'], ['backend/src/**'])).toBe(true);
    expect(globsOverlap(['backend/src/**'], ['backend/**'])).toBe(true);
    expect(globsOverlap(['backend/**'], ['frontend/**'])).toBe(false);
    expect(globsOverlap(['backend/**'], ['backend-api/**'])).toBe(false);
    expect(globsOverlap(['**'], ['anything/**'])).toBe(true);
    expect(globsOverlap(['a/**', 'b/**'], ['c/**', 'b/x.ts'])).toBe(true);
    expect(globsOverlap([], ['a/**'])).toBe(false);
  });

  it('refuses globs that are not project-relative', () => {
    expect(scopeGlobProblem('backend/**')).toBeNull();
    expect(scopeGlobProblem('/etc/**')).toMatch(/project-relative/);
    expect(scopeGlobProblem('C:/x/**')).toMatch(/project-relative/);
    expect(scopeGlobProblem('a\\b')).toMatch(/project-relative/);
    expect(scopeGlobProblem('a/../b')).toMatch(/project-relative/);
    expect(scopeGlobProblem('')).toMatch(/empty/);
    expect(scopeGlobProblem('x'.repeat(201))).toMatch(/200/);
  });
});

describe('findCycle', () => {
  it('finds a cycle as a path and ignores unknown ids', () => {
    expect(
      findCycle(
        new Map([
          ['a', ['b']],
          ['b', ['a']],
        ]),
      ),
    ).toEqual(['a', 'b', 'a']);
    expect(
      findCycle(
        new Map([
          ['a', ['zzz']],
          ['b', ['a']],
        ]),
      ),
    ).toBeNull();
    expect(findCycle(new Map([['a', ['a']]]))).toEqual(['a', 'a']);
  });
});

describe('validateFirstPlan', () => {
  it('accepts a valid plan', () => {
    const p = plan([task('api'), task('ui', { depends_on: ['api'], scope: { write: ['api/**'], read: [] } })]);
    expect(validateFirstPlan(p)).toEqual([]);
  });

  it('needs an objective and a summary of the right length, and at least one task', () => {
    const issues = validateFirstPlan({ summary: 'abc', tasks: [] });
    expect(paths(issues)).toEqual(expect.arrayContaining(['objective', 'summary', 'tasks']));
    expect(messages(validateFirstPlan(plan([task('a')], { objective: 'x'.repeat(501) })))).toMatch(/at most 500/);
  });

  it('refuses more than 12 tasks', () => {
    const tasks = Array.from({ length: 13 }, (_, i) => task(`t${i}`));
    expect(messages(validateFirstPlan(plan(tasks)))).toMatch(/at most 12 tasks/);
  });

  it('wants unique keys', () => {
    const issues = validateFirstPlan(plan([task('api'), task('api', { scope: { write: ['other/**'], read: [] } })]));
    expect(issues).toContainEqual({ path: 'tasks.1.key', message: 'task key "api" is used twice' });
  });

  it('checks key, role, summary, criteria, enums and globs per task', () => {
    const bad = task('Bad Key', {
      summary: 'ab',
      role: 'Backend!',
      acceptance_criteria: [],
      kind: 'other' as DraftTask['kind'],
      priority: 'asap' as DraftTask['priority'],
      risk_level: 'extreme' as DraftTask['risk_level'],
      scope: { write: ['../x/**'], read: ['/abs'] },
      description: 'd'.repeat(4001),
    });
    const p = paths(validateFirstPlan(plan([bad])));
    for (const f of [
      'key',
      'summary',
      'role',
      'acceptance_criteria',
      'kind',
      'priority',
      'risk_level',
      'scope.write',
      'scope.read',
      'description',
    ])
      expect(p).toContain(`tasks.0.${f}`);
  });

  it('knows its dependencies: unknown, self and twice', () => {
    const issues = validateFirstPlan(plan([task('a', { depends_on: ['a', 'ghost', 'ghost'] })]));
    const m = messages(issues);
    expect(m).toMatch(/depends on itself/);
    expect(m).toMatch(/"ghost", which is not a task key/);
    expect(m).toMatch(/lists a dependency twice/);
  });

  it('finds cycles', () => {
    const issues = validateFirstPlan(plan([task('a', { depends_on: ['b'] }), task('b', { depends_on: ['a'] })]));
    expect(issues).toContainEqual({ path: 'tasks', message: 'dependencies form a cycle: a -> b -> a' });
  });

  it('requires a write scope except for review and research', () => {
    const noWrite = { scope: { write: [], read: ['x/**'] } };
    for (const kind of ['implementation', 'verification', 'docs', 'chore'] as const) {
      expect(paths(validateFirstPlan(plan([task('a', { kind, ...noWrite })])))).toContain('tasks.0.scope.write');
    }
    for (const kind of ['review', 'research'] as const) {
      expect(validateFirstPlan(plan([task('a', { kind, ...noWrite })]))).toEqual([]);
    }
  });

  it('refuses overlapping write globs between tasks that can run at the same time', () => {
    const issues = validateFirstPlan(
      plan([
        task('api', { scope: { write: ['backend/**'], read: [] } }),
        task('db', { scope: { write: ['backend/db/**'], read: [] } }),
      ]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('tasks.1.scope.write');
    expect(issues[0]?.related).toEqual(['tasks.0.scope.write']);
    expect(issues[0]?.message).toMatch(/can run at the same time/);
  });

  it('allows the overlap once a dependency orders the tasks, even through another task', () => {
    const ordered = plan([
      task('api', { scope: { write: ['backend/**'], read: [] } }),
      task('mid', { depends_on: ['api'], scope: { write: ['mid/**'], read: [] } }),
      task('db', { depends_on: ['mid'], scope: { write: ['backend/db/**'], read: [] } }),
    ]);
    expect(validateFirstPlan(ordered)).toEqual([]);
  });

  it('lets read-only review tasks run beside anything', () => {
    const p = plan([
      task('api', { scope: { write: ['**'], read: [] } }),
      task('rev', { kind: 'review', scope: { write: [], read: ['**'] } }),
    ]);
    expect(validateFirstPlan(p)).toEqual([]);
  });

  it('reports no overlap while a cycle is reported', () => {
    const p = plan([
      task('a', { depends_on: ['b'], scope: { write: ['x/**'], read: [] } }),
      task('b', { depends_on: ['a'], scope: { write: ['x/**'], read: [] } }),
    ]);
    expect(messages(validateFirstPlan(p))).not.toMatch(/same time/);
  });
});

describe('normalising', () => {
  it('trims text, drops empty lines and globs, and leaves out an empty description', () => {
    const p = normalizeFirstPlan(
      plan(
        [
          task(' api ', {
            acceptance_criteria: [' ok ', '', '  '],
            description: '  ',
            scope: { write: [' a/** ', ''], read: [''] },
          }),
        ],
        { objective: '  ' },
      ),
    );
    expect(p.objective).toBeUndefined();
    expect(p.tasks[0]).toMatchObject({ key: 'api', acceptance_criteria: ['ok'], scope: { write: ['a/**'], read: [] } });
    expect(p.tasks[0]).not.toHaveProperty('description');
  });

  it('numbers new keys', () => {
    expect(nextKey([])).toBe('task-1');
    expect(nextKey(['task-1', 'task-2'])).toBe('task-3');
    expect(nextKey(['task-2'])).toBe('task-1');
  });
});

describe('revisions', () => {
  const existing: ExistingTask[] = [
    {
      task_id: 'task_a',
      key: 'api',
      summary: 'API',
      kind: 'implementation',
      status: 'FAILED',
      depends_on: [],
      write: ['backend/**'],
    },
    {
      task_id: 'task_b',
      key: 'ui',
      summary: 'UI',
      kind: 'implementation',
      status: 'READY',
      depends_on: ['task_a'],
      write: ['frontend/**'],
    },
    {
      task_id: 'task_c',
      key: 'docs',
      summary: 'Docs',
      kind: 'docs',
      status: 'RUNNING',
      depends_on: [],
      write: ['docs/**'],
    },
    {
      task_id: 'task_d',
      key: 'old',
      summary: 'Old',
      kind: 'chore',
      status: 'COMPLETED',
      depends_on: [],
      write: ['old/**'],
    },
    {
      task_id: 'task_e',
      key: 'gone',
      summary: 'Gone',
      kind: 'chore',
      status: 'CANCELLED',
      depends_on: [],
      write: ['gone/**'],
    },
  ];
  const rev = (over: Partial<RevisionDraft>): RevisionDraft => ({
    summary: 'Fix the API task',
    rework: [],
    drop: [],
    new_tasks: [],
    ...over,
  });

  it('accepts a valid revision', () => {
    const r = rev({
      rework: [{ task_id: 'task_a', note: 'use the new client' }],
      new_tasks: [task('tests', { depends_on: ['task_c'], scope: { write: ['tests/**'], read: [] } })],
    });
    expect(validateRevision(r, existing)).toEqual([]);
  });

  it('must change something', () => {
    expect(messages(validateRevision(rev({}), existing))).toMatch(/changes nothing/);
  });

  it('reworks only FAILED tasks, with a note of 3 to 1000 characters', () => {
    const m = messages(
      validateRevision(
        rev({
          rework: [
            { task_id: 'task_b', note: 'no' },
            { task_id: 'nope', note: 'again' },
          ],
        }),
        existing,
      ),
    );
    expect(m).toMatch(/task_b is READY; only FAILED tasks can be reworked/);
    expect(m).toMatch(/nope is not a task of this plan/);
    expect(m).toMatch(/at least 3 characters/);
    expect(canRework({ status: 'FAILED' })).toBe(true);
    expect(canRework({ status: 'REWORK' })).toBe(false);
  });

  it('drops only tasks that have not started', () => {
    const m = messages(validateRevision(rev({ drop: [{ task_id: 'task_c', reason: 'not needed' }] }), existing));
    expect(m).toMatch(/task_c is RUNNING; only tasks that have not started can be dropped/);
    expect(canDrop({ status: 'PROPOSED' })).toBe(true);
    expect(canDrop({ status: 'READY' })).toBe(true);
    expect(canDrop({ status: 'ASSIGNED' })).toBe(false);
  });

  it('refuses a task both reworked and dropped, and lists twice', () => {
    const fail = { task_id: 'task_a', note: 'again please' };
    const m = messages(
      validateRevision(rev({ rework: [fail, fail], drop: [{ task_id: 'task_a', reason: 'gone now' }] }), existing),
    );
    expect(m).toMatch(/both reworked and dropped/);
    expect(m).toMatch(/rework lists a task twice/);
  });

  it('refuses dropping a task another remaining task needs', () => {
    const m = messages(
      validateRevision(rev({ drop: [{ task_id: 'task_b', reason: 'not needed' }] }), [
        ...existing,
        {
          task_id: 'task_f',
          key: 'more',
          summary: 'More',
          kind: 'implementation',
          status: 'READY',
          depends_on: ['task_b'],
          write: ['more/**'],
        },
      ]),
    );
    expect(m).toMatch(/task_b is still needed by task_f/);
  });

  it('keeps new keys unused and dependencies known', () => {
    const issues = validateRevision(
      rev({
        drop: [{ task_id: 'task_b', reason: 'not needed' }],
        new_tasks: [
          task('api', { scope: { write: ['x/**'], read: [] } }),
          task('n2', { depends_on: ['task_b', 'task_e', 'ghost', 'n2'], scope: { write: ['y/**'], read: [] } }),
        ],
      }),
      existing,
    );
    const m = messages(issues);
    expect(m).toMatch(/task key "api" is already used/);
    expect(m).toMatch(/depends on task_b, which is being dropped/);
    expect(m).toMatch(/depends on task_e, which is CANCELLED/);
    expect(m).toMatch(/"ghost", which is neither/);
    expect(m).toMatch(/depends on itself/);
    expect(paths(issues)).toContain('new_tasks.1.depends_on');
  });

  it('finds write overlaps involving new tasks, but not between existing ones', () => {
    const overlap = validateRevision(
      rev({ new_tasks: [task('more-ui', { scope: { write: ['frontend/src/**'], read: [] } })] }),
      existing,
    );
    expect(overlap).toHaveLength(1);
    expect(overlap[0]?.path).toBe('new_tasks.0.scope.write');
    expect(overlap[0]?.message).toMatch(/can run at the same time/);
    // A dependency on the existing task orders them.
    const ordered = validateRevision(
      rev({
        new_tasks: [task('more-ui', { depends_on: ['task_b'], scope: { write: ['frontend/src/**'], read: [] } })],
      }),
      existing,
    );
    expect(ordered).toEqual([]);
    // A completed task conflicts with nothing.
    expect(
      validateRevision(rev({ new_tasks: [task('x', { scope: { write: ['old/**'], read: [] } })] }), existing),
    ).toEqual([]);
  });

  it('describes what changes', () => {
    const r = rev({
      rework: [{ task_id: 'task_a', note: 'use the client' }],
      drop: [{ task_id: 'task_b', reason: 'merged' }],
      new_tasks: [task('tests')],
    });
    const c = revisionChanges(r, existing);
    expect(c.adds).toEqual([{ key: 'tests', summary: 'Do the tests work' }]);
    expect(c.keeps).toBe(3);
    expect(changeLines(c)).toEqual([
      'Add "tests": Do the tests work',
      'Rework "api" API: use the client',
      'Drop "ui" UI: merged',
      'Keep 3 tasks as they are',
    ]);
    expect(normalizeRevision(rev({ rework: [{ task_id: 'task_a', note: '  x  ' }] })).rework[0]?.note).toBe('x');
  });

  it('reads the active plan as the server does', () => {
    const active = makePlan({
      tasks: [
        makePlanTask({ key: 'api', task_id: 'task_a', status: 'FAILED' }),
        makePlanTask({ key: 'ui', task_id: 'task_b', status: 'READY', depends_on: ['api'] }),
        makePlanTask({ key: 'dropped', task_id: 'task_x', change: 'drop' }),
        makePlanTask({ key: 'none', task_id: null }),
      ],
    });
    const ex = existingFromPlan(active, [makeTask({ task_id: 'task_a', summary: 'Live API', dependencies: [] })]);
    expect(ex.map((t) => t.task_id)).toEqual(['task_a', 'task_b']);
    expect(ex[0]).toMatchObject({ summary: 'Live API', status: 'FAILED' });
    expect(ex[1]?.depends_on).toEqual(['task_a']);
  });
});

describe('JSON import and export', () => {
  it('round-trips a first plan', () => {
    const p = normalizeFirstPlan(
      plan([task('api'), task('ui', { depends_on: ['api'], scope: { write: ['ui/**'], read: [] } })]),
    );
    const back = importFirstPlan(exportJson(p));
    expect(back.ok && back.draft).toEqual({ ...p, tasks: p.tasks.map((t) => ({ ...t, description: '' })) });
  });

  it('accepts the route body form and coerces unknown values with notes', () => {
    const r = importFirstPlan(
      JSON.stringify({
        draft: {
          summary: 's',
          tasks: [{ key: 'a', kind: 'weird', priority: 3, scope: { write: ['a/**', 7] } }, 'junk'],
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.tasks[0]).toMatchObject({
      key: 'a',
      kind: 'implementation',
      priority: 'normal',
      scope: { write: ['a/**', '7'], read: [] },
    });
    expect(r.draft.tasks[1]?.key).toBe('task-2');
    expect(r.warnings.join(' ')).toMatch(/kind "weird" is not known/);
  });

  it('refuses what is not a plan', () => {
    expect(importFirstPlan('{not json').ok).toBe(false);
    expect(importFirstPlan('[1,2]')).toEqual({ ok: false, error: 'the JSON is not an object' });
    expect(importFirstPlan('{"new_tasks": []}')).toMatchObject({ ok: false, error: expect.stringMatching(/revision/) });
    expect(importRevision('{"tasks": []}')).toMatchObject({ ok: false, error: expect.stringMatching(/first plan/) });
    expect(importFirstPlan(' '.repeat(MAX_IMPORT_BYTES + 1))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/too large/),
    });
  });

  it('reads a revision', () => {
    const r = importRevision(
      JSON.stringify({
        summary: 'fix',
        rework: [{ task_id: 't1', note: 'n' }, { note: 'no id' }],
        drop: [{ task_id: 't2', reason: 'r' }],
        new_tasks: [{ key: 'x' }],
      }),
    );
    expect(r.ok && r.draft).toMatchObject({
      summary: 'fix',
      rework: [{ task_id: 't1', note: 'n' }],
      drop: [{ task_id: 't2', reason: 'r' }],
      new_tasks: [{ key: 'x' }],
    });
  });

  it('keeps hostile strings as plain data', () => {
    const hostile = '<img src=x onerror=alert(1)>\u202E\u200B';
    const r = importFirstPlan(
      JSON.stringify({ objective: hostile, summary: hostile, tasks: [{ key: 'a', summary: hostile }] }),
    );
    expect(r.ok && r.draft.tasks[0]?.summary).toBe(hostile);
    if (r.ok) expect(paths(validateFirstPlan(normalizeFirstPlan(r.draft)))).not.toContain('tasks.0.summary');
  });
});
