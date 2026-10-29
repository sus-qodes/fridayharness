/**
 * Bound approvals in the state (plan M6a, ADR-0027 §4–§5).
 */
import { openDatabase, type SqlDatabase } from '@friday/db';
import { replay } from '@friday/events';
import { type Actor, HarnessRegisterParams } from '@friday/protocol';
import { FakeClock } from '@friday/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Caller, DOMAIN_TABLES, FridayState } from './index.js';

const PROJECT = 'proj_00000000000000000000000001';
const human: Actor = { kind: 'human', id: 'local-user' };
const PUSH = { capability: 'shell.git.push', decision: 'review' as const, risk: 'high' as const, reason: 'manual' };

let db: SqlDatabase;
let clock: FakeClock;
let state: FridayState;

beforeEach(() => {
  db = openDatabase(':memory:');
  clock = new FakeClock('2026-10-14T10:00:00.000Z');
  state = new FridayState({ db, clock });
  state.ensureProject({ project_id: PROJECT, name: 'shop', root_path: 'C:/demo/shop' });
});

/** An agent holding a running task. */
function agentOnTask(n: number): { caller: Caller; task_id: string; run_id: string } {
  const reg = state.registerHarness(
    PROJECT,
    HarnessRegisterParams.parse({
      protocol_version: '1.0',
      harness_key: `claude-code:${PROJECT}:pid:${200 + n}`,
      vendor: 'claude-code',
      name: 'Claude Code',
      attach_mode: 'attach',
      project_id: PROJECT,
      agent: { agent_key: `dev-${n}` },
    }),
  );
  const t = state.createTask(PROJECT, human, { summary: `task ${n}`, assign_agent_key: `dev-${n}` });
  const caller = { harness_id: reg.harness_id, agent_id: reg.agent_id };
  const run = state.claimTask(PROJECT, caller, { task_id: t.task_id });
  return { caller, task_id: t.task_id, run_id: run.run_id };
}

const ask = (a: ReturnType<typeof agentOnTask>, reuse: 'once' | 'run' | 'task', version = 'v1') =>
  state.requestPermission(
    PROJECT,
    a.caller,
    {
      task_id: a.task_id,
      run_id: a.run_id,
      action_class: 'shell.git.push',
      command: 'git push',
      justification: 'release',
      ttl_s: 600,
      reuse,
    },
    { ...PUSH, policy_version: version },
  ).approval_id as string;

const use = (a: ReturnType<typeof agentOnTask>, version = 'v1', run = a.run_id) =>
  state.q.usableApproval(PROJECT, {
    capability: 'shell.git.push',
    target: 'git push',
    task_id: a.task_id,
    run_id: run,
    agent_id: a.caller.agent_id,
    policy_version: version,
    now: clock.now(),
  });

