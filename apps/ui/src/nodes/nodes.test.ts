import type { SnapshotTask } from '@friday/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveBoard, type GoalGroup, type PodModel } from '../model/board.js';
import type { AgentActivity } from '../store/state.js';
import { makeContext } from '../test/context.js';
import {
  makeAgent,
  makeGoal,
  makeHarness,
  makePlan,
  makePlanTask,
  makeRun,
  makeScenario,
  makeTask,
  makeVerification,
} from '../test/fixtures.js';
import { createAgentPod, type PodCardModel, podModelName, podUsage, ToolDurations, vendorLabel } from './agent-pod.js';
import { actionButton, fingerprint, pills } from './common.js';
import { createGoalNode, integrationText, progressPercent } from './goal-node.js';
import { ARM_DELAY_MS, Arming, createPlanGhost, createPlanReviewBar, planCounts, proposer } from './plan-ghost.js';
import { createTaskNode, statText, statusColor, type TaskCardModel, taskActions, taskDuration } from './task-node.js';

const HOSTILE = '<img src=x onerror=alert(1)>';
const BIDI = '‮';
const ZW = '​';
const LONG = 'x'.repeat(5000);
const flush = () => new Promise((r) => setTimeout(r, 0));

function taskModel(task: Partial<SnapshotTask> = {}, extra: Partial<TaskCardModel> = {}): TaskCardModel {
  return {
    task: makeTask(task),
    run: null,
    harness: null,
    verification: null,
    integration: null,
    reservations: [],
    stats: null,
    files: null,
    recoveryQuestion: false,
    dropped: false,
    proposedVersion: null,
    selected: false,
    now: Date.parse('2026-10-17T10:05:00.000Z'),
    ...extra,
  };
}

function click(el: Element | null | undefined): void {
  if (!el) throw new Error('element not found');
  (el as HTMLElement).click();
}

const actionOf = (root: Element, action: string) => root.querySelector(`[data-action="${action}"]`);

