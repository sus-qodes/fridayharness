/**
 * A backup restored into another clone of the project (review F08): the restored clone works only
 * in its own checkouts. It never reuses, resets or verifies the worktree of the clone the database
 * came from, and it never starts a task over on its own when the task's work is only there.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createDaemon, type Daemon } from '@friday/daemon';
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

/** A check that leaves a trace where it ran. */
const CHECKS =
  "  checks:\n    - name: trace\n      command: node\n      args: [\"-e\", \"require('fs').writeFileSync('checked.txt', 'checked here')\"]\n";

/** A spawn agent claims a chore done in its worktree; the task waits to be verified. */
async function claimDone(td: TestDaemon, agentKey: string) {
  const fake = await FakeHarness.connect(td, { agentKey, role: 'qa' });
  const t = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
    summary: 'tidy',
    kind: 'chore',
    scope: { write: ['tidy/**'], read: [] },
    ready: true,
  });
  await td.operator.post(td.operator.projectPath(`/tasks/${t.task_id}/assign`), { agent_key: agentKey });
  const start = (await fake.waitFor('task.start', 30_000)).params as TaskStartParams;
  await eventually(
    () => td.daemon.state.q.task(td.project.project_id, t.task_id).status,
    (s) => s === 'RUNNING',
    'the chore to run',
  );
  mkdirSync(path.join(start.working_directory, 'tidy'), { recursive: true });
  writeFileSync(path.join(start.working_directory, 'tidy', 'done.txt'), 'tidy\n');
  await fake.client.reportResult({
    task_id: t.task_id,
    run_id: start.run_id,
    status: 'completed_claim',
    summary: 'tidied',
    changed_paths: ['tidy/done.txt'],
    checks: [],
  });
  await fake.close();
  return { task_id: t.task_id, dir: start.working_directory };
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

