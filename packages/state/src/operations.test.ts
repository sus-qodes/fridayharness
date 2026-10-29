/**
 * Runs of operations by the execution gateway in the state (plan M6c, ADR-0029 §3, §7).
 */
import { openDatabase, type SqlDatabase } from '@friday/db';
import { replay } from '@friday/events';
import { type Actor, HarnessRegisterParams } from '@friday/protocol';
import { FakeClock } from '@friday/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import { DOMAIN_TABLES, FridayState } from './index.js';

const PROJECT = 'proj_00000000000000000000000001';
const human: Actor = { kind: 'human', id: 'local-user' };

let db: SqlDatabase;
let clock: FakeClock;
let state: FridayState;

beforeEach(() => {
  db = openDatabase(':memory:');
  clock = new FakeClock('2026-10-14T10:00:00.000Z');
  state = new FridayState({ db, clock });
  state.ensureProject({ project_id: PROJECT, name: 'shop', root_path: 'C:/demo/shop' });
});

function agentOnTask() {
  const reg = state.registerHarness(
    PROJECT,
    HarnessRegisterParams.parse({
      protocol_version: '1.0',
      harness_key: `claude-code:${PROJECT}:pid:301`,
      vendor: 'claude-code',
      name: 'Claude Code',
      attach_mode: 'attach',
      project_id: PROJECT,
      agent: { agent_key: 'backend-1', role: 'backend' },
    }),
  );
  const t = state.createTask(PROJECT, human, { summary: 'subscriptions', assign_agent_key: 'backend-1' });
  const caller = { harness_id: reg.harness_id, agent_id: reg.agent_id };
  const run = state.claimTask(PROJECT, caller, { task_id: t.task_id });
  return { caller, task_id: t.task_id, run_id: run.run_id };
}

const start = (a: ReturnType<typeof agentOnTask>, approval_id: string | null, version = 'v1') =>
  state.startOperation(PROJECT, a.caller, {
    operation: 'stripe-test',
    task_id: a.task_id,
    run_id: a.run_id,
    binary: 'C:/Program Files/nodejs/node.exe',
    cwd: 'C:/demo/shop',
    credentials: ['stripe-test'],
    approval_id,
    policy_version: version,
    risk: 'high',
    reason: 'test the subscription webhook',
  });

describe('operation runs', () => {
  it('records a run with its credential names, spends its approval, and records the outcome', () => {
    const a = agentOnTask();
    const asked = state.requestPermission(
      PROJECT,
      a.caller,
      {
        task_id: a.task_id,
        run_id: a.run_id,
        action_class: 'operation.run',
        resource: 'stripe-test',
        justification: 'test the subscription webhook',
        ttl_s: 600,
        reuse: 'once',
      },
      {
        capability: 'operation.run',
        decision: 'review',
        risk: 'high',
        reason: 'a human decides',
        policy_version: 'v1',
      },
    );
    const id = asked.approval_id as string;
    // Asking again finds the request already waiting.
    expect(
      state.q.pendingApproval(
        PROJECT,
        {
          capability: 'operation.run',
          target: 'stripe-test',
          task_id: a.task_id,
          run_id: a.run_id,
          agent_id: a.caller.agent_id,
        },
        clock.now(),
      )?.approval_id,
    ).toBe(id);
    // Not yet granted: starting with it is refused.
    expect(() => start(a, id)).toThrow(/no longer covers/);
    state.decideApproval(PROJECT, human, id, true, { via: 'cli' });
    // Granted under another policy version: refused too.
    expect(() => start(a, id, 'v2')).toThrow(/no longer covers/);

    const run = start(a, id);
    expect(run).toMatchObject({ status: 'running', credentials: ['stripe-test'], approval_id: id, risk: 'high' });
    expect(state.q.approvals(PROJECT).find((x) => x.approval_id === id)?.status).toBe('used');
    // One at a time per task.
    expect(() => start(a, null)).toThrow(/already running/);

    clock.advance(4200);
    const done = state.finishOperation(PROJECT, run.operation_run_id, {
      status: 'passed',
      exit_code: 0,
      timed_out: false,
      duration_ms: 4200,
      redactions: 2,
      artifact_ref: 'artifact:artifact_x',
      summary: 'passed in 4200 ms',
    });
    expect(done).toMatchObject({ status: 'passed', exit_code: 0, redactions: 2, ended_at: clock.now() });
    // Finished once: a second outcome changes nothing.
    expect(
      state.finishOperation(PROJECT, run.operation_run_id, { ...done, status: 'failed', duration_ms: 1, summary: 'x' }),
    ).toMatchObject({ status: 'passed' });
    expect(state.q.operationRuns(PROJECT, { task_id: a.task_id }).map((r) => r.status)).toEqual(['passed']);
  });

  it('interrupts runs whose runner stopped with the daemon, and rebuilds them on replay', () => {
    const a = agentOnTask();
    const first = start(a, null);
    const ids = state.interruptOrphanedOperations(PROJECT, 'the daemon stopped while it ran', new Set());
    expect(ids).toEqual([first.operation_run_id]);
    expect(state.q.operationRun(first.operation_run_id)).toMatchObject({
      status: 'interrupted',
      summary: 'the daemon stopped while it ran',
    });
    const second = start(a, null);
    expect(state.interruptOrphanedOperations(PROJECT, 'x', new Set([second.operation_run_id]))).toEqual([]);

    const dump = () => Object.fromEntries(DOMAIN_TABLES.map((t) => [t, db.prepare(`SELECT * FROM ${t}`).all()]));
    const before = dump();
    replay(db, state.store, PROJECT, state.projector);
    expect(dump()).toEqual(before);
  });

  it('checks every part of its authority again at the moment it starts (review F06)', () => {
    // The policy (or the operation, or the agent's role) changed meanwhile: the daemon says so.
    const a = agentOnTask();
    expect(() =>
      state.startOperation(
        PROJECT,
        a.caller,
        {
          operation: 'stripe-test',
          task_id: a.task_id,
          run_id: a.run_id,
          binary: 'node',
          cwd: 'C:/demo/shop',
          credentials: [],
          approval_id: null,
          policy_version: 'v1',
          risk: 'low',
          reason: 'x',
        },
        { still: () => "the project's policy changed while stripe-test was being prepared" },
      ),
    ).toThrow(/policy changed/);
    // Another session than the one holding the attempt.
    expect(() => start({ ...a, caller: { ...a.caller, harness_id: 'harness_other' } }, null)).toThrow(
      /no longer holds the attempt/,
    );
    // The task was cancelled while the credentials loaded.
    state.cancelTask(PROJECT, human, a.task_id, 'changed my mind');
    expect(() => start(a, null)).toThrow(/is CANCELLED; stripe-test was not started/);
    expect(state.q.operationRuns(PROJECT, { task_id: a.task_id })).toEqual([]);
  });
});
