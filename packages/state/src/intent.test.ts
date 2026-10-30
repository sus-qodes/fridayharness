/**
 * Project intent, goal intent and learning proposals (ADR-0034 §1–§3, §7; plan Phase 3.1).
 */
import { sequentialIds } from '@friday/core';
import { openDatabase, type SqlDatabase } from '@friday/db';
import { replay } from '@friday/events';
import { type Actor, FridayError, HarnessRegisterParams, PROJECT_INTENT_MAX_CHARS } from '@friday/protocol';
import { FakeClock } from '@friday/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Caller, DOMAIN_TABLES, FridayState } from './index.js';

const PROJECT = 'proj_00000000000000000000000001';
const human: Actor = { kind: 'human', id: 'local-operator' };
const brain: Actor = { kind: 'master_brain', id: 'master-brain' };

let db: SqlDatabase;
let clock: FakeClock;
let state: FridayState;

beforeEach(() => {
  db = openDatabase(':memory:');
  clock = new FakeClock('2026-10-21T10:00:00.000Z');
  state = new FridayState({ db, clock, ids: sequentialIds() });
  state.ensureProject({ project_id: PROJECT, name: 'edutube', root_path: 'C:/demo/edutube' });
});

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(FridayError);
    return (e as FridayError).code;
  }
  throw new Error('expected an error');
}

function agent(key: string): Caller {
  const r = state.registerHarness(
    PROJECT,
    HarnessRegisterParams.parse({
      protocol_version: '1.0',
      harness_key: `fake:${key}`,
      vendor: 'generic',
      name: key,
      attach_mode: 'spawn',
      project_id: PROJECT,
      capabilities: { task_start: true },
      agent: { agent_key: key, role: 'backend' },
    }),
  );
  return { harness_id: r.harness_id, agent_id: r.agent_id };
}

const draft = {
  objective: 'A distraction-free study platform for students.',
  constraints: [{ text: 'Never show ads.', from_paths: ['README.md'] }],
  outcomes: ['Students finish playlists.'],
  non_goals: ['Social feeds.'],
  definition_of_done: ['The build and lint pass.'],
};

describe('project intent (ADR-0034 §1–§2)', () => {
  it('counts only a human-approved version, and approving supersedes the one before', () => {
    const v1 = state.intent.propose(PROJECT, brain, draft);
    expect(v1).toMatchObject({ version: 1, status: 'proposed', proposed_by: brain, decided_by: null });
    expect(v1.constraints).toEqual([{ text: 'Never show ads.', source: 'planner', from_paths: ['README.md'] }]);
    expect(v1.content_hash).toMatch(/^pi1_[0-9a-f]{16}$/);
    // A draft never counts.
    expect(state.q.approvedProjectIntent(PROJECT)).toBeUndefined();
    expect(state.q.proposedProjectIntent(PROJECT)?.version).toBe(1);

    expect(code(() => state.intent.approve(PROJECT, brain, 1))).toBe('COS-3000');
    const a1 = state.intent.approve(PROJECT, human, 1, 'looks right');
    expect(a1).toMatchObject({ status: 'approved', decided_by: human, decision_note: 'looks right' });
    expect(state.q.approvedProjectIntent(PROJECT)?.version).toBe(1);
    expect(code(() => state.intent.approve(PROJECT, human, 1))).toBe('COS-2002');

    // The human keeps the planner's constraint as it was and adds their own line.
    const v2 = state.intent.propose(PROJECT, human, { ...draft, non_goals: ['Social feeds.', 'Paid tiers.'] });
    expect(v2.version).toBe(2);
    expect(v2.constraints[0]?.source).toBe('planner');
    // 'Social feeds.' was the planner's line, kept as it was; 'Paid tiers.' is the human's own.
    expect(v2.non_goals.map((i) => i.source)).toEqual(['planner', 'human']);
    state.intent.approve(PROJECT, human, 2);
    expect(state.q.projectIntents(PROJECT).map((v) => [v.version, v.status])).toEqual([
      [2, 'approved'],
      [1, 'superseded'],
    ]);
    expect(state.q.approvedProjectIntent(PROJECT)?.version).toBe(2);
  });

  it('records nothing for an unchanged proposal, and a newer proposal replaces a waiting one', () => {
    state.intent.propose(PROJECT, brain, draft);
    state.intent.approve(PROJECT, human, 1);
    const events = () => state.store.readByRef(PROJECT, 'intent', 'v1').length;
    const before = events();
    // The same content as approved, with nothing waiting: no new version.
    expect(state.intent.propose(PROJECT, human, { ...draft, objective: `  ${draft.objective}  ` }).version).toBe(1);
    expect(events()).toBe(before);
    expect(state.q.projectIntents(PROJECT)).toHaveLength(1);

    state.intent.propose(PROJECT, human, { ...draft, outcomes: ['Students learn faster.'] });
    // The same proposal again returns the waiting version.
    expect(state.intent.propose(PROJECT, human, { ...draft, outcomes: ['Students learn faster.'] }).version).toBe(2);
    state.intent.propose(PROJECT, human, { ...draft, outcomes: ['Students learn more.'] });
    expect(state.q.projectIntents(PROJECT).map((v) => [v.version, v.status])).toEqual([
      [3, 'proposed'],
      [2, 'superseded'],
      [1, 'approved'],
    ]);
    state.intent.reject(PROJECT, human, 3, 'no');
    expect(state.q.projectIntent(PROJECT, 3)).toMatchObject({ status: 'rejected', decision_note: 'no' });
    expect(state.q.approvedProjectIntent(PROJECT)?.version).toBe(1);
    expect(code(() => state.q.projectIntent(PROJECT, 9))).toBe('COS-2009');
  });

  it('refuses agents, and an intent too long to include in every packet', () => {
    expect(code(() => state.intent.propose(PROJECT, { kind: 'agent', id: 'agent_x' }, draft))).toBe('COS-3000');
    const long = Array.from({ length: 12 }, (_, i) => `${i} ${'x'.repeat(250)}`);
    const err = (() => {
      try {
        state.intent.propose(PROJECT, human, { ...draft, constraints: long });
      } catch (e) {
        return e as FridayError;
      }
      throw new Error('expected an error');
    })();
    expect(err.code).toBe('COS-1000');
    expect(err.message).toContain(String(PROJECT_INTENT_MAX_CHARS));
    expect(state.q.projectIntents(PROJECT)).toEqual([]);
  });

  it('drops repeated lines, ignoring case and spacing', () => {
    const v = state.intent.propose(PROJECT, human, {
      ...draft,
      non_goals: ['Social  feeds.', 'social feeds.', 'Ads.'],
    });
    expect(v.non_goals.map((i) => i.text)).toEqual(['Social feeds.', 'Ads.']);
  });
});

