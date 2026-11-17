/**
 * "Assign to" is followed (2026-11-17): routing is told when a person gave the task to the agent a
 * run is created for, so it chooses the model and no longer whether the work may run there. It is
 * told for a person's own assignment, for a task kept for an agent at a person's word, and for the
 * rework of an attempt a person had given that agent; never for what Friday delegated itself.
 */
import { sequentialIds } from '@friday/core';
import { openDatabase } from '@friday/db';
import { type Actor, AgentResultParams, HarnessRegisterParams } from '@friday/protocol';
import { FakeClock } from '@friday/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import { FridayState, type RunRouter } from './index.js';

const PROJECT = 'proj_00000000000000000000000001';
const human: Actor = { kind: 'human', id: 'local-user' };
const brain: Actor = { kind: 'master_brain', id: 'master-brain' };
let state: FridayState;
/** What routing was told for each run it decided, in order: the agent and whether a person assigned. */
let told: [agent: string, assigned: boolean][];

beforeEach(() => {
  state = new FridayState({
    db: openDatabase(':memory:'),
    clock: new FakeClock('2026-11-17T10:00:00.000Z'),
    ids: sequentialIds(),
  });
  state.ensureProject({ project_id: PROJECT, name: 'shop', root_path: 'C:/demo/shop' });
  told = [];
  // A router as the daemon's: it records what it was told, and its decision carries the code the
  // real one gives a person's assignment, which is how a rework finds it again.
  const router: RunRouter = ({ task, agent, assigned }) => {
    told.push([agent.agent_key, assigned === true]);
    return {
      decision: {
        mode: 'registry',
        task_class: task.kind,
        model: 'model-x',
        binding: true,
        blocked: false,
        source: 'registry',
        reason: 'test',
        reason_codes: assigned ? ['assignment.human', 'registry.rank'] : ['registry.rank'],
      },
    };
  };
  state.setRouter(router);
});

function spawned(agent: string) {
  return state.registerHarness(
    PROJECT,
    HarnessRegisterParams.parse({
      protocol_version: '1.0',
      harness_key: `generic:${PROJECT}:${agent}`,
      vendor: 'generic',
      name: agent,
      attach_mode: 'spawn',
      project_id: PROJECT,
      capabilities: { task_start: true },
      agent: { agent_key: agent, role: 'backend' },
    }),
  );
}
type Reg = ReturnType<typeof spawned>;

function accept(reg: Reg): { run_id: string } {
  const [m] = state.pollOutbox(PROJECT, reg.harness_id);
  if (!m) throw new Error('no task.start');
  state.ackOutbox(PROJECT, reg.harness_id, [{ message_id: m.message_id, accepted: true, session_ref: 's' }]);
  return m.params as { run_id: string };
}

/** The attempt claims done, a human's check refuses it, and the task is sent back for rework. */
function refuse(reg: Reg, taskId: string, runId: string) {
  state.submitResult(
    PROJECT,
    { harness_id: reg.harness_id, agent_id: reg.agent_id },
    AgentResultParams.parse({
      protocol_version: '1.0',
      idempotency_key: `done-${runId}`,
      task_id: taskId,
      run_id: runId,
      status: 'completed_claim',
      summary: 'done',
      changed_paths: [],
    }),
  );
  const { verification_id } = state.startVerification(PROJECT, human, taskId);
  state.recordVerificationCheck(PROJECT, human, verification_id, {
    name: 'tests',
    kind: 'test',
    status: 'FAILED',
    exit_code: 1,
    artifact_ref: null,
    summary: 'the edge case fails',
  });
  state.finishVerification(PROJECT, human, verification_id, false, '0/1 checks passed');
  state.reworkTask(PROJECT, human, taskId, 'cover the edge case');
}

const task = (summary = 'redeem a gift card') =>
  state.createTask(PROJECT, human, { summary, scope: { write: ['backend/**'], read: [] }, ready: true });

describe('routing is told when a person gave the task to the agent', () => {
  it('for a person’s own assignment, and not for what Friday delegates', () => {
    const be = spawned('be-1');
    const t = task();
    expect(state.assignTask(PROJECT, human, t.task_id, 'be-1').mode).toBe('assigned');
    expect(told).toEqual([['be-1', true]]);

    const other = spawned('be-2');
    const mine = task('another');
    state.delegateTask(PROJECT, brain, mine.task_id, { agent_key: 'be-2', reason: 'best fit', scores: [] });
    expect(told).toEqual([
      ['be-1', true],
      ['be-2', false],
    ]);
    void be;
    void other;
  });

  it('for a task kept for a busy agent at a person’s word, when Friday starts it there later', () => {
    const be = spawned('be-1');
    const first = task('first');
    state.assignTask(PROJECT, human, first.task_id, 'be-1');
    const run = accept(be);
    const kept = task('second');
    // The agent is busy: the task is kept for it, and no run exists yet, so nothing was routed.
    expect(state.assignTask(PROJECT, human, kept.task_id, 'be-1').mode).toBe('reserved');
    expect(state.q.task(PROJECT, kept.task_id)).toMatchObject({ reserved_for_agent_key: 'be-1', reserved_by: 'human' });
    expect(told).toHaveLength(1);
    // The agent finishes; Friday pushes the kept task: still a person's choice of agent.
    state.submitResult(
      PROJECT,
      { harness_id: be.harness_id, agent_id: be.agent_id },
      AgentResultParams.parse({
        protocol_version: '1.0',
        idempotency_key: 'done-first',
        task_id: first.task_id,
        run_id: run.run_id,
        status: 'completed_claim',
        summary: 'done',
        changed_paths: [],
      }),
    );
    state.delegateTask(PROJECT, brain, kept.task_id, {
      agent_key: 'be-1',
      reason: 'reserved for this agent',
      scores: [],
    });
    expect(told.at(-1)).toEqual(['be-1', true]);
  });

  it('for the rework of an attempt a person had given that agent, and not of one Friday delegated', () => {
    const be = spawned('be-1');
    const t = task();
    state.assignTask(PROJECT, human, t.task_id, 'be-1');
    refuse(be, t.task_id, accept(be).run_id);
    expect(state.q.task(PROJECT, t.task_id)).toMatchObject({ reserved_for_agent_key: 'be-1', reserved_by: 'rework' });
    state.delegateTask(PROJECT, brain, t.task_id, { agent_key: 'be-1', reason: 'reserved for this agent', scores: [] });
    expect(told).toEqual([
      ['be-1', true],
      ['be-1', true],
    ]);

    // An attempt Friday delegated comes back for rework as Friday's own choice.
    const two = spawned('be-2');
    const own = task('delegated');
    state.delegateTask(PROJECT, brain, own.task_id, { agent_key: 'be-2', reason: 'best fit', scores: [] });
    refuse(two, own.task_id, accept(two).run_id);
    state.delegateTask(PROJECT, brain, own.task_id, {
      agent_key: 'be-2',
      reason: 'reserved for this agent',
      scores: [],
    });
    expect(told.slice(2)).toEqual([
      ['be-2', false],
      ['be-2', false],
    ]);
  });
});
