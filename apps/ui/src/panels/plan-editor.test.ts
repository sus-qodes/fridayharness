import { afterEach, describe, expect, it } from 'vitest';
import { draftFromProposal } from '../model/plan-draft.js';
import { ApiError } from '../platform/transport.js';
import { makeContext } from '../test/context.js';
import { makeAgent, makeGoal, makeHarness, makePlan, makePlanTask, makeSnapshot, makeTask } from '../test/fixtures.js';
import { followingTask, forgetPlanDrafts, planEditorModal, starterTask, WHOLE_PROJECT } from './plan-editor.js';
import { buttonBy, check, choose, controlBy, flush, HOSTILE, type, ZW } from './test-support.js';

const GID = 'goal_0000000000000000000000gg01';

// A draft is kept per goal for as long as the page lives: each test starts without one.
afterEach(() => forgetPlanDrafts());
const PLANS = `/goals/${GID}/plans`;

function tasksOf(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll('.pn-tasks > .pn-task'));
}

function fillTask(t: HTMLElement, o: { key?: string; summary: string; criteria: string; write?: string }) {
  if (o.key !== undefined) type(controlBy(t, 'Key'), o.key);
  type(controlBy(t, 'Summary'), o.summary);
  type(controlBy<HTMLTextAreaElement>(t, 'Acceptance criteria'), o.criteria);
  if (o.write) {
    const input = t.querySelectorAll('.pn-scope')[0]?.querySelector('.pn-scope-add input') as HTMLInputElement;
    input.value = o.write;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  }
}

/** Opens the editor's More fold, where the JSON tools live (review §4), and answers it. */
function more(el: HTMLElement): HTMLDetailsElement {
  const fold = el.querySelector('details.pn-json-tools') as HTMLDetailsElement;
  fold.open = true;
  return fold;
}

function firstPlanContext(answers = {}) {
  return makeContext({
    snapshot: makeSnapshot({ goals: [makeGoal({ status: 'OPEN', plan_id: null })] }),
    answers: { 'POST /files/match': { counts: {}, total: 0, truncated: false }, ...answers },
  });
}

