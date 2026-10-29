import type { VerificationView } from '@friday/protocol';
import { describe, expect, it } from 'vitest';
import {
  makeEscalation,
  makeGoal,
  makeHarness,
  makePlan,
  makePlanTask,
  makeScenario,
  makeSnapshot,
  makeTask,
  makeVerification,
} from '../test/fixtures.js';
import {
  assignableAgents,
  checksSummary,
  conflictOf,
  deriveBoard,
  ghostId,
  goalProgress,
  integrationSummary,
  LOOSE_GROUP,
  layoutInputOf,
  NODE_SIZE,
  planBarId,
  podId,
  taskCardHeight,
  taskCardParts,
} from './board.js';

const IDS = {
  api: 'task_00000000000000000000api001',
  ui: 'task_00000000000000000000ui0001',
  docs: 'task_0000000000000000000doc001',
  qa: 'task_00000000000000000000qa0001',
  loose: 'task_0000000000000000000loose01',
};
const GOAL = 'goal_0000000000000000000000gg01';

describe('deriveBoard from the scenario', () => {
  const board = deriveBoard(makeScenario(), { showFinished: true });

  it('groups the goal with its tasks in plan order', () => {
    expect(board.groups).toHaveLength(1);
    const g = board.groups[0];
    expect(g?.id).toBe(GOAL);
    expect(g?.taskIds).toEqual([IDS.api, IDS.ui, IDS.docs, IDS.qa]);
    expect(g?.active?.version).toBe(1);
    expect(g?.proposed).toBeNull();
  });

  it('keeps tasks without a goal in the loose group', () => {
    expect(board.loose).toEqual([IDS.loose]);
    expect(board.groupOf.get(IDS.loose)).toBe(LOOSE_GROUP);
    expect(board.groupOf.get(IDS.api)).toBe(GOAL);
    expect(board.empty).toBe(false);
  });

  it('computes progress as completed of the tasks not cancelled', () => {
    expect(board.groups[0]?.progress).toEqual({ completed: 1, total: 4 });
  });

  it('draws dependency edges, satisfied only when the dependency completed', () => {
    const deps = board.edges.filter((e) => e.kind === 'dependency');
    expect(deps.map((e) => [e.from, e.to])).toEqual(
      expect.arrayContaining([
        [IDS.api, IDS.ui],
        [IDS.api, IDS.docs],
        [IDS.ui, IDS.docs],
      ]),
    );
    expect(deps).toHaveLength(3);
    expect(deps.every((e) => !e.satisfied)).toBe(true);
    const goalEdges = board.edges.filter((e) => e.kind === 'goal').map((e) => e.to);
    expect(goalEdges.sort()).toEqual([IDS.api, IDS.qa].sort());
  });

  it('makes a pod per agent with its task, run, harness and conduit', () => {
    expect(board.pods.map((p) => p.agentKey)).toEqual(['claude-1', 'codex-1']);
    const claude = board.pods[0];
    expect(claude?.id).toBe(podId('claude-1'));
    expect(claude?.taskId).toBe(IDS.api);
    expect(claude?.working).toBe(true);
    expect(claude?.run?.run_id).toBe('run_000000000000000000000rr01');
    expect(claude?.harness?.vendor).toBe('claude-code');
    const codex = board.pods[1];
    expect(codex?.taskId).toBe(IDS.ui);
    expect(codex?.working).toBe(false);
    expect(codex?.harness?.vendor).toBe('codex');
    const links = board.edges.filter((e) => e.kind === 'conduit' || e.kind === 'assignment');
    expect(links).toEqual([
      expect.objectContaining({ from: 'pod:claude-1', to: IDS.api, kind: 'conduit' }),
      expect.objectContaining({ from: 'pod:codex-1', to: IDS.ui, kind: 'assignment' }),
    ]);
  });

  it('indexes reservations, recovery questions and harnesses', () => {
    expect(board.harnessById.size).toBe(2);
    expect(board.escalations.get(IDS.api)).toHaveLength(1);
    expect(board.recoveryTasks.size).toBe(0);
  });
});

