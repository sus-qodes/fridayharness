/**
 * Dependencies in a fresh task worktree (plan Phase 7): installed before the agent starts, under
 * the policy's trust rule, with the outcome on the run's record and in the agent's start note.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
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
        // Repository code pnpm would load before installing anything (review 2026-10-22, R10).
        '.pnpmfile.cjs': "require('fs').writeFileSync('.friday-pnpmfile-ran', 'x');\nmodule.exports = { hooks: {} };\n",
      });
      const lock = spawnSync('pnpm', ['install', '--lockfile-only', '--ignore-scripts', '--ignore-pnpmfile'], {
        cwd: dir,
        shell: true,
        encoding: 'utf8',
      });
      expect(lock.status, lock.stderr).toBe(0);
      // The lockfile step itself kept the hook out, so the commit carries no marker.
      expect(existsSync(path.join(dir, '.friday-pnpmfile-ran'))).toBe(false);
      await deterministicGit(dir, { startEpoch: 1_767_225_800 }).commitAll('lockfile');
      const fake = await FakeHarness.connect(td, { agentKey: 'be-1' });
      const { start, setup } = await take(td, fake, 'be-1');
      // The postinstall script would have failed the install: scripts are ignored without trust.
      expect(setup).toMatchObject({
        status: 'passed',
        source: 'lockfile',
        command: 'pnpm',
        args: ['install', '--frozen-lockfile', '--prefer-offline', '--ignore-scripts', '--ignore-pnpmfile'],
      });
      expect(existsSync(path.join(start.working_directory, 'node_modules', 'tiny', 'index.js'))).toBe(true);
      // The pnpmfile did not run: no marker in the worktree.
      expect(existsSync(path.join(start.working_directory, '.friday-pnpmfile-ran'))).toBe(false);
      expect(start.note).toBeNull();
      // The installed tree went into the dependency cache.
      expect(setup).toMatchObject({ cache: { from: 'install', files: expect.any(Number) } });

      // A second task's worktree has the same lockfile: its tree comes from the cache, no install
      // runs, and its links point into its own worktree.
      const other = await FakeHarness.connect(td, { agentKey: 'be-2' });
      const second = await take(td, other, 'be-2');
      expect(second.start.working_directory).not.toBe(start.working_directory);
      expect(second.setup).toMatchObject({
        status: 'passed',
        source: 'lockfile',
        command: 'pnpm',
        exit_code: null,
        reason: 'ok',
        cache: { key: (setup as { cache: { key: string } }).cache.key, from: 'cache' },
      });
      const tiny = path.join(second.start.working_directory, 'node_modules', 'tiny');
      expect(existsSync(path.join(tiny, 'index.js'))).toBe(true);
      expect(realpathSync.native(tiny).startsWith(realpathSync.native(second.start.working_directory))).toBe(true);
      expect(second.start.note).toBeNull();
      const shown = await cli(['--project', dir, 'task', 'inspect', second.task.task_id, '--events', '50']);
      expect(shown.stdout).toContain('worktree ready; dependencies passed from the cache (pnpm');
      await other.close();
      await fake.close();
    },
    180_000,
  );
});

describe('a check that fails where the install failed (2026-11-17)', () => {
  /** Installs only once `node_modules/.allow` is there: what a person fixes between two tries. */
  const INSTALL =
    "const fs=require('fs');if(!fs.existsSync('node_modules/.allow')){console.error('registry unreachable');process.exit(3)}fs.writeFileSync('node_modules/.friday-setup','ok')";
  /** A check of the project's own that needs what the install leaves. */
  const CHECKS =
    '  checks:\n    - name: tests\n      command: node\n      args: ["-e", "require(\'fs\').accessSync(\'node_modules/.friday-setup\')"]\n';

  it('waits for a person with the reason, shows what the check printed, and installs again on request', async () => {
    const td = await startTestDaemon(ws(), {
      git: true,
      brain: { autoStart: false },
      extensions: [claudeCodeHooks()],
      extraConfig: declared(INSTALL),
      editConfig: (y) => y.replace('  checks: []\n', CHECKS),
    });
    const dir = ws().projectDir;
    const pid = td.project.project_id;
    const P = (p: string) => td.operator.projectPath(p);
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    await deterministicGit(dir, { startEpoch: 1_767_225_700 }).commitAll('source');
    expect((await cli(['--project', dir, 'policy', 'trust', '--yes'])).code).toBe(0);

    // A goal with one task, so what follows a failed check is the planner's to decide.
    const goal = await td.operator.post<{ goal_id: string }>(P('/goals'), { request: 'Change a', plan: false });
    const v1 = await td.operator.post<{ plan_id: string; version: number }>(P(`/goals/${goal.goal_id}/plans`), {
      draft: {
        objective: 'Change a',
        summary: 'One task',
        tasks: [
          {
            key: 'a',
            summary: 'Change a',
            acceptance_criteria: ['tests pass'],
            scope: { write: ['src/**'], read: ['**'] },
            depends_on: [],
          },
        ],
      },
    });
    await td.operator.post(P(`/plans/${v1.plan_id}/versions/${v1.version}/approve`), {});
    const taskId = td.daemon.state.q.tasks(pid, {}).find((t) => t.goal_id === goal.goal_id)?.task_id as string;
    const fake = await FakeHarness.connect(td, { agentKey: 'be-1' });
    await td.operator.post(P(`/tasks/${taskId}/assign`), { agent_key: 'be-1' });
    const start = (await fake.waitFor('task.start', 30_000)).params as TaskStartParams;
    // The install failed, and the agent was told; it works on, as it may by default.
    expect(start.note).toContain("Friday could not install this worktree's dependencies");
    await until(
      () => taskOf(td, taskId),
      (t) => t.status === 'RUNNING',
      'the task to run',
    );
    writeFileSync(path.join(start.working_directory, 'src', 'a.ts'), 'export const a = 2;\n');
    await fake.client.reportResult({
      task_id: taskId,
      run_id: start.run_id,
      status: 'completed_claim',
      summary: 'changed a',
      changed_paths: ['src/a.ts'],
      checks: [],
    });
    await fake.close();

    type Verified = {
      task: TaskView;
      verification: {
        summary: string;
        checks: { name: string; status: string; origin: string; artifact_ref: string | null }[];
      };
    };
    const verified = await td.operator.post<Verified>(P(`/tasks/${taskId}/verify`), {}, { timeoutMs: 120_000 });
    expect(verified.task.status).toBe('FAILED');
    // The verdict says what it most likely is.
    expect(verified.verification.summary).toContain(
      "the project's dependencies were not installed in this task's folder (node exited with 3), so a failing check may be the setup and not the work",
    );
    expect(td.daemon.state.worktreeSetupTrouble(pid, taskId)).toBe('node exited with 3');

    // The planner does not send it back to fail the same way, nor revise the plan: a person is asked.
    await td.operator.post(P('/brain/run-once'), {});
    const questions = () => td.daemon.state.q.escalations(pid, 'pending').filter((e) => e.task_id === taskId);
    expect(questions().map((e) => e.kind)).toEqual(['setup_failed']);
    expect(questions()[0]?.question).toContain(
      'its dependencies were not installed in its folder (node exited with 3). This looks like a setup problem',
    );
    const details = JSON.parse(String(questions()[0]?.details_json)) as { evidence: string[] };
    expect(details.evidence.join('\n')).toContain('install: node -e');
    expect(details.evidence.join('\n')).toContain('registry unreachable');
    expect((await taskOf(td, taskId)).status).toBe('FAILED');
    // A second pass asks nothing more.
    await td.operator.post(P('/brain/run-once'), {});
    expect(questions()).toHaveLength(1);

    // What the failing check printed can be read.
    const check = verified.verification.checks.find((c) => c.name === 'tests');
    expect(check).toMatchObject({ status: 'FAILED', origin: 'configured' });
    const ref = String(check?.artifact_ref);
    expect(ref).toMatch(/^artifact:/);
    type Output = {
      artifact_ref: string;
      kind: string;
      text: string;
      lines: number;
      from_line: number;
      truncated: boolean;
    };
    const output = await td.operator.get<Output>(P(`/artifacts/${encodeURIComponent(ref)}`));
    expect(output).toMatchObject({ artifact_ref: ref, kind: 'verification', from_line: 1, truncated: false });
    expect(output.text).toContain('$ node -e');
    expect(output.text).toContain('ENOENT');
    // By its bare id too; nothing else is served from there, and only to the operator.
    expect((await td.operator.get<Output>(P(`/artifacts/${ref.slice('artifact:'.length)}`))).text).toBe(output.text);
    await expect(td.operator.get(P('/artifacts/nope'))).rejects.toThrow(/not kept/);
    await expect(td.operator.get(P(`/artifacts/${encodeURIComponent('../config.yaml')}`))).rejects.toThrow();
    await expect(td.bootstrap.get(td.bootstrap.projectPath(`/artifacts/${encodeURIComponent(ref)}`))).rejects.toThrow();

    // The install is run again as it stands: it fails the same way, and that is on record.
    type Setup = { setup: { status: string; reason: string; output_tail: string | null } };
    const again = await td.operator.post<Setup>(P(`/tasks/${taskId}/setup`), {}, { timeoutMs: 120_000 });
    expect(again.setup).toMatchObject({ status: 'failed', reason: 'node exited with 3' });
    expect(again.setup.output_tail).toContain('registry unreachable');
    // The person fixes what kept it from installing, and runs it again.
    mkdirSync(path.join(start.working_directory, 'node_modules'), { recursive: true });
    writeFileSync(path.join(start.working_directory, 'node_modules', '.allow'), '');
    const fixed = await td.operator.post<Setup>(P(`/tasks/${taskId}/setup`), {}, { timeoutMs: 120_000 });
    expect(fixed.setup).toMatchObject({ status: 'passed', reason: 'ok' });
    expect(readFileSync(path.join(start.working_directory, 'node_modules', '.friday-setup'), 'utf8')).toBe('ok');
    expect(td.daemon.state.latestWorktreeSetup(pid, taskId)?.setup.status).toBe('passed');
    // With the dependencies in place, a failure from here on is the work's.
    expect(td.daemon.state.worktreeSetupTrouble(pid, taskId)).toBeNull();

    // Sent back to its agent, the question is settled.
    await td.operator.post(P(`/tasks/${taskId}/rework`), { reason: 'the dependencies are installed now' });
    expect(questions()).toEqual([]);
    expect((await taskOf(td, taskId)).status).toBe('READY');
    // Not while an agent works there, and not for a task with no folder of its own.
    const loose = await td.operator.post<TaskView>(P('/tasks'), { summary: 'no folder yet', ready: true });
    await expect(td.operator.post(P(`/tasks/${loose.task_id}/setup`), {})).rejects.toThrow(/no folder of its own/);
  }, 180_000);

  it('leaves a failure of the work itself to the usual course, whatever the install did', async () => {
    const td = await startTestDaemon(ws(), {
      git: true,
      brain: { autoStart: false },
      extensions: [claudeCodeHooks()],
      extraConfig: declared(INSTALL),
    });
    const dir = ws().projectDir;
    const pid = td.project.project_id;
    const P = (p: string) => td.operator.projectPath(p);
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    await deterministicGit(dir, { startEpoch: 1_767_225_700 }).commitAll('source');
    expect((await cli(['--project', dir, 'policy', 'trust', '--yes'])).code).toBe(0);
    const fake = await FakeHarness.connect(td, { agentKey: 'be-1' });
    const { task, start } = await take(td, fake, 'be-1');
    await until(
      () => taskOf(td, task.task_id),
      (t) => t.status === 'RUNNING',
      'the task to run',
    );
    // The work breaks the task's scope: Friday's own check fails, and no check of the project ran.
    mkdirSync(path.join(start.working_directory, 'docs'), { recursive: true });
    writeFileSync(path.join(start.working_directory, 'docs', 'x.md'), 'outside\n');
    await fake.client.reportResult({
      task_id: task.task_id,
      run_id: start.run_id,
      status: 'completed_claim',
      summary: 'wrote docs',
      changed_paths: ['docs/x.md'],
      checks: [],
    });
    await fake.close();
    const verified = await td.operator.post<{ task: TaskView; verification: { summary: string } }>(
      P(`/tasks/${task.task_id}/verify`),
      {},
      { timeoutMs: 120_000 },
    );
    expect(verified.task.status).toBe('FAILED');
    expect(verified.verification.summary).not.toContain('dependencies were not installed');
    expect(td.daemon.state.latestWorktreeSetup(pid, task.task_id)?.setup.status).toBe('failed');
    expect(td.daemon.state.worktreeSetupTrouble(pid, task.task_id)).toBeNull();
  }, 180_000);
});