describe('bound approvals', () => {
  it('resumes a task its agent set waiting once the approvals it waited on are granted (LESSONS D-46)', () => {
    const a = agentOnTask(1);
    const push = ask(a, 'once');
    const tag = state.requestPermission(
      PROJECT,
      a.caller,
      {
        task_id: a.task_id,
        run_id: a.run_id,
        action_class: 'shell.git.push',
        command: 'git push --tags',
        justification: 'release tags',
        ttl_s: 600,
      },
      { ...PUSH, policy_version: 'v1' },
    ).approval_id as string;
    const waiting = { task_id: a.task_id, run_id: a.run_id, note: 'waiting for the human' };
    state.updateTask(PROJECT, a.caller, { ...waiting, status: 'waiting', waiting_reason: 'human_approval' });
    expect(state.q.task(PROJECT, a.task_id).status).toBe('WAITING');

    // One of two requests granted: the other still waits for a human.
    state.decideApproval(PROJECT, human, push, true, { via: 'cli' });
    expect(state.q.task(PROJECT, a.task_id).status).toBe('WAITING');
    state.decideApproval(PROJECT, human, tag, true, { via: 'cli' });
    expect(state.q.task(PROJECT, a.task_id)).toMatchObject({ status: 'RUNNING', waiting_reason: null });

    // A task waiting for something else, or a refusal, does not resume.
    const b = agentOnTask(2);
    const other = ask(b, 'once');
    state.updateTask(PROJECT, b.caller, {
      task_id: b.task_id,
      run_id: b.run_id,
      note: 'needs more context',
      status: 'waiting',
      waiting_reason: 'context_required',
    });
    state.decideApproval(PROJECT, human, other, true, { via: 'cli' });
    expect(state.q.task(PROJECT, b.task_id).status).toBe('WAITING');
  });

  it('covers one use of the exact target, for its own task only', () => {
    const a = agentOnTask(1);
    const b = agentOnTask(2);
    const id = ask(a, 'once');
    expect(use(a)).toBeUndefined(); // pending
    state.decideApproval(PROJECT, human, id, true, { via: 'cli' });
    expect(use(a)).toBe(id);
    expect(use(b)).toBeUndefined();
    expect(
      state.q.usableApproval(PROJECT, {
        capability: 'shell.git.push',
        target: 'git push --force',
        task_id: a.task_id,
        run_id: a.run_id,
        agent_id: a.caller.agent_id,
        policy_version: 'v1',
        now: clock.now(),
      }),
    ).toBeUndefined();
    state.useApprovals(PROJECT, { kind: 'agent', id: a.caller.agent_id }, [
      { approval_id: id, tool: 'Bash', target: 'git push' },
    ]);
    expect(use(a)).toBeUndefined();
    expect(state.q.approvals(PROJECT).find((x) => x.approval_id === id)).toMatchObject({ status: 'used', uses: 1 });
  });

  it('a run grant stays with its attempt, a task grant reaches later ones; both end with a policy change, expiry or revocation', () => {
    const a = agentOnTask(1);
    const run = ask(a, 'run');
    const task = ask(a, 'task');
    state.decideApproval(PROJECT, human, run, true);
    state.decideApproval(PROJECT, human, task, true, { ttl_s: 60 });
    expect(use(a)).toBe(run);
    state.useApprovals(PROJECT, human, [{ approval_id: run, tool: 'Bash', target: 'git push' }]);
    expect(use(a)).toBe(run); // still usable within its attempt
    expect(use(a, 'v1', 'run_other')).toBe(task); // another attempt: only the task grant
    expect(use(a, 'v2')).toBeUndefined(); // the policy changed since
    state.revokeApproval(PROJECT, human, run, 'no more pushes from this attempt');
    expect(use(a)).toBe(task);
    clock.advance(61_000);
    expect(use(a)).toBeUndefined();

    const dump = () => Object.fromEntries(DOMAIN_TABLES.map((t) => [t, db.prepare(`SELECT * FROM ${t}`).all()]));
    const before = dump();
    replay(db, state.store, PROJECT, state.projector);
    expect(dump()).toEqual(before);
  });

  it('records a request the policy decides alone, without an approval for a human', () => {
    const a = agentOnTask(1);
    const allowed = state.requestPermission(
      PROJECT,
      a.caller,
      { task_id: a.task_id, action_class: 'file.write', resource: 'src/a.ts', justification: 'edit', ttl_s: 600 },
      { capability: 'file.write', decision: 'allow', risk: 'medium', reason: 'inside the scope', policy_version: 'v1' },
    );
    expect(allowed).toMatchObject({ approval_id: null, status: 'granted', capability: 'file.write' });
    const denied = state.requestPermission(
      PROJECT,
      a.caller,
      { task_id: a.task_id, action_class: 'secret.resolve', resource: 'STRIPE_KEY', justification: 'test', ttl_s: 600 },
      {
        capability: 'secret.resolve',
        decision: 'deny',
        risk: 'high',
        reason: 'never handed to agents',
        policy_version: 'v1',
      },
    );
    expect(denied).toMatchObject({ approval_id: null, status: 'denied' });
    expect(state.q.approvals(PROJECT)).toEqual([]);
  });
});