function expectNoMarkup(el: Element): void {
  expect(el.querySelector('img')).toBeNull();
  expect(el.querySelector('script')).toBeNull();
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('task card', () => {
  it('renders hostile strings as text with visible marks where a human decides', () => {
    const ctx = makeContext();
    const glob = `src/${BIDI}evil${ZW}/**`;
    const m = taskModel(
      {
        summary: `${HOSTILE} ${BIDI}reversed ${LONG}`,
        acceptance_criteria: [`${HOSTILE} criterion`, LONG, 'third', 'fourth'],
        scope: { write: [glob], read: [] },
        agent_key: `bad${ZW}key`,
        status: 'WAITING',
        waiting_reason: 'blocked',
        waiting_note: `${HOSTILE}${BIDI} ${LONG}`,
      },
      {
        run: makeRun({ branch_ref: `friday/${BIDI}task` }),
        reservations: [
          {
            reservation_id: 'r1',
            task_id: 't',
            pattern: `pnpm-lock${ZW}.yaml`,
            status: 'active',
            via: 'write',
            acquired_at: '',
            ended_at: null,
            note: null,
          },
        ],
      },
    );
    const node = createTaskNode(ctx, m);
    document.body.append(node.el);
    const el = node.el;
    expectNoMarkup(el);
    expect(el.textContent).toContain(HOSTILE);
    const summary = el.querySelector('.nd-summary') as HTMLElement;
    expect(summary.textContent).not.toContain(BIDI);
    expect(Array.from(summary.textContent ?? '').length).toBeLessThanOrEqual(240);
    const scope = el.querySelector('.nd-scope') as HTMLElement;
    expect(scope.textContent).toContain('⟨U+202E⟩');
    expect(scope.textContent).toContain('⟨U+200B⟩');
    expect(el.querySelector('.nd-branch')?.textContent).toContain('⟨U+202E⟩');
    expect(el.querySelector('.nd-agent')?.textContent).toContain('⟨U+200B⟩');
    expect(el.querySelector('.nd-reservation')?.textContent).toContain('⟨U+200B⟩');
    const criteria = el.querySelectorAll('.nd-criteria li');
    expect(criteria).toHaveLength(4); // three shown and "+1 more"
    expect(criteria[0]?.textContent).toBe(`${HOSTILE} criterion`);
    expect(Array.from(criteria[1]?.textContent ?? '').length).toBeLessThanOrEqual(140);
    expect(criteria[3]?.textContent).toBe('+1 more');
    const note = el.querySelector('.nd-note') as HTMLElement;
    expect(note.textContent).toContain('The agent needs you');
    expect(note.textContent).not.toContain(BIDI);
    expect(el.querySelector('.nd-status')?.textContent).toContain('blocked: needs you');
    expect(el.dataset.status).toBe('WAITING');
    expect(el.getAttribute('role')).toBe('group');
    expect(el.tabIndex).toBe(0);
    node.destroy();
    expect(el.isConnected).toBe(false);
  });

  it('shows kind, priority, risk, checks, conflicts, duration and line counts', () => {
    const ctx = makeContext();
    const node = createTaskNode(
      ctx,
      taskModel(
        {
          kind: 'docs',
          priority: 'urgent',
          risk_level: 'high',
          status: 'COMPLETED',
          started_at: '2026-10-17T10:00:00.000Z',
          completed_at: '2026-10-17T10:03:05.000Z',
        },
        {
          verification: makeVerification(),
          integration: { status: 'conflicted', conflicts: ['a.ts', 'b.ts'], summary: null } as never,
          stats: { added: 14, removed: 2 },
          files: 3,
          dropped: true,
          proposedVersion: 3,
        },
      ),
    );
    const t = node.el.textContent ?? '';
    expect(node.el.querySelector('.nd-kind')?.textContent).toBe('docs');
    expect(t).toContain('Urgent');
    expect(t).toContain('High risk');
    expect(t).toContain('Checks 1 of 1 passed');
    expect(t).toContain('Conflict (2)');
    expect(t).toContain('Dropped in plan v3');
    expect(t).toContain('3m 05s');
    expect(t).toContain('3 files');
    expect(node.el.querySelector('.nd-lines')?.textContent).toBe('+14 −2');
    expect(node.el.style.getPropertyValue('--nd-status')).toBe('var(--status-completed)');
  });

  it('shows "—" until the line counts answer, then updates in place', () => {
    const ctx = makeContext();
    const node = createTaskNode(ctx, taskModel());
    const body = node.el.querySelector('.nd-body');
    expect(node.el.querySelector('.nd-lines')?.textContent).toBe('—');
    node.update(taskModel({}, { stats: { added: 1, removed: 0 } }));
    expect(node.el.querySelector('.nd-lines')?.textContent).toBe('+1 −0');
    expect(node.el.querySelector('.nd-body')).toBe(body);
    const before = node.el.querySelector('.nd-summary');
    node.update(taskModel({}, { stats: { added: 1, removed: 0 } }));
    expect(node.el.querySelector('.nd-summary')).toBe(before); // nothing changed: no re-render
    node.update(taskModel({}, { stats: { added: 1, removed: 0 }, selected: true }));
    expect(node.el.classList.contains('nd-selected')).toBe(true);
  });

  it('strikes through a cancelled task and colours a lost agent amber', () => {
    const ctx = makeContext();
    const cancelled = createTaskNode(ctx, taskModel({ status: 'CANCELLED' }));
    expect(cancelled.el.querySelector('.nd-summary')?.classList.contains('nd-struck')).toBe(true);
    const lost = createTaskNode(ctx, taskModel({ status: 'HARNESS_LOST' }));
    expect(lost.el.style.getPropertyValue('--nd-status')).toBe('var(--color-amber)');
    expect(statusColor('RUNNING')).toBe('var(--status-running)');
    expect(lost.el.textContent).toContain('Agent lost');
  });

  it('offers the actions each state allows', () => {
    const base = { run: null, harness: null, integration: null, recoveryQuestion: false };
    const acts = (task: Partial<SnapshotTask>, extra: Partial<typeof base> = {}) =>
      taskActions({ ...base, ...extra, task: makeTask(task) } as never);
    expect(acts({ status: 'READY' })).toEqual(['inspect', 'reassign', 'cancel']);
    expect(acts({ status: 'ASSIGNED' })).toEqual(['inspect', 'reassign', 'cancel']);
    expect(acts({ status: 'READY_FOR_VERIFICATION' })).toEqual(['inspect', 'verify', 'cancel']);
    expect(acts({ status: 'FAILED' })).toEqual(['inspect', 'rework', 'cancel']);
    expect(acts({ status: 'HARNESS_LOST' })).toEqual(['inspect', 'recover', 'cancel']);
    expect(acts({ status: 'WAITING', waiting_reason: 'agent_error' })).toEqual(['inspect', 'recover', 'cancel']);
    expect(acts({ status: 'RUNNING' }, { recoveryQuestion: true })).toEqual(['inspect', 'recover', 'cancel']);
    expect(acts({ status: 'COMPLETED' })).toEqual(['inspect']);
    expect(acts({ status: 'COMPLETED' }, { integration: { status: 'failed' } as never })).toEqual([
      'inspect',
      'integrate',
    ]);
    const spawned = { run: makeRun(), harness: makeHarness({ attach_mode: 'spawn' }) } as never;
    const attached = { run: makeRun(), harness: makeHarness({ attach_mode: 'attach' }) } as never;
    expect(acts({ status: 'WAITING', waiting_reason: 'blocked' }, spawned)).toEqual(['inspect', 'continue', 'cancel']);
    expect(acts({ status: 'WAITING', waiting_reason: 'blocked' }, attached)).toEqual(['inspect', 'cancel']);
    const ended = { run: makeRun({ status: 'ENDED' }), harness: makeHarness() } as never;
    expect(acts({ status: 'WAITING' }, ended)).toEqual(['inspect', 'cancel']);
  });

  it('opens the inspector, the verification panel and the recovery dialog', () => {
    const ctx = makeContext();
    const id = 'task_0000000000000000000000aa01';
    const node = createTaskNode(ctx, taskModel({ status: 'READY_FOR_VERIFICATION' }));
    click(actionOf(node.el, 'inspect'));
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'inspector', id });
    click(actionOf(node.el, 'verify'));
    expect(ctx.store.select('ui').modal).toEqual({ kind: 'verify', id });
    node.update(taskModel({ status: 'HARNESS_LOST' }));
    click(actionOf(node.el, 'recover'));
    expect(ctx.store.select('ui').modal).toEqual({ kind: 'recover', id });
    node.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(ctx.store.select('ui').drawer?.kind).toBe('inspector');
  });

  it('continues, reworks and integrates through the daemon', async () => {
    const id = 'task_0000000000000000000000aa01';
    const ctx = makeContext({ answers: { [`POST /tasks/${id}/continue`]: { continued: true, reason: null } } });
    const node = createTaskNode(
      ctx,
      taskModel({ status: 'WAITING', waiting_reason: 'blocked' }, { run: makeRun(), harness: makeHarness() }),
    );
    click(actionOf(node.el, 'continue'));
    expect((actionOf(node.el, 'continue') as HTMLButtonElement).disabled).toBe(true);
    await flush();
    expect(ctx.transport.to('POST', `/tasks/${id}/continue`)).toHaveLength(1);
    expect(ctx.toasts.at(-1)?.text).toBe('The agent continues in the same session');
    expect(ctx.refreshes).toBe(1);

    node.update(taskModel({ status: 'FAILED' }));
    click(actionOf(node.el, 'rework'));
    await flush();
    expect(ctx.transport.to('POST', `/tasks/${id}/rework`)).toHaveLength(1);

    node.update(taskModel({ status: 'COMPLETED' }, { integration: { status: 'conflicted', conflicts: [] } as never }));
    click(actionOf(node.el, 'integrate'));
    await flush();
    expect(ctx.transport.to('POST', `/tasks/${id}/integrate`)).toHaveLength(1);
  });

  it('cancels only after the confirmation', async () => {
    const id = 'task_0000000000000000000000aa01';
    const ctx = makeContext();
    const node = createTaskNode(ctx, taskModel({ status: 'RUNNING', summary: HOSTILE }));
    ctx.confirmAnswer = false;
    click(actionOf(node.el, 'cancel'));
    await flush();
    expect(ctx.confirms).toHaveLength(1);
    expect(ctx.confirms[0]?.danger).toBe(true);
    expect(ctx.transport.to('POST', `/tasks/${id}/cancel`)).toHaveLength(0);
    ctx.confirmAnswer = true;
    click(actionOf(node.el, 'cancel'));
    await flush();
    await flush();
    expect(ctx.transport.to('POST', `/tasks/${id}/cancel`)).toHaveLength(1);
  });

  it('reassigns from a menu of other agents, or releases the task', async () => {
    const s = makeScenario();
    const ctx = makeContext({ snapshot: s });
    const id = 'task_0000000000000000000000aa01';
    const node = createTaskNode(ctx, taskModel({ status: 'ASSIGNED', agent_key: 'claude-1' }));
    document.body.append(node.el);
    click(actionOf(node.el, 'reassign'));
    const menu = node.el.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    const items = [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])] as HTMLElement[];
    expect(items.map((i) => i.dataset.agent ?? i.dataset.action)).toEqual(['codex-1', 'release']);
    expect(document.activeElement).toBe(items[0]);
    menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(items[1]);
    click(items[0]);
    await flush();
    const assign = ctx.transport.to('POST', `/tasks/${id}/assign`);
    expect(assign).toHaveLength(1);
    expect(assign[0]?.body).toEqual({ agent_key: 'codex-1' });
    expect(node.el.querySelector('[role="menu"]')).toBeNull();

    click(actionOf(node.el, 'reassign'));
    click(node.el.querySelector('[data-action="release"]'));
    await flush();
    expect(ctx.transport.to('POST', `/tasks/${id}/release`)).toHaveLength(1);

    click(actionOf(node.el, 'reassign'));
    const open = node.el.querySelector('[role="menu"]');
    open?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(node.el.querySelector('[role="menu"]')).toBeNull();
    node.destroy();
  });

  it('computes durations and line texts', () => {
    const now = Date.parse('2026-10-17T10:10:00.000Z');
    expect(taskDuration(makeTask({ started_at: null }), now)).toBeNull();
    expect(taskDuration(makeTask({ started_at: '2026-10-17T10:00:00.000Z', status: 'RUNNING' }), now)).toBe(600_000);
    expect(
      taskDuration(makeTask({ started_at: '2026-10-17T10:00:00.000Z', cancelled_at: '2026-10-17T10:01:00.000Z' }), now),
    ).toBe(60_000);
    expect(taskDuration(makeTask({ started_at: '2026-10-17T10:00:00.000Z', status: 'COMPLETED' }), now)).toBeNull();
    expect(statText(null)).toBe('—');
    expect(statText({ added: 3, removed: 9 })).toBe('+3 −9');
  });
});

