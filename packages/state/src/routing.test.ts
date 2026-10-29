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

  it("records the model a session reports, which its runs inherit, and a router's failure without stopping the run", () => {
    state.setRouter(() => {
      throw new Error('registry unreadable');
    });
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
    expect(state.q.routingDecisions(PROJECT, { task_id: task.task_id })[0]).toMatchObject({
      model: null,
      reason_codes: ['router.error'],
    });
    expect(state.q.task(PROJECT, task.task_id).status).toBe('RUNNING');
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
