/**
 * Runtime readiness (ADR-0035 §1, §3; plan Phase 2.1): evidence from sessions, completion claims
 * and doctor checks, the loose-rule verdict, what ends evidence, and replay.
 */
import { sequentialIds } from '@friday/core';
import { openDatabase, type SqlDatabase } from '@friday/db';
import { replay } from '@friday/events';
import { type Actor, FridayError, HarnessRegisterParams } from '@friday/protocol';
import { FakeClock } from '@friday/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import { AUTHENTICATED_TTL_MS, type Caller, DOMAIN_TABLES, FridayState } from './index.js';

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
