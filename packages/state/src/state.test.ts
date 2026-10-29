import { sequentialIds, taskInvariantViolations } from '@friday/core';
import { openDatabase, type SqlDatabase } from '@friday/db';
import { replay } from '@friday/events';
import { type Actor, FridayError, HarnessRegisterParams } from '@friday/protocol';
import { FakeClock } from '@friday/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Caller, DOMAIN_TABLES, FridayState } from './index.js';

const PROJECT = 'proj_00000000000000000000000001';
const human: Actor = { kind: 'human', id: 'local-user' };

let db: SqlDatabase;
let clock: FakeClock;
let state: FridayState;

beforeEach(() => {
  db = openDatabase(':memory:');
  clock = new FakeClock('2026-10-13T10:00:00.000Z');
  state = new FridayState({ db, clock, ids: sequentialIds() });
  state.ensureProject({ project_id: PROJECT, name: 'shop', root_path: 'C:/demo/shop' });
});

function register(key: string, opts: { agent?: string; mode?: 'attach' | 'spawn'; session?: string } = {}) {
  return state.registerHarness(
    PROJECT,
    HarnessRegisterParams.parse({
      protocol_version: '1.0',
      harness_key: key,
      vendor: opts.mode === 'spawn' ? 'generic' : 'claude-code',
      name: key,
      attach_mode: opts.mode ?? 'attach',
      project_id: PROJECT,
      agent: { agent_key: opts.agent ?? 'dev-1' },
      host: opts.session ? { session_id: opts.session } : {},
    }),
  );
}

const callerOf = (r: { harness_id: string; agent_id: string }): Caller => ({
  harness_id: r.harness_id,
  agent_id: r.agent_id,
});

function dumpDomain(): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const table of DOMAIN_TABLES) out[table] = db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all();
  return out;
}

