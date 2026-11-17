/**
 * A failed check told apart from a failed install (2026-11-17): what the state knows about the last
 * install of a task's folder, and when a failed verification is likely the setup and not the work.
 */
import { openDatabase, type SqlDatabase } from '@friday/db';
import { type Actor, HarnessRegisterParams } from '@friday/protocol';
import { FakeClock } from '@friday/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import { FridayState } from './index.js';
import type { WorkspaceSetupRecord } from './service.js';

const PROJECT = 'proj_00000000000000000000000001';
const human: Actor = { kind: 'human', id: 'local-user' };

let db: SqlDatabase;
let state: FridayState;

beforeEach(() => {
  db = openDatabase(':memory:');
  state = new FridayState({ db, clock: new FakeClock('2026-11-17T10:00:00.000Z') });
  state.ensureProject({ project_id: PROJECT, name: 'shop', root_path: 'C:/demo/shop' });
});

/** A task with a completion claim, waiting to be verified. */
function claimed(): string {
  const reg = state.registerHarness(
    PROJECT,
    HarnessRegisterParams.parse({
      protocol_version: '1.0',
      harness_key: `claude-code:${PROJECT}:pid:101`,
      vendor: 'claude-code',
      name: 'Claude Code',
      attach_mode: 'attach',
      project_id: PROJECT,
      agent: { agent_key: 'dev-1' },
    }),
  );
  const task = state.createTask(PROJECT, human, {
    summary: 'change a',
    scope: { write: ['src/**'], read: [] },
    assign_agent_key: 'dev-1',
  });
  const caller = { harness_id: reg.harness_id, agent_id: reg.agent_id };
  const run = state.claimTask(PROJECT, caller, { task_id: task.task_id });
  state.submitResult(PROJECT, caller, {
    idempotency_key: 'claim-1',
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

function setup(over: Partial<WorkspaceSetupRecord> = {}): WorkspaceSetupRecord {
  return {
    status: 'failed',
    source: 'config',
    command: 'npm',
    args: ['ci'],
    exit_code: 1,
    timed_out: false,
    duration_ms: 900,
    reason: 'npm exited with 1',
    output_tail: 'npm ERR! network unreachable',
    ...over,
  };
}

function installed(taskId: string, record: WorkspaceSetupRecord): void {
  state.recordObservation(PROJECT, human, 'worktree.setup_ran', { task_id: taskId, run_id: null, setup: record }, [
    { kind: 'task', id: taskId },
  ]);
}

/** A failed verification with one failed check of the given origin. */
function failedCheck(taskId: string, origin: 'friday' | 'configured' | 'targeted'): void {
  const { verification_id } = state.startVerification(PROJECT, human, taskId, {
    execution_root: 'C:/worktrees/abcd1234/task0001',
    commit_sha: 'a'.repeat(40),
    source_version: `${'a'.repeat(40)}+0123456789ab`,
    base_commit: 'b'.repeat(40),
    task_kind: 'implementation',
  });
  state.recordVerificationCheck(PROJECT, human, verification_id, {
    name: origin === 'friday' ? 'friday.diff' : 'tests',
    kind: origin === 'friday' ? 'diff' : 'test',
    origin,
    status: 'FAILED',
    exit_code: origin === 'friday' ? null : 1,
    artifact_ref: null,
    summary: 'failed',
  });
  state.finishVerification(PROJECT, human, verification_id, false, '1/1 required checks failed');
}

describe('the last install of a task folder', () => {
  it('is none before any was attempted', () => {
    const taskId = claimed();
    expect(state.latestWorktreeSetup(PROJECT, taskId)).toBeNull();
    expect(state.worktreeSetupTrouble(PROJECT, taskId)).toBeNull();
    expect(state.worktreeSetupEvidence(PROJECT, taskId)).toEqual([]);
  });

  it('is the latest one on record, with what it ran and the end of what it printed', () => {
    const taskId = claimed();
    installed(taskId, setup());
    expect(state.latestWorktreeSetup(PROJECT, taskId)?.setup).toMatchObject({ status: 'failed', exit_code: 1 });
    expect(state.worktreeSetupEvidence(PROJECT, taskId)).toEqual([
      'install: npm ci',
      'install output: npm ERR! network unreachable',
    ]);
    installed(taskId, setup({ status: 'passed', exit_code: 0, reason: 'ok', output_tail: null }));
    expect(state.latestWorktreeSetup(PROJECT, taskId)?.setup.status).toBe('passed');
    expect(state.worktreeSetupEvidence(PROJECT, taskId)).toEqual(['install: npm ci']);
  });

  it('keeps the evidence short however much the install printed', () => {
    const taskId = claimed();
    installed(taskId, setup({ output_tail: `${'x'.repeat(4000)}the last line` }));
    const output = state.worktreeSetupEvidence(PROJECT, taskId)[1] ?? '';
    expect(output.length).toBeLessThanOrEqual('install output: '.length + 1500);
    expect(output.endsWith('the last line')).toBe(true);
  });

  it('only observations Friday knows are recorded', () => {
    const taskId = claimed();
    expect(() => state.recordObservation(PROJECT, human, 'worktree.setup_run', { task_id: taskId }, [])).toThrow(
      /not an observation event type/,
    );
  });
});

describe('a failed verification that is likely the setup', () => {
  it("is one where the install failed and a check of the project's own failed", () => {
    const taskId = claimed();
    installed(taskId, setup());
    // No verification yet: nothing failed.
    expect(state.worktreeSetupTrouble(PROJECT, taskId)).toBeNull();
    failedCheck(taskId, 'configured');
    expect(state.worktreeSetupTrouble(PROJECT, taskId)).toBe('npm exited with 1');
  });

  it('counts an install Friday refused to run, and a check limited to related tests', () => {
    const taskId = claimed();
    installed(
      taskId,
      setup({ status: 'refused', exit_code: null, reason: 'the install is not trusted on this machine' }),
    );
    failedCheck(taskId, 'targeted');
    expect(state.worktreeSetupTrouble(PROJECT, taskId)).toBe('the install is not trusted on this machine');
  });

  it("is not one where only Friday's own checks failed: that is the work, whatever the install did", () => {
    const taskId = claimed();
    installed(taskId, setup());
    failedCheck(taskId, 'friday');
    expect(state.worktreeSetupTrouble(PROJECT, taskId)).toBeNull();
  });

  it('is not one where the install passed, was skipped, or was run again and passed since', () => {
    const passed = claimed();
    installed(passed, setup({ status: 'passed', exit_code: 0, reason: 'ok' }));
    failedCheck(passed, 'configured');
    expect(state.worktreeSetupTrouble(PROJECT, passed)).toBeNull();
    installed(passed, setup({ status: 'skipped', exit_code: null, reason: 'nothing to install' }));
    expect(state.worktreeSetupTrouble(PROJECT, passed)).toBeNull();
    // Failed, then fixed by a person: from here on a failure is the work's.
    installed(passed, setup());
    expect(state.worktreeSetupTrouble(PROJECT, passed)).toBe('npm exited with 1');
    installed(passed, setup({ status: 'passed', exit_code: 0, reason: 'ok' }));
    expect(state.worktreeSetupTrouble(PROJECT, passed)).toBeNull();
  });
});