describe('deriveBoard rules', () => {
  it('gives an empty board without a snapshot or anything to show', () => {
    expect(deriveBoard(null).empty).toBe(true);
    expect(deriveBoard(makeSnapshot()).empty).toBe(true);
  });

  it('marks a dependency satisfied once its task completed', () => {
    const s = makeSnapshot({
      tasks: [
        makeTask({ task_id: 'task_a', status: 'COMPLETED' }),
        makeTask({ task_id: 'task_b', dependencies: ['task_a', 'task_missing'] }),
      ],
    });
    const deps = deriveBoard(s).edges.filter((e) => e.kind === 'dependency');
    expect(deps).toEqual([expect.objectContaining({ from: 'task_a', to: 'task_b', satisfied: true })]);
  });

  it('hides finished goals and their tasks, and finished loose tasks, when asked', () => {
    const done = makeGoal({ goal_id: 'goal_done', status: 'COMPLETED' });
    const open = makeGoal({ goal_id: 'goal_open', status: 'ACTIVE' });
    const s = makeSnapshot({
      goals: [done, open],
      tasks: [
        makeTask({ task_id: 'task_d', goal_id: 'goal_done', status: 'COMPLETED' }),
        makeTask({ task_id: 'task_o', goal_id: 'goal_open', status: 'COMPLETED' }),
        makeTask({ task_id: 'task_l', status: 'CANCELLED' }),
        makeTask({ task_id: 'task_r', status: 'READY' }),
      ],
    });
    const shown = deriveBoard(s, { showFinished: true });
    expect(shown.groups.map((g) => g.id)).toEqual(['goal_done', 'goal_open']);
    expect(shown.loose).toEqual(['task_l', 'task_r']);
    const hidden = deriveBoard(s, { showFinished: false });
    expect(hidden.groups.map((g) => g.id)).toEqual(['goal_open']);
    expect(hidden.groups[0]?.taskIds).toEqual(['task_o']);
    expect(hidden.tasks.has('task_d')).toBe(false);
    expect(hidden.loose).toEqual(['task_r']);
  });

  it('takes goal progress from the totals over all the goal’s tasks, not from the tasks listed (review R4)', () => {
    const goal = makeGoal({ goal_id: 'goal_g', status: 'ACTIVE' });
    // t1 completed yesterday and has aged out of the list; its plan still names it.
    const s = makeSnapshot({
      goals: [goal],
      plans: {
        goal_g: {
          active: makePlan({
            goal_id: 'goal_g',
            tasks: [
              makePlanTask({ key: 'a', task_id: 'task_1', status: 'COMPLETED' }),
              makePlanTask({ key: 'b', position: 1, task_id: 'task_2', status: 'READY' }),
            ],
          }),
          proposed: null,
        },
      },
      tasks: [makeTask({ task_id: 'task_2', goal_id: 'goal_g', status: 'READY' })],
      goal_progress: { goal_g: { completed: 1, total: 2 } },
    });
    const board = deriveBoard(s);
    expect(board.groups[0]?.taskIds).toEqual(['task_2']);
    expect(board.groups[0]?.progress).toEqual({ completed: 1, total: 2 });
  });

  it('keeps the totals when every task of a finished goal aged out, or the task list hit its cap', () => {
    const done = makeGoal({ goal_id: 'goal_done', status: 'COMPLETED' });
    const big = makeGoal({ goal_id: 'goal_big', status: 'ACTIVE' });
    const s = makeSnapshot({
      goals: [done, big],
      tasks: [makeTask({ task_id: 'task_b1', goal_id: 'goal_big', status: 'COMPLETED' })],
      truncated: { tasks: true },
      goal_progress: { goal_done: { completed: 2, total: 2 }, goal_big: { completed: 40, total: 700 } },
    });
    const board = deriveBoard(s);
    expect(board.groups.map((g) => [g.id, g.progress])).toEqual([
      ['goal_done', { completed: 2, total: 2 }],
      ['goal_big', { completed: 40, total: 700 }],
    ]);
  });

  it('counts the listed tasks when the snapshot carries no totals for a goal', () => {
    const goal = makeGoal({ goal_id: 'goal_g' });
    const s = makeSnapshot({
      goals: [goal],
      tasks: [
        makeTask({ task_id: 'task_1', goal_id: 'goal_g', status: 'COMPLETED' }),
        makeTask({ task_id: 'task_2', goal_id: 'goal_g', status: 'READY' }),
      ],
      goal_progress: {},
    });
    expect(deriveBoard(s).groups[0]?.progress).toEqual({ completed: 1, total: 2 });
  });

  it('puts a task whose goal the snapshot does not list with the loose tasks', () => {
    const b = deriveBoard(makeSnapshot({ tasks: [makeTask({ task_id: 'task_x', goal_id: 'goal_unknown' })] }));
    expect(b.loose).toEqual(['task_x']);
  });

  it('turns new and reworked tasks of a proposed plan into ghosts with their dependencies', () => {
    const goal = makeGoal();
    const s = makeSnapshot({
      goals: [goal],
      tasks: [
        makeTask({ task_id: 'task_api', goal_id: goal.goal_id, status: 'FAILED' }),
        makeTask({ task_id: 'task_old', goal_id: goal.goal_id }),
      ],
      plans: {
        [goal.goal_id]: {
          active: makePlan({ tasks: [makePlanTask({ key: 'api', task_id: 'task_api' })] }),
          proposed: makePlan({
            version: 2,
            status: 'PROPOSED',
            tasks: [
              makePlanTask({ key: 'api', task_id: 'task_api', change: 'rework', position: 0 }),
              makePlanTask({ key: 'page', change: 'new', depends_on: ['api'], position: 1 }),
              makePlanTask({ key: 'e2e', change: 'new', depends_on: ['page', 'task_old', 'nope'], position: 2 }),
              makePlanTask({ key: 'old', task_id: 'task_old', change: 'drop', position: 3 }),
              makePlanTask({ key: 'keep', change: 'keep', position: 4 }),
            ],
          }),
        },
      },
    });
    const b = deriveBoard(s);
    const g = b.groups[0];
    const plan = 'plan_0000000000000000000000pp01';
    expect(g?.ghostIds).toEqual([ghostId(plan, 2, 'api'), ghostId(plan, 2, 'page'), ghostId(plan, 2, 'e2e')]);
    expect(b.ghosts.get(ghostId(plan, 2, 'api'))?.change).toBe('rework');
    expect(b.ghosts.get(ghostId(plan, 2, 'api'))?.deps).toEqual([]);
    expect(b.ghosts.get(ghostId(plan, 2, 'page'))?.deps).toEqual(['task_api']);
    expect(b.ghosts.get(ghostId(plan, 2, 'e2e'))?.deps).toEqual([ghostId(plan, 2, 'page'), 'task_old']);
    expect(g?.dropped).toEqual(['task_old']);
    const input = layoutInputOf(b);
    expect(input.groups[0]?.items[0]).toMatchObject({ id: planBarId(goal.goal_id), pinned: true });
    expect(b.edges.filter((e) => e.kind === 'ghost').length).toBe(4);
  });

  it('skips terminated agents, and disconnected ones without a task', () => {
    const s = makeScenario();
    s.agents.push(
      { ...s.agents[0], agent_id: 'agent_t', agent_key: 'gone', status: 'TERMINATED', current_task_id: null } as never,
      {
        ...s.agents[0],
        agent_id: 'agent_d',
        agent_key: 'away',
        status: 'DISCONNECTED',
        current_task_id: null,
      } as never,
    );
    expect(deriveBoard(s).pods.map((p) => p.agentKey)).toEqual(['claude-1', 'codex-1']);
  });

  it('finds an agent task by its key when the agent names none', () => {
    const s = makeScenario();
    const a = s.agents[0];
    if (a) a.current_task_id = null;
    expect(deriveBoard(s).pods[0]?.taskId).toBe(IDS.api);
  });

  it('flags recovery questions', () => {
    const s = makeScenario();
    s.escalations.push(makeEscalation({ escalation_id: 'esc_r', task_id: IDS.ui, kind: 'recovery_needed' }));
    expect(deriveBoard(s).recoveryTasks.has(IDS.ui)).toBe(true);
  });
});