describe('goal intent (ADR-0034 §3)', () => {
  it('stores non-goals and a definition of done, and counts intent revisions', () => {
    const goal = state.createGoal(PROJECT, human, {
      request: 'Refactor the video cards',
      constraints: ['Keep the public props.'],
      non_goals: ['No new npm packages.'],
      definition_of_done: ['The dashboard builds.'],
      plan: false,
    });
    expect(goal).toMatchObject({
      non_goals: ['No new npm packages.'],
      definition_of_done: ['The dashboard builds.'],
      inferred_non_goals: [],
      inferred_definition_of_done: [],
      intent_revision: 1,
    });

    const edited = state.intent.updateGoal(PROJECT, human, goal.goal_id, {
      non_goals: ['No new npm packages.', 'No style changes.'],
    });
    expect(edited.non_goals).toEqual(['No new npm packages.', 'No style changes.']);
    expect(edited.intent_revision).toBe(2);

    // The same values again change nothing and record nothing.
    const events = state.store.readByRef(PROJECT, 'goal', goal.goal_id).length;
    const same = state.intent.updateGoal(PROJECT, human, goal.goal_id, {
      non_goals: ['No new npm packages.', 'No style changes.'],
      definition_of_done: ['The dashboard builds.'],
    });
    expect(same.intent_revision).toBe(2);
    expect(state.store.readByRef(PROJECT, 'goal', goal.goal_id)).toHaveLength(events);

    expect(code(() => state.intent.updateGoal(PROJECT, brain, goal.goal_id, { non_goals: [] }))).toBe('COS-3000');
    state.cancelGoal(PROJECT, human, goal.goal_id, 'done with it');
    expect(code(() => state.intent.updateGoal(PROJECT, human, goal.goal_id, { non_goals: [] }))).toBe('COS-2002');
  });

  it('caps intent lines like the existing constraints', () => {
    expect(() =>
      state.createGoal(PROJECT, human, { request: 'Big goal', non_goals: Array(13).fill('x'), plan: false }),
    ).toThrow();
    expect(() =>
      state.createGoal(PROJECT, human, { request: 'Big goal', definition_of_done: ['x'.repeat(301)], plan: false }),
    ).toThrow();
  });
});