describe('a backup restored into another clone (review F08)', () => {
  it('works only in its own checkouts and asks a human when a task’s work is in the other clone', async () => {
    // Clone A: a task works in its worktree, with a commit on its branch and uncommitted work.
    const a = await startTestDaemon(ws(), {
      git: true,
      brain: false,
      editConfig: (y) => y.replace('  checks: []\n', CHECKS),
    });
    const A = ws().projectDir;
    const pid = a.project.project_id;
    // Another task, claimed done in A and waiting to be verified when the backup is taken.
    const claimed = await claimDone(a, 'qa-1');
    const fakeA = await FakeHarness.connect(a, { agentKey: 'be-1', role: 'backend' });
    const task = await a.operator.post<TaskView>(a.operator.projectPath('/tasks'), {
      summary: 'write notes',
      kind: 'chore',
      scope: { write: ['notes/**'], read: [] },
      ready: true,
    });
    const id = task.task_id;
    await a.operator.post(a.operator.projectPath(`/tasks/${id}/assign`), { agent_key: 'be-1' });
    const wa = ((await fakeA.waitFor('task.start', 30_000)).params as TaskStartParams).working_directory;
    mkdirSync(path.join(wa, 'notes'), { recursive: true });
    writeFileSync(path.join(wa, 'notes', 'committed.txt'), 'committed in A\n');
    await deterministicGit(wa, { startEpoch: 1_767_225_800 }).commitAll('committed work of the task');
    writeFileSync(path.join(wa, 'notes', 'marker.txt'), 'only in A\n');
    const headA = (await deterministicGit(wa).run(['rev-parse', 'HEAD'])).trim();

    const backup = path.join(ws().root, 'backup');
    expect((await cli(['--project', A, 'backup', '--into', backup])).code).toBe(0);
    // A backup made before backups held code (format 1): the task's work stays only in clone A.
    // With the code, the restored clone has it too (review F16, backup-code.test.ts).
    const manifestFile = path.join(backup, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    manifest.format_version = 1;
    manifest.files = manifest.files.filter((f: string) => f !== 'code.bundle');
    delete manifest.code;
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    rmSync(path.join(backup, 'code.bundle'));
    await fakeA.close();
    await a.daemon.close('moving to another clone');

    // Clone B: the repository cloned as on another machine, and the backup restored into it.
    const B = path.join(ws().root, 'b');
    await deterministicGit(ws().root).run(['clone', '-q', A, B]);
    expect((await cli(['--project', B, 'restore', '--from', backup])).code).toBe(0);
    const daemonB = await createDaemon({
      projectRoot: B,
      stateDir: ws().stateDir,
      tickMs: 0,
      pollIntervalMs: 25,
      logToFile: true,
      brain: false,
    });
    ws().track({ close: () => daemonB.close('test cleanup') });
    const b = wrap(daemonB);

    // 1. The project lives in B now: new runs in its main checkout work in B.
    expect(same(daemonB.state.q.project(pid)?.root_path ?? '', realpathSync(B))).toBe(true);

    // The task claimed done in A worked in A's checkout: B does not judge it there.
    const v = await b.operator.post<{ task: TaskView; verification: { summary: string | null } }>(
      b.operator.projectPath(`/tasks/${claimed.task_id}/verify`),
      {},
      { timeoutMs: 120_000 },
    );
    expect(v.task.status).toBe('READY_FOR_VERIFICATION');
    expect(v.verification.summary).toContain('belongs to another clone of the project');
    expect(existsSync(path.join(claimed.dir, 'checked.txt'))).toBe(false);

    // 2. A new agent in B gets the task: its recorded worktree is A's. Nothing is prepared, and a
    // human is asked; A's checkout is not touched.
    const fakeB = await FakeHarness.connect(b, { agentKey: 'be-2', role: 'backend' });
    await b.operator.post(b.operator.projectPath(`/tasks/${id}/release`), { reason: 'its session was in clone A' });
    await b.operator.post(b.operator.projectPath(`/tasks/${id}/assign`), { agent_key: 'be-2' });
    const asked = await eventually(
      () =>
        daemonB.state.q.escalations(pid, 'pending').find((e) => e.task_id === id && e.kind === 'recovery_needed') as
          | { question?: string }
          | undefined,
      (e) => e !== undefined,
      'a human to be asked',
    );
    expect(asked?.question).toContain('belongs to another clone of the project');
    expect(asked?.question).toContain(`has no branch friday/${id}`);
    await eventually(
      () => daemonB.state.q.task(pid, id).status,
      (s) => s === 'READY',
      'the run to be declined',
    );
    expect(fakeB.received.filter((m) => m.method === 'task.start')).toEqual([]);
    expect(text(path.join(wa, 'notes', 'marker.txt'))).toBe('only in A\n');

    // 3. Continuing needs the task's branch in this clone.
    await expect(daemonB.recovery.perform(id, 'reassign', human)).rejects.toThrow(/fetch it/);

    // 4. A human fetches the branch from A and continues from it, in a worktree of B.
    await deterministicGit(B).run(['fetch', '-q', A, `friday/${id}:friday/${id}`]);
    await daemonB.recovery.perform(id, 'reassign', human, 'continue in clone B');
    expect(daemonB.state.q.escalations(pid, 'pending').filter((e) => e.task_id === id)).toEqual([]);
    await b.operator.post(b.operator.projectPath(`/tasks/${id}/assign`), { agent_key: 'be-2' });
    const wb = (
      (await fakeB.waitFor('task.start', 30_000, (m) => (m.params as TaskStartParams).task_id === id))
        .params as TaskStartParams
    ).working_directory;
    expect(same(wb, wa)).toBe(false);
    expect(daemonB.state.inThisClone(wb)).toBe(true);
    expect(text(path.join(wb, 'notes', 'committed.txt'))).toBe('committed in A\n');
    expect(existsSync(path.join(wb, 'notes', 'marker.txt'))).toBe(false);

    // A's checkout is exactly as A left it.
    expect(text(path.join(wa, 'notes', 'marker.txt'))).toBe('only in A\n');
    expect((await deterministicGit(wa).run(['rev-parse', 'HEAD'])).trim()).toBe(headA);
    expect(await deterministicGit(wa).run(['status', '--porcelain'])).toContain('notes/');
  }, 120_000);
});
