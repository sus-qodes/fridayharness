import type { GoalSummary, SnapshotTask, UiSnapshot } from '@friday/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveBoard, type GoalGroup, type PodModel } from '../model/board.js';
import { enforcementWords } from '../model/status.js';
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
  makeSnapshot,
  makeTask,
  makeVerification,
} from '../test/fixtures.js';
import { createAgentPod, type PodCardModel, podModelName, podUsage, ToolDurations, vendorLabel } from './agent-pod.js';
import { actionButton, fingerprint, pills } from './common.js';
import {
  createGoalNode,
  goalSummaryLine,
  goalSummaryRows,
  hostsWords,
  integrationText,
  planNeed,
  progressPercent,
} from './goal-node.js';
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
    // The branch name left the card (review M9k): the inspector's Changes tab shows it.
    expect(el.querySelector('.nd-branch')).toBeNull();
    expect(el.textContent).not.toContain('friday/');
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

  it('shows the tool calls its hosts reported for the task, from the snapshot (review R13)', () => {
    const ctx = makeContext();
    const node = createTaskNode(ctx, taskModel({ tool_calls: 12 }));
    const tools = node.el.querySelector('.nd-tools') as HTMLElement;
    expect(tools.textContent).toBe('12 tools');
    expect(tools.title).toContain('Tool calls');
    expect(tools.title).toContain('every attempt');
    node.update(taskModel({ tool_calls: 13 }));
    expect(node.el.querySelector('.nd-tools')?.textContent).toBe('13 tools');
    node.update(taskModel({ tool_calls: 1 }));
    expect(node.el.querySelector('.nd-tools')?.textContent).toBe('1 tool');
    node.update(taskModel({ tool_calls: 0 }));
    expect(node.el.querySelector('.nd-tools')?.textContent).toBe('0 tools');
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
    // Once there is an attempt, Changes is one click away (review M9k), whatever the state.
    const spawned = { run: makeRun(), harness: makeHarness({ attach_mode: 'spawn' }) } as never;
    const attached = { run: makeRun(), harness: makeHarness({ attach_mode: 'attach' }) } as never;
    expect(acts({ status: 'WAITING', waiting_reason: 'blocked' }, spawned)).toEqual([
      'inspect',
      'changes',
      'continue',
      'cancel',
    ]);
    expect(acts({ status: 'WAITING', waiting_reason: 'blocked' }, attached)).toEqual(['inspect', 'changes', 'cancel']);
    const ended = { run: makeRun({ status: 'ENDED' }), harness: makeHarness() } as never;
    expect(acts({ status: 'WAITING' }, ended)).toEqual(['inspect', 'changes', 'cancel']);
    expect(acts({ status: 'COMPLETED' }, { run: makeRun({ status: 'ENDED' }) } as never)).toEqual([
      'inspect',
      'changes',
    ]);
  });

  it('opens the diff from the +N −M figure and from the Changes action, once there is an attempt', () => {
    const ctx = makeContext();
    const id = 'task_0000000000000000000000aa01';
    const none = createTaskNode(ctx, taskModel({ status: 'READY' }));
    // No attempt: the figure is a plain "—" and there is no door to nothing.
    expect(none.el.querySelector('.nd-lines')?.tagName).toBe('SPAN');
    expect(none.el.querySelector('.nd-lines')?.textContent).toBe('—');
    expect(actionOf(none.el, 'changes')).toBeNull();
    expect(actionOf(none.el, 'changes-figure')).toBeNull();
    const node = createTaskNode(
      ctx,
      taskModel({ status: 'RUNNING' }, { run: makeRun(), stats: { added: 14, removed: 2 } }),
    );
    document.body.append(node.el);
    const figure = node.el.querySelector<HTMLButtonElement>('.nd-lines');
    expect(figure?.tagName).toBe('BUTTON');
    expect(figure?.textContent).toBe('+14 −2');
    expect(figure?.title).toContain('changes');
    click(figure);
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'diff', id });
    // The figure is a control: pressing it does not select the card.
    expect(ctx.store.select('ui').selectedTaskId).toBeNull();
    ctx.store.patch('ui', { drawer: null });
    click(actionOf(node.el, 'changes'));
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'diff', id });
    expect(actionOf(node.el, 'changes')?.textContent).toContain('Changes');
    // The figure still updates in place.
    node.update(taskModel({ status: 'RUNNING' }, { run: makeRun(), stats: { added: 15, removed: 2 } }));
    expect(node.el.querySelector('.nd-lines')?.textContent).toBe('+15 −2');
    node.destroy();
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

  describe('what Friday did (plan M12.7)', () => {
    const GID = 'goal_0000000000000000000000gg01';
    /** A goal with tasks and nothing else on record; each test changes what it needs. */
    const summary = (o: Partial<GoalSummary> = {}): GoalSummary => ({
      tasks: { total: 4, verified: 1 },
      claims_refused: 0,
      reworked: 0,
      held_for_human: 0,
      refused_by_policy: 0,
      sessions_lost: 0,
      sessions_recovered: 0,
      hosts: { attempts: 0, reported: 0, tokens: null, tokens_reporters: 0, cost_usd: null, cost_reporters: 0 },
      planning: { calls: 0, cost_usd: null, unknown_cost_calls: 0 },
      ...o,
    });
    const line = (root: Element) => root.querySelector('[data-role="did"]') as HTMLElement;

    it('words the facts as the plan does, in one line and in rows', () => {
      const s = summary({
        tasks: { total: 3, verified: 3 },
        claims_refused: 1,
        reworked: 1,
        held_for_human: 2,
        sessions_lost: 1,
        sessions_recovered: 1,
        hosts: { attempts: 2, reported: 2, tokens: 184_321, tokens_reporters: 2, cost_usd: 0.42, cost_reporters: 2 },
      });
      expect(goalSummaryLine(s)).toBe(
        '3 of 3 tasks verified · 1 claim refused by the checks, reworked · 2 actions held for you · 1 session recovered · hosts reported 184k tokens, $0.42 (2 of 2 attempts)',
      );
      expect(goalSummaryRows(s)).toEqual([
        { label: 'Tasks verified', value: '3 of 3' },
        { label: 'Claims refused by the checks', value: '1, reworked' },
        { label: 'Actions held for you', value: '2' },
        { label: 'Actions refused by policy', value: 'none' },
        { label: 'Sessions lost', value: '1, recovered' },
        { label: 'Hosts reported', value: '184k tokens, $0.42 (2 of 2 attempts)' },
      ]);
      // Fewer reworked or recovered than refused or lost, and a planning cost.
      expect(
        goalSummaryLine(
          summary({
            claims_refused: 2,
            reworked: 1,
            sessions_lost: 2,
            sessions_recovered: 1,
            refused_by_policy: 1,
            planning: { calls: 2, cost_usd: 0.03, unknown_cost_calls: 0 },
          }),
        ),
      ).toBe(
        '1 of 4 tasks verified · 2 claims refused by the checks, 1 reworked · 1 action refused by policy · 1 of 2 sessions recovered · Friday planned in 2 calls, $0.03',
      );
    });

    it('never writes 0 for what nobody reported: no token figure without a report, a cost with its own count', () => {
      // Three attempts, none reported: the line has no token figure; the rows say so.
      const none = summary({
        hosts: { attempts: 3, reported: 0, tokens: null, tokens_reporters: 0, cost_usd: null, cost_reporters: 0 },
      });
      expect(goalSummaryLine(none)).toBe('1 of 4 tasks verified');
      expect(goalSummaryRows(none)).toContainEqual({ label: 'Hosts reported', value: 'nothing (0 of 3 attempts)' });
      // One of three counted tokens and named no cost.
      expect(
        hostsWords({ attempts: 3, reported: 1, tokens: 1234, tokens_reporters: 1, cost_usd: null, cost_reporters: 0 }),
      ).toBe('1.2k tokens (1 of 3 attempts)');
      // Both counted tokens, one named a cost.
      expect(
        hostsWords({ attempts: 2, reported: 2, tokens: 5000, tokens_reporters: 2, cost_usd: 0.1, cost_reporters: 1 }),
      ).toBe('5.0k tokens (2 of 2 attempts), $0.10 (1 of 2 attempts)');
      // A goal without work has no line and no rows.
      const idle = summary({ tasks: { total: 0, verified: 0 } });
      expect(goalSummaryLine(idle)).toBeNull();
      expect(goalSummaryRows(idle)).toEqual([]);
    });

    it('shows the line on the card once the goal has tasks, reads it again when a task changes, and not for a goal without tasks', async () => {
      const s = summary({ tasks: { total: 4, verified: 1 }, claims_refused: 1, reworked: 1 });
      const ctx = makeContext({ answers: { [`GET /goals/${GID}`]: { summary: s } } });
      const node = createGoalNode(ctx, { group: group() });
      // Hidden until the answer arrives: nothing is shown that is not on record.
      expect(line(node.el).hidden).toBe(true);
      await flush();
      expect(line(node.el).hidden).toBe(false);
      expect(line(node.el).textContent).toBe('1 of 4 tasks verified · 1 claim refused by the checks, reworked');
      expect(line(node.el).title).toContain('Actions refused by policy: none');
      expect(line(node.el).title).not.toContain('tokens');
      expectNoMarkup(node.el);
      // The same board again reads nothing new.
      node.update({ group: group() });
      await flush();
      expect(ctx.transport.to('GET', `/goals/${GID}`)).toHaveLength(1);
      // A task of the goal changed: the line is read again.
      const scenario = makeScenario();
      ctx.board({
        ...scenario,
        tasks: scenario.tasks.map((t) => (t.plan_key === 'api' ? { ...t, status: 'FAILED' as const } : t)),
      });
      node.update({ group: group() });
      await flush();
      expect(ctx.transport.to('GET', `/goals/${GID}`)).toHaveLength(2);
      node.destroy();

      // A goal without tasks asks for nothing and shows nothing.
      const quiet = makeContext({ answers: { [`GET /goals/${GID}`]: { summary: s } } });
      const empty = createGoalNode(quiet, {
        group: group({
          goal: makeGoal({ status: 'OPEN', plan_id: null }),
          active: null,
          taskIds: [],
          progress: { total: 0, completed: 0 },
        }),
      });
      await flush();
      expect(quiet.transport.to('GET', `/goals/${GID}`)).toHaveLength(0);
      expect(line(empty.el).hidden).toBe(true);
    });
  });

  describe('an open goal without a plan (review R1)', () => {
    const GID = 'goal_0000000000000000000000gg01';
    const unplanned = () =>
      group({
        goal: makeGoal({ goal_id: GID, status: 'OPEN', plan_id: null }),
        active: null,
        proposed: null,
        taskIds: [],
        progress: { completed: 0, total: 0 },
      });
    const brain = (planner_available: boolean) => ({ planner_available }) as UiSnapshot['brain'];

    it('offers "Write the plan", which opens the plan editor on the goal', () => {
      const ctx = makeContext();
      const node = createGoalNode(ctx, { group: unplanned() });
      expect(actionOf(node.el, 'brain-plan')).toBeNull();
      click(actionOf(node.el, 'write-plan'));
      expect(ctx.store.select('ui').modal).toEqual({ kind: 'plan-editor', id: GID, mode: 'first' });
    });

    it('lets the Master Brain plan while a planner is ready', async () => {
      const ctx = makeContext({
        snapshot: makeSnapshot({ brain: brain(true) }),
        answers: { [`POST /goals/${GID}/replan`]: { result: 'proposed plan_1 v1 with 3 task(s)' } },
      });
      const node = createGoalNode(ctx, { group: unplanned() });
      expect(actionOf(node.el, 'write-plan')).not.toBeNull();
      click(actionOf(node.el, 'brain-plan'));
      await flush();
      expect(ctx.transport.to('POST', `/goals/${GID}/replan`)).toHaveLength(1);
      expect(ctx.refreshes).toBe(1);
      expect(ctx.toasts.at(-1)).toMatchObject({ kind: 'success', text: expect.stringContaining('proposed a plan') });
    });

    it('says when the Master Brain proposed nothing', async () => {
      const ctx = makeContext({
        snapshot: makeSnapshot({ brain: brain(true) }),
        answers: { [`POST /goals/${GID}/replan`]: { result: `failed: ${HOSTILE}` } },
      });
      const node = createGoalNode(ctx, { group: unplanned() });
      click(actionOf(node.el, 'brain-plan'));
      await flush();
      expect(ctx.toasts.at(-1)).toMatchObject({ kind: 'warn', detail: `failed: ${HOSTILE}` });
    });

    it('shows the Master Brain planning instead of asking it twice', () => {
      const ctx = makeContext({
        snapshot: makeSnapshot({
          brain: brain(true),
          brain_jobs: [{ job_id: 'job_1', kind: 'plan', status: 'calling', goal_id: GID }],
        }),
      });
      const node = createGoalNode(ctx, { group: unplanned() });
      expect(node.el.textContent).toContain('Master Brain planning');
      expect(actionOf(node.el, 'brain-plan')).toBeNull();
      expect(actionOf(node.el, 'write-plan')).not.toBeNull();
    });

    it('follows the planner and the plan on the board', () => {
      const ctx = makeContext();
      const node = createGoalNode(ctx, { group: unplanned() });
      expect(actionOf(node.el, 'brain-plan')).toBeNull();
      ctx.board(makeSnapshot({ brain: brain(true) }));
      node.update({ group: unplanned() });
      expect(actionOf(node.el, 'brain-plan')).not.toBeNull();
      node.update({ group: { ...unplanned(), proposed: makePlan({ status: 'PROPOSED' }) } });
      expect(actionOf(node.el, 'write-plan')).toBeNull();
      expect(actionOf(node.el, 'brain-plan')).toBeNull();
    });

    it('offers nothing for a goal with a plan, or one that is not open', () => {
      const ctx = makeContext({ snapshot: makeSnapshot({ brain: brain(true) }) });
      expect(actionOf(createGoalNode(ctx, { group: group() }).el, 'write-plan')).toBeNull();
      const cancelled = { ...unplanned(), goal: makeGoal({ status: 'CANCELLED', plan_id: null }) };
      const node = createGoalNode(ctx, { group: cancelled });
      expect(actionOf(node.el, 'write-plan')).toBeNull();
      expect(node.el.textContent).toContain('No plan yet');
      expect(planNeed(group(), null)).toBeNull();
    });
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
    expect(t).toContain('Reported');
    expect(t).not.toContain('L1 reported');
    expect(node.el.querySelector('.badge-info')?.getAttribute('title')).toBe('Enforcement level L1 (reported)');
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
    expect(t).toContain('Watched');
    expect(t).not.toContain('L0');
    expect(t).toContain('attached');
    expect(podUsage({ pod: p, activity: null })).toEqual({ cost: '—', tokens: '—' });
    expect(podModelName({ pod: { ...p, run: null }, activity: null })).toBeNull();
    expect(vendorLabel({ harness: null })).toBe('Agent');
  });

  it('says Enforced, Reported, Watched or Unverified, with the level in the tooltip (review M9k)', () => {
    const basis = `Friday hooks from this session ${HOSTILE}`;
    expect(enforcementWords('L1', 'enforcing', basis)).toEqual({
      label: 'Enforced',
      tone: 'good',
      title: `Enforcement level L1 (enforcing): ${basis}`,
    });
    expect(enforcementWords('L2', null)).toEqual({
      label: 'Enforced',
      tone: 'strong',
      title: 'Enforcement level L2 (isolated)',
    });
    expect(enforcementWords('L1', 'reported')).toMatchObject({ label: 'Reported', tone: 'info' });
    expect(enforcementWords('L1', 'degraded')).toEqual({
      label: 'Unverified',
      tone: 'warn',
      title: 'Enforcement level L1 (degraded)',
    });
    expect(enforcementWords('L1', null)).toMatchObject({
      label: 'Unverified',
      title: 'Enforcement level L1 (unverified)',
    });
    expect(enforcementWords('L0', 'observed')).toMatchObject({ label: 'Watched', tone: 'muted' });
    expect(enforcementWords(null, null)).toEqual({
      label: 'Watched',
      tone: 'muted',
      title: 'Enforcement level L0 (observed)',
    });
    // On the pod: the word on the badge, the level only in its tooltip; the basis is text.
    const ctx = makeContext();
    const p = pod({
      harness: makeHarness({ enforcement_level: 'L1', enforcement_status: 'enforcing', enforcement_basis: basis }),
    });
    const node = createAgentPod(ctx, model({ pod: p }));
    const badge = node.el.querySelector('.badge-good') as HTMLElement;
    expect(badge.textContent).toBe('Enforced');
    expect(badge.title).toContain('L1');
    expect(badge.title).toContain(HOSTILE);
    expectNoMarkup(node.el);
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

  it("shows a new task's note, the ceiling cut, beside its scope (plan M12.2)", () => {
    const ctx = makeContext();
    const cut = `scope.write cut to the project's scope for role frontend: frontend/** (the plan asked for **; policies/teams.yaml)`;
    const board = deriveBoard(
      (() => {
        const s = makeScenario();
        const p = s.plans[goal.goal_id];
        if (p) {
          p.proposed = {
            ...plan,
            tasks: [
              makePlanTask({
                key: 'page',
                change: 'new',
                role: 'frontend',
                scope: { write: ['frontend/**'], read: [] },
                note: cut,
              }),
              makePlanTask({ key: 'api', change: 'new', note: null }),
            ],
          };
        }
        return s;
      })(),
    );
    const [withNote, without] = [...board.ghosts.values()];
    const shown = createPlanGhost(ctx, { ghost: withNote as never });
    const foot = shown.el.querySelector('.nd-ghost-note') as HTMLElement;
    expect(foot.textContent).toContain('Proposed in plan v2: scope.write cut to');
    expect(foot.title).toBe(cut);
    expect(shown.el.textContent).toContain('frontend/**');
    const plain = createPlanGhost(ctx, { ghost: without as never });
    expect(plain.el.querySelector('.nd-ghost-note')?.textContent).toBe('Proposed in plan v2');
    expect(plain.el.querySelector('.nd-ghost-note')?.hasAttribute('title')).toBe(false);
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
