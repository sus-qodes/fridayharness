import { describe, expect, it } from 'vitest';
import { ApiError } from '../platform/transport.js';
import { makeContext } from '../test/context.js';
import { makeGoal, makePlan, makePlanTask, makeSnapshot, makeTask } from '../test/fixtures.js';
import { planEditorModal } from './plan-editor.js';
import { buttonBy, check, controlBy, flush, HOSTILE, type, ZW } from './test-support.js';

const GID = 'goal_0000000000000000000000gg01';
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

  it('runs the page checks first and shows them beside the fields', async () => {
    const ctx = firstPlanContext();
    const m = planEditorModal(ctx, { kind: 'plan-editor', id: GID, mode: 'first' }, () => undefined);
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
    fillTask(tasksOf(m.el)[1] as HTMLElement, { summary: 'Backend db', criteria: 'ok', write: 'backend/db/**' });
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
    buttonBy(m.el, 'Export JSON').click();
    const json = JSON.parse((m.el.querySelector('.pn-json') as HTMLTextAreaElement).value);
    expect(json.tasks[1].depends_on).toEqual(['api']);
    buttonBy(m.el, 'Remove task 1').click();
    expect(tasksOf(m.el)).toHaveLength(2);
    buttonBy(m.el, 'Export JSON').click();
    expect(JSON.parse((m.el.querySelector('.pn-json') as HTMLTextAreaElement).value).tasks[0].depends_on).toEqual([]);
    m.destroy();
  });

  it('imports a plan from JSON and reports what it could not read', () => {
    const ctx = firstPlanContext();
    const m = planEditorModal(ctx, { kind: 'plan-editor', id: GID }, () => undefined);
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