describe('plan editor, first plan', () => {
  it('writes a plan and proposes it', async () => {
    const ctx = firstPlanContext({ [`POST ${PLANS}`]: makePlan({ status: 'PROPOSED' }) });
    let closed = 0;
    const m = planEditorModal(ctx, { kind: 'plan-editor', id: GID, mode: 'first' }, () => {
      closed += 1;
    });
    expect(m.title).toBe('Write the plan');
    expect(controlBy(m.el, 'Objective').value).toBe('Add Stripe subscriptions and keep one-time checkout working');
    type(controlBy<HTMLTextAreaElement>(m.el, 'Summary'), 'API first, then the page');
    fillTask(tasksOf(m.el)[0] as HTMLElement, {
      key: 'api',
      summary: 'Add the API',
      criteria: 'tests pass\n\n',
      write: 'backend/**',
    });
    buttonBy(m.el, 'Add a task').click();
    const second = tasksOf(m.el)[1] as HTMLElement;
    fillTask(second, { summary: 'Add the page', criteria: 'page renders', write: 'frontend/**' });
    check(second.querySelector('.pn-deps input') as HTMLInputElement, true);
    buttonBy(m.el, 'Propose the plan').click();
    await flush();
    const call = ctx.transport.to('POST', PLANS)[0];
    expect(call?.body).toEqual({
      draft: {
        objective: 'Add Stripe subscriptions and keep one-time checkout working',
        summary: 'API first, then the page',
        tasks: [
          {
            key: 'api',
            summary: 'Add the API',
            kind: 'implementation',
            role: 'developer',
            acceptance_criteria: ['tests pass'],
            depends_on: [],
            scope: { write: ['backend/**'], read: [] },
            priority: 'normal',
            risk_level: 'low',
          },
          {
            key: 'task-1',
            summary: 'Add the page',
            kind: 'implementation',
            role: 'developer',
            acceptance_criteria: ['page renders'],
            depends_on: ['api'],
            scope: { write: ['frontend/**'], read: [] },
            priority: 'normal',
            risk_level: 'low',
          },
        ],
      },
      trigger: 'written in the interface',
    });
    expect(closed).toBe(1);
    expect(ctx.refreshes).toBe(1);
    m.destroy();
  });

  it('gives a task to one agent, Antigravity among them, and sends no agent for the others', async () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({
        goals: [makeGoal({ status: 'OPEN', plan_id: null })],
        agents: [
          makeAgent({ agent_key: 'claude-1', role: 'backend' }),
          makeAgent({
            agent_id: 'agent_000000000000000000000ag03',
            agent_key: 'dev-1',
            status: 'DISCONNECTED',
            harness_id: 'harness_00000000000000000000ag01',
          }),
        ],
        harnesses: [
          makeHarness(),
          makeHarness({ harness_id: 'harness_00000000000000000000ag01', vendor: 'antigravity', attach_mode: 'attach' }),
        ],
      }),
      answers: {
        'POST /files/match': { counts: {}, total: 0, truncated: false },
        [`POST ${PLANS}`]: makePlan({ status: 'PROPOSED' }),
      },
    });
    const m = planEditorModal(ctx, { kind: 'plan-editor', id: GID, mode: 'first' }, () => undefined);
    type(controlBy<HTMLTextAreaElement>(m.el, 'Summary'), 'The API, and its docs');
    fillTask(tasksOf(m.el)[0] as HTMLElement, {
      key: 'api',
      summary: 'Add the API',
      criteria: 'ok',
      write: 'backend/**',
    });
    buttonBy(m.el, 'Add a task').click();
    const second = tasksOf(m.el)[1] as HTMLElement;
    fillTask(second, { key: 'docs', summary: 'Write the docs', criteria: 'ok', write: 'docs/**' });
    const assign = controlBy<HTMLSelectElement>(second, 'Assign to');
    // Friday decides by default; every agent it knows is offered, connected or not.
    expect(assign.value).toBe('');
    expect(Array.from(assign.options).map((o) => o.textContent)).toEqual([
      'Friday decides (an agent of its role)',
      'claude-1 · Claude Code',
      'dev-1 · Antigravity · not open now',
    ]);
    choose(assign, 'dev-1');
    expect(second.textContent).toContain('waits until you type /friday in Antigravity');
    buttonBy(m.el, 'Propose the plan').click();
    await flush();
    const call = ctx.transport.to('POST', PLANS)[0];
    expect(call).toBeDefined();
    const sent = (call?.body as { draft: { tasks: Record<string, unknown>[] } } | undefined)?.draft;
    expect(sent?.tasks.map((t) => [t.key, t.assign_to])).toEqual([
      ['api', undefined],
      ['docs', 'dev-1'],
    ]);
    m.destroy();
  });

  it('opens on one task filled in from the goal, which can be proposed as it stands', async () => {
    const ctx = firstPlanContext({ [`POST ${PLANS}`]: makePlan({ status: 'PROPOSED' }) });
    const m = planEditorModal(ctx, { kind: 'plan-editor', id: GID, mode: 'first' }, () => undefined);
    // What a plan is, for someone who has never written one.
    expect(m.el.querySelector('.pn-plan-intro')?.textContent).toContain(
      'A plan is the list of tasks that gets the goal done.',
    );
    expect(m.el.querySelector('.pn-plan-intro')?.textContent).toContain('For a small goal one task is enough');
    const [only] = tasksOf(m.el);
    expect(tasksOf(m.el)).toHaveLength(1);
    expect(only?.querySelector('.pn-task-title')?.textContent).toBe('Task 1');
    expect(controlBy(only as HTMLElement, 'Summary').value).toBe(
      'Add Stripe subscriptions and keep one-time checkout working',
    );
    expect(controlBy<HTMLTextAreaElement>(only as HTMLElement, 'Acceptance criteria').value).toBe(
      'It does what the goal asks',
    );
    expect(only?.querySelector('.pn-scope')?.textContent).toContain('**');
    // The first task follows nothing, so it is not asked what it depends on.
    expect(only?.querySelector('.pn-deps')).toBeNull();
    buttonBy(m.el, 'Propose the plan').click();
    await flush();
    expect(m.el.querySelector('.pn-errors-page')?.hasAttribute('hidden')).toBe(true);
    expect(ctx.transport.to('POST', PLANS)[0]?.body).toEqual({
      draft: {
        objective: 'Add Stripe subscriptions and keep one-time checkout working',
        summary: 'One task that does what the goal asks.',
        tasks: [
          {
            key: 'task-1',
            summary: 'Add Stripe subscriptions and keep one-time checkout working',
            kind: 'implementation',
            role: 'developer',
            acceptance_criteria: ['It does what the goal asks'],
            depends_on: [],
            scope: { write: ['**'], read: [] },
            priority: 'normal',
            risk_level: 'low',
          },
        ],
      },
      trigger: 'written in the interface',
    });
    m.destroy();
  });

  it('shortens a long goal to one line for the starter task', () => {
    const long = `Rework   the checkout\n\n${'and more '.repeat(60)}`;
    const starter = starterTask({ request: long });
    expect(starter.summary.length).toBeLessThanOrEqual(200);
    expect(starter.summary.startsWith('Rework the checkout and more')).toBe(true);
    expect(starter.summary).not.toContain('\n');
    expect(starter).toMatchObject({ key: 'task-1', scope: { write: [WHOLE_PROJECT], read: [] } });
  });

  it('adds a task after the one before it, free to change the whole project', () => {
    const ctx = firstPlanContext();
    const m = planEditorModal(ctx, { kind: 'plan-editor', id: GID }, () => undefined);
    buttonBy(m.el, 'Add a task').click();
    const second = tasksOf(m.el)[1] as HTMLElement;
    // "First this, then that": it follows the first, so the two may touch the same files.
    const dep = second.querySelector('.pn-deps input') as HTMLInputElement;
    expect(dep.checked).toBe(true);
    expect(second.querySelector('.pn-scope')?.textContent).toContain('**');
    expect(followingTask('task-2', undefined).depends_on).toEqual([]);
    expect(followingTask('task-2', { ...starterTask({ request: 'x' }), key: ' api ' }).depends_on).toEqual(['api']);
    m.destroy();
  });

  it('narrows "the whole project" to the first folder named, and widens folders back to it', () => {
    const ctx = firstPlanContext();
    const m = planEditorModal(ctx, { kind: 'plan-editor', id: GID }, () => undefined);
    const task = tasksOf(m.el)[0] as HTMLElement;
    const globs = () =>
      Array.from(task.querySelectorAll('.pn-scope')[0]?.querySelectorAll('.pn-globs li') ?? []).length;
    const add = (glob: string) => {
      const input = task.querySelectorAll('.pn-scope')[0]?.querySelector('.pn-scope-add input') as HTMLInputElement;
      input.value = glob;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    };
    const exported = () => {
      more(m.el);
      buttonBy(m.el, 'Export JSON').click();
      return JSON.parse((m.el.querySelector('.pn-json') as HTMLTextAreaElement).value).tasks[0].scope.write;
    };
    expect(exported()).toEqual(['**']);
    // A folder added to the whole project is the person keeping the task to that folder.
    add('backend/**');
    expect(exported()).toEqual(['backend/**']);
    add('docs/**');
    expect(exported()).toEqual(['backend/**', 'docs/**']);
    expect(globs()).toBe(2);
    // The whole project added to folders replaces them: together they would mean the same.
    add('**');
    expect(exported()).toEqual(['**']);
    expect(globs()).toBe(1);
    m.destroy();
  });

  it('keeps what is seldom changed under Advanced, which opens when one of its fields is wrong', async () => {
    const ctx = firstPlanContext();
    const m = planEditorModal(ctx, { kind: 'plan-editor', id: GID }, () => undefined);
    const task = tasksOf(m.el)[0] as HTMLElement;
    const advanced = task.querySelector('details.pn-task-advanced') as HTMLDetailsElement;
    expect(advanced.open).toBe(false);
    expect(advanced.querySelector('summary')?.textContent).toBe('Advanced');
    for (const label of ['Key', 'Kind', 'Role', 'Priority', 'Risk']) {
      expect(advanced.contains(controlBy(task, label)), label).toBe(true);
    }
    expect(advanced.textContent).toContain('Read scope');
    // What a person fills in stays in view.
    for (const label of ['Summary', 'Description', 'Acceptance criteria', 'Assign to']) {
      expect(advanced.contains(controlBy(task, label)), label).toBe(false);
    }
    expect(advanced.contains(task.querySelectorAll('.pn-scope')[0] as Node)).toBe(false);
    type(controlBy(task, 'Role'), 'Not A Role');
    buttonBy(m.el, 'Propose the plan').click();
    await flush();
    expect(ctx.transport.to('POST', PLANS)).toHaveLength(0);
    expect(advanced.open).toBe(true);
    expect(controlBy(task, 'Role').getAttribute('aria-invalid')).toBe('true');
    m.destroy();
  });

  it('runs the page checks first and shows them beside the fields', async () => {
    const ctx = firstPlanContext();
    const m = planEditorModal(ctx, { kind: 'plan-editor', id: GID, mode: 'first' }, () => undefined);
    // The editor opens on a plan that could be sent: what the checks catch is what is taken out of it.
    type(controlBy<HTMLTextAreaElement>(m.el, 'Summary'), '');
    buttonBy(tasksOf(m.el)[0] as HTMLElement, 'Remove **').click();
    buttonBy(m.el, 'Propose the plan').click();
    await flush();
    expect(ctx.transport.to('POST', PLANS)).toHaveLength(0);
    const page = m.el.querySelector('.pn-errors-page') as HTMLElement;
    expect(page.hidden).toBe(false);
    expect(page.textContent).toMatch(/the summary needs at least 5 characters/);
    expect(page.textContent).toMatch(/must declare a write scope/);
    const summary = controlBy<HTMLTextAreaElement>(m.el, 'Summary');
    expect(summary.getAttribute('aria-invalid')).toBe('true');
    // Live once tried: fixing a field clears its error.
    type(summary, 'A fine summary');
    expect(summary.getAttribute('aria-invalid')).toBeNull();
    m.destroy();
  });

  it('flags overlapping write scopes of tasks that can run together', async () => {
    const ctx = firstPlanContext();
    const m = planEditorModal(ctx, { kind: 'plan-editor', id: GID }, () => undefined);
    type(controlBy<HTMLTextAreaElement>(m.el, 'Summary'), 'Two tasks');
    fillTask(tasksOf(m.el)[0] as HTMLElement, { summary: 'Backend', criteria: 'ok', write: 'backend/**' });
    buttonBy(m.el, 'Add a task').click();
    const second = tasksOf(m.el)[1] as HTMLElement;
    fillTask(second, { summary: 'Backend db', criteria: 'ok', write: 'backend/db/**' });
    // An added task follows the one before it; taken out of that order, the two run side by side.
    check(second.querySelector('.pn-deps input') as HTMLInputElement, false);
    buttonBy(m.el, 'Propose the plan').click();
    await flush();
    expect(ctx.transport.to('POST', PLANS)).toHaveLength(0);
    expect(m.el.textContent).toMatch(/can run at the same time but both write backend\/\*\* \/ backend\/db\/\*\*/);
    expect(m.el.querySelectorAll('.pn-scope.pn-invalid')).toHaveLength(2);
    m.destroy();
  });

  it("shows the daemon's details.errors as text beside the form", async () => {
    const ctx = firstPlanContext({
      [`POST ${PLANS}`]: () => {
        throw new ApiError(400, 'COS-1003', 'schema_mismatch', 'the plan is not valid', false, {
          errors: ['task "api" must declare scope.write', HOSTILE],
        });
      },
    });
    let closed = false;
    const m = planEditorModal(ctx, { kind: 'plan-editor', id: GID }, () => {
      closed = true;
    });
    type(controlBy<HTMLTextAreaElement>(m.el, 'Summary'), 'One task');
    fillTask(tasksOf(m.el)[0] as HTMLElement, { summary: 'Backend', criteria: 'ok', write: 'backend/**' });
    buttonBy(m.el, 'Propose the plan').click();
    await flush();
    const server = Array.from(m.el.querySelectorAll('.pn-errors')).find((e) =>
      e.textContent?.includes('Friday refused it'),
    ) as HTMLElement;
    expect(server.hidden).toBe(false);
    expect(server.textContent).toContain('must declare scope.write');
    expect(server.textContent).toContain(HOSTILE);
    expect(m.el.querySelector('img')).toBeNull();
    expect(ctx.toasts.at(-1)).toMatchObject({ kind: 'error', text: 'Propose the plan' });
    expect(closed).toBe(false);
    m.destroy();
  });

  it('renames dependencies with the key and offers only earlier keys', () => {
    const ctx = firstPlanContext();
    const m = planEditorModal(ctx, { kind: 'plan-editor', id: GID }, () => undefined);
    buttonBy(m.el, 'Add a task').click();
    buttonBy(m.el, 'Add a task').click();
    const [first, second, third] = tasksOf(m.el) as HTMLElement[];
    expect(first?.querySelectorAll('.pn-deps input')).toHaveLength(0);
    expect(third?.querySelectorAll('.pn-deps input')).toHaveLength(2);
    check(second?.querySelector('.pn-deps input') as HTMLInputElement, true);
    type(controlBy(first as HTMLElement, 'Key'), 'api');
    expect(second?.querySelector('.pn-deps')?.textContent).toContain('api');
    more(m.el);
    buttonBy(m.el, 'Export JSON').click();
    const json = JSON.parse((m.el.querySelector('.pn-json') as HTMLTextAreaElement).value);
    expect(json.tasks[1].depends_on).toEqual(['api']);
    buttonBy(m.el, 'Remove task 1').click();
    expect(tasksOf(m.el)).toHaveLength(2);
    buttonBy(m.el, 'Export JSON').click();
    expect(JSON.parse((m.el.querySelector('.pn-json') as HTMLTextAreaElement).value).tasks[0].depends_on).toEqual([]);
    m.destroy();
  });

  it('keeps the JSON tools behind a More fold after the tasks, closed until opened', () => {
    const ctx = firstPlanContext();
    const m = planEditorModal(ctx, { kind: 'plan-editor', id: GID }, () => undefined);
    const fold = m.el.querySelector('details.pn-json-tools') as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    expect(fold.querySelector('summary')?.textContent).toBe('More');
    expect(fold.contains(buttonBy(m.el, 'Export JSON'))).toBe(true);
    expect(fold.contains(buttonBy(m.el, 'Import JSON'))).toBe(true);
    // The editor opens on its fields: the fold comes after the tasks, not above the Objective.
    const objective = controlBy(m.el, 'Objective');
    expect(objective.compareDocumentPosition(fold) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    m.destroy();
  });

  it('imports a plan from JSON and reports what it could not read', () => {
    const ctx = firstPlanContext();
    const m = planEditorModal(ctx, { kind: 'plan-editor', id: GID }, () => undefined);
    more(m.el);
    buttonBy(m.el, 'Import JSON').click();
    const area = m.el.querySelector('.pn-json') as HTMLTextAreaElement;
    area.value = '{broken';
    buttonBy(m.el, 'Load this JSON').click();
    expect(m.el.querySelector('.pn-json-status')?.textContent).toMatch(/^Not loaded: not valid JSON/);
    area.value = JSON.stringify({
      summary: `Imported ${ZW}`,
      tasks: [
        { key: 'a', summary: HOSTILE, kind: 'docs', acceptance_criteria: ['x'], scope: { write: ['docs/**'] } },
        { key: 'b', summary: 'B', kind: 'nonsense', depends_on: ['a'] },
      ],
    });
    buttonBy(m.el, 'Load this JSON').click();
    expect(m.el.querySelector('.pn-json-status')?.textContent).toMatch(/kind "nonsense" is not known/);
    expect(tasksOf(m.el)).toHaveLength(2);
    expect(controlBy(tasksOf(m.el)[0] as HTMLElement, 'Summary').value).toBe(HOSTILE);
    expect(m.el.querySelector('img')).toBeNull();
    expect(tasksOf(m.el)[0]?.querySelector('.pn-scope')?.textContent).toContain('docs/**');
    m.destroy();
  });

  it('reads the goal when the board does not show it', async () => {
    const ctx = makeContext({
      answers: {
        [`GET /goals/${GID}`]: { goal: makeGoal({ request: 'Read from the daemon' }), active: null, proposed: null },
      },
    });
    const m = planEditorModal(ctx, { kind: 'plan-editor', id: GID }, () => undefined);
    expect(m.el.textContent).toContain('Reading the goal');
    await flush();
    expect(controlBy(m.el, 'Objective').value).toBe('Read from the daemon');
    m.destroy();
  });
});

