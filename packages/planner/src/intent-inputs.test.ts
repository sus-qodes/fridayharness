/**
 * The intent the Master Brain works from (ADR-0034 §3–§4; plan Phase 3.5).
 */
import { sequentialIds } from '@friday/core';
import { openDatabase } from '@friday/db';
import type { Actor } from '@friday/protocol';
import { FridayState } from '@friday/state';
import { FakeClock } from '@friday/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import { type BrainSettings, MasterBrain } from './brain.js';
import { parsePlanDraft } from './parse.js';
import { proposalFromDraft } from './proposals.js';
import { FakePlannerModel, type FakeResponse } from './providers/fake.js';

const PROJECT = 'proj_00000000000000000000000001';
const human: Actor = { kind: 'human', id: 'local-operator' };
const SETTINGS: BrainSettings = {
  model: 'claude-opus-5-5',
  maxTokens: 4000,
  autoApprove: false,
  escalateAfterFailures: 2,
  maxReplans: 3,
  allowRemote: false,
  dailyBudgetUsd: 5,
};
const classified = (role: string): FakeResponse => ({
  purpose: 'role',
  output: {
    status: 'classified',
    roles: [{ role, task_summary: 'the change', depends_on: [], confidence: 0.95 }],
    assumptions: [],
  },
});

let state: FridayState;
beforeEach(() => {
  state = new FridayState({
    db: openDatabase(':memory:'),
    clock: new FakeClock('2026-10-22T10:00:00.000Z'),
    ids: sequentialIds(),
  });
  state.ensureProject({ project_id: PROJECT, name: 'edutube', root_path: 'C:/demo/edutube' });
});

const brain = (model: FakePlannerModel) =>
  new MasterBrain({ state, projectId: PROJECT, model, settings: SETTINGS, projectContext: () => 'edutube' });

/** A task whose kind and paths name no one role, so the decision model is asked. */
const ambiguousTask = () =>
  state.createTask(PROJECT, human, {
    summary: 'Split a cross-cutting change',
    scope: { write: ['apps/web/src/App.tsx', 'server/src/api.ts'], read: [] },
  });

describe('the role classifier and the intent (ADR-0034 §4)', () => {
  it("receives the project's non-goals and definition of done", async () => {
    state.intent.propose(PROJECT, human, {
      objective: 'A distraction-free study platform.',
      non_goals: ['Social feeds.'],
      definition_of_done: ['The build passes.'],
    });
    state.intent.approve(PROJECT, human, 1);
    const model = new FakePlannerModel([classified('backend_engineer')]);
    ambiguousTask();
    await brain(model).runOnce();
    expect(model.requests).toHaveLength(1);
    const prompt = model.requests[0]?.prompt ?? '';
    expect(prompt).toContain('Social feeds.');
    expect(prompt).toContain('The build passes.');
  });

  it('classifies again after the intent changes, for work not started', async () => {
    const model = new FakePlannerModel([classified('backend_engineer'), classified('frontend_engineer')]);
    const b = brain(model);
    const t = ambiguousTask();
    await b.runOnce();
    expect(state.q.task(PROJECT, t.task_id)).toMatchObject({ role: 'backend_engineer', role_source: 'decision_model' });
    // Without a change, never a second call.
    await b.runOnce();
    expect(model.requests).toHaveLength(1);
    state.intent.propose(PROJECT, human, { objective: 'A study platform, web first.' });
    state.intent.approve(PROJECT, human, 1);
    await b.runOnce();
    expect(model.requests).toHaveLength(2);
    expect(state.q.task(PROJECT, t.task_id)).toMatchObject({
      role: 'frontend_engineer',
      role_source: 'decision_model',
    });
  });
});

describe("the planner's own intent suggestions (ADR-0034 §3)", () => {
  it('keeps suggested non-goals and definition of done apart from the human', () => {
    const goal = state.createGoal(PROJECT, human, {
      request: 'Refactor the video cards',
      non_goals: ['No new npm packages.'],
      plan: false,
    });
    const parsed = parsePlanDraft({
      objective: 'Refactor the video cards for reuse',
      non_goals: ['no new npm packages.', 'No visual redesign.'],
      definition_of_done: ['The dashboard builds.'],
      summary: 'one task',
      tasks: [
        {
          key: 'cards',
          summary: 'Refactor the cards',
          acceptance_criteria: ['builds'],
          scope: { write: ['components/**'], read: [] },
          role: 'frontend',
        },
      ],
    });
    if (!parsed.ok) throw new Error(parsed.errors.join('; '));
    state.proposePlan(PROJECT, human, goal.goal_id, proposalFromDraft(parsed.value, { trigger: 'test' }));
    expect(state.q.goal(PROJECT, goal.goal_id)).toMatchObject({
      non_goals: ['No new npm packages.'],
      // The human's own line is not repeated as a suggestion.
      inferred_non_goals: ['No visual redesign.'],
      inferred_definition_of_done: ['The dashboard builds.'],
      intent_revision: 2,
    });
  });
});
