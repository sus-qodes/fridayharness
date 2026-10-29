/**
 * Work restored into a clean clone continues from the state it was in (review M7.1 R05): a claim
 * waiting to be verified, a verification the backup caught midway, and a verified task whose
 * integration had failed. Each is brought into a worktree of this clone without changing its state,
 * then verified by its real checks and integrated into the goal branch there. A claim is brought
 * over only with the work it lists: without the backup's record of its uncommitted work, its branch
 * here must hold it, so verification never judges other code than the claim describes.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createDaemon, type Daemon } from '@friday/daemon';
import { restoredRef, runGit } from '@friday/git';
import type { IntegrationView, TaskStartParams, TaskView, VerificationView } from '@friday/protocol';
import { DaemonClient } from '@friday/sdk';
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

/** `a + b` may not exceed 3, unless a flag outside the repository says otherwise. */
const LIMIT = [
  "const fs = require('node:fs');",
  "const num = (f) => Number(/= (\\d+)/.exec(fs.readFileSync(f, 'utf8'))[1]);",
  "process.exit(num('src/a.mjs') + num('src/b.mjs') <= 3 || fs.existsSync(process.env.FLAG || '') ? 0 : 1);",
  '',
].join('\n');

async function eventually<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${String(JSON.stringify(v)).slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

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

const verify = (td: TestDaemon, id: string) =>
  td.operator.post<{ task: TaskView; verification: VerificationView }>(
    td.operator.projectPath(`/tasks/${id}/verify`),
    {},
    { timeoutMs: 120_000 },
  );
const integrationOf = (td: TestDaemon, id: string, not?: string) =>
  eventually(
    () => td.daemon.state.q.latestIntegration(td.project.project_id, id),
    (i): i is IntegrationView => i !== undefined && i.integration_id !== not,
    `the integration of ${id}`,
    60_000,
  ) as Promise<IntegrationView>;

/** An agent takes a task in its own worktree. */
async function begin(td: TestDaemon, agent: string, taskId: string) {
  const fake = await FakeHarness.connect(td, { agentKey: agent });
  await td.operator.post(td.operator.projectPath(`/tasks/${taskId}/assign`), { agent_key: agent });
  const start = (await fake.waitFor('task.start', 30_000, (m) => (m.params as TaskStartParams).task_id === taskId))
    .params as TaskStartParams;
  await eventually(
    () => td.daemon.state.q.task(td.project.project_id, taskId).status,
    (s) => s === 'RUNNING',
    `${taskId} to run`,
  );
  return { fake, start, taskId };
}

/** The agent writes `files` in its worktree (committing them with `commit`) and claims completion. */
async function claim(
  w: Awaited<ReturnType<typeof begin>>,
  files: Record<string, string>,
  opts: { commit?: boolean } = {},
) {
  const { fake, start, taskId } = w;
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(start.working_directory, rel)), { recursive: true });
    writeFileSync(path.join(start.working_directory, rel), body);
  }
  if (opts.commit) {
    // Only the files written: the worktree is checked out with this machine's line endings.
    const g = deterministicGit(start.working_directory, { startEpoch: 1_767_226_000 });
    await g.run(['add', '--', ...Object.keys(files)]);
    await g.run(['commit', '-q', '-m', 'the work, committed']);
  }
  await fake.client.reportResult({
    task_id: taskId,
    run_id: start.run_id,
    status: 'completed_claim',
    summary: `wrote ${Object.keys(files).join(', ')}`,
    changed_paths: Object.keys(files),
    checks: [],
  });
  await fake.close();
  return start;
}

