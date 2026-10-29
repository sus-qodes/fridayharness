/**
 * Revision-bound verification through the daemon (plan M5b, ADR-0024).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createDaemon } from '@friday/daemon';
import { GitRoot } from '@friday/git';
import type { Actor, TaskStartParams, TaskView, VerificationView } from '@friday/protocol';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const human: Actor = { kind: 'human', id: 'test' };

/** Tests for implementation work, related tests first; a chore check that edits the checkout it checks. */
const CHECKS = [
  '  checks:',
  '    - name: tests',
  '      command: node',
  '      args: ["--test", "test/*.test.mjs"]',
  '      task_kinds: [implementation]',
  '      targeted_args: ["--test", "{files}"]',
  '    - name: touch',
  '      command: node',
  `      args: ["-e", "require('fs').writeFileSync('src/late.mjs', 'export {};')"]`,
  '      task_kinds: [chore]',
  '',
].join('\n');
const editConfig = (yaml: string) => {
  if (!yaml.includes('  checks: []\n')) throw new Error('the config template changed: update this test');
  return yaml.replace('  checks: []\n', CHECKS);
};

const testFile = (name: string) =>
  [
    "import assert from 'node:assert';",
    "import { test } from 'node:test';",
    `import { ${name} } from '../src/${name}.mjs';`,
    `test('${name} is positive', () => assert.ok(${name} > 0));`,
    '',
  ].join('\n');

async function project(): Promise<TestDaemon> {
  const td = await startTestDaemon(ws(), { git: true, editConfig });
  const dir = ws().projectDir;
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  mkdirSync(path.join(dir, 'test'), { recursive: true });
  for (const name of ['shared', 'other']) {
    writeFileSync(path.join(dir, 'src', `${name}.mjs`), `export const ${name} = 1;\n`);
    writeFileSync(path.join(dir, 'test', `${name}.test.mjs`), testFile(name));
  }
  await deterministicGit(dir, { startEpoch: 1_767_225_700 }).commitAll('sources and tests');
  return td;
}

async function eventually<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const taskOf = (td: TestDaemon, id: string) =>
  td.operator.get<{ task: TaskView }>(td.operator.projectPath(`/tasks/${id}`)).then((r) => r.task);

/** A spawn agent works on a task in its worktree, writes `files` there and claims completion. */
async function claimWork(
  td: TestDaemon,
  o: { agent: string; kind?: string; write?: string[]; files: Record<string, string>; claim?: string[] },
) {
  const fake = await FakeHarness.connect(td, { agentKey: o.agent });
  const task = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
    summary: `work of ${o.agent}`,
    kind: o.kind ?? 'implementation',
    scope: { write: o.write ?? ['src/**'], read: [] },
    ready: true,
  });
  await td.operator.post(td.operator.projectPath(`/tasks/${task.task_id}/assign`), { agent_key: o.agent });
  const start = (await fake.waitFor('task.start', 20_000)).params as TaskStartParams;
  await eventually(
    () => taskOf(td, task.task_id),
    (t) => t.status === 'RUNNING',
    `${o.agent}'s task to run`,
  );
  for (const [rel, text] of Object.entries(o.files)) {
    mkdirSync(path.dirname(path.join(start.working_directory, rel)), { recursive: true });
    writeFileSync(path.join(start.working_directory, rel), text);
  }
  await fake.client.reportResult({
    task_id: task.task_id,
    run_id: start.run_id,
    status: 'completed_claim',
    summary: 'done',
    changed_paths: o.claim ?? Object.keys(o.files),
    checks: [],
  });
  return { task, start, fake };
}

const verify = (td: TestDaemon, taskId: string) =>
  td.operator.post<{ task: TaskView; verification: VerificationView }>(
    td.operator.projectPath(`/tasks/${taskId}/verify`),
    {},
    { timeoutMs: 120_000 },
  );

