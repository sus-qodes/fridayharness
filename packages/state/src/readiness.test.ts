/**
 * Runtime readiness (ADR-0035 §1, §3; plan Phase 2.1): evidence from sessions, completion claims
 * and doctor checks, the loose-rule verdict, what ends evidence, and replay.
 */
import { sequentialIds } from '@friday/core';
import { openDatabase, type SqlDatabase } from '@friday/db';
import { replay } from '@friday/events';
import { type Actor, FridayError, HarnessRegisterParams, type HostFailure } from '@friday/protocol';
import { FakeClock } from '@friday/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AUTHENTICATED_TTL_MS,
  type Caller,
  DOMAIN_TABLES,
  FridayState,
  HOST_FAILURE_BENCH_MS,
  RATE_LIMIT_BENCH_MS,
} from './index.js';

const PROJECT = 'proj_00000000000000000000000001';
const human: Actor = { kind: 'human', id: 'local-operator' };
const SOL = 'openai/gpt-6.1-sol';

let db: SqlDatabase;
let clock: FakeClock;
let state: FridayState;

beforeEach(() => {
  db = openDatabase(':memory:');
  clock = new FakeClock('2026-10-22T10:00:00.000Z');
  state = new FridayState({ db, clock, ids: sequentialIds() });
  state.ensureProject({ project_id: PROJECT, name: 'edutube', root_path: 'C:/demo/edutube' });
});

function register(key: string, vendor: 'codex' | 'claude-code' | 'generic' = 'codex'): Caller {
  const r = state.registerHarness(
    PROJECT,
    HarnessRegisterParams.parse({
      protocol_version: '1.0',
      harness_key: `fake:${key}`,
      vendor,
      name: key,
      version: '0.162.1',
      attach_mode: 'spawn',
      project_id: PROJECT,
      capabilities: { task_start: true, model_control: 'set', models: [SOL] },
      agent: { agent_key: key, role: 'backend' },
    }),
  );
  return { harness_id: r.harness_id, agent_id: r.agent_id };
}

const stages = (host: string, model: string | null) =>
  Object.fromEntries(state.readiness.assess(PROJECT, host, model).stages.map((s) => [s.stage, s.status]));

