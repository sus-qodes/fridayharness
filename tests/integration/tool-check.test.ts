/**
 * `tool.check` (ADR-0032 §4): a spawn adapter asks Friday before its host acts, and gets the same
 * judgment Claude Code's hooks get, for the task its session holds. Where a human decides, one
 * pending approval is recorded and the action passes once it is granted, for one use.
 */
import type { TaskStartParams, TaskView } from '@friday/protocol';
import { FakeClock, useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli } from '../helpers/cli.js';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { FakeHarness } from '../helpers/fake-harness.js';

const ws = useTestWorkspace();
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FRIDAY_STATE_DIR;
  process.env.FRIDAY_STATE_DIR = ws().stateDir;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = saved;
});

async function running(td: TestDaemon, agent: string, write: string[]) {
  const h = await FakeHarness.connect(td, { agentKey: agent, role: 'backend' });
  const t = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
    summary: `work of ${agent}`,
    scope: { write, read: [] },
    ready: true,
  });
  await td.operator.post(td.operator.projectPath(`/tasks/${t.task_id}/assign`), { agent_key: agent });
  const start = (await h.waitFor('task.start', 30_000)).params as TaskStartParams;
  for (let i = 0; i < 200; i++) {
    if (td.daemon.state.q.task(td.project.project_id, t.task_id).status === 'RUNNING') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  return { h, task: td.daemon.state.q.task(td.project.project_id, t.task_id), start };
}

const PS = '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command';

