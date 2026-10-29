/**
 * What a backup preserves after M5 (review F16): restored into a clean clone after the original
 * clone and its task worktrees are gone, a backup brings back a task's committed, uncommitted and
 * preserved work, or Friday says the work is missing instead of starting a new branch as if it
 * were the work. The same clone never starts a task over silently when its branch is gone.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createDaemon, type Daemon } from '@friday/daemon';
import { runGit } from '@friday/git';
import type { Actor, TaskStartParams, TaskView } from '@friday/protocol';
import { DaemonClient } from '@friday/sdk';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli } from '../helpers/cli.js';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { FakeHarness } from '../helpers/fake-harness.js';

const ws = useTestWorkspace();
const human: Actor = { kind: 'human', id: 'local-operator' };
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FRIDAY_STATE_DIR;
  process.env.FRIDAY_STATE_DIR = ws().stateDir;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = saved;
});

const same = (a: string, b: string) =>
  process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : a === b;
const text = (f: string) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

async function eventually<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${String(JSON.stringify(v)).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A daemon started on another folder, wrapped like `startTestDaemon` wraps its own. */
function wrap(daemon: Daemon): TestDaemon {
  const base = { baseUrl: daemon.url, projectId: daemon.project.project_id };
  return {
    daemon,
    url: daemon.url,
    project: daemon.project,
    operator: new DaemonClient({ ...base, token: daemon.tokens.operator, tokenClass: 'operator' }),
    bootstrap: new DaemonClient({ ...base, token: daemon.tokens.bootstrap, tokenClass: 'bootstrap' }),
    ws: ws(),
  };
}

/**
 * Commits the task's notes only. Friday checked the worktree out with this machine's line endings,
 * so staging everything with the test's git settings would also rewrite every other file.
 */
async function commitNotes(dir: string, message: string) {
  const g = deterministicGit(dir, { startEpoch: 1_767_225_800 });
  await g.run(['add', 'notes']);
  await g.run(['commit', '-q', '--no-verify', '-m', message]);
}

const startOf = async (fake: FakeHarness, taskId: string, not?: string) =>
  (
    await fake.waitFor('task.start', 30_000, (m) => {
      const p = m.params as TaskStartParams;
      return p.task_id === taskId && p.run_id !== not;
    })
  ).params as TaskStartParams;

/**
 * Clone A with a remote holding its main branch, and a task whose work is in three places: a
 * commit on its branch, a preserved state of its first attempt, and uncommitted work of the second.
 */
async function cloneWithWork() {
  const a = await startTestDaemon(ws(), {
    git: true,
    brain: false,
    editConfig: (y) =>
      y.replace(
        '  checks: []\n',
        '  checks:\n    - name: notes\n      command: node\n      args: ["-e", "require(\'fs\').readFileSync(\'notes/committed.txt\')"]\n',
      ),
  });
  const A = ws().projectDir;
  const pid = a.project.project_id;
  const remote = path.join(ws().root, 'remote.git');
  await deterministicGit(ws().root).run(['init', '-q', '--bare', remote]);
  await deterministicGit(A).run(['push', '-q', remote, 'HEAD:refs/heads/main']);
  const init = (await deterministicGit(A).run(['rev-parse', 'HEAD'])).trim();

  const fake = await FakeHarness.connect(a, { agentKey: 'be-1', role: 'backend' });
  const task = await a.operator.post<TaskView>(a.operator.projectPath('/tasks'), {
    summary: 'write notes',
    kind: 'chore',
    scope: { write: ['notes/**'], read: [] },
    ready: true,
  });
  const id = task.task_id;
  await a.operator.post(a.operator.projectPath(`/tasks/${id}/assign`), { agent_key: 'be-1' });
  const first = await startOf(fake, id);
  const wa = first.working_directory;
  mkdirSync(path.join(wa, 'notes'), { recursive: true });
  writeFileSync(path.join(wa, 'notes', 'committed.txt'), 'committed in A\n');
  await commitNotes(wa, 'committed work of the task');
  const branchHead = (await deterministicGit(wa).run(['rev-parse', 'HEAD'])).trim();
  writeFileSync(path.join(wa, 'notes', 'first.txt'), 'attempt 1, not committed\n');
  // The first attempt starts over: its uncommitted work is preserved (ADR-0026 §3).
  const restart = await a.daemon.recovery.perform(id, 'restart', human, 'start the attempt again');
  expect(restart.preserved_ref).toBe(`refs/friday/preserved/${id}/attempt-1`);
  await a.operator.post(a.operator.projectPath(`/tasks/${id}/assign`), { agent_key: 'be-1' });
  const second = await startOf(fake, id, first.run_id);
  expect(same(second.working_directory, wa)).toBe(true);
  writeFileSync(path.join(wa, 'notes', 'second.txt'), 'attempt 2, not committed\n');
  return { a, A, pid, id, wa, remote, init, branchHead, fake };
}