describe('plan editor, revision', () => {
  function revisionContext(answers = {}) {
    const active = makePlan({
      status: 'ACTIVE',
      tasks: [
        makePlanTask({ key: 'api', task_id: 'task_api', status: 'FAILED', scope: { write: ['backend/**'], read: [] } }),
        makePlanTask({ key: 'ui', task_id: 'task_ui', status: 'READY', scope: { write: ['frontend/**'], read: [] } }),
        makePlanTask({
          key: 'docs',
          task_id: 'task_docs',
          status: 'RUNNING',
          summary: HOSTILE,
          scope: { write: ['docs/**'], read: [] },
        }),
      ],
    });
    return makeContext({
      snapshot: makeSnapshot({
        goals: [makeGoal()],
        plans: { [GID]: { active, proposed: null } },
        tasks: [makeTask({ task_id: 'task_api', status: 'FAILED', summary: 'Add the API' })],
      }),
      answers: { 'POST /files/match': { counts: {}, total: 0, truncated: false }, ...answers },
    });
  }

  it('reworks FAILED tasks, drops not-started ones, shows what changes and confirms it', async () => {
    const ctx = revisionContext({ [`POST ${PLANS}`]: makePlan({ status: 'PROPOSED', version: 2 }) });
    let closed = 0;
    const m = planEditorModal(ctx, { kind: 'plan-editor', id: GID, mode: 'revision' }, () => {
      closed += 1;
    });
    expect(m.title).toBe('Revise the plan');
    const items = Array.from(m.el.querySelectorAll('.pn-existing-item')) as HTMLElement[];
    expect(items).toHaveLength(3);
    expect(items[0]?.textContent).toContain('Rework with a note');
    expect(items[1]?.textContent).toContain('Drop it (not started)');
    expect(items[2]?.textContent).toContain('kept as it is');
    expect(m.el.querySelector('img')).toBeNull();
    type(controlBy<HTMLTextAreaElement>(m.el, 'Summary of the revision'), 'Retry the API');
    check(items[0]?.querySelector('label.check input') as HTMLInputElement, true);
    type(items[0]?.querySelector('textarea') as HTMLTextAreaElement, 'use the new client');
    check(items[1]?.querySelector('label.check input') as HTMLInputElement, true);
    type(items[1]?.querySelector('.pn-existing-extra input') as HTMLInputElement, 'merged into api');
    const changes = m.el.querySelector('.pn-changes')?.textContent ?? '';
    expect(changes).toContain('Rework "api" Add the API: use the new client');
    expect(changes).toContain('Drop "ui"');
    expect(changes).toContain('Keep 1 task as it is');
    ctx.confirmAnswer = false;
    buttonBy(m.el, 'Propose the revision').click();
    await flush();
    expect(ctx.confirms[0]?.body).toEqual(expect.arrayContaining([expect.stringContaining('Rework "api"')]));
    expect(ctx.transport.to('POST', PLANS)).toHaveLength(0);
    ctx.confirmAnswer = true;
    buttonBy(m.el, 'Propose the revision').click();
    await flush();
    expect(ctx.transport.to('POST', PLANS)[0]?.body).toEqual({
      draft: {
        summary: 'Retry the API',
        rework: [{ task_id: 'task_api', note: 'use the new client' }],
        drop: [{ task_id: 'task_ui', reason: 'merged into api' }],
        new_tasks: [],
      },
      trigger: 'written in the interface',
    });
    expect(closed).toBe(1);
    m.destroy();
  });

  it('adds new tasks that may depend on existing ones, and checks the rules', async () => {
    const ctx = revisionContext();
    const m = planEditorModal(ctx, { kind: 'plan-editor', id: GID, mode: 'revision' }, () => undefined);
    buttonBy(m.el, 'Add a task').click();
    const t = tasksOf(m.el)[0] as HTMLElement;
    expect(controlBy(t, 'Key').value).toBe('task-1');
    const deps = Array.from(t.querySelectorAll('.pn-deps label')).map((l) => l.textContent ?? '');
    expect(deps).toHaveLength(3);
    expect(deps[0]).toContain('api');
    fillTask(t, { summary: 'More frontend', criteria: 'ok', write: 'frontend/src/**' });
    type(controlBy<HTMLTextAreaElement>(m.el, 'Summary of the revision'), 'Add a task');
    buttonBy(m.el, 'Propose the revision').click();
    await flush();
    expect(m.el.textContent).toMatch(/can run at the same time/);
    expect(ctx.confirms).toHaveLength(0);
    m.destroy();
  });

  it('refuses a rework note that is too short', async () => {
    const ctx = revisionContext();
    const m = planEditorModal(ctx, { kind: 'plan-editor', id: GID, mode: 'revision' }, () => undefined);
    type(controlBy<HTMLTextAreaElement>(m.el, 'Summary of the revision'), 'Retry the API');
    const item = m.el.querySelector('.pn-existing-item') as HTMLElement;
    check(item.querySelector('label.check input') as HTMLInputElement, true);
    type(item.querySelector('textarea') as HTMLTextAreaElement, 'no');
    buttonBy(m.el, 'Propose the revision').click();
    await flush();
    expect(item.querySelector('textarea')?.getAttribute('aria-invalid')).toBe('true');
    expect(item.textContent).toContain('the note needs at least 3 characters');
    expect(ctx.transport.to('POST', PLANS)).toHaveLength(0);
    m.destroy();
  });
});

