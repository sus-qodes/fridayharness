import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { claudeCodeHooks } from '@friday/adapter-claude';
import type { TaskView, VerificationView } from '@friday/protocol';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { startTestDaemon } from '../helpers/daemon.js';
import { attachedSession } from '../helpers/ui.js';

/** A project with no configured checks can still verify a task when a human asks (plan §5.8, FD-29). */

const ws = useTestWorkspace();

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
