/**
 * Routing in the state (plan M7a–M7b, ADR-0031 §4–§8): each run routed in its own transaction, the
 * model in `task.start`, the model that ran, human pins, and outcomes as evidence.
 */
import { openDatabase, type SqlDatabase } from '@friday/db';
import { replay } from '@friday/events';
import { type Actor, HarnessRegisterParams } from '@friday/protocol';
import { FakeClock } from '@friday/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import { DOMAIN_TABLES, FridayState, type RunRouter } from './index.js';

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

const register = (key: string, mode: 'spawn' | 'attach', capabilities: Record<string, unknown> = {}) =>
  state.registerHarness(
    PROJECT,
    HarnessRegisterParams.parse({
      protocol_version: '1.0',
      harness_key: `generic:${PROJECT}:${key}`,
      vendor: mode === 'spawn' ? 'codex' : 'claude-code',
      name: key,
      attach_mode: mode,
      project_id: PROJECT,
      capabilities,
      agent: { agent_key: key, role: 'backend' },
    }),
  );

/** A router that names a model and says whether the harness applies it. */
const router: RunRouter = ({ task, harness }) => ({
  decision: {
    mode: 'hybrid',
    task_class: task.kind,
    model: harness.vendor === 'codex' ? 'gpt-5.6-luna' : 'claude-opus-5-5',
    binding: harness.capabilities.model_control === 'set',
    source: 'score',
    reason: 'best fit',
    reason_codes: ['score.best'],
  },
});

