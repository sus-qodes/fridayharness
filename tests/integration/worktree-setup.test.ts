/**
 * Dependencies in a fresh task worktree (plan Phase 7): installed before the agent starts, under
 * the policy's trust rule, with the outcome on the run's record and in the agent's start note.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { claudeCodeHooks } from '@friday/adapter-claude';
import type { TaskStartParams, TaskView } from '@friday/protocol';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
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

/** A setup command that leaves a marker where node_modules would be. */
const MARKER =
  "require('fs').mkdirSync('node_modules',{recursive:true});require('fs').writeFileSync('node_modules/.friday-setup','ok')";
const declared = (js: string) => `worktrees:\n  setup:\n    command: node\n    args: ["-e", ${JSON.stringify(js)}]\n`;

async function project(extraConfig: string, files: Record<string, string> = {}) {
  const td = await startTestDaemon(ws(), { git: true, brain: false, extensions: [claudeCodeHooks()], extraConfig });
  const dir = ws().projectDir;
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  await deterministicGit(dir, { startEpoch: 1_767_225_700 }).commitAll('source');
  return { td, dir };
}

const taskOf = (td: TestDaemon, id: string) =>
  td.operator.get<{ task: TaskView }>(td.operator.projectPath(`/tasks/${id}`)).then((r) => r.task);
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** An agent takes a new task; returns its start and the setup record of its run. */
async function take(td: TestDaemon, fake: FakeHarness, agent: string) {
  const task = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
    summary: `work of ${agent}`,
    scope: { write: ['src/**'], read: [] },
    ready: true,
  });
  await td.operator.post(td.operator.projectPath(`/tasks/${task.task_id}/assign`), { agent_key: agent });
  const start = (await fake.waitFor('task.start', 30_000)).params as TaskStartParams;
  const ready = td.daemon.state.store
    .readByRef(td.project.project_id, 'run', start.run_id, { types: ['run.workspace_ready'] })
    .at(-1);
  const setup = (ready?.payload as { setup?: Record<string, unknown> | null } | undefined)?.setup ?? null;
  return { task, start, setup };
}