describe('helpers', () => {
  it('summarises checks that ran', () => {
    expect(checksSummary(null)).toBeNull();
    const check = makeVerification().checks[0] as VerificationView['checks'][number];
    const v = makeVerification({
      checks: [
        { ...check, status: 'PASSED' },
        { ...check, status: 'FAILED' },
        { ...check, status: 'NOT_REQUESTED' },
      ],
    });
    expect(checksSummary(v)).toEqual({ passed: 1, run: 2 });
  });

  it('names conflicts and counts integrations', () => {
    expect(conflictOf(null)).toBeNull();
    expect(conflictOf({ status: 'conflicted' } as never)).toBe('conflicted');
    expect(conflictOf({ status: 'integrated' } as never)).toBeNull();
    expect(integrationSummary([{ status: 'integrated' } as never, undefined, { status: 'failed' } as never])).toEqual({
      integrated: 1,
      conflicted: 0,
      failed: 1,
      not_needed: 0,
    });
  });

  it('counts progress without cancelled tasks', () => {
    expect(goalProgress([{ status: 'COMPLETED' }, { status: 'CANCELLED' }, { status: 'RUNNING' }])).toEqual({
      completed: 1,
      total: 2,
    });
  });

  it('reserves taller cards for what they show', () => {
    const b = deriveBoard(makeScenario());
    const plain = taskCardHeight({ scope: false, criteria: 0, note: null, badges: false });
    expect(plain).toBe(NODE_SIZE.task.h);
    expect(taskCardHeight({ scope: true, criteria: 5, note: 'blocked', badges: true })).toBe(
      plain + 24 + 6 + 3 * 17 + 17 + 56 + 26,
    );
    const waiting = b.tasks.get(IDS.ui);
    expect(waiting && taskCardParts(b, waiting, false).note).toBe('blocked');
    const loose = b.tasks.get(IDS.loose);
    expect(loose && taskCardParts(b, loose, false).note).toBe('delegation');
    const qa = b.tasks.get(IDS.qa);
    expect(qa && taskCardParts(b, qa, false).badges).toBe(true);
  });

  it('lists assignable agents: connected, not shadows, not the holder', () => {
    const s = makeScenario();
    s.harnesses.push(makeHarness());
    const task = s.tasks.find((t) => t.task_id === IDS.api);
    expect(task && assignableAgents(s, task).map((a) => a.agent_key)).toEqual(['codex-1']);
    expect(assignableAgents(null, makeTask())).toEqual([]);
  });
});
