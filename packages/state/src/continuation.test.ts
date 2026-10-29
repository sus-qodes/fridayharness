/**
 * A rework continues the session that did the work (plan M13.2): when the same agent on the same
 * harness takes it, the attempt verification refused left a session, the harness can resume one,
 * and the policy its packet was compiled under still holds.
 */
import { sequentialIds } from '@friday/core';
import { openDatabase } from '@friday/db';
import { type Actor, AgentResultParams, type ContextPacket, HarnessRegisterParams } from '@friday/protocol';
import { FakeClock } from '@friday/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import { FridayState } from './index.js';

const PROJECT = 'proj_00000000000000000000000001';
const human: Actor = { kind: 'human', id: 'local-user' };
let state: FridayState;

beforeEach(() => {
  state = new FridayState({
    db: openDatabase(':memory:'),
    clock: new FakeClock('2026-10-19T10:00:00.000Z'),
    ids: sequentialIds(),
  });
  state.ensureProject({ project_id: PROJECT, name: 'shop', root_path: 'C:/demo/shop' });
});

function spawned(agent: string, resume: boolean) {
  return state.registerHarness(
    PROJECT,
    HarnessRegisterParams.parse({
      protocol_version: '1.0',
      harness_key: `generic:${PROJECT}:${agent}`,
      vendor: 'generic',
      name: agent,
      attach_mode: 'spawn',
      project_id: PROJECT,
      capabilities: { task_start: true, resume_session: resume },
      agent: { agent_key: agent, role: 'backend' },
    }),
  );
}
type Reg = ReturnType<typeof spawned>;

/** The harness's next task.start, accepted with a session (or declined). */
function start(reg: Reg, session: string | null) {
  const [m] = state.pollOutbox(PROJECT, reg.harness_id);
  if (!m) throw new Error('no task.start');
  state.ackOutbox(PROJECT, reg.harness_id, [
    session
      ? { message_id: m.message_id, accepted: true, session_ref: session }
      : { message_id: m.message_id, accepted: false, reason: 'busy' },
  ]);
  return m.params as { run_id: string; continue_session: string | null; note: string | null };
}

function packetFor(reg: Reg, taskId: string, runId: string, policy: string | null) {
  const packet = {
    context_id: `ctx_${runId.slice(4)}`,
    project_id: PROJECT,
    recipient: { kind: 'agent', id: reg.agent_id, harness_id: reg.harness_id, run_id: runId },
    task_id: taskId,
    purpose: 'request:task',
    created_at: '2026-10-19T10:00:00.000Z',
    state_version: 1,
    budget: { tokens: 100, latency_ms: 50 },
    sections: [],
    staleness: { is_stale: false },
  } as unknown as ContextPacket;
  state.recordContextPacket(PROJECT, { kind: 'agent', id: reg.agent_id }, packet, { policy_version: policy });
}

/** The attempt claims done, a human refuses the claim, and the task is sent back. */
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

function task() {
  return state.createTask(PROJECT, human, {
    summary: 'redeem a gift card',
    scope: { write: ['backend/**'], read: [] },
    ready: true,
  });
}

describe('a rework continues its session (plan M13.2)', () => {
  it('names the session and why the claim was refused, for the same agent on a harness that can resume', () => {
    const be = spawned('be-1', true);
    const t = task();
    state.assignTask(PROJECT, human, t.task_id, 'be-1');
    const first = start(be, 'sess-1');
    refuse(be, t.task_id, first.run_id);
    state.assignTask(PROJECT, human, t.task_id, 'be-1');
    const second = start(be, 'sess-1');
    expect(second.continue_session).toBe('sess-1');
    expect(second.note).toBe(
      "Friday's verification refused your completion claim.\nWhy: cover the edge case\nChecks that failed: tests: the edge case fails\nFix this in this worktree, then give your final answer again.",
    );
  });

  it('starts a new session for a harness that cannot resume, or for another agent', () => {
    const be = spawned('be-1', false);
    const t = task();
    state.assignTask(PROJECT, human, t.task_id, 'be-1');
    refuse(be, t.task_id, start(be, 'sess-1').run_id);
    state.assignTask(PROJECT, human, t.task_id, 'be-1');
    expect(start(be, 'sess-2').continue_session).toBeNull();

    const a = spawned('be-a', true);
    const b = spawned('be-b', true);
    const u = task();
    state.assignTask(PROJECT, human, u.task_id, 'be-a');
    refuse(a, u.task_id, start(a, 'sess-a').run_id);
    state.unreserveTask(PROJECT, human, u.task_id, 'anyone');
    state.assignTask(PROJECT, human, u.task_id, 'be-b');
    expect(start(b, 'sess-b').continue_session).toBeNull();
  });

  it('starts a new session when the policy changed since the packet the session was given (review M7.1e R02)', () => {
    let policy = 'p1';
    state.policyVersion = () => policy;
    const be = spawned('be-1', true);
    const t = task();
    state.assignTask(PROJECT, human, t.task_id, 'be-1');
    const first = start(be, 'sess-1');
    packetFor(be, t.task_id, first.run_id, 'p1');
    refuse(be, t.task_id, first.run_id);
    policy = 'p2';
    state.assignTask(PROJECT, human, t.task_id, 'be-1');
    expect(start(be, 'sess-1').continue_session).toBeNull();
  });

  it('continues past an attempt that was declined and started no session', () => {
    state.policyVersion = () => 'p1';
    const be = spawned('be-1', true);
    const t = task();
    state.assignTask(PROJECT, human, t.task_id, 'be-1');
    const first = start(be, 'sess-1');
    packetFor(be, t.task_id, first.run_id, 'p1');
    refuse(be, t.task_id, first.run_id);
    state.assignTask(PROJECT, human, t.task_id, 'be-1');
    start(be, null);
    state.assignTask(PROJECT, human, t.task_id, 'be-1');
    expect(start(be, 'sess-1').continue_session).toBe('sess-1');
  });
});