describe('readiness evidence (ADR-0035 §1)', () => {
  it('a session shows its host installed, configured and connected while it lives', () => {
    const codex = register('cx-1');
    const evidence = state.q.readinessEvidence(PROJECT, { host: 'codex' });
    expect(evidence.map((e) => [e.stage, e.status, e.model, e.harness_id, e.expires_at])).toEqual([
      ['handshake', 'passed', null, codex.harness_id, null],
      ['configured', 'passed', null, codex.harness_id, null],
      ['detected', 'passed', null, codex.harness_id, null],
    ]);
    expect(evidence[0]).toMatchObject({
      source: 'harness.register',
      version: '0.162.1',
      detail: 'cx-1 registered (spawn)',
    });
    // Live, and a sign-in never seen is tried (the loose rule).
    const a = state.readiness.assess(PROJECT, 'codex', SOL);
    expect(a).toMatchObject({ live: true, dispatchable: true, blocking: null, reason: 'ready' });
    expect(stages('codex', SOL)).toMatchObject({ authenticated: 'unknown', benched: 'passed', dispatchable: 'passed' });

    // The session ends: its evidence ends with it, and nothing vouches for the host any more.
    state.disconnectHarness(PROJECT, codex.harness_id, 'process exited', true);
    expect(state.q.harness(codex.harness_id).status).toBe('TERMINATED');
    expect(state.q.readinessEvidence(PROJECT, { host: 'codex' })).toEqual([]);
    expect(state.q.readinessEvidence(PROJECT, { host: 'codex', all: true }).map((e) => e.ended_reason)).toEqual([
      'the session ended',
      'the session ended',
      'the session ended',
    ]);
    const after = state.readiness.assess(PROJECT, 'codex', SOL);
    expect(after).toMatchObject({
      live: false,
      dispatchable: false,
      blocking: { stage: 'detected', status: 'missing' },
    });
    expect(after.reason).toContain('no session is connected and no doctor check has seen it');
  });

  it('a completion claim shows the host and model signed in for seven days, renewed by each claim', () => {
    const codex = register('cx-1');
    const t = state.createTask(PROJECT, human, {
      summary: 'Fix migrations',
      scope: { write: ['db/**'], read: [] },
      assign_agent_key: 'cx-1',
    });
    const run = state.claimTask(PROJECT, codex, { task_id: t.task_id }).run_id;
    state.observeModel(PROJECT, { kind: 'harness', id: codex.harness_id }, { run_id: run }, SOL, 'adapter');
    clock.advance(60_000);
    state.submitResult(PROJECT, codex, {
      idempotency_key: 'claim-1',
      task_id: t.task_id,
      run_id: run,
      status: 'completed_claim',
      summary: 'done',
      changed_paths: [],
      checks: [],
      notes: [],
      risks: [],
    });
    const auth = state.q.readinessEvidence(PROJECT, { host: 'codex' }).filter((e) => e.stage === 'authenticated');
    expect(auth).toHaveLength(1);
    expect(auth[0]).toMatchObject({
      model: SOL,
      status: 'passed',
      source: `run:${run}`,
      harness_id: null,
      checked_at: clock.now(),
      expires_at: new Date(Date.parse(clock.now()) + AUTHENTICATED_TTL_MS).toISOString(),
    });
    expect(stages('codex', SOL).authenticated).toBe('passed');
    // Another model of the host was not shown signed in by it.
    expect(stages('codex', 'openai/gpt-6-astra').authenticated).toBe('unknown');
    // It outlives the session, and expires a week on.
    state.disconnectHarness(PROJECT, codex.harness_id, 'process exited', true);
    expect(state.q.readinessEvidence(PROJECT, { host: 'codex' }).map((e) => e.stage)).toEqual(['authenticated']);
    clock.advance(AUTHENTICATED_TTL_MS + 1);
    expect(stages('codex', SOL).authenticated).toBe('stale');
  });

  it('a doctor check counts for a day, and a later check of the same stage replaces it', () => {
    const first = state.readiness.record(PROJECT, human, {
      host: 'claude-code',
      version: '2.1.304',
      source: 'harness doctor',
      stages: [
        { stage: 'detected', status: 'passed', detail: 'Claude Code 2.1.304 via PATH' },
        { stage: 'configured', status: 'passed' },
        { stage: 'handshake', status: 'passed' },
      ],
    });
    expect(first.map((e) => e.stage)).toEqual(['handshake', 'configured', 'detected']);
    expect(first[2]).toMatchObject({
      status: 'passed',
      version: '2.1.304',
      expires_at: '2026-10-23T10:00:00.000Z',
      harness_id: null,
    });
    // Not connected now, but seen within a day: dispatchable.
    expect(state.readiness.assess(PROJECT, 'claude-code', 'claude-sonnet-5-5')).toMatchObject({
      live: false,
      dispatchable: true,
    });
    // A failing check keeps the host out, with the doctor's words.
    clock.advance(3_600_000);
    state.readiness.record(PROJECT, human, {
      host: 'claude-code',
      source: 'harness doctor',
      stages: [{ stage: 'handshake', status: 'failed', detail: 'MCP server did not start: spawn ENOENT' }],
    });
    const blocked = state.readiness.assess(PROJECT, 'claude-code', 'claude-sonnet-5-5');
    expect(blocked).toMatchObject({ dispatchable: false, blocking: { stage: 'handshake', status: 'failed' } });
    expect(blocked.reason).toContain('spawn ENOENT');
    const all = state.q.readinessEvidence(PROJECT, { host: 'claude-code', all: true });
    expect(all.filter((e) => e.stage === 'handshake').map((e) => [e.status, e.ended_reason])).toEqual([
      ['failed', null],
      ['passed', 'superseded'],
    ]);
    // A day on, the check has expired: the host is stale, not assumed.
    clock.advance(86_400_000);
    expect(state.readiness.assess(PROJECT, 'claude-code', null)).toMatchObject({
      dispatchable: false,
      blocking: { stage: 'detected', status: 'stale' },
    });
    // Only a human or Friday records; the request is validated.
    expect(() =>
      state.readiness.record(PROJECT, { kind: 'agent', id: 'x' }, { host: 'codex', source: 's', stages: [] }),
    ).toThrow();
    expect(() =>
      state.readiness.record(PROJECT, human, { host: 'codex', source: 's', stages: [] as never }),
    ).toThrowError();
  });

  it('a human clears what keeps a host out; passed evidence stays', () => {
    register('cx-1');
    state.readiness.record(PROJECT, human, {
      host: 'codex',
      source: 'test',
      stages: [{ stage: 'authenticated', status: 'failed', detail: 'run "codex login"' }],
    });
    expect(state.readiness.assess(PROJECT, 'codex', SOL)).toMatchObject({
      dispatchable: false,
      blocking: { stage: 'authenticated', status: 'failed' },
    });
    expect(() => state.readiness.clear(PROJECT, { kind: 'agent', id: 'x' }, 'codex')).toThrow(FridayError);
    const ended = state.readiness.clear(PROJECT, human, 'codex');
    expect(ended.map((e) => [e.stage, e.ended_reason])).toEqual([['authenticated', 'cleared by local-operator']]);
    expect(state.readiness.assess(PROJECT, 'codex', SOL).dispatchable).toBe(true);
    // The registration evidence was not touched.
    expect(state.q.readinessEvidence(PROJECT, { host: 'codex' })).toHaveLength(3);
    expect(state.readiness.clear(PROJECT, human, 'codex')).toEqual([]);
  });

  it('a detail never carries a credential', () => {
    state.readiness.record(PROJECT, human, {
      host: 'codex',
      source: 'test',
      stages: [
        {
          stage: 'authenticated',
          status: 'failed',
          detail: 'token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ refused',
        },
      ],
    });
    const [e] = state.q.readinessEvidence(PROJECT, { host: 'codex' });
    expect(e?.detail).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('replay rebuilds the evidence as it was', () => {
    const codex = register('cx-1');
    state.readiness.record(PROJECT, human, {
      host: 'claude-code',
      source: 'harness doctor',
      stages: [{ stage: 'detected', status: 'passed' }],
    });
    state.readiness.record(PROJECT, human, {
      host: 'claude-code',
      source: 'harness doctor',
      stages: [{ stage: 'detected', status: 'failed', detail: 'gone' }],
    });
    state.readiness.clear(PROJECT, human, 'claude-code');
    state.disconnectHarness(PROJECT, codex.harness_id, 'process exited', true);
    const dump = () =>
      Object.fromEntries(DOMAIN_TABLES.map((tb) => [tb, db.prepare(`SELECT * FROM ${tb} ORDER BY 1, 2`).all()]));
    const before = dump();
    expect((before.readiness_evidence as unknown[]).length).toBe(5);
    replay(db, state.store, PROJECT, state.projector);
    expect(dump()).toEqual(before);
  });
});

describe('host failures bench the host or model; work failures never (ADR-0035 §3–§4)', () => {
  const SONNET = 'claude-sonnet-5-5';
  const ASTRA = 'openai/gpt-6-astra';
  const at = (ms: number) => new Date(Date.parse(clock.now()) + ms).toISOString();
  const benches = (host: string) => state.q.readinessEvidence(PROJECT, { host }).filter((e) => e.status === 'failed');
  /** A fresh READY task nobody is reserved for. */
  const freshTask = () => {
    const t = state.createTask(PROJECT, human, { summary: 'Fix one file', scope: { write: ['src/**'], read: [] } });
    return state.readyTask(PROJECT, human, t.task_id).task_id;
  };
  /** An agent on a host takes a task; the run is ACTIVE and its model observed. */
  function attempt(key: string, vendor: 'codex' | 'claude-code', taskId = freshTask()) {
    const caller = register(key, vendor);
    const model = vendor === 'codex' ? SOL : SONNET;
    const run_id = state.claimTask(PROJECT, caller, { task_id: taskId }).run_id;
    state.observeModel(PROJECT, { kind: 'harness', id: caller.harness_id }, { run_id }, model, 'adapter');
    return { caller, task_id: taskId, run_id, model };
  }
  const fail = (a: ReturnType<typeof attempt>, message: string, failure?: HostFailure) =>
    state.reportAgentError(PROJECT, a.caller, {
      task_id: a.task_id,
      run_id: a.run_id,
      message,
      fatal: true,
      ...(failure ? { failure } : {}),
    });

  it("a rate limit benches the model until its reset, else for 30 minutes; the host's other models stay in", () => {
    const a = attempt('cx-1', 'codex');
    fail(a, 'Codex stopped: HTTP 429 Too Many Requests', { kind: 'rate_limit', retry_after_s: 600 });
    expect(state.q.task(PROJECT, a.task_id)).toMatchObject({ status: 'WAITING', waiting_reason: 'agent_error' });
    const [bench] = benches('codex');
    expect(bench).toMatchObject({
      stage: 'benched',
      model: SOL,
      source: `run:${a.run_id}`,
      detail: 'rate_limit: Codex stopped: HTTP 429 Too Many Requests',
      expires_at: at(600_000),
      harness_id: null,
    });
    expect(state.readiness.assess(PROJECT, 'codex', SOL)).toMatchObject({
      dispatchable: false,
      blocking: { stage: 'benched', status: 'failed' },
      bench_until: at(600_000),
    });
    expect(state.readiness.assess(PROJECT, 'codex', ASTRA).dispatchable).toBe(true);
    // Without a reset time, 30 minutes; the newer bench replaces the older.
    const b = attempt('cx-2', 'codex');
    fail(b, 'rate limited', { kind: 'rate_limit' });
    expect(benches('codex').map((e) => [e.model, e.expires_at])).toEqual([[SOL, at(RATE_LIMIT_BENCH_MS)]]);
    clock.advance(RATE_LIMIT_BENCH_MS + 1);
    expect(state.readiness.assess(PROJECT, 'codex', SOL).dispatchable).toBe(true);
  });

  it('a sign-in failure benches the host until it is seen signed in again, or a human clears it', () => {
    const a = attempt('cx-1', 'codex');
    fail(a, 'Codex stopped: not logged in; run "codex login"', { kind: 'auth' });
    expect(benches('codex')).toEqual([
      expect.objectContaining({
        stage: 'authenticated',
        model: null,
        expires_at: null,
        detail: 'auth: Codex stopped: not logged in; run "codex login"',
      }),
    ]);
    for (const model of [SOL, ASTRA]) {
      expect(state.readiness.assess(PROJECT, 'codex', model)).toMatchObject({
        dispatchable: false,
        blocking: { stage: 'authenticated', status: 'failed' },
      });
    }
    clock.advance(7 * 86_400_000);
    expect(state.readiness.assess(PROJECT, 'codex', SOL).dispatchable).toBe(false);
    // Seen signed in again: a completion claim on that model lets it back; the host's other models wait.
    const b = attempt('cx-2', 'codex');
    state.submitResult(PROJECT, b.caller, {
      idempotency_key: 'claim-b',
      task_id: b.task_id,
      run_id: b.run_id,
      status: 'completed_claim',
      summary: 'done',
      changed_paths: [],
      checks: [],
      notes: [],
      risks: [],
    });
    expect(state.readiness.assess(PROJECT, 'codex', SOL).dispatchable).toBe(true);
    expect(state.readiness.assess(PROJECT, 'codex', ASTRA).dispatchable).toBe(false);
    expect(state.readiness.clear(PROJECT, human, 'codex').map((e) => e.stage)).toEqual(['authenticated']);
    expect(state.readiness.assess(PROJECT, 'codex', ASTRA).dispatchable).toBe(true);
  });

  it('a lost process benches the host and model for 10 minutes; a work error or a failed verification benches nothing', () => {
    const a = attempt('cc-1', 'claude-code');
    fail(a, 'Claude Code stopped: it exited (1)', { kind: 'transport' });
    expect(benches('claude-code')).toEqual([
      expect.objectContaining({
        stage: 'benched',
        model: SONNET,
        expires_at: at(HOST_FAILURE_BENCH_MS),
        detail: 'transport: Claude Code stopped: it exited (1)',
      }),
    ]);
    // An error of the work: the attempt ends as before, and nothing is benched.
    const b = attempt('cc-2', 'claude-code');
    fail(b, 'the Claude Code turn ended: error_max_turns');
    expect(state.q.task(PROJECT, b.task_id).waiting_reason).toBe('agent_error');
    expect(benches('claude-code')).toHaveLength(1);
    // A failed verification: rework, never a bench.
    const c = attempt('cc-3', 'claude-code');
    state.submitResult(PROJECT, c.caller, {
      idempotency_key: 'claim-c',
      task_id: c.task_id,
      run_id: c.run_id,
      status: 'completed_claim',
      summary: 'done',
      changed_paths: [],
      checks: [],
      notes: [],
      risks: [],
    });
    const { verification_id } = state.startVerification(PROJECT, { kind: 'system', id: 'friday' }, c.task_id);
    state.finishVerification(PROJECT, { kind: 'system', id: 'friday' }, verification_id, false, 'tests failed');
    expect(benches('claude-code')).toHaveLength(1);
  });

  it('an attempt the host could not start, or never acknowledged, benches it: Friday classifies those itself', () => {
    const cc = register('cc-1', 'claude-code');
    const t1 = freshTask();
    expect(state.assignTask(PROJECT, human, t1, 'cc-1').mode).toBe('assigned');
    const run1 = state.q.task(PROJECT, t1).current_run_id as string;
    expect(state.q.run(run1).status).toBe('STARTING');
    state.reportAgentError(PROJECT, cc, { task_id: t1, run_id: run1, message: 'spawn claude ENOENT', fatal: true });
    expect(state.q.run(run1).status).toBe('DECLINED');
    expect(state.q.task(PROJECT, t1).status).toBe('READY');
    expect(benches('claude-code')).toEqual([
      expect.objectContaining({
        stage: 'benched',
        model: null,
        source: `run:${run1}`,
        detail: 'start: spawn claude ENOENT',
      }),
    ]);
    // A task.start nobody acknowledged within its time is a timeout of the host.
    const cx = register('cx-1', 'codex');
    const t2 = freshTask();
    state.assignTask(PROJECT, human, t2, 'cx-1');
    const run2 = state.q.task(PROJECT, t2).current_run_id as string;
    clock.advance(301_000);
    state.heartbeat(PROJECT, cx.harness_id);
    expect(state.tick(PROJECT).declined).toContain(run2);
    expect(benches('codex')).toEqual([
      expect.objectContaining({ stage: 'benched', model: null, source: `run:${run2}`, detail: 'timeout: ack timeout' }),
    ]);
  });

  it('a session that does not come back within the reconnect window benches its host for transport', () => {
    const a = attempt('cx-1', 'codex');
    clock.advance(31_000);
    expect(state.tick(PROJECT).lost).toEqual([a.caller.harness_id]);
    expect(state.q.task(PROJECT, a.task_id).status).toBe('HARNESS_LOST');
    expect(benches('codex')).toEqual([]);
    clock.advance(121_000);
    expect(state.tick(PROJECT).terminated).toEqual([a.caller.harness_id]);
    expect(benches('codex')).toEqual([
      expect.objectContaining({
        stage: 'benched',
        model: SOL,
        source: `run:${a.run_id}`,
        detail: 'transport: the session did not come back within the reconnect window',
        expires_at: at(HOST_FAILURE_BENCH_MS),
      }),
    ]);
  });

  it("the next attempt's route records the failover from the benched host, and replay keeps it all", () => {
    state.setRouter(({ task, harness }) => ({
      decision: {
        mode: 'registry',
        task_class: task.kind,
        model: harness.vendor === 'codex' ? SOL : SONNET,
        binding: true,
        source: 'registry',
        reason: 'test',
        reason_codes: [],
      },
    }));
    const a = attempt('cx-1', 'codex');
    fail(a, 'Codex stopped: HTTP 429', { kind: 'rate_limit', retry_after_s: 900 });
    state.recoverTask(PROJECT, human, a.task_id, 'reassign', { reason: 'its host is rate limited' });
    expect(state.q.task(PROJECT, a.task_id)).toMatchObject({ status: 'READY', reserved_for_agent_key: null });
    const b = attempt('cc-1', 'claude-code', a.task_id);
    const [next, first] = state.q.routingDecisions(PROJECT, { task_id: a.task_id });
    expect(first?.failover_from ?? null).toBeNull();
    expect(next).toMatchObject({
      run_id: b.run_id,
      model: SONNET,
      failover_from: {
        run_id: a.run_id,
        host: 'codex',
        model: SOL,
        kind: 'rate_limit',
        detail: 'Codex stopped: HTTP 429',
        bench_until: at(900_000),
      },
    });
    const dump = () =>
      Object.fromEntries(DOMAIN_TABLES.map((tb) => [tb, db.prepare(`SELECT * FROM ${tb} ORDER BY 1, 2`).all()]));
    const before = dump();
    replay(db, state.store, PROJECT, state.projector);
    expect(dump()).toEqual(before);
  });
});