function expectError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(FridayError);
    expect((e as FridayError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('task lifecycle through Claude-Code-style attach mode', () => {
  it('create → claim → progress → completion claim → verify → COMPLETED, with a full event trail', () => {
    const task = state.createTask(PROJECT, human, {
      summary: 'Add discount codes',
      acceptance_criteria: ['tests pass'],
      scope: { write: ['frontend/src/pricing/**'], read: ['frontend/**'] },
      assign_agent_key: 'dev-1',
    });
    expect(task).toMatchObject({ status: 'READY', reserved_for_agent_key: 'dev-1' });

    const reg = register('claude-code:proj:pid:100', { session: 'sess-a' });
    expect(reg).toMatchObject({ agent_key: 'dev-1', shadow: false, reconnected: false });
    const caller = callerOf(reg);

    const claimed = state.claimTask(PROJECT, caller, { next: true });
    expect(claimed.task).toMatchObject({ task_id: task.task_id, status: 'RUNNING', assigned_agent_id: reg.agent_id });
    expect(claimed).toMatchObject({ attempt: 1, resumed: false });
    expect(state.q.agent(reg.agent_id)).toMatchObject({ status: 'BUSY', current_task_id: task.task_id });
    expect(state.q.harness(reg.harness_id).status).toBe('BUSY');

    state.updateTask(PROJECT, caller, {
      task_id: task.task_id,
      run_id: claimed.run_id,
      note: 'edited pricing',
      changed_paths: ['frontend\\src\\pricing\\discount.ts'],
    });
    state.observePaths(PROJECT, { kind: 'harness', id: reg.harness_id }, claimed.run_id, [
      'frontend/test/discount.test.ts',
    ]);

    const result = state.submitResult(PROJECT, caller, {
      idempotency_key: 'claim-1',
      task_id: task.task_id,
      run_id: claimed.run_id,
      status: 'completed_claim',
      summary: 'discount codes added',
      changed_paths: ['frontend/src/pricing/discount.ts', 'frontend/src/extra.ts'],
      checks: [{ name: 'tests', kind: 'test', outcome: 'passed' }],
      notes: [],
      risks: [],
    });
    expect(result.task_status).toBe('READY_FOR_VERIFICATION');
    expect(result.observed_changed_paths).toEqual([
      'frontend/src/pricing/discount.ts',
      'frontend/test/discount.test.ts',
    ]);
    expect(result.discrepancies).toEqual([
      { path: 'frontend/src/extra.ts', note: 'claimed but not observed by Friday' },
      { path: 'frontend/test/discount.test.ts', note: 'changed but not listed in the claim' },
    ]);
    expect(state.q.agent(reg.agent_id)).toMatchObject({ status: 'AVAILABLE', current_task_id: null });
    expect(state.q.harness(reg.harness_id).status).toBe('READY');

    const { verification_id } = state.startVerification(PROJECT, human, task.task_id);
    state.recordVerificationCheck(PROJECT, human, verification_id, {
      name: 'tests',
      kind: 'test',
      status: 'PASSED',
      exit_code: 0,
      artifact_ref: null,
      summary: '3 passed',
    });
    const done = state.finishVerification(PROJECT, human, verification_id, true, 'all checks passed');
    expect(done).toMatchObject({ status: 'COMPLETED', current_run_id: null });
    expect(done.completed_at).not.toBeNull();
    expect(state.q.latestVerification(task.task_id)).toMatchObject({
      status: 'PASSED',
      checks: [{ name: 'tests', status: 'PASSED' }],
    });

    const types = state.store.readByRef(PROJECT, 'task', task.task_id).map((e) => e.type);
    expect(types).toEqual([
      'task.created',
      'task.ready',
      'run.created',
      'task.assigned',
      'run.accepted',
      'task.started',
      'run.paths_observed',
      'agent.event',
      'run.paths_observed',
      'run.ended',
      'task.completion_claimed',
      'task.verification_started',
      'verification.started',
      'verification.check_completed',
      'verification.finished',
      'task.completed',
    ]);
    for (const t of state.q.tasks(PROJECT)) expect(taskInvariantViolations(t)).toEqual([]);
  });

  it('rejects an invalid transition with COS-2002 and leaves every table and the head unchanged', () => {
    const task = state.createTask(PROJECT, human, { summary: 'x' });
    const before = dumpDomain();
    const head = state.store.head(PROJECT);
    expectError(() => state.startVerification(PROJECT, human, task.task_id), 'COS-2002');
    expectError(() => state.reworkTask(PROJECT, human, task.task_id, 'no'), 'COS-2002');
    expect(dumpDomain()).toEqual(before);
    expect(state.store.head(PROJECT)).toBe(head);
    const audits = db.prepare('SELECT action, error_code FROM audit_records').all();
    expect(audits).toEqual([
      { action: 'verification.start', error_code: 'COS-2002' },
      { action: 'task.rework', error_code: 'COS-2002' },
    ]);
  });

  it('records rejected agent commands as command.rejected events', () => {
    const reg = register('h1');
    expectError(() => state.claimTask(PROJECT, callerOf(reg), { next: true }), 'COS-2001');
    const rejected = state.store.readSince(PROJECT, 0, { types: ['command.rejected'] });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.payload).toMatchObject({ command: 'task.claim', error: { code: 'COS-2001' } });
  });

  it('a completion claim can never complete a task by itself', () => {
    state.createTask(PROJECT, human, { summary: 'x', ready: true });
    const reg = register('h1');
    const c = state.claimTask(PROJECT, callerOf(reg), { next: true });
    state.submitResult(PROJECT, callerOf(reg), {
      idempotency_key: 'k',
      task_id: c.task.task_id,
      run_id: c.run_id,
      status: 'completed_claim',
      summary: 'done!',
      changed_paths: [],
      checks: [],
      notes: [],
      risks: [],
    });
    expect(state.q.task(PROJECT, c.task.task_id).status).toBe('READY_FOR_VERIFICATION');
  });
});

describe('idempotency and replay', () => {
  it('returns the stored response for a repeated key and rejects a reused key with different content', () => {
    const a = state.createTask(PROJECT, human, { summary: 'same' }, { idempotency_key: 'create-1' });
    const head = state.store.head(PROJECT);
    const b = state.createTask(PROJECT, human, { summary: 'same' }, { idempotency_key: 'create-1' });
    expect(b.task_id).toBe(a.task_id);
    expect(state.store.head(PROJECT)).toBe(head);
    expectError(
      () => state.createTask(PROJECT, human, { summary: 'different' }, { idempotency_key: 'create-1' }),
      'COS-1003',
    );
  });

  it('rebuilds identical domain tables from the event log', () => {
    const reg = register('h1');
    const t1 = state.createTask(PROJECT, human, { summary: 'one', ready: true });
    state.createTask(PROJECT, human, { summary: 'two', depends_on: [t1.task_id], ready: true });
    const c = state.claimTask(PROJECT, callerOf(reg), { task_id: t1.task_id });
    state.updateTask(PROJECT, callerOf(reg), {
      task_id: t1.task_id,
      run_id: c.run_id,
      status: 'waiting',
      waiting_reason: 'context_required',
    });
    state.requestPermission(PROJECT, callerOf(reg), {
      action_class: 'fs.write',
      resource: 'x',
      justification: 'need it',
      ttl_s: 60,
    });
    clock.advance(31_000);
    state.tick(PROJECT);
    const before = dumpDomain();
    expect(before.tasks?.length).toBe(2);
    replay(db, state.store, PROJECT, state.projector);
    expect(dumpDomain()).toEqual(before);
  });
});

describe('reservations and dependencies', () => {
  it('only the reserved agent can claim, and dependencies must be completed first', () => {
    const t1 = state.createTask(PROJECT, human, { summary: 'base', assign_agent_key: 'dev-1' });
    const t2 = state.createTask(PROJECT, human, { summary: 'after', depends_on: [t1.task_id], ready: true });
    const dev2 = register('h2', { agent: 'dev-2' });
    expectError(() => state.claimTask(PROJECT, callerOf(dev2), { task_id: t1.task_id }), 'COS-3000');
    expectError(() => state.claimTask(PROJECT, callerOf(dev2), { task_id: t2.task_id }), 'COS-2002');
    expectError(() => state.claimTask(PROJECT, callerOf(dev2), { next: true }), 'COS-2001');
    const dev1 = register('h1', { agent: 'dev-1' });
    expect(state.claimableTasks(PROJECT, 'dev-1').map((t) => t.task_id)).toEqual([t1.task_id]);
    expect(state.claimTask(PROJECT, callerOf(dev1), { next: true }).task.task_id).toBe(t1.task_id);
  });

  it('an agent works on one task at a time', () => {
    state.createTask(PROJECT, human, { summary: 'a', ready: true });
    const b = state.createTask(PROJECT, human, { summary: 'b', ready: true });
    const reg = register('h1');
    state.claimTask(PROJECT, callerOf(reg), { next: true });
    expectError(() => state.claimTask(PROJECT, callerOf(reg), { task_id: b.task_id }), 'COS-2005');
  });
});

describe('spawn-mode assignment through the outbox', () => {
  it('assign → task.start delivered → ack accepted → RUNNING; ack declined → READY', () => {
    const reg = register('fake-1', { mode: 'spawn' });
    const task = state.createTask(PROJECT, human, { summary: 'spawned', ready: true });
    expect(state.assignTask(PROJECT, human, task.task_id, 'dev-1').mode).toBe('assigned');
    expect(state.q.task(PROJECT, task.task_id).status).toBe('ASSIGNED');
    const [msg] = state.pollOutbox(PROJECT, reg.harness_id);
    expect(msg).toMatchObject({ method: 'task.start', attempt: 1, params: { task_id: task.task_id } });
    expect(state.pollOutbox(PROJECT, reg.harness_id)).toEqual([]);
    state.ackOutbox(PROJECT, reg.harness_id, [{ message_id: msg?.message_id as string, accepted: true }]);
    expect(state.q.task(PROJECT, task.task_id).status).toBe('RUNNING');
    expect(state.q.agent(reg.agent_id).status).toBe('BUSY');

    const t2 = state.createTask(PROJECT, human, { summary: 'declined', ready: true });
    const reg2 = register('fake-2', { mode: 'spawn', agent: 'dev-2' });
    state.assignTask(PROJECT, human, t2.task_id, 'dev-2');
    const [m2] = state.pollOutbox(PROJECT, reg2.harness_id);
    state.ackOutbox(PROJECT, reg2.harness_id, [
      { message_id: m2?.message_id as string, accepted: false, reason: 'busy' },
    ]);
    expect(state.q.task(PROJECT, t2.task_id)).toMatchObject({ status: 'READY', assigned_agent_id: null });
    expect(state.q.agent(reg2.agent_id).status).toBe('AVAILABLE');
  });

  it('reserves instead of pushing when the agent has no live spawn-mode session', () => {
    const task = state.createTask(PROJECT, human, { summary: 'x', ready: true });
    expect(state.assignTask(PROJECT, human, task.task_id, 'dev-9')).toMatchObject({
      mode: 'reserved',
      task: { status: 'READY', reserved_for_agent_key: 'dev-9' },
    });
  });
});

describe('leases, loss and recovery', () => {
  it('marks a quiet harness DEGRADED, then lost; its task becomes HARNESS_LOST', () => {
    state.createTask(PROJECT, human, { summary: 'x', ready: true });
    const reg = register('h1');
    const c = state.claimTask(PROJECT, callerOf(reg), { next: true });
    clock.advance(21_000);
    expect(state.tick(PROJECT).degraded).toEqual([reg.harness_id]);
    expect(state.q.harness(reg.harness_id).status).toBe('DEGRADED');
    clock.advance(10_000);
    expect(state.tick(PROJECT).lost).toEqual([reg.harness_id]);
    expect(state.q.task(PROJECT, c.task.task_id).status).toBe('HARNESS_LOST');
    expect(state.q.run(c.run_id).status).toBe('SUSPENDED');
    expect(state.q.agent(reg.agent_id).status).toBe('DISCONNECTED');
    expectError(() => state.heartbeat(PROJECT, reg.harness_id), 'COS-4004');
  });

  it('the same session reconnecting within the window continues the same run', () => {
    state.createTask(PROJECT, human, { summary: 'x', ready: true });
    const reg = register('h1');
    const c = state.claimTask(PROJECT, callerOf(reg), { next: true });
    clock.advance(31_000);
    state.tick(PROJECT);
    const again = register('h1');
    expect(again).toMatchObject({ harness_id: reg.harness_id, reconnected: true });
    const resumed = state.claimTask(PROJECT, callerOf(again), { next: true });
    expect(resumed).toMatchObject({ run_id: c.run_id, resumed: true, task: { status: 'RUNNING' } });
  });

  it('a new session for the same agent resumes the work as a new attempt', () => {
    state.createTask(PROJECT, human, { summary: 'x', ready: true });
    const first = register('h1', { session: 's1' });
    const c = state.claimTask(PROJECT, callerOf(first), { next: true });
    clock.advance(31_000);
    state.tick(PROJECT);
    const second = register('h2', { session: 's2' });
    expect(second.shadow).toBe(false);
    const resumed = state.claimTask(PROJECT, callerOf(second), { next: true });
    expect(resumed).toMatchObject({
      attempt: 2,
      resumed: true,
      task: { status: 'RUNNING', assigned_harness_id: second.harness_id },
    });
    expect(state.q.run(c.run_id)).toMatchObject({ status: 'ENDED', outcome: 'released' });
  });

  it('a spawn-mode harness that reconnects is told to resume via task.resume', () => {
    const reg = register('fake', { mode: 'spawn' });
    const task = state.createTask(PROJECT, human, { summary: 'x', ready: true });
    state.assignTask(PROJECT, human, task.task_id, 'dev-1');
    const [start] = state.pollOutbox(PROJECT, reg.harness_id);
    state.ackOutbox(PROJECT, reg.harness_id, [{ message_id: start?.message_id as string, accepted: true }]);
    clock.advance(31_000);
    state.tick(PROJECT);
    register('fake', { mode: 'spawn' });
    const [resume] = state.pollOutbox(PROJECT, reg.harness_id);
    expect(resume?.method).toBe('task.resume');
    state.ackOutbox(PROJECT, reg.harness_id, [{ message_id: resume?.message_id as string, accepted: true }]);
    expect(state.q.task(PROJECT, task.task_id).status).toBe('RUNNING');
  });

  it('a clean exit gets a grace period before the work counts as lost', () => {
    state.createTask(PROJECT, human, { summary: 'x', ready: true });
    const reg = register('h1');
    const c = state.claimTask(PROJECT, callerOf(reg), { next: true });
    state.disconnectHarness(PROJECT, reg.harness_id, 'session_end', false);
    expect(state.q.task(PROJECT, c.task.task_id).status).toBe('RUNNING');
    clock.advance(59_000);
    expect(state.tick(PROJECT).lost).toEqual([]);
    clock.advance(2_000);
    expect(state.tick(PROJECT).lost).toEqual([reg.harness_id]);
    expect(state.q.task(PROJECT, c.task.task_id).status).toBe('HARNESS_LOST');
    clock.advance(121_000);
    expect(state.tick(PROJECT).terminated).toEqual([reg.harness_id]);
  });

  it('an unacknowledged task.start is declined and the task returns to READY', () => {
    const reg = register('fake', { mode: 'spawn' });
    const task = state.createTask(PROJECT, human, { summary: 'x', ready: true });
    state.assignTask(PROJECT, human, task.task_id, 'dev-1');
    for (let i = 0; i < 5; i += 1) {
      state.pollOutbox(PROJECT, reg.harness_id);
      clock.advance(31_000);
      state.heartbeat(PROJECT, reg.harness_id);
    }
    expect(state.tick(PROJECT).declined).toHaveLength(1);
    expect(state.q.task(PROJECT, task.task_id).status).toBe('READY');
  });
});

describe('shadow sessions', () => {
  it('a second live session for the same agent is a shadow until the first one is gone', () => {
    state.createTask(PROJECT, human, { summary: 'x', ready: true });
    const first = register('h1');
    const second = register('h2');
    expect(second.shadow).toBe(true);
    expect(second.agent_id).toBe(first.agent_id);
    expectError(() => state.claimTask(PROJECT, callerOf(second), { next: true }), 'COS-4006');
    clock.advance(31_000);
    state.heartbeat(PROJECT, second.harness_id);
    state.tick(PROJECT);
    expect(state.q.harness(second.harness_id).shadow).toBe(false);
    expect(state.q.agent(first.agent_id).harness_id).toBe(second.harness_id);
    expect(state.claimTask(PROJECT, callerOf(second), { next: true }).task.status).toBe('RUNNING');
  });
});

describe('tokens, approvals and observations', () => {
  it('issues hashed tokens that resolve until revoked', () => {
    const raw = state.issueToken(PROJECT, 'operator');
    expect(state.resolveToken(raw)).toMatchObject({ token_class: 'operator', project_id: PROJECT });
    expect(JSON.stringify(db.prepare('SELECT * FROM credentials').all())).not.toContain(raw);
    state.revokeTokens({ token_class: 'operator' }, 'rotated');
    expect(state.resolveToken(raw)).toBeUndefined();
    const reg = register('h1');
    expect(state.resolveToken(reg.harness_token)).toMatchObject({ token_class: 'harness', harness_id: reg.harness_id });
    const again = register('h1');
    expect(state.resolveToken(reg.harness_token)).toBeUndefined();
    expect(state.resolveToken(again.harness_token)?.harness_id).toBe(reg.harness_id);
  });

  it('tokens never reach the event log, even when echoed', () => {
    const reg = register('h1');
    state.recordObservation(PROJECT, { kind: 'agent', id: reg.agent_id }, 'agent.event', {
      output: `token ${reg.harness_token}`,
    });
    const all = JSON.stringify(state.store.readSince(PROJECT, 0, { limit: 1000 }));
    expect(all).not.toContain(reg.harness_token);
  });

  it('approvals are decided by humans only, once', () => {
    const reg = register('h1');
    const a = state.requestPermission(PROJECT, callerOf(reg), {
      action_class: 'fs.write',
      resource: 'backend/x.ts',
      justification: 'needed',
      ttl_s: 600,
    });
    expect(a.status).toBe('pending');
    const id = a.approval_id as string;
    expectError(() => state.decideApproval(PROJECT, { kind: 'agent', id: reg.agent_id }, id, true), 'COS-3000');
    state.decideApproval(PROJECT, human, id, true);
    expect(state.q.grantedApproval(PROJECT, 'fs.write', 'backend/x.ts', clock.now())).toBe(true);
    expectError(() => state.decideApproval(PROJECT, human, id, false), 'COS-2002');
  });

  it('only observation types can be recorded directly', () => {
    expectError(() => state.recordObservation(PROJECT, human, 'task.completed', {}), 'COS-1000');
  });
});

describe('what an acknowledgement makes current (review M8-R03, R05)', () => {
  const startFor = (key: string, agent: string) => {
    const reg = register(key, { mode: 'spawn', agent });
    const task = state.createTask(PROJECT, human, { summary: `for ${agent}`, ready: true });
    state.assignTask(PROJECT, human, task.task_id, agent);
    const [msg] = state.pollOutbox(PROJECT, reg.harness_id);
    return { reg, task, id: msg?.message_id as string };
  };
  const ack = (reg: { harness_id: string }, id: string) =>
    state.ackOutbox(PROJECT, reg.harness_id, [{ message_id: id, accepted: true }]);

  it('an accepted start is current, and stays so when the same acknowledgement is read again', () => {
    const { reg, id } = startFor('a', 'dev-1');
    expect(ack(reg, id)).toMatchObject({ acked: [id], current: [id] });
    expect(ack(reg, id)).toMatchObject({ acked: [id], current: [id] });
  });

  it('a start Friday no longer wants is acknowledged, and is not current', () => {
    // Cancelled before the acknowledgement arrived.
    const one = startFor('a', 'dev-1');
    state.cancelTask(PROJECT, human, one.task.task_id, 'not wanted');
    expect(ack(one.reg, one.id)).toMatchObject({ acked: [one.id], current: [] });
    // Released (its delivery expired) and given to another agent.
    const two = startFor('b', 'dev-2');
    state.releaseTask(PROJECT, human, two.task.task_id, 'someone else');
    register('c', { mode: 'spawn', agent: 'dev-3' });
    state.assignTask(PROJECT, human, two.task.task_id, 'dev-3');
    expect(ack(two.reg, two.id)).toMatchObject({ acked: [two.id], current: [] });
    expect(state.q.task(PROJECT, two.task.task_id).status).toBe('ASSIGNED');
  });

  it('a resume Friday no longer wants is not current either', () => {
    const { reg, task, id } = startFor('a', 'dev-1');
    ack(reg, id);
    clock.advance(31_000);
    state.tick(PROJECT);
    register('a', { mode: 'spawn', agent: 'dev-1' });
    const [resume] = state.pollOutbox(PROJECT, reg.harness_id);
    expect(resume?.method).toBe('task.resume');
    state.releaseTask(PROJECT, human, task.task_id, 'reassigned while the harness was away');
    expect(ack(reg, resume?.message_id as string).current).toEqual([]);
  });

  it('a spawn harness that registers again is told to resume what it holds as running, not what waits for a human', () => {
    const running = startFor('a', 'dev-1');
    ack(running.reg, running.id);
    const blocked = startFor('b', 'dev-2');
    ack(blocked.reg, blocked.id);
    const run = state.q.task(PROJECT, blocked.task.task_id).current_run_id as string;
    state.submitResult(PROJECT, callerOf(blocked.reg), {
      idempotency_key: 'blocked-1',
      task_id: blocked.task.task_id,
      run_id: run,
      status: 'blocked',
      summary: 'needs a decision',
      changed_paths: [],
      checks: [],
      notes: [],
      risks: [],
    });
    // Both adapters start again before their leases run out.
    register('a', { mode: 'spawn', agent: 'dev-1' });
    register('b', { mode: 'spawn', agent: 'dev-2' });
    const [resume] = state.pollOutbox(PROJECT, running.reg.harness_id);
    expect(resume).toMatchObject({ method: 'task.resume', params: { task_id: running.task.task_id } });
    expect(ack(running.reg, resume?.message_id as string).current).toEqual([resume?.message_id]);
    expect(state.q.task(PROJECT, running.task.task_id).status).toBe('RUNNING');
    expect(state.pollOutbox(PROJECT, blocked.reg.harness_id)).toEqual([]);
  });
});
