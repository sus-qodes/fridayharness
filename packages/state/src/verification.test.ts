/**
 * Revision-bound verification in the state (plan M5b, ADR-0024 §1, §2, §6, §8).
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
let state: FridayState;

beforeEach(() => {
  db = openDatabase(':memory:');
  state = new FridayState({ db, clock: new FakeClock('2026-10-14T10:00:00.000Z') });
  state.ensureProject({ project_id: PROJECT, name: 'shop', root_path: 'C:/demo/shop' });
});

/** A task with a completion claim, waiting to be verified. */
function claimed(n = 1): string {
  const reg = state.registerHarness(
    PROJECT,
    HarnessRegisterParams.parse({
      protocol_version: '1.0',
      harness_key: `claude-code:${PROJECT}:pid:${100 + n}`,
      vendor: 'claude-code',
      name: 'Claude Code',
      attach_mode: 'attach',
      project_id: PROJECT,
      agent: { agent_key: `dev-${n}` },
    }),
  );
  const task = state.createTask(PROJECT, human, {
    summary: `change ${n}`,
    scope: { write: ['src/**'], read: [] },
    assign_agent_key: `dev-${n}`,
  });
  const caller = { harness_id: reg.harness_id, agent_id: reg.agent_id };
  const run = state.claimTask(PROJECT, caller, { task_id: task.task_id });
  state.submitResult(PROJECT, caller, {
    idempotency_key: `claim-${n}`,
    task_id: task.task_id,
    run_id: run.run_id,
    status: 'completed_claim',
    summary: 'done',
    changed_paths: ['src/a.ts'],
    checks: [],
    notes: [],
    risks: [],
  });
  return task.task_id;
}

const revision = {
  execution_root: 'C:/worktrees/abcd1234/task0001',
  commit_sha: 'a'.repeat(40),
  source_version: `${'a'.repeat(40)}+0123456789ab`,
  base_commit: 'b'.repeat(40),
  task_kind: 'implementation',
};

describe('what a verification judged', () => {
  it('records the checkout, revision and kind, and how each check counted', () => {
    const taskId = claimed();
    const { verification_id } = state.startVerification(PROJECT, human, taskId, revision);
    state.recordVerificationCheck(PROJECT, human, verification_id, {
      name: 'friday.diff',
      kind: 'diff',
      origin: 'friday',
      status: 'PASSED',
      exit_code: null,
      artifact_ref: null,
      summary: '1 changed file(s) within scope',
      details: {
        findings: [
          { rule: 'diff.unclaimed', severity: 'warn', message: 'changed but not listed', paths: ['src/b.ts'] },
        ],
        files: ['test/a.test.ts'],
      },
    });
    state.recordVerificationCheck(PROJECT, human, verification_id, {
      name: 'lint',
      kind: 'lint',
      status: 'FAILED',
      exit_code: 1,
      artifact_ref: null,
      summary: 'failed',
      required: false,
      duration_ms: 42,
    });
    state.finishVerification(PROJECT, human, verification_id, true, '1/1 required checks passed');
    const v = state.q.verification(verification_id);
    expect(v).toMatchObject({ status: 'PASSED', ...revision });
    expect(v.checks).toEqual([
      expect.objectContaining({
        name: 'friday.diff',
        origin: 'friday',
        required: true,
        duration_ms: null,
        details: {
          findings: [
            { rule: 'diff.unclaimed', severity: 'warn', message: 'changed but not listed', paths: ['src/b.ts'] },
          ],
          files: ['test/a.test.ts'],
        },
      }),
      expect.objectContaining({ name: 'lint', origin: 'configured', required: false, duration_ms: 42, details: null }),
    ]);
    // Replay rebuilds the same rows.
    const dump = () => Object.fromEntries(DOMAIN_TABLES.map((t) => [t, db.prepare(`SELECT * FROM ${t}`).all()]));
    const before = dump();
    replay(db, state.store, PROJECT, state.projector);
    expect(dump()).toEqual(before);
  });
});

describe('a verification that could not finish', () => {
  it('ends interrupted and returns the task to READY_FOR_VERIFICATION, ready to be verified again', () => {
    const taskId = claimed();
    const first = state.startVerification(PROJECT, human, taskId, revision);
    const task = state.interruptVerification(
      PROJECT,
      human,
      first.verification_id,
      'the code changed while it was verified',
    );
    expect(task.status).toBe('READY_FOR_VERIFICATION');
    expect(task.current_run_id).not.toBeNull();
    expect(state.q.verification(first.verification_id)).toMatchObject({
      status: 'CANCELLED',
      summary: 'interrupted: the code changed while it was verified',
    });
    const types = state.store.readByRef(PROJECT, 'task', taskId).map((e) => e.type);
    expect(types.slice(-2)).toEqual(['verification.interrupted', 'task.verification_interrupted']);
    // A finished verification cannot be interrupted, and the next one runs normally.
    expect(() => state.interruptVerification(PROJECT, human, first.verification_id, 'again')).toThrow(
      /already CANCELLED/,
    );
    const second = state.startVerification(PROJECT, human, taskId, revision);
    expect(state.finishVerification(PROJECT, human, second.verification_id, true, 'ok').status).toBe('COMPLETED');
  });

  it('at a daemon start, ends every RUNNING verification except those still running in this process', () => {
    const a = claimed(1);
    const b = claimed(2);
    const va = state.startVerification(PROJECT, human, a, revision).verification_id;
    const vb = state.startVerification(PROJECT, human, b, revision).verification_id;
    expect(
      state.interruptOrphanedVerifications(PROJECT, 'the daemon stopped while its checks ran', new Set([vb])),
    ).toEqual([va]);
    expect(state.q.task(PROJECT, a).status).toBe('READY_FOR_VERIFICATION');
    expect(state.q.task(PROJECT, b).status).toBe('VERIFYING');
    expect(state.interruptOrphanedVerifications(PROJECT, 'restart')).toEqual([vb]);
    expect(state.q.verificationsWithStatus(PROJECT, 'RUNNING')).toEqual([]);
  });
});