describe('learning proposals (ADR-0034 §7)', () => {
  it('lets an agent propose from a task it holds, once, and a human reject it', () => {
    const be = agent('be-1');
    const t = state.createTask(PROJECT, human, {
      summary: 'Fix migrations',
      scope: { write: ['db/**'], read: [] },
      assign_agent_key: 'be-1',
    });
    const input = {
      task_id: t.task_id,
      kind: 'bug-pattern' as const,
      subject: 'Migrations',
      content: 'Back up the dev database before running migrations.',
      paths: ['db/migrations/**'],
      tags: ['db', 'db'],
    };
    const p = state.learnings.propose(PROJECT, be, input);
    expect(p).toMatchObject({
      task_id: t.task_id,
      proposed_by: { agent_id: be.agent_id, agent_key: 'be-1' },
      status: 'proposed',
      memory_id: null,
      tags: ['db'],
      paths: ['db/migrations/**'],
    });
    expect(p.proposal_id).toMatch(/^lrn_/);
    // The same proposal again is the same record.
    expect(state.learnings.propose(PROJECT, be, { ...input, content: ` ${input.content}  ` }).proposal_id).toBe(
      p.proposal_id,
    );
    expect(state.q.learningProposals(PROJECT)).toHaveLength(1);
    // Agents still never write project memory directly.
    expect(state.memory.search(PROJECT, { kind: 'human', actor: human })).toEqual([]);

    expect(code(() => state.learnings.reject(PROJECT, { kind: 'agent', id: be.agent_id }, p.proposal_id))).toBe(
      'COS-3000',
    );
    const r = state.learnings.reject(PROJECT, human, p.proposal_id, 'too specific');
    expect(r).toMatchObject({ status: 'rejected', decided_by: human, decision_note: 'too specific' });
    expect(code(() => state.learnings.reject(PROJECT, human, p.proposal_id))).toBe('COS-2002');
    expect(code(() => state.q.learningProposal(PROJECT, 'lrn_missing'))).toBe('COS-2010');
  });

  it('refuses a task the agent does not hold', () => {
    agent('be-1');
    const other = agent('fe-1');
    const t = state.createTask(PROJECT, human, {
      summary: 'Fix migrations',
      scope: { write: ['db/**'], read: [] },
      assign_agent_key: 'be-1',
    });
    expect(
      code(() =>
        state.learnings.propose(PROJECT, other, {
          task_id: t.task_id,
          kind: 'convention',
          subject: 'x',
          content: 'y',
        }),
      ),
    ).toBe('COS-3000');
    expect(
      code(() => state.learnings.propose(PROJECT, other, { kind: 'convention', subject: 'x', content: 'y' })),
    ).toBe('COS-1000');
  });
});

describe('replay (ADR-0034 §9)', () => {
  it('rebuilds project intent, goal intent and proposals exactly', () => {
    state.intent.propose(PROJECT, brain, draft);
    state.intent.approve(PROJECT, human, 1);
    state.intent.propose(PROJECT, human, { ...draft, outcomes: ['More focus.'] });
    const goal = state.createGoal(PROJECT, human, { request: 'Refactor cards', non_goals: ['No deps.'], plan: false });
    state.intent.updateGoal(PROJECT, human, goal.goal_id, { definition_of_done: ['Builds.'] });
    const be = agent('be-1');
    const t = state.createTask(PROJECT, human, {
      summary: 'Cards',
      scope: { write: ['app/**'], read: [] },
      assign_agent_key: 'be-1',
    });
    const p = state.learnings.propose(PROJECT, be, {
      task_id: t.task_id,
      kind: 'convention',
      subject: 'Cards',
      content: 'Use VideoCard.',
    });
    state.learnings.propose(PROJECT, be, {
      task_id: t.task_id,
      kind: 'dependency',
      subject: 'Icons',
      content: 'lucide only.',
    });
    state.learnings.reject(PROJECT, human, p.proposal_id);

    const dump = () =>
      Object.fromEntries(DOMAIN_TABLES.map((tb) => [tb, db.prepare(`SELECT * FROM ${tb} ORDER BY 1, 2`).all()]));
    const before = dump();
    replay(db, state.store, PROJECT, state.projector);
    expect(dump()).toEqual(before);
    expect(state.q.goal(PROJECT, goal.goal_id).intent_revision).toBe(2);
    expect(state.q.approvedProjectIntent(PROJECT)?.version).toBe(1);
  });
});