describe('dependencies in a fresh task worktree', () => {
  it("runs the project's own command once trusted, records it, and skips a worktree that has them", async () => {
    const { td, dir } = await project(declared(MARKER));
    expect((await cli(['--project', dir, 'policy', 'trust', '--yes'])).code).toBe(0);
    const fake = await FakeHarness.connect(td, { agentKey: 'be-1' });
    const first = await take(td, fake, 'be-1');
    expect(first.start.working_directory).not.toBe(dir);
    expect(readFileSync(path.join(first.start.working_directory, 'node_modules', '.friday-setup'), 'utf8')).toBe('ok');
    expect(first.start.note).toBeNull();
    expect(first.setup).toMatchObject({
      status: 'passed',
      source: 'config',
      command: 'node',
      exit_code: 0,
      reason: 'ok',
    });
    const shown = await cli(['--project', dir, 'task', 'inspect', first.task.task_id, '--events', '50']);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain('worktree ready; dependencies passed (node -e');

    // The next attempt reuses the worktree: nothing is installed twice.
    await td.operator.post(td.operator.projectPath(`/tasks/${first.task.task_id}/release`), { reason: 'again' });
    await until(
      () => taskOf(td, first.task.task_id),
      (t) => t.status === 'READY',
      'the task to be free',
    );
    await td.operator.post(td.operator.projectPath(`/tasks/${first.task.task_id}/assign`), { agent_key: 'be-1' });
    const again = (
      await fake.waitFor('task.start', 30_000, (m) => (m.params as TaskStartParams).run_id !== first.start.run_id)
    ).params as TaskStartParams;
    // The task's worktree is reused as it is (ADR-0023): the run starts ready, nothing is prepared
    // again, and the dependencies are still there.
    expect(again.working_directory).toBe(first.start.working_directory);
    expect(td.daemon.state.q.run(again.run_id)).toMatchObject({
      workspace: 'ready',
      execution_root: again.working_directory,
    });
    expect(
      td.daemon.state.store.readByRef(td.project.project_id, 'run', again.run_id, { types: ['run.workspace_ready'] }),
    ).toEqual([]);
    expect(readFileSync(path.join(again.working_directory, 'node_modules', '.friday-setup'), 'utf8')).toBe('ok');
    await fake.close();
  }, 120_000);

  it('refuses a declared command this clone has not trusted, and tells the agent', async () => {
    const { td } = await project(declared(MARKER));
    const fake = await FakeHarness.connect(td, { agentKey: 'be-1' });
    const { start, setup } = await take(td, fake, 'be-1');
    expect(existsSync(path.join(start.working_directory, 'node_modules'))).toBe(false);
    expect(setup).toMatchObject({ status: 'refused', source: null, command: null });
    expect((setup as { reason: string }).reason).toContain('waits for "friday policy trust"');
    expect(start.note).toContain("Friday could not install this worktree's dependencies");
    expect(start.note).toContain('install them yourself');
    await fake.close();
  }, 120_000);

  it('with on_failure: fail, a failed install declines the attempt and asks a human', async () => {
    const { td, dir } = await project(`${declared('process.exit(3)')}    on_failure: fail\n`);
    expect((await cli(['--project', dir, 'policy', 'trust', '--yes'])).code).toBe(0);
    const fake = await FakeHarness.connect(td, { agentKey: 'be-1' });
    const task = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
      summary: 'work that needs deps',
      scope: { write: ['src/**'], read: [] },
      ready: true,
    });
    await td.operator.post(td.operator.projectPath(`/tasks/${task.task_id}/assign`), { agent_key: 'be-1' });
    const freed = await until(
      () => taskOf(td, task.task_id),
      (t) => t.status === 'READY' && t.current_run_id === null,
      'the decline',
    );
    expect(freed.status).toBe('READY');
    const pending = td.daemon.state.q
      .escalations(td.project.project_id, 'pending')
      .filter((e) => e.task_id === task.task_id);
    expect(pending.map((e) => e.kind)).toEqual(['recovery_needed']);
    expect(pending[0]?.question).toContain('node exited with 3');
    const runs = td.daemon.state.q.runs(task.task_id);
    expect(runs.at(-1)).toMatchObject({ status: 'DECLINED' });
    await fake.close();
  }, 120_000);

  const pnpm = spawnSync('pnpm', ['--version'], { shell: true, encoding: 'utf8' });
  it.skipIf(pnpm.status !== 0)(
    'installs what a pnpm lockfile calls for, offline, scripts ignored',
    async () => {
      const { td, dir } = await project('', {
        'package.json': '{"name":"shop","private":true,"dependencies":{"tiny":"file:vendor/tiny"}}\n',
        'vendor/tiny/package.json':
          '{"name":"tiny","version":"1.0.0","scripts":{"postinstall":"node -e \\"process.exit(9)\\""}}\n',
        'vendor/tiny/index.js': 'module.exports = 1;\n',
      });
      const lock = spawnSync('pnpm', ['install', '--lockfile-only', '--ignore-scripts'], {
        cwd: dir,
        shell: true,
        encoding: 'utf8',
      });
      expect(lock.status, lock.stderr).toBe(0);
      await deterministicGit(dir, { startEpoch: 1_767_225_800 }).commitAll('lockfile');
      const fake = await FakeHarness.connect(td, { agentKey: 'be-1' });
      const { start, setup } = await take(td, fake, 'be-1');
      // The postinstall script would have failed the install: scripts are ignored without trust.
      expect(setup).toMatchObject({
        status: 'passed',
        source: 'lockfile',
        command: 'pnpm',
        args: ['install', '--frozen-lockfile', '--prefer-offline', '--ignore-scripts'],
      });
      expect(existsSync(path.join(start.working_directory, 'node_modules', 'tiny', 'index.js'))).toBe(true);
      expect(start.note).toBeNull();
      await fake.close();
    },
    180_000,
  );
});