describe('a draft that is not proposed yet (review of 2026-11-16)', () => {
  /** Mounts the dialog as the modal host does, with its close guarded by `beforeClose`. */
  function open(ctx: ReturnType<typeof firstPlanContext>) {
    let closed = 0;
    const m = planEditorModal(ctx, { kind: 'plan-editor', id: GID, mode: 'first' }, () => {
      closed += 1;
    });
    return { m, closed: () => closed };
  }

  it('closes without a question while nothing was typed, and asks once something was', async () => {
    const ctx = firstPlanContext();
    const { m } = open(ctx);
    expect(await m.beforeClose()).toBe(true);
    expect(ctx.confirms).toHaveLength(0);
    const [t1] = tasksOf(m.el);
    fillTask(t1 as HTMLElement, { summary: 'Build the API', criteria: 'tests pass', write: 'backend/**' });
    ctx.confirmAnswer = false;
    expect(await m.beforeClose()).toBe(false);
    expect(ctx.confirms[0]).toMatchObject({
      title: 'Close the plan editor?',
      confirmLabel: 'Close',
      cancelLabel: 'Keep writing',
    });
    expect([ctx.confirms[0]?.body].flat().join(' ')).toContain('Your draft is kept for this goal');
    ctx.confirmAnswer = true;
    expect(await m.beforeClose()).toBe(true);
    m.destroy();
  });

  it('keeps the draft when the dialog goes away, brings it back, and can start over', () => {
    const ctx = firstPlanContext();
    const first = open(ctx).m;
    fillTask(tasksOf(first.el)[0] as HTMLElement, {
      summary: `Build the API ${HOSTILE}`,
      criteria: 'tests pass',
      write: 'backend/**',
    });
    // Another dialog opened over it, Esc, the close button: whichever way, it is destroyed.
    first.destroy();

    const again = open(ctx).m;
    expect(again.el.textContent).toContain('Your draft for this goal was kept');
    const summary = controlBy(tasksOf(again.el)[0] as HTMLElement, 'Summary') as HTMLInputElement;
    expect(summary.value).toBe(`Build the API ${HOSTILE}`);
    expect(again.el.querySelector('img')).toBeNull();
    // Another goal's editor does not get it.
    const other = planEditorModal(
      makeContext({ snapshot: makeSnapshot({ goals: [makeGoal({ goal_id: 'goal_other' })] }) }),
      { kind: 'plan-editor', id: 'goal_other', mode: 'first' },
      () => undefined,
    );
    expect(other.el.textContent).not.toContain('Your draft for this goal was kept');
    other.destroy();

    // Starting over is the editor as it opens: the task filled in from the goal.
    buttonBy(again.el, 'Start over').click();
    expect((controlBy(tasksOf(again.el)[0] as HTMLElement, 'Summary') as HTMLInputElement).value).toBe(
      'Add Stripe subscriptions and keep one-time checkout working',
    );
    expect(again.el.textContent).not.toContain('Your draft for this goal was kept');
    again.destroy();
    // Started over and closed: nothing is kept.
    const third = open(ctx).m;
    expect(third.el.textContent).not.toContain('Your draft for this goal was kept');
    third.destroy();
  });

  it('keeps nothing once the plan was proposed, and closes without asking', async () => {
    const ctx = firstPlanContext({ [`POST /goals/${GID}/plans`]: { plan_id: 'plan_1', version: 1 } });
    const { m, closed } = open(ctx);
    type(controlBy(m.el, 'Summary') as HTMLTextAreaElement, 'One task for the API');
    fillTask(tasksOf(m.el)[0] as HTMLElement, {
      summary: 'Build the API',
      criteria: 'tests pass',
      write: 'backend/**',
    });
    buttonBy(m.el, 'Propose the plan').click();
    await flush();
    expect(ctx.transport.to('POST', `/goals/${GID}/plans`)).toHaveLength(1);
    expect(closed()).toBe(1);
    expect(await m.beforeClose()).toBe(true);
    expect(ctx.confirms).toHaveLength(0);
    m.destroy();
    const again = open(ctx).m;
    expect(again.el.textContent).not.toContain('Your draft for this goal was kept');
    again.destroy();
  });
});