describe('learning promotion (ADR-0034 §7)', () => {
  let claims = 0;
  /** be-1 holds a task, proposes what it learned, claims done; returns the task and its proposal. */
  function proposedWork(content = 'Back up the dev database before running migrations.') {
    const be = agent('be-1');
    const t = state.createTask(PROJECT, human, {
      summary: 'Fix migrations',
      scope: { write: ['db/**'], read: [] },
      assign_agent_key: 'be-1',
    });
    const run = state.claimTask(PROJECT, be, { task_id: t.task_id }).run_id;
    const proposal = state.learnings.propose(PROJECT, be, {
      task_id: t.task_id,
      kind: 'bug-pattern',
      subject: 'Migrations',
      content,
      paths: ['db/migrations/**'],
      tags: ['db'],
    });
    claims += 1;
    state.submitResult(PROJECT, be, {
      idempotency_key: `claim-${claims}`,
      task_id: t.task_id,
      run_id: run,
      status: 'completed_claim',
      summary: 'done',
      changed_paths: [],
      checks: [],
      notes: [],
      risks: [],
    });
    return { taskId: t.task_id, proposal, be };
  }
  const verify = (taskId: string, passed: boolean) => {
    const { verification_id } = state.startVerification(PROJECT, { kind: 'system', id: 'friday' }, taskId);
    state.finishVerification(
      PROJECT,
      { kind: 'system', id: 'friday' },
      verification_id,
      passed,
      passed ? 'ok' : 'failed',
    );
    return verification_id;
  };
  const H = { kind: 'human' as const, actor: human };

  it('makes a proposal project memory with verification authority once its task passes', () => {
    const { taskId, proposal } = proposedWork();
    const verificationId = verify(taskId, true);
    const p = state.q.learningProposal(PROJECT, proposal.proposal_id);
    expect(p).toMatchObject({
      status: 'promoted',
      decided_by: { kind: 'system', id: `verification:${verificationId}` },
    });
    const memory = state.memory.get(p.memory_id as string);
    expect(memory).toMatchObject({
      scope_type: 'project',
      kind: 'bug-pattern',
      content: 'Back up the dev database before running migrations.',
      authority: 'verified',
      verification_status: 'verified',
      needs_review: false,
      source: { kind: 'system', id: `verification:${verificationId}` },
    });
    // Its paths become path tags, so a later packet can pick it for matching work.
    expect(memory.tags).toEqual(expect.arrayContaining(['db', 'db/migrations/**']));
    // The verdict and the promotion are one transaction.
    const types = state.store.readByRef(PROJECT, 'task', taskId).map((e) => e.type);
    expect(types.indexOf('learning.promoted')).toBeGreaterThan(types.indexOf('verification.finished'));
  });

  it('promotes nothing when verification fails; a human may still approve it', () => {
    const { taskId, proposal } = proposedWork();
    verify(taskId, false);
    expect(state.q.learningProposal(PROJECT, proposal.proposal_id).status).toBe('proposed');
    expect(state.memory.search(PROJECT, H)).toEqual([]);
    expect(() => state.learnings.approve(PROJECT, { kind: 'agent', id: 'agent_x' }, proposal.proposal_id)).toThrow(
      FridayError,
    );
    const approved = state.learnings.approve(PROJECT, human, proposal.proposal_id, 'right after all');
    expect(approved).toMatchObject({ status: 'promoted', decided_by: human, decision_note: 'right after all' });
    expect(state.memory.get(approved.memory_id as string)).toMatchObject({ authority: 'human-approved' });
    expect(code(() => state.learnings.approve(PROJECT, human, proposal.proposal_id))).toBe('COS-2002');
  });

  it('keeps a promoted learning that contradicts a human decision waiting for review', () => {
    state.memory.record(PROJECT, H, {
      scope_type: 'project',
      kind: 'bug-pattern',
      subject: 'Migrations',
      content: 'Migrations run without a backup; the dev database is disposable.',
    });
    const { taskId, proposal } = proposedWork();
    verify(taskId, true);
    const p = state.q.learningProposal(PROJECT, proposal.proposal_id);
    expect(p.status).toBe('promoted');
    const memory = state.memory.get(p.memory_id as string);
    // A verified memory never overrides a human-approved one: both stay, the new one needs review.
    expect(memory).toMatchObject({ needs_review: true, status: 'active' });
    expect(memory.contradicts.length).toBe(1);
  });

  it('records an identical lesson once', () => {
    state.memory.record(PROJECT, H, {
      scope_type: 'project',
      kind: 'bug-pattern',
      subject: 'Migrations',
      content: 'Back up the dev database before running migrations.',
    });
    const before = state.memory.search(PROJECT, H).length;
    const { taskId, proposal } = proposedWork();
    verify(taskId, true);
    const p = state.q.learningProposal(PROJECT, proposal.proposal_id);
    expect(p.status).toBe('promoted');
    expect(state.memory.search(PROJECT, H).length).toBe(before);
  });

  it('replays promotions exactly', () => {
    const { taskId } = proposedWork();
    verify(taskId, true);
    const dump = () =>
      Object.fromEntries(DOMAIN_TABLES.map((tb) => [tb, db.prepare(`SELECT * FROM ${tb} ORDER BY 1, 2`).all()]));
    const before = dump();
    replay(db, state.store, PROJECT, state.projector);
    expect(dump()).toEqual(before);
  });
});
