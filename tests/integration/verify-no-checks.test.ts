import { utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { claudeCodeHooks } from '@friday/adapter-claude';
import type { TaskView, VerificationView } from '@friday/protocol';
import { useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli } from '../helpers/cli.js';
import { startTestDaemon } from '../helpers/daemon.js';
import { attachedSession } from '../helpers/ui.js';

/**
 * A project with no configured checks: Friday's own checks judge a claim, for a human's request
 * (plan §5.8, FD-29) and, once this clone trusts automatic verification, on the claim itself. An
 * implementation task's claim must show the work was run (S07 §5.5).
 */

const ws = useTestWorkspace();
// The CLI finds the test daemon through the workspace's state folder.
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FRIDAY_STATE_DIR;
  process.env.FRIDAY_STATE_DIR = ws().stateDir;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = saved;
});

type Verified = { task: TaskView; verification: VerificationView };
const verify = (td: Awaited<ReturnType<typeof startTestDaemon>>, taskId: string) =>
  td.operator.post<Verified>(td.operator.projectPath(`/tasks/${taskId}/verify`), {});
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('evidence that an implementation task was run', () => {
  it('refuses a claim that names no check when the session ran no test, build or lint command', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const { client, task, run_id, dir } = await attachedSession(td, {
      kind: 'implementation',
      summary: 'add a helper',
    });
    writeFileSync(path.join(dir, 'README.md'), '# test project\n\nwith a helper\n');
    await client.reportResult({
      task_id: task.task_id,
      run_id,
      status: 'completed_claim',
      summary: 'added the helper; I did not run anything',
      changed_paths: ['README.md'],
      checks: [],
      notes: [],
    });
    const r = await verify(td, task.task_id);
    expect(r.task.status).toBe('FAILED');
    const evidence = r.verification.checks.find((c) => c.name === 'friday.evidence');
    expect(evidence).toMatchObject({ status: 'FAILED', required: true, origin: 'friday' });
    expect(evidence?.details?.findings?.map((f) => f.rule)).toEqual(['evidence.none']);
    expect(r.verification.checks.map((c) => c.name)).toEqual(['friday.diff', 'friday.secrets', 'friday.evidence']);
  });

  it("accepts a check the claim names, with a warning when Friday's hooks saw no such command", async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const { client, task, run_id, dir } = await attachedSession(td, {
      kind: 'implementation',
      summary: 'add a helper',
    });
    writeFileSync(path.join(dir, 'README.md'), '# test project\n\nwith a helper\n');
    await client.reportResult({
      task_id: task.task_id,
      run_id,
      status: 'completed_claim',
      summary: 'added the helper and ran the suite',
      changed_paths: ['README.md'],
      checks: [{ name: 'the suite', kind: 'test', command: 'node --test', outcome: 'passed' }],
      notes: [],
    });
    const r = await verify(td, task.task_id);
    expect(r.task.status).toBe('COMPLETED');
    const evidence = r.verification.checks.find((c) => c.name === 'friday.evidence');
    expect(evidence?.status).toBe('PASSED');
    expect(evidence?.summary).toBe('the claim names 1 check(s), 1 not seen run');
    expect(evidence?.details?.findings?.map((f) => f.rule)).toEqual(['evidence.unconfirmed']);
  });

  it('does not blame the task for an untracked file that was there before its first attempt', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const dir = ws().projectDir;
    // A credential file written before any agent started, old by its modification time.
    writeFileSync(path.join(dir, '.env'), 'MODE=test\n');
    const old = new Date(Date.now() - 60_000);
    utimesSync(path.join(dir, '.env'), old, old);
    const { client, task, run_id } = await attachedSession(td, { kind: 'implementation', summary: 'add a helper' });
    writeFileSync(path.join(dir, 'README.md'), '# test project\n\nwith a helper\n');
    await client.reportResult({
      task_id: task.task_id,
      run_id,
      status: 'completed_claim',
      summary: 'added the helper',
      changed_paths: ['README.md'],
      checks: [{ name: 'ran it', outcome: 'passed' }],
      notes: [],
    });
    const r = await verify(td, task.task_id);
    expect(r.task.status).toBe('COMPLETED');
    const diff = r.verification.checks.find((c) => c.name === 'friday.diff');
    expect(diff?.status).toBe('PASSED');
    expect(diff?.summary).toContain('1 changed file(s)');
  });

  it('verifies a claim by itself once this clone trusts automatic verification, with no project checks', async () => {
    const td = await startTestDaemon(ws(), {
      git: true,
      extensions: [claudeCodeHooks()],
      editConfig: (y) => y.replace('auto_on_completion: false', 'auto_on_completion: true'),
    });
    const dir = ws().projectDir;
    expect((await cli(['--project', dir, 'policy', 'trust', '--yes'])).code).toBe(0);
    const { client, task, run_id } = await attachedSession(td, { kind: 'implementation', summary: 'add a helper' });
    writeFileSync(path.join(dir, 'README.md'), '# test project\n\nwith a helper\n');
    await client.reportResult({
      task_id: task.task_id,
      run_id,
      status: 'completed_claim',
      summary: 'added the helper',
      changed_paths: ['README.md'],
      checks: [{ name: 'ran it', outcome: 'passed' }],
      notes: [],
    });
    const done = await until(
      () => td.operator.get<{ task: TaskView }>(td.operator.projectPath(`/tasks/${task.task_id}`)).then((r) => r.task),
      (t) => t.status === 'COMPLETED' || t.status === 'FAILED',
      'automatic verification',
    );
    expect(done.status).toBe('COMPLETED');
  });
});

describe('verification without project checks', () => {
  it("runs Friday's own checks for a human and completes the task when they pass", async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    expect(td.project.config.verification.checks).toEqual([]);
    const { client, task, run_id, dir } = await attachedSession(td);
    writeFileSync(path.join(dir, 'README.md'), '# test project\n\nchanged\n');
    await client.reportResult({
      task_id: task.task_id,
      run_id,
      status: 'completed_claim',
      summary: 'changed the readme',
      changed_paths: ['README.md'],
      checks: [],
      notes: [],
    });
    const r = await td.operator.post<{ task: TaskView; verification: VerificationView }>(
      td.operator.projectPath(`/tasks/${task.task_id}/verify`),
      {},
    );
    expect(r.task.status).toBe('COMPLETED');
    expect(r.verification.summary).toContain('no project checks are configured');
    expect(r.verification.checks.map((c) => c.name)).toEqual(['friday.diff', 'friday.secrets']);
  });

  it('fails the task when one of those checks fails', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const { client, task, run_id, dir } = await attachedSession(td);
    // A credential in a changed file fails friday.secrets.
    writeFileSync(path.join(dir, 'README.md'), `token: ghp_${'a'.repeat(36)}\n`);
    await client.reportResult({
      task_id: task.task_id,
      run_id,
      status: 'completed_claim',
      summary: 'changed the readme',
      changed_paths: ['README.md'],
      checks: [],
      notes: [],
    });
    const r = await td.operator.post<{ task: TaskView; verification: VerificationView }>(
      td.operator.projectPath(`/tasks/${task.task_id}/verify`),
      {},
    );
    expect(r.task.status).toBe('FAILED');
    expect(r.verification.checks.find((c) => c.name === 'friday.secrets')?.status).toBe('FAILED');
  });
});
