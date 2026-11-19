/**
 * The Master Brain's questions about a goal's planning ("Friday cannot plan…") are answered as moot
 * once a person wrote or approved a plan for the goal, and every question of a goal once it is
 * cancelled (2026-11-17). They used to stay in "Waiting for you", and answering a stale one later
 * started a revision nobody asked for; an answer marked moot starts none.
 */
import { sequentialIds } from '@friday/core';
import { openDatabase } from '@friday/db';
import type { Actor } from '@friday/protocol';
import { FakeClock } from '@friday/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import { FridayState, type PlanTaskInput } from './index.js';

const PROJECT = 'proj_00000000000000000000000001';
const human: Actor = { kind: 'human', id: 'local-operator' };
const brain: Actor = { kind: 'master_brain', id: 'master-brain' };

let state: FridayState;
beforeEach(() => {
  state = new FridayState({
    db: openDatabase(':memory:'),
    clock: new FakeClock('2026-11-17T10:00:00.000Z'),
    ids: sequentialIds(),
  });
  state.ensureProject({ project_id: PROJECT, name: 'shop', root_path: 'C:/demo/shop' });
});

const task = (key: string): PlanTaskInput => ({
  key,
  change: 'new',
  task_id: null,
  kind: 'implementation',
  summary: `do ${key}`,
  description: null,
  acceptance_criteria: ['done'],
  depends_on: [],
  scope: { write: [`${key}/**`], read: [] },
  role: 'developer',
  priority: 'normal',
  risk_level: 'low',
  note: null,
});
const proposal = (trigger: string) => ({
  summary: 'the plan',
  rationale: '',
  needs_human: null,
  trigger,
  tasks: [task('api')],
});
const ask = (kind: string, goal_id: string, by: Actor = brain, task_id: string | null = null) =>
  state.raiseEscalation(PROJECT, by, { kind, goal_id, task_id, question: `${kind}?`, options: [], details: {} });
const pending = () => state.q.escalations(PROJECT, 'pending').map((e) => String(e.kind));
const answers = () =>
  state.store
    .readSince(PROJECT, 0, { types: ['escalation.answered'] })
    .map((e) => e.payload as { answer: string; moot?: boolean });

describe("a goal's planning questions", () => {
  it('are answered as moot when a person writes the plan, and the others stay', () => {
    const g = state.createGoal(PROJECT, human, { request: 'Ship the discount codes', plan: false });
    const other = state.createGoal(PROJECT, human, { request: 'Something else', plan: false });
    ask('planner_unavailable', g.goal_id);
    ask('invalid_plan', g.goal_id);
    // Not about planning, another goal's, or a person's own question: none of these is answered.
    ask('ambiguous_intent', g.goal_id);
    ask('planner_unavailable', other.goal_id);
    ask('planner_unavailable', g.goal_id, human);
    expect(pending()).toHaveLength(5);

    state.proposePlan(PROJECT, human, g.goal_id, proposal('human'));
    expect(pending().sort()).toEqual(['ambiguous_intent', 'planner_unavailable', 'planner_unavailable']);
    expect(answers()).toEqual([
      { escalation_id: expect.any(String), answer: 'no longer needed: a person wrote the plan', moot: true },
      { escalation_id: expect.any(String), answer: 'no longer needed: a person wrote the plan', moot: true },
    ]);
  });

  it('stay when the Master Brain itself proposes, and go when the plan is approved', () => {
    const g = state.createGoal(PROJECT, human, { request: 'Ship the discount codes', plan: false });
    ask('budget_exceeded', g.goal_id);
    const v = state.proposePlan(PROJECT, brain, g.goal_id, proposal('first plan'));
    expect(pending()).toEqual(['budget_exceeded']);
    state.approvePlan(PROJECT, human, v.plan_id, v.version);
    expect(pending()).toEqual([]);
    expect(answers().at(-1)).toMatchObject({ answer: 'no longer needed: a plan was approved', moot: true });
  });

  it('all go when the goal is cancelled, whatever they asked', () => {
    const g = state.createGoal(PROJECT, human, { request: 'Ship the discount codes', plan: false });
    const other = state.createGoal(PROJECT, human, { request: 'Something else', plan: false });
    ask('planner_unavailable', g.goal_id);
    ask('ambiguous_intent', g.goal_id);
    ask('planner_unavailable', other.goal_id);
    state.cancelGoal(PROJECT, human, g.goal_id, 'not needed');
    expect(pending()).toEqual(['planner_unavailable']);
    expect(answers().every((a) => a.moot === true && a.answer === 'no longer needed: the goal was cancelled')).toBe(
      true,
    );
    expect(answers()).toHaveLength(2);
  });
});