describe('tool.check', () => {
  it("judges a spawn adapter's host actions as the hooks judge Claude Code's, and asks a human once", async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    const dir = ws().projectDir;
    const pid = td.project.project_id;
    const { h, task, start } = await running(td, 'cx-1', ['src/**']);
    const check = (tool: string, action: Record<string, unknown>) =>
      h.client.call('tool.check', { tool, action: action as never });

    // Writes inside the scope pass; outside it, and Friday's protected files, do not.
    expect(await check('fileChange', { kind: 'write', paths: ['src/a.ts'] })).toMatchObject({
      decision: 'allow',
      approval_id: null,
    });
    expect(await check('fileChange', { kind: 'write', paths: ['docs/x.md'] })).toMatchObject({
      decision: 'deny',
      rule: 'write.outside_scope',
    });
    expect((await check('fileChange', { kind: 'write', paths: ['.friday/config.yaml'] })).decision).toBe('deny');
    // A host's absolute path into its checkout is the same file.
    expect(
      (await check('fileChange', { kind: 'write', paths: [`${start.working_directory}/src/b.ts`] })).decision,
    ).toBe('allow');

    // The command inside the host's shell wrapper is what is judged.
    expect((await check('commandExecution', { kind: 'command', command: `${PS} 'node --test'` })).decision).toBe(
      'allow',
    );
    expect(
      await check('commandExecution', {
        kind: 'command',
        command: `${PS} 'node --test; Remove-Item -Recurse src'`,
      }),
    ).toMatchObject({ decision: 'ask', rule: 'command.fs.destructive' });
    expect((await check('commandExecution', { kind: 'command', command: `${PS} 'git push'` })).decision).toBe('deny');
    // How Codex reads on Windows (the M8a live check): PowerShell blocks of reads pass, and a read of
    // Friday's protected files inside one does not.
    const inspect = `${PS} 'Get-ChildItem src | Select-Object FullName; if (Test-Path src/a.ts) { Get-Content src/a.ts }'`;
    expect((await check('commandExecution', { kind: 'command', command: inspect })).decision).toBe('allow');
    expect(
      (
        await check('commandExecution', {
          kind: 'command',
          command: `${PS} 'if (Test-Path .friday/run/daemon.json) { Get-Content .friday/run/daemon.json }'`,
        })
      ).decision,
    ).toBe('deny');

    // A human decides a commit: one pending approval, whichever number of times it is asked.
    const commit = { kind: 'command', command: `${PS} 'git commit -m wip'` };
    const asked = await check('commandExecution', commit);
    expect(asked).toMatchObject({ decision: 'ask', rule: 'command.git.mutate' });
    expect(asked.approval_id).toMatch(/^apr_/);
    expect((await check('commandExecution', commit)).approval_id).toBe(asked.approval_id);
    const pending = td.daemon.state.q.approvals(pid, 'pending').filter((a) => a.capability === 'shell.git.commit');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ task_id: task.task_id, run_id: start.run_id });
    // Granted, it lets the same action through once.
    expect((await cli(['--project', dir, 'approve', asked.approval_id as string])).code).toBe(0);
    expect(await check('commandExecution', commit)).toMatchObject({ decision: 'allow', rule: 'command.approved' });
    const again = await check('commandExecution', commit);
    expect(again.decision).toBe('ask');
    expect(again.approval_id).not.toBe(asked.approval_id);

    // Every decision is recorded with the host's name for the tool.
    const evaluated = td.daemon.state.store
      .readByRef(pid, 'task', task.task_id)
      .filter((e) => e.type === 'policy.evaluated')
      .map((e) => (e.payload as { tool: string }).tool);
    expect(new Set(evaluated)).toEqual(new Set(['fileChange', 'commandExecution']));

    // A session judges only for the task it holds.
    await expect(
      h.client.call('tool.check', {
        task_id: 'task_00000000000000000000000000',
        tool: 'fileChange',
        action: { kind: 'write', paths: ['src/a.ts'] },
      }),
    ).rejects.toThrow(/not a task this session holds/);
    await h.close();
  });

  it('asks a human before a printed value is written into a file (review M8-R01)', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    const { h, start } = await running(td, 'cx-1', ['src/**']);
    const check = (command: string) =>
      h.client.call('tool.check', { tool: 'commandExecution', action: { kind: 'command', command } });
    // As Claude Code's PowerShell tool passes it, and as Codex wraps it.
    for (const command of ["'review redirection' > outside.txt", `${PS} "'review redirection' > outside.txt"`]) {
      expect(await check(command), command).toMatchObject({ decision: 'ask', rule: 'command.git.mutate' });
    }
    // Printed or thrown away, it still passes.
    expect((await check("'review redirection' > $null")).decision).toBe('allow');
    expect((await check(`${PS} "'--- done'"`)).decision).toBe('allow');

    // What the host does with Friday's answer: it runs the command only when Friday allows it.
    if (process.platform === 'win32') {
      const command = "'review redirection' > outside.txt";
      const verdict = await check(command);
      if (verdict.decision === 'allow') {
        const { spawnSync } = await import('node:child_process');
        spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
          cwd: start.working_directory,
          stdio: 'ignore',
        });
      }
      const { existsSync } = await import('node:fs');
      const path = await import('node:path');
      expect(existsSync(path.join(start.working_directory, 'outside.txt'))).toBe(false);
    }
    await h.close();
  });

  it('refuses a write another task holds the reservation of, as the hooks do', async () => {
    const td = await startTestDaemon(ws(), {
      git: true,
      brain: false,
      extraConfig: 'reservations:\n  mode: hybrid\n  required: ["shared/api.ts"]\n',
    });
    const one = await running(td, 'cx-1', ['shared/**']);
    const two = await running(td, 'cx-2', ['shared/**']);
    const write = (h: FakeHarness) =>
      h.client.call('tool.check', { tool: 'fileChange', action: { kind: 'write', paths: ['shared/api.ts'] } });
    expect((await write(one.h)).decision).toBe('allow');
    expect(await write(two.h)).toMatchObject({ decision: 'deny', rule: 'write.reserved' });
    await one.h.close();
    await two.h.close();
  });

  it('sends the session a run worked in back with task.resume', async () => {
    const clock = new FakeClock(new Date().toISOString());
    const td = await startTestDaemon(ws(), { git: true, brain: false, clock });
    const h = await FakeHarness.connect(td, {
      key: 'resuming-host',
      agentKey: 'cx-1',
      onMessage: async () => ({ accepted: true, session_ref: 'thread-0001' }),
    });
    const t = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
      summary: 'resumable',
      ready: true,
    });
    await td.operator.post(td.operator.projectPath(`/tasks/${t.task_id}/assign`), { agent_key: 'cx-1' });
    const start = (await h.waitFor('task.start', 30_000)).params as TaskStartParams;
    expect(start.session_ref).toBeNull();
    for (let i = 0; i < 200; i++) {
      if (td.daemon.state.q.task(td.project.project_id, t.task_id).status === 'RUNNING') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    await h.crash();
    clock.advance(31_000);
    td.daemon.tick();
    expect(td.daemon.state.q.task(td.project.project_id, t.task_id).status).toBe('HARNESS_LOST');
    await h.reconnect();
    const resume = (await h.waitFor('task.resume', 30_000)).params as TaskStartParams;
    expect(resume).toMatchObject({ task_id: t.task_id, run_id: start.run_id, session_ref: 'thread-0001' });
    await h.close();
  });
});