describe('a proposed plan, changed before it is approved (2026-11-17)', () => {
  const proposedFirst = makePlan({
    version: 1,
    status: 'PROPOSED',
    summary: `Two steps ${HOSTILE}`,
    proposed_by: { kind: 'master_brain', id: 'master-brain' },
    tasks: [
      makePlanTask({
        key: 'page',
        position: 1,
        summary: 'Add the page',
        role: 'frontend',
        depends_on: ['api'],
        acceptance_criteria: ['the page renders'],
        scope: { write: ['frontend/**'], read: ['backend/**'] },
        assign_to: 'claude-1',
      }),
      makePlanTask({
        key: 'api',
        position: 0,
        summary: 'Add the API',
        description: 'Follow the existing routes.',
        acceptance_criteria: ['tests pass'],
        priority: 'high',
      }),
    ],
  });

  it('turns a proposed first plan into the draft of the editor, in its order', () => {
    expect(draftFromProposal(proposedFirst, { revision: false, objective: ' Ship it ' })).toEqual({
      objective: 'Ship it',
      summary: `Two steps ${HOSTILE}`,
      tasks: [
        {
          key: 'api',
          summary: 'Add the API',
          kind: 'implementation',
          role: 'backend',
          description: 'Follow the existing routes.',
          acceptance_criteria: ['tests pass'],
          depends_on: [],
          scope: { write: ['backend/**'], read: [] },
          priority: 'high',
          risk_level: 'low',
        },
        {
          key: 'page',
          summary: 'Add the page',
          kind: 'implementation',
          role: 'frontend',
          acceptance_criteria: ['the page renders'],
          depends_on: ['api'],
          scope: { write: ['frontend/**'], read: ['backend/**'] },
          priority: 'normal',
          risk_level: 'low',
          assign_to: 'claude-1',
        },
      ],
    });
  });

  it('turns a proposed revision into what it changes, naming existing tasks by their id', () => {
    const revision = makePlan({
      version: 2,
      status: 'PROPOSED',
      summary: 'Fix the API, drop the docs, add tests',
      tasks: [
        makePlanTask({ key: 'api', position: 0, change: 'rework', task_id: 'task_api', note: 'handle empty carts' }),
        makePlanTask({ key: 'ui', position: 1, change: 'keep', task_id: 'task_ui' }),
        makePlanTask({ key: 'docs', position: 2, change: 'drop', task_id: 'task_docs', note: 'not needed' }),
        makePlanTask({
          key: 'tests',
          position: 3,
          change: 'new',
          summary: 'Test it',
          depends_on: ['ui', 'helpers'],
          acceptance_criteria: [],
        }),
        makePlanTask({ key: 'helpers', position: 4, change: 'new', summary: 'Add helpers', kind: 'odd' as never }),
      ],
    });
    expect(draftFromProposal(revision, { revision: true })).toEqual({
      summary: 'Fix the API, drop the docs, add tests',
      rework: [{ task_id: 'task_api', note: 'handle empty carts' }],
      drop: [{ task_id: 'task_docs', reason: 'not needed' }],
      new_tasks: [
        expect.objectContaining({
          key: 'tests',
          // A task of the active plan by its id, another new task by its key.
          depends_on: ['task_ui', 'helpers'],
          // No criterion yet: one empty line to fill, as a new task has.
          acceptance_criteria: [''],
        }),
        // A kind this page does not know becomes implementation, as an import does.
        expect.objectContaining({ key: 'helpers', kind: 'implementation' }),
      ],
    });
  });

  function open(active: ReturnType<typeof makePlan> | null, proposed: ReturnType<typeof makePlan>, answers = {}) {
    const ctx = makeContext({
      snapshot: makeSnapshot({
        goals: [makeGoal({ status: active ? 'ACTIVE' : 'OPEN' })],
        plans: { [GID]: { active, proposed } },
        tasks: [makeTask({ task_id: 'task_api', status: 'FAILED', summary: 'Add the API' })],
      }),
      answers: { 'POST /files/match': { counts: {}, total: 0, truncated: false }, ...answers },
    });
    let closed = 0;
    const m = planEditorModal(
      ctx,
      { kind: 'plan-editor', id: GID, mode: active ? 'revision' : 'first', seed: 'proposed' },
      () => {
        closed += 1;
      },
    );
    return { ctx, m, closed: () => closed };
  }

  it('opens on the proposal, says what proposing it does, and sends the edited plan', async () => {
    const { ctx, m, closed } = open(null, proposedFirst, {
      [`POST ${PLANS}`]: makePlan({ status: 'PROPOSED', version: 2 }),
    });
    expect(m.title).toBe('Edit the proposed plan');
    expect(m.el.textContent).toContain(
      'This is version 1 as it was proposed. Change what you like: proposing it replaces that version',
    );
    expect(m.el.textContent).not.toContain('approve or reject it on the board');
    expect(controlBy<HTMLTextAreaElement>(m.el, 'Summary').value).toBe(`Two steps ${HOSTILE}`);
    expect(m.el.querySelector('img')).toBeNull();
    const [api, page] = tasksOf(m.el) as [HTMLElement, HTMLElement];
    expect(tasksOf(m.el)).toHaveLength(2);
    expect(controlBy(api, 'Summary').value).toBe('Add the API');
    expect(controlBy<HTMLTextAreaElement>(api, 'Description').value).toBe('Follow the existing routes.');
    expect(controlBy(page, 'Role').value).toBe('frontend');
    expect(controlBy<HTMLSelectElement>(page, 'Assign to').value).toBe('claude-1');
    expect((page.querySelector('.pn-deps input') as HTMLInputElement).checked).toBe(true);
    // Opened and closed without a change: nothing to ask about, and nothing kept as a draft.
    expect(await m.beforeClose()).toBe(true);
    expect(ctx.confirms).toHaveLength(0);
    type(controlBy(api, 'Summary'), 'Add the API and its tests');
    buttonBy(m.el, 'Propose the plan').click();
    await flush();
    const sent = ctx.transport.to('POST', PLANS)[0]?.body as { draft: { tasks: { summary: string }[] } } | undefined;
    expect(sent?.draft.tasks.map((t) => t.summary)).toEqual(['Add the API and its tests', 'Add the page']);
    expect(closed()).toBe(1);
    m.destroy();
  });

  it('keeps an edited proposal apart from a plan written from nothing, and starts over from the proposal', () => {
    const first = open(null, proposedFirst);
    type(controlBy(tasksOf(first.m.el)[0] as HTMLElement, 'Summary'), 'Changed by me');
    first.m.destroy();
    // The plain editor of the same goal does not get the edited proposal as its draft.
    const plain = planEditorModal(first.ctx, { kind: 'plan-editor', id: GID, mode: 'first' }, () => undefined);
    expect(plain.el.textContent).not.toContain('Your draft for this goal was kept');
    plain.destroy();
    const again = planEditorModal(
      first.ctx,
      { kind: 'plan-editor', id: GID, mode: 'first', seed: 'proposed' },
      () => undefined,
    );
    expect(again.el.textContent).toContain('Your draft for this goal was kept');
    expect(controlBy(tasksOf(again.el)[0] as HTMLElement, 'Summary').value).toBe('Changed by me');
    buttonBy(again.el, 'Start over').click();
    expect(controlBy(tasksOf(again.el)[0] as HTMLElement, 'Summary').value).toBe('Add the API');
    again.destroy();
  });

  it('opens a proposed revision as the changes it makes to the active plan', () => {
    const active = makePlan({
      status: 'ACTIVE',
      tasks: [
        makePlanTask({ key: 'api', task_id: 'task_api', status: 'FAILED', scope: { write: ['backend/**'], read: [] } }),
        makePlanTask({ key: 'ui', task_id: 'task_ui', status: 'READY', scope: { write: ['frontend/**'], read: [] } }),
      ],
    });
    const revision = makePlan({
      version: 2,
      status: 'PROPOSED',
      summary: 'Fix the API and add its tests',
      proposed_by: { kind: 'master_brain', id: 'master-brain' },
      tasks: [
        makePlanTask({ key: 'api', position: 0, change: 'rework', task_id: 'task_api', note: 'handle empty carts' }),
        makePlanTask({ key: 'ui', position: 1, change: 'keep', task_id: 'task_ui' }),
        makePlanTask({
          key: 'api-tests',
          position: 2,
          change: 'new',
          summary: 'Test the API',
          acceptance_criteria: ['tests pass'],
          scope: { write: ['backend/test/**'], read: [] },
          depends_on: ['api'],
        }),
      ],
    });
    const { m } = open(active, revision);
    expect(m.title).toBe('Edit the proposed plan');
    expect(m.el.textContent).toContain('This is version 2 as it was proposed.');
    expect(controlBy<HTMLTextAreaElement>(m.el, 'Summary of the revision').value).toBe('Fix the API and add its tests');
    // The rework it proposed is ticked with its note, and its new task is there to change.
    const note = m.el.querySelector('textarea[aria-label="Rework note for api"]') as HTMLTextAreaElement;
    expect(note.value).toBe('handle empty carts');
    const added = Array.from(m.el.querySelectorAll('.pn-tasks > .pn-task')) as HTMLElement[];
    expect(added).toHaveLength(1);
    expect(controlBy(added[0] as HTMLElement, 'Summary').value).toBe('Test the API');
    m.destroy();
  });
});