describe('goal card', () => {
  function group(overrides: Partial<GoalGroup> = {}): GoalGroup {
    const board = deriveBoard(makeScenario());
    return { ...(board.groups[0] as GoalGroup), ...overrides };
  }

  it('renders the goal with hostile text, inferred constraints marked, and progress', () => {
    const ctx = makeContext();
    const g = group({
      goal: makeGoal({
        request: `${HOSTILE} ${LONG}`,
        constraints: [`${HOSTILE}${BIDI}`],
        inferred_constraints: ['keep the API stable'],
      }),
    });
    const node = createGoalNode(ctx, { group: g });
    expectNoMarkup(node.el);
    expect(node.el.textContent).toContain(HOSTILE);
    expect(node.el.textContent).not.toContain(BIDI);
    expect(node.el.querySelector('.nd-pill-inferred')?.textContent).toContain('inferred');
    expect(node.el.querySelectorAll('.nd-pill-constraint')).toHaveLength(1);
    expect(node.el.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('25');
    expect(node.el.textContent).toContain('25% (1 of 4 tasks)');
    expect(node.el.textContent).toContain('Plan v1');
    expect(node.el.querySelector('[data-action="land"]')).toBeNull();
  });

  it('offers "Ready to land" once completed and shows the integration state', () => {
    const ctx = makeContext();
    const g = group({
      goal: makeGoal({ status: 'COMPLETED' }),
      integration: { integrated: 2, conflicted: 1, failed: 0, not_needed: 0 },
      proposed: makePlan({ version: 2, status: 'PROPOSED' }),
    });
    const node = createGoalNode(ctx, { group: g });
    expect(node.el.textContent).toContain('2 integrated · 1 conflicted');
    expect(node.el.textContent).toContain('v2 proposed');
    click(node.el.querySelector('[data-action="land"]'));
    expect(ctx.store.select('ui').modal).toEqual({ kind: 'land', id: g.goal.goal_id });
  });

  it('computes percentages and integration text', () => {
    expect(progressPercent({ completed: 0, total: 0 })).toBe(0);
    expect(progressPercent({ completed: 2, total: 3 })).toBe(67);
    expect(integrationText({ integrated: 0, conflicted: 0, failed: 0, not_needed: 0 })).toBeNull();
    expect(integrationText({ integrated: 0, conflicted: 0, failed: 2, not_needed: 1 })).toBe('2 failed · 1 not needed');
  });
});

describe('agent pod', () => {
  function pod(overrides: Partial<PodModel> = {}): PodModel {
    const board = deriveBoard(makeScenario());
    return { ...(board.pods[0] as PodModel), ...overrides };
  }
  function activity(target: string, kind: 'write' | 'command' = 'write'): AgentActivity {
    return {
      current: { at: 1, tool: `Edit${ZW}`, kind, target, decision: 'allow', taskId: 'task_00000000000000000000api001' },
      log: [],
      usage: { cost_usd: 0.18, input_tokens: 18_000, output_tokens: 400 },
      model: null,
    };
  }
  const model = (extra: Partial<PodCardModel> = {}): PodCardModel => ({
    pod: pod(),
    activity: null,
    stats: null,
    lastToolMs: null,
    recentFile: null,
    selected: false,
    ...extra,
  });

  it('renders vendor, key, enforcement, model, usage and the ribbon with hostile strings visible', () => {
    const ctx = makeContext();
    const target = `src/${BIDI}${HOSTILE}${LONG}.ts`;
    const node = createAgentPod(
      ctx,
      model({ activity: activity(target), stats: { added: 14, removed: 2 }, lastToolMs: 1100 }),
    );
    expectNoMarkup(node.el);
    const t = node.el.textContent ?? '';
    expect(t).toContain('Claude Code');
    expect(t).toContain('claude-1');
    expect(t).toContain('L1 reported');
    expect(t).toContain('claude-haiku-5-5');
    expect(t).toContain('$0.18');
    expect(t).toContain('18k tokens');
    expect(t).toContain('last tool 1.1 s');
    expect(t).toContain('+14 −2');
    expect(t).toContain('spawned');
    const file = node.el.querySelector('[data-action="diff"]') as HTMLElement;
    expect(file.textContent).toContain('⟨U+202E⟩');
    expect(Array.from(file.textContent ?? '').length).toBeLessThan(80);
    expect(node.el.querySelector('.nd-tool')?.textContent).toContain('⟨U+200B⟩');
    click(file);
    expect(ctx.store.select('ui').drawer).toEqual({
      kind: 'diff',
      id: 'task_00000000000000000000api001',
      path: target,
    });
  });

  it('opens the live stream on click and Enter, and shows a command as text', () => {
    const ctx = makeContext();
    const node = createAgentPod(ctx, model({ activity: activity(`rm -rf /${BIDI}`, 'command') }));
    expect(node.el.querySelector('[data-action="diff"]')).toBeNull();
    expect(node.el.querySelector('.nd-target')?.textContent).toContain('⟨U+202E⟩');
    click(node.el.querySelector('.nd-model'));
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'terminal', id: 'claude-1' });
    ctx.store.patch('ui', { drawer: null });
    node.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(ctx.store.select('ui').drawer?.kind).toBe('terminal');
    ctx.store.patch('ui', { drawer: null });
    click(node.el.querySelector('[data-action="terminal"]'));
    expect(ctx.store.select('ui').drawer?.kind).toBe('terminal');
  });

  it('marks shadows and shows the requested model when none was observed', () => {
    const ctx = makeContext();
    const p = pod({
      agent: makeAgent({ shadow: true }),
      harness: makeHarness({ observed_model: null, enforcement_level: 'L0', attach_mode: 'attach' }),
      run: makeRun({ model_requested: 'big-model', model_observed: null }),
      usage: null,
    });
    const node = createAgentPod(ctx, model({ pod: p }));
    const t = node.el.textContent ?? '';
    expect(t).toContain('shadow');
    expect(t).toContain('big-model');
    expect(t).toContain('(requested)');
    expect(t).toContain('L0 observed');
    expect(t).toContain('attached');
    expect(podUsage({ pod: p, activity: null })).toEqual({ cost: '—', tokens: '—' });
    expect(podModelName({ pod: { ...p, run: null }, activity: null })).toBeNull();
    expect(vendorLabel({ harness: null })).toBe('Agent');
  });

  it('measures the last tool from its decision to its completion', () => {
    const d = new ToolDurations();
    const cur = (at: number, decision: 'allow' | 'done' | 'deny' | 'failed') =>
      ({
        current: { at, tool: 'Edit', kind: 'write', target: null, decision, taskId: null },
        log: [],
        usage: null,
        model: null,
      }) as AgentActivity;
    const a1 = cur(1000, 'allow');
    d.observe({ k: a1 });
    d.observe({ k: a1 }); // the same activity again changes nothing
    expect(d.last('k')).toBeNull();
    d.observe({ k: cur(2100, 'done') });
    expect(d.last('k')).toBe(1100);
    d.observe({ k: cur(3000, 'allow') });
    d.observe({ k: cur(3100, 'deny') });
    d.observe({ k: cur(3500, 'failed') });
    expect(d.last('k')).toBe(1100);
    expect(d.last('other')).toBeNull();
  });
});