describe('routing in the state', () => {
  it('routes each run in its own transaction and puts the model into task.start', () => {
    state.setRouter(router);
    const reg = register('codex-1', 'spawn', { task_start: true, model_control: 'set' });
    const task = state.createTask(PROJECT, human, { summary: 'fix generics', ready: true });
    state.assignTask(PROJECT, human, task.task_id, 'codex-1');
    const [start] = state.pollOutbox(PROJECT, reg.harness_id);
    expect(start?.params).toMatchObject({ model: 'gpt-5.6-luna', model_binding: true });
    if (!start) throw new Error('no task.start was queued');
    const run = state.q.run((start.params as { run_id: string }).run_id);
    expect(run).toMatchObject({ model_requested: 'gpt-5.6-luna', model_binding: true });
    const [decision] = state.q.routingDecisions(PROJECT, { task_id: task.task_id });
    expect(decision).toMatchObject({ model: 'gpt-5.6-luna', run_id: run.run_id, reason: 'best fit', source: 'score' });
    expect(run.routing_decision_id).toBe(decision?.decision_id);
  });

  it('records the model a session reports, which its runs inherit', () => {
    state.setRouter(router);
    const reg = register('cc-1', 'attach');
    state.observeModel(
      PROJECT,
      { kind: 'harness', id: reg.harness_id },
      { harness_id: reg.harness_id },
      'claude-sonnet-5-5',
      'session_start',
    );
    const task = state.createTask(PROJECT, human, { summary: 'docs', ready: true });
    const claimed = state.claimTask(
      PROJECT,
      { harness_id: reg.harness_id, agent_id: reg.agent_id },
      { task_id: task.task_id },
    );
    expect(state.q.run(claimed.run_id)).toMatchObject({ model_observed: 'claude-sonnet-5-5', model_basis: 'session' });
    expect(state.q.task(PROJECT, task.task_id).status).toBe('RUNNING');
  });

  it('starts nothing a route blocks, a failing router included, and asks a human once (review F01)', () => {
    // A router that fails cannot show the work may run here: it does not (until M7.1 it did).
    state.setRouter(() => {
      throw new Error('registry unreadable');
    });
    const cc = register('cc-1', 'attach');
    const task = state.createTask(PROJECT, human, { summary: 'docs', ready: true });
    const caller = { harness_id: cc.harness_id, agent_id: cc.agent_id };
    expect(() => state.claimTask(PROJECT, caller, { task_id: task.task_id })).toThrow(
      /routing failed: registry unreadable/,
    );
    expect(() => state.claimTask(PROJECT, caller, { task_id: task.task_id })).toThrow(/COS-7003|routing/);
    expect(state.q.task(PROJECT, task.task_id).status).toBe('READY');
    expect(state.q.runs(task.task_id)).toEqual([]);
    const blocks = state.store.readSince(PROJECT, 0, { types: ['routing.blocked'] });
    expect(blocks).toHaveLength(1);
    const asked = () =>
      state.q.escalations(PROJECT, 'pending').filter((e) => e.task_id === task.task_id && e.kind === 'routing_blocked');
    expect(asked()).toHaveLength(1);

    // A decision that blocks (no eligible model here): no run and no task.start for a spawn host.
    state.setRouter(({ task: t }) => ({
      decision: {
        mode: 'hybrid',
        task_class: t.kind,
        model: null,
        binding: false,
        blocked: true,
        source: 'none',
        reason: 'no eligible model can run this task here; a human decides',
        reason_codes: ['none.eligible'],
      },
    }));
    const codex = register('codex-1', 'spawn', { task_start: true, model_control: 'set' });
    expect(() => state.assignTask(PROJECT, human, task.task_id, 'codex-1')).toThrow(/no eligible model/);
    expect(state.pollOutbox(PROJECT, codex.harness_id)).toEqual([]);
    expect(state.q.task(PROJECT, task.task_id).status).toBe('READY');
    expect(asked()).toHaveLength(1);

    // A route that allows it: the work starts, and the question about the block is answered.
    state.setRouter(router);
    state.assignTask(PROJECT, human, task.task_id, 'codex-1');
    expect(state.pollOutbox(PROJECT, codex.harness_id)[0]?.params).toMatchObject({ model: 'gpt-5.6-luna' });
    expect(asked()).toEqual([]);
  });

  it('ends an attempt whose host runs another model than its hard constraints allowed (review F01)', () => {
    state.setRouter(({ task: t }) => ({
      decision: {
        mode: 'hybrid',
        task_class: t.kind,
        model: 'local-coder',
        binding: true,
        source: 'score',
        reason: 'the only local model',
        reason_codes: ['score.best'],
        constraints: ['must_use_local'],
      },
    }));
    const codex = register('codex-1', 'spawn', { task_start: true, model_control: 'set' });
    const task = state.createTask(PROJECT, human, { summary: 'refactor', ready: true });
    state.assignTask(PROJECT, human, task.task_id, 'codex-1');
    const [start] = state.pollOutbox(PROJECT, codex.harness_id);
    if (!start) throw new Error('no task.start was queued');
    const runId = (start.params as { run_id: string }).run_id;
    state.ackOutbox(PROJECT, codex.harness_id, [{ message_id: start.message_id, accepted: true }]);
    expect(state.q.task(PROJECT, task.task_id).status).toBe('RUNNING');
    // The same model: nothing happens.
    state.observeModel(
      PROJECT,
      { kind: 'harness', id: codex.harness_id },
      { run_id: runId },
      'local-coder',
      'reported',
    );
    expect(state.q.task(PROJECT, task.task_id).status).toBe('RUNNING');
    // Another one: the attempt ends, the host is told to stop, and a human decides.
    state.observeModel(
      PROJECT,
      { kind: 'harness', id: codex.harness_id },
      { run_id: runId },
      'gpt-5.6-luna',
      'reported',
    );
    expect(state.q.task(PROJECT, task.task_id).status).toBe('READY');
    expect(state.q.run(runId).status).toBe('ENDED');
    expect(state.pollOutbox(PROJECT, codex.harness_id).map((m) => m.method)).toContain('task.cancel');
    expect(
      state.q
        .escalations(PROJECT, 'pending')
        .filter((e) => e.task_id === task.task_id && e.kind === 'routing_violated'),
    ).toHaveLength(1);
  });

  it('keeps human pins with their source and expiry, and only humans make them', () => {
    const p = state.pinRouting(PROJECT, human, {
      scope: 'role',
      target: 'architect',
      model: 'claude-opus-5-5',
      mode: null,
      sensitive: false,
      needs_vision: false,
      until: '2026-10-21T10:00:00.000Z',
      note: 'architecture this week',
    });
    expect(p).toMatchObject({ source: 'human:local-user', until: '2026-10-21T10:00:00.000Z' });
    expect(state.q.routingPins(PROJECT, clock.now()).map((x) => x.pin_id)).toEqual([p.pin_id]);
    clock.advance(8 * 24 * 3600 * 1000);
    expect(state.q.routingPins(PROJECT, clock.now())).toEqual([]);
    expect(() => state.pinRouting(PROJECT, { kind: 'agent', id: 'agent_x' }, { ...p, until: null } as never)).toThrow(
      /only a human/,
    );
    const q = state.pinRouting(PROJECT, human, { ...p, until: null, note: null } as never);
    state.unpinRouting(PROJECT, human, q.pin_id);
    expect(state.q.routingPins(PROJECT, clock.now())).toEqual([]);
  });

  it('turns each verification into evidence for the model that ran, and rebuilds it all on replay', () => {
    state.setRouter(router);
    const reg = register('cc-2', 'attach');
    const caller = { harness_id: reg.harness_id, agent_id: reg.agent_id };
    const verify = (passed: boolean, n: number) => {
      const task = state.createTask(PROJECT, human, { summary: `t${n}`, ready: true });
      const run = state.claimTask(PROJECT, caller, { task_id: task.task_id });
      if (n === 1)
        state.observeModel(
          PROJECT,
          { kind: 'harness', id: reg.harness_id },
          { run_id: run.run_id },
          'claude-haiku-5-5',
          'reported',
        );
      state.submitResult(PROJECT, caller, {
        idempotency_key: `claim-${n}`,
        task_id: task.task_id,
        run_id: run.run_id,
        status: 'completed_claim',
        summary: 'done',
        changed_paths: [],
        checks: [],
        notes: [],
        risks: [],
      });
      const { verification_id } = state.startVerification(PROJECT, human, task.task_id);
      state.finishVerification(PROJECT, human, verification_id, passed, passed ? 'ok' : 'failed');
    };
    verify(true, 1);
    verify(false, 2);
    verify(true, 3);
    // The first ran on what the host reported; the others on what Friday requested.
    expect(state.q.modelEvidence(PROJECT)).toEqual([
      expect.objectContaining({ model: 'claude-haiku-5-5', task_class: 'implementation', samples: 1, passed: 1 }),
      expect.objectContaining({
        model: 'claude-opus-5-5',
        task_class: 'implementation',
        samples: 2,
        passed: 1,
        failed: 1,
      }),
    ]);
    const dump = () => Object.fromEntries(DOMAIN_TABLES.map((t) => [t, db.prepare(`SELECT * FROM ${t}`).all()]));
    const before = dump();
    replay(db, state.store, PROJECT, state.projector);
    expect(dump()).toEqual(before);
  });
});