/** The disk of clone A is lost: its main checkout, its git repository and its task worktrees. */
async function loseClone(c: { a: TestDaemon; A: string; wa: string; fake: FakeHarness }) {
  await c.fake.close();
  await c.a.daemon.close('the disk is lost');
  rmSync(c.wa, { recursive: true, force: true });
  rmSync(c.A, { recursive: true, force: true });
  expect(existsSync(c.A)).toBe(false);
}

/** A clean clone of the remote, with the backup restored into it and Friday started there. */
async function restoreInto(remote: string, backup: string) {
  const B = path.join(ws().root, 'b');
  await deterministicGit(ws().root).run(['clone', '-q', remote, B]);
  const restored = await cli(['--project', B, '--json', 'restore', '--from', backup]);
  expect(restored.code, restored.stderr).toBe(0);
  const daemon = await createDaemon({
    projectRoot: B,
    stateDir: ws().stateDir,
    tickMs: 0,
    pollIntervalMs: 25,
    logToFile: true,
    brain: false,
  });
  ws().track({ close: () => daemon.close('test cleanup') });
  return { B, report: JSON.parse(restored.stdout), b: wrap(daemon), daemon };
}

describe('a backup restored after the original clone is gone (review F16)', () => {
  it('brings back the committed, uncommitted and preserved work of a task', async () => {
    const c = await cloneWithWork();
    const backup = path.join(ws().root, 'backup');
    const made = await cli(['--project', c.A, '--json', 'backup', '--into', backup]);
    expect(made.code, made.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(path.join(backup, 'manifest.json'), 'utf8'));
    expect(manifest.code).toMatchObject({ included: true, bundle: 'code.bundle' });
    expect(manifest.code.refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: `refs/heads/friday/${c.id}`, kind: 'task_branch', task_id: c.id }),
        expect.objectContaining({ ref: `refs/friday/preserved/${c.id}/attempt-1`, kind: 'preserved' }),
        expect.objectContaining({ ref: `refs/friday/backup/${c.id}`, kind: 'uncommitted', task_id: c.id }),
      ]),
    );
    // The names used while writing the bundle are gone again from clone A.
    expect(await deterministicGit(c.A).run(['for-each-ref', 'refs/friday/backup/'])).toBe('');
    await loseClone(c);

    const { B, report, b, daemon } = await restoreInto(c.remote, backup);
    expect(report.code.included).toBe(true);
    expect(report.code.uncommitted).toEqual([{ task_id: c.id, ref: `refs/friday/restored/${c.id}` }]);
    const g = deterministicGit(B);
    expect((await g.run(['rev-parse', `refs/heads/friday/${c.id}`])).trim()).toBe(c.branchHead);
    expect(await g.run(['show', `refs/friday/preserved/${c.id}/attempt-1:notes/first.txt`])).toBe(
      'attempt 1, not committed',
    );
    expect(await g.run(['show', `refs/friday/restored/${c.id}:notes/second.txt`])).toBe('attempt 2, not committed');

    // The task's attempt was in clone A; a human brings its work into a worktree of this clone.
    await b.operator.post(b.operator.projectPath(`/tasks/${c.id}/release`), { reason: 'its session was in clone A' });
    const before = await daemon.recovery.assess(c.id);
    expect(before.worktree).toMatchObject({ elsewhere: true, restored_here: expect.any(String) });
    expect(before.missing_code).toBeNull();
    expect(before.options.find((o) => o.action === 'reassign')).toMatchObject({
      available: true,
      reason: expect.stringContaining('with the uncommitted work a backup recorded'),
    });
    const done = await daemon.recovery.perform(c.id, 'reassign', human, 'continue in clone B');
    expect(done.preserved_ref).toBe(`refs/friday/preserved/${c.id}/restored`);
    expect(await g.run(['for-each-ref', 'refs/friday/restored/'])).toBe('');

    const wt = daemon.state.q.worktreeForTask(c.id);
    expect(wt && daemon.state.inThisClone(wt.path)).toBe(true);
    const wb = wt?.path as string;
    expect(text(path.join(wb, 'notes', 'committed.txt'))).toBe('committed in A\n');
    expect(text(path.join(wb, 'notes', 'second.txt'))).toBe('attempt 2, not committed\n');
    expect(existsSync(path.join(wb, 'notes', 'first.txt'))).toBe(false);
    // Friday checked the worktree out with this machine's git configuration (line endings included).
    expect((await runGit(wb, ['status', '--porcelain'])).stdout.trim()).toBe('?? notes/second.txt');
    // Verification judges every change of the task since the commit its branch started from.
    expect(wt?.base_commit).toBe(c.init);

    // The next attempt works there, and its work is verified there.
    const fake = await FakeHarness.connect(b, { agentKey: 'be-2', role: 'backend' });
    await b.operator.post(b.operator.projectPath(`/tasks/${c.id}/assign`), { agent_key: 'be-2' });
    const start = await startOf(fake, c.id);
    expect(same(start.working_directory, wb)).toBe(true);
    await fake.client.reportResult({
      task_id: c.id,
      run_id: start.run_id,
      status: 'completed_claim',
      summary: 'notes written',
      changed_paths: ['notes/committed.txt', 'notes/second.txt'],
      checks: [],
    });
    const v = await b.operator.post<{ task: TaskView }>(
      b.operator.projectPath(`/tasks/${c.id}/verify`),
      {},
      { timeoutMs: 120_000 },
    );
    expect(v.task.status, JSON.stringify(v).slice(0, 3000)).toBe('COMPLETED');
    await fake.close();
  }, 180_000);

  it('says the work is missing when the backup holds no code, and starts over only when a human says so', async () => {
    const c = await cloneWithWork();
    const backup = path.join(ws().root, 'backup');
    expect((await cli(['--project', c.A, 'backup', '--into', backup])).code).toBe(0);
    // A backup made before backups held code (format 1).
    const file = path.join(backup, 'manifest.json');
    const m = JSON.parse(readFileSync(file, 'utf8'));
    m.format_version = 1;
    m.files = m.files.filter((f: string) => f !== 'code.bundle');
    delete m.code;
    writeFileSync(file, JSON.stringify(m, null, 2));
    rmSync(path.join(backup, 'code.bundle'), { force: true });
    await loseClone(c);

    const { B, report, b, daemon } = await restoreInto(c.remote, backup);
    expect(report.code).toMatchObject({ included: false, reason: expect.stringContaining('format 1') });
    const pid = c.pid;

    // A new agent gets the task: nothing is prepared, no branch is made, and a human is told why.
    const fake = await FakeHarness.connect(b, { agentKey: 'be-2', role: 'backend' });
    await b.operator.post(b.operator.projectPath(`/tasks/${c.id}/release`), { reason: 'its session was in clone A' });
    await b.operator.post(b.operator.projectPath(`/tasks/${c.id}/assign`), { agent_key: 'be-2' });
    const asked = await eventually(
      () =>
        daemon.state.q.escalations(pid, 'pending').find((e) => e.task_id === c.id && e.kind === 'recovery_needed') as
          | { question?: string }
          | undefined,
      (e) => e !== undefined,
      'a human to be asked',
    );
    expect(asked?.question).toContain(`has no branch friday/${c.id}, so its work is not here`);
    expect(asked?.question).toContain('Restore a backup that holds the project');
    await eventually(
      () => daemon.state.q.task(pid, c.id).status,
      (s) => s === 'READY',
      'the run to be declined',
    );
    expect(fake.received.filter((m) => m.method === 'task.start')).toEqual([]);
    const g = deterministicGit(B);
    expect(await g.run(['branch', '--list', `friday/${c.id}`])).toBe('');
    const a = await daemon.recovery.assess(c.id);
    expect(a.missing_code).toContain(`friday/${c.id}, which this clone does not have`);
    await expect(daemon.recovery.perform(c.id, 'reassign', human)).rejects.toThrow(/restore a backup that holds it/);

    // A human starts the task over: from its base, never presented as the earlier work.
    expect(a.options.find((o) => o.action === 'restart')?.reason).toContain("without the earlier attempts' work");
    await daemon.recovery.perform(c.id, 'restart', human, 'the work is lost; start over');
    expect(daemon.state.q.escalations(pid, 'pending').filter((e) => e.task_id === c.id)).toEqual([]);
    expect((await g.run(['rev-parse', `refs/heads/friday/${c.id}`])).trim()).toBe(c.init);
    await b.operator.post(b.operator.projectPath(`/tasks/${c.id}/assign`), { agent_key: 'be-2' });
    const start = await startOf(fake, c.id);
    expect(daemon.state.inThisClone(start.working_directory)).toBe(true);
    expect(existsSync(path.join(start.working_directory, 'notes'))).toBe(false);
    await fake.close();
  }, 180_000);
});