describe('verification at a recorded revision of the task checkout', () => {
  it('verifies each task in its own worktree, related tests first, and says what it verified', async () => {
    const td = await project();
    const good = await claimWork(td, { agent: 'be-1', files: { 'src/shared.mjs': 'export const shared = 2;\n' } });
    const bad = await claimWork(td, { agent: 'fe-1', files: { 'src/shared.mjs': 'export const shared = -1;\n' } });

    const passed = await verify(td, good.task.task_id);
    expect(passed.task.status).toBe('COMPLETED');
    expect(passed.verification).toMatchObject({
      status: 'PASSED',
      execution_root: good.start.working_directory,
      task_kind: 'implementation',
    });
    expect(passed.verification.source_version).toMatch(/^[0-9a-f]{40}\+[0-9a-f]{12}$/);
    expect(passed.verification.checks.map((c) => [c.name, c.status, c.origin])).toEqual([
      ['friday.diff', 'PASSED', 'friday'],
      ['friday.secrets', 'PASSED', 'friday'],
      ['tests (targeted)', 'PASSED', 'targeted'],
      ['tests', 'PASSED', 'configured'],
    ]);
    expect(passed.verification.checks[2]?.details?.files).toEqual(['test/shared.test.mjs']);
    expect(passed.verification.checks[0]?.details?.findings?.map((f) => f.rule)).toEqual(['diff.uncommitted']);

    // The same test file, run in the other checkout, sees the other contents; the full run is skipped.
    const failed = await verify(td, bad.task.task_id);
    expect(failed.task.status).toBe('FAILED');
    expect(failed.verification.execution_root).toBe(bad.start.working_directory);
    expect(failed.verification.checks.map((c) => [c.name, c.status])).toEqual([
      ['friday.diff', 'PASSED'],
      ['friday.secrets', 'PASSED'],
      ['tests (targeted)', 'FAILED'],
    ]);

    const shown = await cli(['--project', ws().projectDir, 'task', 'inspect', good.task.task_id]);
    expect(shown.stdout).toContain(`in ${good.start.working_directory}`);
    expect(shown.stdout).toContain('tests (targeted): PASSED');
  });

  it('fails changes outside the scope and credentials in the code, without recording the credential', async () => {
    const td = await project();
    const aws = `AKIA${'Q'.repeat(16)}`;
    const leaked = await claimWork(td, {
      agent: 'be-1',
      files: { 'src/config.mjs': `export const key = '${aws}';\n`, 'infra/deploy.json': '{}\n' },
      claim: ['src/config.mjs'],
    });
    const v = await verify(td, leaked.task.task_id);
    expect(v.task.status).toBe('FAILED');
    const diff = v.verification.checks.find((c) => c.name === 'friday.diff');
    expect(diff?.status).toBe('FAILED');
    expect(diff?.details?.findings?.map((f) => [f.rule, f.severity, f.paths])).toEqual(
      expect.arrayContaining([
        ['diff.outside_scope', 'fail', ['infra/deploy.json']],
        ['diff.unclaimed', 'warn', ['infra/deploy.json']],
        ['tests.none_related', 'warn', ['src/config.mjs']],
      ]),
    );
    const secrets = v.verification.checks.find((c) => c.name === 'friday.secrets');
    expect(secrets?.status).toBe('FAILED');
    expect(secrets?.details?.findings?.[0]?.message).toContain('src/config.mjs:1 (aws_key)');
    const log = JSON.stringify(td.daemon.state.store.readSince(td.project.project_id, 0));
    expect(log).not.toContain(aws);

    // A docs task that no configured check applies to is judged by Friday's own checks.
    const docs = await claimWork(td, {
      agent: 'docs-1',
      kind: 'docs',
      write: ['docs/**'],
      files: { 'docs/guide.md': '# Guide\n' },
    });
    const d = await verify(td, docs.task.task_id);
    expect(d.task.status).toBe('COMPLETED');
    expect(d.verification.checks.map((c) => c.name)).toEqual(['friday.diff', 'friday.secrets']);
    expect(d.verification.summary).toContain('no configured check applies to docs tasks');
  });

  it('judges nothing when the code changes during verification, or when the daemon stops mid-way', async () => {
    const td = await project();
    const chore = await claimWork(td, {
      agent: 'ops-1',
      kind: 'chore',
      files: { 'src/other.mjs': 'export const other = 3;\n' },
    });
    const moved = await verify(td, chore.task.task_id);
    expect(moved.task.status).toBe('READY_FOR_VERIFICATION');
    expect(moved.verification.status).toBe('CANCELLED');
    expect(moved.verification.summary).toContain('interrupted: the code changed while it was verified');
    // Verified again, the check finds the file it writes already there: the revision holds.
    expect((await verify(td, chore.task.task_id)).task.status).toBe('COMPLETED');

    // A verification in flight when the daemon stops is ended at the next start.
    const other = await claimWork(td, { agent: 'be-9', files: { 'src/shared.mjs': 'export const shared = 5;\n' } });
    const pid = td.project.project_id;
    const started = td.daemon.state.startVerification(pid, human, other.task.task_id, {});
    await other.fake.close();
    await chore.fake.close();
    await td.daemon.close('test restart');
    const again = await createDaemon({
      projectRoot: ws().projectDir,
      stateDir: ws().stateDir,
      tickMs: 0,
      pollIntervalMs: 25,
      logToFile: true,
    });
    ws().track({ close: () => again.close('test cleanup') });
    expect(again.state.q.task(pid, other.task.task_id).status).toBe('READY_FOR_VERIFICATION');
    expect(again.state.q.verification(started.verification_id)).toMatchObject({
      status: 'CANCELLED',
      summary: 'interrupted: the daemon stopped while its checks ran',
    });
  });

  it('judges nothing when git cannot read the task checkout, before or after the checks (review F05)', async () => {
    const td = await project();
    const w = await claimWork(td, { agent: 'be-1', files: { 'src/shared.mjs': 'export const shared = 2;\n' } });
    // Before the checks: what the task changed cannot be read.
    const before = vi
      .spyOn(GitRoot.prototype, 'changesSince')
      .mockRejectedValueOnce(new Error('simulated: git could not read the index'));
    try {
      const v = await verify(td, w.task.task_id);
      expect(v.task.status).toBe('READY_FOR_VERIFICATION');
      expect(v.verification).toMatchObject({ status: 'CANCELLED' });
      expect(v.verification.summary).toContain('simulated: git could not read the index');
    } finally {
      before.mockRestore();
    }
    // After the checks: whether the code stayed the same cannot be read.
    const identity = GitRoot.prototype.identity;
    let calls = 0;
    const after = vi.spyOn(GitRoot.prototype, 'identity').mockImplementation(async function (
      this: GitRoot,
      ...args: Parameters<GitRoot['identity']>
    ) {
      calls += 1;
      if (calls > 1) throw new Error('simulated: git stopped answering');
      return identity.apply(this, args);
    });
    try {
      const v = await verify(td, w.task.task_id);
      expect(v.task.status).toBe('READY_FOR_VERIFICATION');
      expect(v.verification).toMatchObject({ status: 'CANCELLED' });
      expect(v.verification.summary).toContain('simulated: git stopped answering');
    } finally {
      after.mockRestore();
    }
    // A base commit the repository does not have: the task's commits cannot be judged against it.
    const realBase = td.daemon.state.q.findRun(w.start.run_id)?.base_commit;
    expect(realBase).toMatch(/^[0-9a-f]{40}$/);
    td.daemon.state.db
      .prepare('UPDATE task_runs SET base_commit = ? WHERE run_id = ?')
      .run('0'.repeat(40), w.start.run_id);
    const lost = await verify(td, w.task.task_id);
    expect(lost.task.status).toBe('READY_FOR_VERIFICATION');
    expect(lost.verification.summary).toContain(`base commit ${'0'.repeat(40)} is not in this repository`);
    td.daemon.state.db.prepare('UPDATE task_runs SET base_commit = ? WHERE run_id = ?').run(realBase, w.start.run_id);

    // Readable again: verified, at a revision known by its content and its exact tree.
    const ok = await verify(td, w.task.task_id);
    expect(ok.task.status).toBe('COMPLETED');
    expect(ok.verification.source_version).toMatch(/^[0-9a-f]{40}\+[0-9a-f]{12}$/);
    expect(ok.verification.tree).toMatch(/^[0-9a-f]{40}$/);
  });
});