describe('proposed plan', () => {
  const goal = makeGoal();
  const plan = makePlan({
    version: 2,
    status: 'PROPOSED',
    summary: `${HOSTILE} ${LONG}`,
    proposed_by: { kind: 'master_brain', id: 'brain' } as never,
    tasks: [
      makePlanTask({ key: 'a', change: 'new' }),
      makePlanTask({ key: 'b', change: 'rework', task_id: 'task_b', note: `${HOSTILE} fix it` }),
      makePlanTask({ key: 'c', change: 'drop' }),
    ],
  });

  it('approves only in the review, where every task is shown in full (review M9i)', () => {
    const ctx = makeContext();
    const bar = createPlanReviewBar(ctx, { goalId: goal.goal_id, plan });
    expectNoMarkup(bar.el);
    expect(bar.el.textContent).toContain('Plan v2 proposed');
    expect(bar.el.textContent).toContain('by the Master Brain');
    expect(bar.el.textContent).toContain('1 new · 1 rework · 1 dropped');
    expect(actionOf(bar.el, 'approve')).toBeNull();
    click(actionOf(bar.el, 'review'));
    expect(ctx.store.select('ui').modal).toEqual({ kind: 'plan-review', id: goal.goal_id });
    expect(ctx.transport.calls).toHaveLength(0);
    bar.destroy();
  });

  it('arms Reject only after 700 ms and a real pointer move, never from the click’s own focus', async () => {
    vi.useFakeTimers();
    const ctx = makeContext();
    const bar = createPlanReviewBar(ctx, { goalId: goal.goal_id, plan });
    document.body.append(bar.el);
    const reject = actionOf(bar.el, 'reject') as HTMLButtonElement;
    await vi.advanceTimersByTimeAsync(ARM_DELAY_MS);
    // Focus from a click, and a pointer event that did not move, arm nothing.
    bar.el.dispatchEvent(new Event('focusin'));
    bar.el.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 10 }));
    expect(reject.getAttribute('aria-disabled')).toBe('true');
    bar.el.dispatchEvent(new MouseEvent('pointermove', { clientX: 14, clientY: 11 }));
    expect(reject.getAttribute('aria-disabled')).toBe('false');
    // A move of the card re-arms.
    bar.moved?.();
    expect(reject.getAttribute('aria-disabled')).toBe('true');
    bar.destroy();
  });

  it('rejects with a note', async () => {
    vi.useFakeTimers();
    const ctx = makeContext();
    const bar = createPlanReviewBar(ctx, { goalId: goal.goal_id, plan });
    document.body.append(bar.el);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    bar.el.dispatchEvent(new Event('focusin'));
    await vi.advanceTimersByTimeAsync(ARM_DELAY_MS);
    click(actionOf(bar.el, 'reject'));
    const field = bar.el.querySelector('textarea') as HTMLTextAreaElement;
    expect(field).not.toBeNull();
    field.value = `  ${HOSTILE}  `;
    click(actionOf(bar.el, 'reject-send'));
    await vi.advanceTimersByTimeAsync(0);
    const calls = ctx.transport.to('POST', `/plans/${plan.plan_id}/versions/2/reject`);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ note: HOSTILE });
    bar.destroy();
  });

  it('renders ghosts for new and reworked tasks with hostile text', () => {
    const ctx = makeContext();
    const board = deriveBoard(
      (() => {
        const s = makeScenario();
        s.tasks.push(makeTask({ task_id: 'task_b', goal_id: goal.goal_id }));
        const p = s.plans[goal.goal_id];
        if (p)
          p.proposed = {
            ...plan,
            tasks: [
              makePlanTask({ key: `k${BIDI}`, change: 'new', summary: `${HOSTILE} ${LONG}` }),
              makePlanTask({ key: 'b', change: 'rework', task_id: 'task_b', note: `${HOSTILE} fix it` }),
            ],
          };
        return s;
      })(),
    );
    const ghosts = [...board.ghosts.values()];
    expect(ghosts).toHaveLength(2);
    const first = createPlanGhost(ctx, { ghost: ghosts[0] as never });
    expectNoMarkup(first.el);
    expect(first.el.textContent).toContain('New');
    expect(first.el.querySelector('.nd-id')?.textContent).toContain('⟨U+202E⟩');
    expect(Array.from(first.el.querySelector('.nd-summary')?.textContent ?? '').length).toBeLessThanOrEqual(200);
    const second = createPlanGhost(ctx, { ghost: ghosts[1] as never });
    expect(second.el.textContent).toContain('Rework of task_b');
    click(actionOf(second.el, 'review'));
    expect(ctx.store.select('ui').modal).toEqual({ kind: 'plan-review', id: goal.goal_id });
  });

  it('counts changes and names who proposed', () => {
    expect(planCounts(plan)).toEqual({ new: 1, rework: 1, drop: 1, keep: 0 });
    expect(proposer({ proposed_by: { kind: 'human', id: 'x' } as never })).toBe('a human');
    expect(proposer({ proposed_by: { kind: 'agent', id: 'x' } as never })).toBe('Agent');
  });

  it('arming needs both the delay and an engagement after the last reset', () => {
    vi.useFakeTimers();
    const changes: boolean[] = [];
    const a = new Arming((v) => changes.push(v), 100);
    vi.advanceTimersByTime(200);
    expect(a.armed).toBe(false);
    a.engage();
    expect(a.armed).toBe(true);
    a.reset();
    a.engage();
    expect(a.armed).toBe(false);
    vi.advanceTimersByTime(100);
    expect(a.armed).toBe(true);
    expect(changes).toEqual([true, false, true]);
    a.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('common helpers', () => {
  it('limits pills with a "+N" pill and fingerprints values', () => {
    const out = pills(['a', 'b', 'c', 'd'], 2, (v) => {
      const el = document.createElement('span');
      el.textContent = v;
      return el;
    });
    expect(out).toHaveLength(3);
    expect(out[2]?.textContent).toBe('+2');
    expect(fingerprint({ a: 1 })).toBe(fingerprint({ a: 1 }));
  });

  it('keeps an action button busy while its call runs', async () => {
    let release: () => void = () => undefined;
    const b = actionButton('Go', 'play', () => new Promise<void>((r) => (release = r)), { busyLabel: 'Going…' });
    b.click();
    expect(b.disabled).toBe(true);
    expect(b.textContent).toBe('Going…');
    b.click();
    release();
    await flush();
    expect(b.disabled).toBe(false);
    expect(b.textContent).toBe('Go');
  });
});