describe('a task whose branch is gone (review F16)', () => {
  it('is not started over silently in the same clone', async () => {
    const a = await startTestDaemon(ws(), { git: true, brain: false });
    const pid = a.project.project_id;
    const fake = await FakeHarness.connect(a, { agentKey: 'be-1', role: 'backend' });
    const task = await a.operator.post<TaskView>(a.operator.projectPath('/tasks'), {
      summary: 'write notes',
      kind: 'chore',
      scope: { write: ['notes/**'], read: [] },
      ready: true,
    });
    const id = task.task_id;
    await a.operator.post(a.operator.projectPath(`/tasks/${id}/assign`), { agent_key: 'be-1' });
    const first = await startOf(fake, id);
    mkdirSync(path.join(first.working_directory, 'notes'), { recursive: true });
    writeFileSync(path.join(first.working_directory, 'notes', 'committed.txt'), 'committed\n');
    await commitNotes(first.working_directory, 'work of the task');
    await a.operator.post(a.operator.projectPath(`/tasks/${id}/release`), { reason: 'try again later' });
    // Someone removes the worktree and deletes the branch by hand.
    const g = deterministicGit(ws().projectDir);
    await g.run(['worktree', 'remove', '--force', first.working_directory]);
    await g.run(['branch', '-D', `friday/${id}`]);

    await a.operator.post(a.operator.projectPath(`/tasks/${id}/assign`), { agent_key: 'be-1' });
    const asked = await eventually(
      () =>
        a.daemon.state.q.escalations(pid, 'pending').find((e) => e.task_id === id && e.kind === 'recovery_needed') as
          | { question?: string }
          | undefined,
      (e) => e !== undefined,
      'a human to be asked',
    );
    expect(asked?.question).toContain(`earlier attempts worked on its branch friday/${id}`);
    await eventually(
      () => a.daemon.state.q.task(pid, id).status,
      (s) => s === 'READY',
      'the run to be declined',
    );
    expect(fake.received.filter((m) => m.method === 'task.start' && m.params.run_id !== first.run_id)).toEqual([]);
    expect(await g.run(['branch', '--list', `friday/${id}`])).toBe('');
    await fake.close();
  }, 120_000);
});