describe('restored work continues where it was (review M7.1 R05)', () => {
  it('verifies and integrates a claim, an interrupted verification and a failed integration in a clean clone', async () => {
    const flag = path.join(ws().root, 'merged-ok').replace(/\\/g, '/');
    const checks = [
      '  checks:',
      '    - name: limit',
      '      command: node',
      '      args: ["scripts/limit.cjs"]',
      `      env: { FLAG: "${flag}" }`,
      '    - name: slow',
      '      command: node',
      '      args: ["-e", "setTimeout(() => {}, 4000)"]',
      '      task_kinds: [review]',
      '',
    ].join('\n');
    const td = await startTestDaemon(ws(), {
      git: true,
      brain: { autoStart: false },
      editConfig: (y) => y.replace('  checks: []\n', checks).replace(/provider: anthropic(\s+#)/, 'provider: none$1'),
    });
    const A = ws().projectDir;
    for (const [rel, body] of Object.entries({
      'src/a.mjs': 'export const a = 1;\n',
      'src/b.mjs': 'export const b = 1;\n',
      'scripts/limit.cjs': LIMIT,
    })) {
      mkdirSync(path.dirname(path.join(A, rel)), { recursive: true });
      writeFileSync(path.join(A, rel), body);
    }
    await deterministicGit(A, { startEpoch: 1_767_225_700 }).commitAll('sources and the limit check');
    const remote = path.join(ws().root, 'remote.git');
    await deterministicGit(ws().root).run(['init', '-q', '--bare', remote]);
    await deterministicGit(A).run(['push', '-q', remote, 'HEAD:refs/heads/main']);

    // A goal of four independent tasks, approved by a human.
    const op = td.operator;
    const goal = await op.post<{ goal_id: string }>(op.projectPath('/goals'), { request: 'Four changes', plan: false });
    const task = (key: string, kind: string, write: string) => ({
      key,
      kind,
      summary: `Change ${write}`,
      acceptance_criteria: ['the checks pass'],
      scope: { write: [write], read: ['**'] },
    });
    const v1 = await op.post<{ plan_id: string; version: number }>(op.projectPath(`/goals/${goal.goal_id}/plans`), {
      draft: {
        objective: 'Four changes',
        summary: 'Four independent changes',
        tasks: [
          task('api', 'implementation', 'src/a.mjs'),
          task('ui', 'implementation', 'src/b.mjs'),
          task('notes', 'chore', 'notes/**'),
          task('audit', 'review', 'audit/**'),
        ],
      },
    });
    await op.post(op.projectPath(`/plans/${v1.plan_id}/versions/${v1.version}/approve`), {});
    const detail = await op.get<{ active: { tasks: { key: string; task_id: string }[] } }>(
      op.projectPath(`/goals/${goal.goal_id}`),
    );
    const id = Object.fromEntries(detail.active.tasks.map((t) => [t.key, t.task_id])) as Record<string, string>;
    const branch = `friday/goal-${goal.goal_id}`;

    // All four start from the same base, in parallel.
    const wApi = await begin(td, 'be-1', id.api as string);
    const wUi = await begin(td, 'fe-1', id.ui as string);
    const wNotes = await begin(td, 'ch-1', id.notes as string);
    const wAudit = await begin(td, 'rv-1', id.audit as string);
    // api: verified and integrated. ui: verified alone, but its merge fails the limit (no flag yet).
    await claim(wApi, { 'src/a.mjs': 'export const a = 2;\n' });
    const va = await verify(td, id.api as string);
    expect(va.task.status, JSON.stringify(va.verification.checks).slice(0, 1500)).toBe('COMPLETED');
    expect((await integrationOf(td, id.api as string)).status).toBe('integrated');
    await claim(wUi, { 'src/b.mjs': 'export const b = 2;\n' });
    expect((await verify(td, id.ui as string)).task.status).toBe('COMPLETED');
    const failed = await integrationOf(td, id.ui as string);
    expect(failed.status).toBe('failed');
    // notes: claimed, waiting to be verified. audit: claimed, and being verified when the backup is taken.
    await claim(wNotes, { 'notes/x.md': '# Notes\n' });
    await claim(wAudit, { 'audit/r.md': '# Audit\n' });
    const auditing = verify(td, id.audit as string).catch(() => undefined);
    await eventually(
      () => td.daemon.state.q.latestVerification(id.audit as string)?.status,
      (s) => s === 'RUNNING',
      'the audit to be verified',
    );
    const backup = path.join(ws().root, 'backup');
    const made = await cli(['--project', A, 'backup', '--into', backup]);
    expect(made.code, made.stderr).toBe(0);

    // The disk of clone A is lost.
    const worktrees = path.join(path.dirname(ws().stateDir), 'friday-worktrees');
    // (What clone A does after the backup is lost with it; its check finishes first, so its files can go.)
    await auditing;
    await td.daemon.close('the disk is lost');
    rmSync(worktrees, { recursive: true, force: true });
    rmSync(A, { recursive: true, force: true });

    // A clean clone of the team's remote, the backup restored, Friday started there.
    const B = path.join(ws().root, 'b');
    await deterministicGit(ws().root).run(['clone', '-q', remote, B]);
    const restored = await cli(['--project', B, 'restore', '--from', backup]);
    expect(restored.code, restored.stderr).toBe(0);
    const daemon = await createDaemon({
      projectRoot: B,
      stateDir: ws().stateDir,
      tickMs: 0,
      pollIntervalMs: 25,
      logToFile: true,
      brain: { autoStart: false },
    });
    ws().track({ close: () => daemon.close('test cleanup') });
    const b = wrap(daemon);
    const pid = b.project.project_id;
    const status = (t: string) => daemon.state.q.task(pid, t).status;
    // The verification caught midway judged nothing: the claim waits, like the other one.
    expect([status(id.notes as string), status(id.audit as string), status(id.ui as string)]).toEqual([
      'READY_FOR_VERIFICATION',
      'READY_FOR_VERIFICATION',
      'COMPLETED',
    ]);

    // Their work was in clone A: a human brings it into this clone, keeping each task's state.
    for (const t of [id.notes, id.audit, id.ui] as string[]) {
      const a = await daemon.recovery.assess(t);
      expect(a.options.find((o) => o.action === 'rebind')).toMatchObject({ available: true });
      const r = await cli(['--project', B, 'recover', t, '--action', 'rebind', '--reason', 'continue here']);
      expect(r.code, r.stderr).toBe(0);
      const wt = daemon.state.q.worktreeForTask(t);
      expect(wt && daemon.state.inThisClone(wt.path)).toBe(true);
    }
    expect([status(id.notes as string), status(id.audit as string), status(id.ui as string)]).toEqual([
      'READY_FOR_VERIFICATION',
      'READY_FOR_VERIFICATION',
      'COMPLETED',
    ]);
    const tree = (t: string) => daemon.state.q.worktreeForTask(t)?.path as string;
    expect(existsSync(path.join(tree(id.notes as string), 'notes', 'x.md'))).toBe(true);
    expect(existsSync(path.join(tree(id.audit as string), 'audit', 'r.md'))).toBe(true);

    // The claims are verified here by their real checks, and integrated.
    for (const t of [id.notes, id.audit] as string[]) {
      const v = await verify(b, t);
      expect(v.task.status, JSON.stringify(v.verification.checks)).toBe('COMPLETED');
      expect(v.verification.execution_root).toBe(tree(t));
      expect((await integrationOf(b, t)).status).toBe('integrated');
    }
    // The failed integration is retried here once its cause is gone, from the same verified commit.
    writeFileSync(flag, 'ok');
    const retried = await b.operator
      .post<{ integration: IntegrationView }>(
        b.operator.projectPath(`/tasks/${id.ui}/integrate`),
        {},
        {
          timeoutMs: 120_000,
        },
      )
      .then((r) => r.integration);
    expect(retried).toMatchObject({ status: 'integrated', task_commit: failed.task_commit });

    await b.operator.post(b.operator.projectPath('/brain/run-once'), {});
    await eventually(
      () => b.operator.get<{ goal: { status: string } }>(b.operator.projectPath(`/goals/${goal.goal_id}`)),
      (d) => d.goal.status === 'COMPLETED',
      'the goal to complete in the restored clone',
    );
    const show = async (p: string) =>
      (await runGit(B, ['show', `${branch}:${p}`])).stdout.replace(/\r\n/g, '\n').trim();
    expect(await show('src/a.mjs')).toBe('export const a = 2;');
    expect(await show('src/b.mjs')).toBe('export const b = 2;');
    expect(await show('notes/x.md')).toBe('# Notes');
    expect(await show('audit/r.md')).toBe('# Audit');
  }, 240_000);

  it('brings a claim over only with the work it lists, so verification never judges other code', async () => {
    const td = await startTestDaemon(ws(), {
      git: true,
      brain: { autoStart: false },
      editConfig: (y) =>
        y
          .replace(
            '  checks: []\n',
            '  checks:\n    - name: ok\n      command: node\n      args: ["-e", "process.exit(0)"]\n',
          )
          .replace(/provider: anthropic(\s+#)/, 'provider: none$1'),
    });
    const A = ws().projectDir;
    writeFileSync(path.join(A, 'README.md'), '# shop\n');
    await deterministicGit(A, { startEpoch: 1_767_225_700 }).commitAll('a readme');
    const remote = path.join(ws().root, 'remote.git');
    await deterministicGit(ws().root).run(['init', '-q', '--bare', remote]);
    await deterministicGit(A).run(['push', '-q', remote, 'HEAD:refs/heads/main']);
    const op = td.operator;
    const chore = (summary: string) =>
      op
        .post<TaskView>(op.projectPath('/tasks'), {
          summary,
          kind: 'chore',
          scope: { write: ['notes/**'], read: [] },
          ready: true,
        })
        .then((t) => t.task_id);
    const kept = await chore('Notes, committed');
    const lost = await chore('Notes, left uncommitted');
    // One agent commits its work before claiming; the other leaves it uncommitted.
    await claim(await begin(td, 'ch-1', kept), { 'notes/kept.md': '# Kept\n' }, { commit: true });
    await claim(await begin(td, 'ch-2', lost), { 'notes/lost.md': '# Lost\n' });
    const backup = path.join(ws().root, 'backup');
    const made = await cli(['--project', A, 'backup', '--into', backup]);
    expect(made.code, made.stderr).toBe(0);
    await td.daemon.close('the disk is lost');
    rmSync(path.join(path.dirname(ws().stateDir), 'friday-worktrees'), { recursive: true, force: true });
    rmSync(A, { recursive: true, force: true });

    const B = path.join(ws().root, 'b');
    await deterministicGit(ws().root).run(['clone', '-q', remote, B]);
    const restored = await cli(['--project', B, 'restore', '--from', backup]);
    expect(restored.code, restored.stderr).toBe(0);
    // As if the backup had not been able to read the second worktree: its uncommitted work is not here.
    await runGit(B, ['update-ref', '-d', restoredRef(lost)]);
    const daemon = await createDaemon({
      projectRoot: B,
      stateDir: ws().stateDir,
      tickMs: 0,
      pollIntervalMs: 25,
      logToFile: true,
      brain: { autoStart: false },
    });
    ws().track({ close: () => daemon.close('test cleanup') });
    const b = wrap(daemon);
    const status = (t: string) => daemon.state.q.task(b.project.project_id, t).status;
    const rebind = async (t: string) => (await daemon.recovery.assess(t)).options.find((o) => o.action === 'rebind');

    // The claim lists a file its branch here does not hold: it is not brought over to be verified.
    expect(await rebind(lost)).toMatchObject({ available: false });
    expect((await rebind(lost))?.reason).toContain('notes/lost.md');
    const refused = await cli(['--project', B, 'recover', lost, '--action', 'rebind', '--reason', 'continue here']);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('notes/lost.md');
    expect(status(lost)).toBe('READY_FOR_VERIFICATION');
    // A human records what happened instead, and the task is reworked.
    const failed = await b.operator.post<{ task: TaskView }>(b.operator.projectPath(`/tasks/${lost}/verify`), {
      result: 'failed',
      note: 'its work was lost with clone A',
    });
    expect(failed.task.status).toBe('FAILED');

    // The committed claim needs no record: its branch holds what it lists, and it is verified here.
    expect(await rebind(kept)).toMatchObject({ available: true });
    const r = await cli(['--project', B, 'recover', kept, '--action', 'rebind', '--reason', 'continue here']);
    expect(r.code, r.stderr).toBe(0);
    const tree = daemon.state.q.worktreeForTask(kept)?.path as string;
    expect(daemon.state.inThisClone(tree)).toBe(true);
    const v = await verify(b, kept);
    expect(v.task.status, JSON.stringify(v.verification.checks)).toBe('COMPLETED');
    expect(v.verification.execution_root).toBe(tree);
  }, 180_000);
});
