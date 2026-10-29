/**
 * Integration of verified task branches into goal branches (plan M5c, ADR-0025).
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { closeDatabase, openDatabase } from '@friday/db';
import { commitContent, FRIDAY_IDENTITY, GitRoot, runGit } from '@friday/git';
import type { GoalSummary, IntegrationView, TaskStartParams, TaskView, VerificationView } from '@friday/protocol';
import { FridayState } from '@friday/state';
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

/** `a + b` may not exceed 3: each change below passes alone; two of them together do not. */
const SUM_TEST = [
  "import assert from 'node:assert';",
  "import { test } from 'node:test';",
  "import { a } from '../src/a.mjs';",
  "import { b } from '../src/b.mjs';",
  "test('a + b stays small', () => assert.ok(a + b <= 3));",
  '',
].join('\n');
const CHECKS = '  checks:\n    - name: tests\n      command: node\n      args: ["--test", "test/*.test.mjs"]\n';

/**
 * A check that repairs what it checks, as a formatter or a code generator might: when `a + b`
 * exceeds 3 it lowers b in the checkout, then passes.
 */
const REPAIRING_CHECK = [
  "const fs = require('node:fs');",
  "const num = (f) => Number(/= (\\d+)/.exec(fs.readFileSync(f, 'utf8'))[1]);",
  "if (num('src/a.mjs') + num('src/b.mjs') > 3) fs.writeFileSync('src/b.mjs', 'export const b = 0;\\n');",
  "process.exit(num('src/a.mjs') + num('src/b.mjs') <= 3 ? 0 : 1);",
  '',
].join('\n');
const REPAIRING_CHECKS = '  checks:\n    - name: repairing\n      command: node\n      args: ["scripts/check.cjs"]\n';

async function project(checks = CHECKS, extra: Record<string, string> = {}): Promise<TestDaemon> {
  const td = await startTestDaemon(ws(), {
    git: true,
    brain: { autoStart: false },
    editConfig: (y) => y.replace('  checks: []\n', checks),
  });
  const dir = ws().projectDir;
  const git = deterministicGit(dir, { startEpoch: 1_767_225_700 });
  for (const [rel, text] of Object.entries({
    'src/a.mjs': 'export const a = 1;\n',
    'src/b.mjs': 'export const b = 1;\n',
    'test/sum.test.mjs': SUM_TEST,
    ...extra,
  })) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  await git.commitAll('sources and tests');
  return td;
}

interface GoalDetail {
  goal: { goal_id: string; status: string };
  active: { plan_id: string; tasks: { key: string; task_id: string | null; status: string }[] } | null;
  /** What Friday did for the goal, from its records (plan M12.7). */
  summary: GoalSummary;
}

/** A goal with a human-written plan, approved: its tasks exist. */
async function goalWith(
  td: TestDaemon,
  tasks: { key: string; summary: string; write: string[]; depends_on?: string[] }[],
) {
  const op = td.operator;
  const goal = await op.post<{ goal_id: string }>(op.projectPath('/goals'), { request: 'Tune a and b', plan: false });
  const v1 = await op.post<{ plan_id: string; version: number }>(op.projectPath(`/goals/${goal.goal_id}/plans`), {
    draft: {
      objective: 'Tune a and b',
      summary: 'Small changes to a and b',
      tasks: tasks.map((t) => ({
        key: t.key,
        summary: t.summary,
        acceptance_criteria: ['tests pass'],
        scope: { write: t.write, read: ['**'] },
        depends_on: t.depends_on ?? [],
      })),
    },
  });
  await op.post(op.projectPath(`/plans/${v1.plan_id}/versions/${v1.version}/approve`), {});
  const detail = await op.get<GoalDetail>(op.projectPath(`/goals/${goal.goal_id}`));
  const ids = Object.fromEntries((detail.active?.tasks ?? []).map((t) => [t.key, t.task_id as string]));
  return { goalId: goal.goal_id, ids };
}

const taskOf = (td: TestDaemon, id: string) =>
  td.operator.get<{ task: TaskView }>(td.operator.projectPath(`/tasks/${id}`)).then((r) => r.task);

async function eventually<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v).slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** An agent takes a task: its worktree is prepared and the task runs. */
async function begin(td: TestDaemon, agent: string, taskId: string) {
  const fake = await FakeHarness.connect(td, { agentKey: agent });
  await td.operator.post(td.operator.projectPath(`/tasks/${taskId}/assign`), { agent_key: agent });
  const start = (await fake.waitFor('task.start', 20_000)).params as TaskStartParams;
  await eventually(
    () => taskOf(td, taskId),
    (t) => t.status === 'RUNNING',
    `${taskId} to run`,
  );
  return { fake, start, taskId };
}

/** The agent writes `files` in its worktree and claims completion; a human verifies. */
async function finish(td: TestDaemon, w: Awaited<ReturnType<typeof begin>>, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) writeFileSync(path.join(w.start.working_directory, rel), text);
  await w.fake.client.reportResult({
    task_id: w.taskId,
    run_id: w.start.run_id,
    status: 'completed_claim',
    summary: `changed ${Object.keys(files).join(', ')}`,
    changed_paths: Object.keys(files),
    checks: [],
  });
  // A finished agent leaves, so the coordinator cannot hand it the next task.
  await w.fake.close();
  const verified = await td.operator.post<{ task: TaskView; verification: VerificationView }>(
    td.operator.projectPath(`/tasks/${w.taskId}/verify`),
    {},
    { timeoutMs: 120_000 },
  );
  expect(verified.task.status, JSON.stringify(verified.verification.checks)).toBe('COMPLETED');
  return w;
}

const work = async (td: TestDaemon, agent: string, taskId: string, files: Record<string, string>) =>
  finish(td, await begin(td, agent, taskId), files);

const integrationOf = (td: TestDaemon, taskId: string) =>
  eventually(
    () => td.daemon.state.q.latestIntegration(td.project.project_id, taskId),
    (i): i is IntegrationView => i !== undefined,
    `the integration of ${taskId}`,
  ) as Promise<IntegrationView>;

const git = (args: string[]) => deterministicGit(ws().projectDir).run(args);
const runOnce = (td: TestDaemon) => td.operator.post(td.operator.projectPath('/brain/run-once'), {});

describe('goal branches', () => {
  it('integrates each verified task, builds dependent work on it, and completes the goal only then', async () => {
    const td = await project();
    const mainHead = (await git(['rev-parse', 'HEAD'])).trim();
    const { goalId, ids } = await goalWith(td, [
      { key: 'raise-a', summary: 'Raise a to 2', write: ['src/a.mjs'] },
      { key: 'lower-b', summary: 'Lower b to 0', write: ['src/b.mjs'], depends_on: ['raise-a'] },
    ]);
    const first = ids['raise-a'] as string;
    const second = ids['lower-b'] as string;
    await work(td, 'be-1', first, { 'src/a.mjs': 'export const a = 2;\n' });

    const one = await integrationOf(td, first);
    // The goal branch had not moved: a fast-forward to the verified commit, nothing to check again.
    expect(one).toMatchObject({
      status: 'integrated',
      branch: `friday/goal-${goalId}`,
      base_commit: mainHead,
      checks: [],
    });
    expect(one.summary).toContain('fast-forward');
    const branch = `friday/goal-${goalId}`;
    expect((await git(['rev-parse', branch])).trim()).toBe(one.merged_commit);
    expect((await git(['show', `${branch}:src/a.mjs`])).trim()).toBe('export const a = 2;');
    // The verified work was committed on its task branch, in the agent's name, not the user's.
    expect((await git(['log', '-1', '--format=%an <%ae>', `friday/${first}`])).trim()).toBe(
      'be-1 (via Friday) <be-1@agents.friday.invalid>',
    );
    // Nothing of this touched the main checkout.
    expect((await git(['rev-parse', 'HEAD'])).trim()).toBe(mainHead);
    expect(await git(['status', '--porcelain'])).toBe('');
    // Not complete yet: the dependent task has work to do.
    await runOnce(td);
    expect((await td.operator.get<GoalDetail>(td.operator.projectPath(`/goals/${goalId}`))).goal.status).toBe('ACTIVE');

    // The dependent task starts from the goal branch, so it sees the integrated work.
    expect((await taskOf(td, second)).status).toBe('READY');
    const { start } = await work(td, 'be-2', second, { 'src/b.mjs': 'export const b = 0;\n' });
    expect(readFileSync(path.join(start.working_directory, 'src', 'a.mjs'), 'utf8').replace(/\r\n/g, '\n')).toBe(
      'export const a = 2;\n',
    );
    const two = await integrationOf(td, second);
    expect(two).toMatchObject({ status: 'integrated', base_commit: one.merged_commit });
    await runOnce(td);
    const done = await td.operator.get<GoalDetail>(td.operator.projectPath(`/goals/${goalId}`));
    expect(done.goal.status).toBe('COMPLETED');
    const listed = await cli(['--project', ws().projectDir, 'integrations', '--goal', goalId]);
    expect(listed.stdout).toContain(`git merge ${branch}`);

    // What Friday did for the goal (plan M12.7), from its records: both tasks verified at their
    // first claim, nothing held, refused or lost; two attempts whose plain harnesses reported no
    // usage, so no token figure and no cost; a plan a human wrote, so no planning call.
    expect(done.summary).toMatchObject({
      tasks: { total: 2, verified: 2 },
      claims_refused: 0,
      reworked: 0,
      held_for_human: 0,
      refused_by_policy: 0,
      sessions_lost: 0,
      sessions_recovered: 0,
      hosts: { attempts: 2, reported: 0, tokens: null, tokens_reporters: 0, cost_usd: null, cost_reporters: 0 },
      planning: { calls: 0, cost_usd: null, unknown_cost_calls: 0 },
    });
    const shown = await cli(['--project', ws().projectDir, 'goal', 'show', goalId]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain('What Friday did:');
    expect(shown.stdout).toContain('tasks verified: 2 of 2');
    expect(shown.stdout).toContain('hosts reported: nothing (0 of 2 attempts)');
    expect(shown.stdout).not.toContain('tokens');
    expect(shown.stdout).not.toContain('$');
  });

  it('never moves the goal branch to a merge whose checks fail, nor through a conflict, and asks a human', async () => {
    const td = await project();
    const { goalId, ids } = await goalWith(td, [
      { key: 'raise-a', summary: 'Raise a to 2', write: ['src/a.mjs'] },
      { key: 'raise-b', summary: 'Raise b to 2', write: ['src/b.mjs'] },
      { key: 'reset-a', summary: 'Set a to 0', write: ['src/a.mjs'], depends_on: ['raise-a'] },
    ]);
    const branch = `friday/goal-${goalId}`;
    // Both start from the same commit, in parallel.
    const ra = await begin(td, 'be-1', ids['raise-a'] as string);
    const rb = await begin(td, 'be-2', ids['raise-b'] as string);
    await finish(td, ra, { 'src/a.mjs': 'export const a = 2;\n' });
    const one = await integrationOf(td, ids['raise-a'] as string);
    expect(one.status).toBe('integrated');

    // Each change passes alone; together a + b = 4. The goal branch stays where it was.
    await finish(td, rb, { 'src/b.mjs': 'export const b = 2;\n' });
    const two = await integrationOf(td, ids['raise-b'] as string);
    expect(two).toMatchObject({ status: 'failed', base_commit: one.merged_commit, merged_commit: null });
    expect(two.checks.map((c) => [c.name, c.status])).toEqual([['tests', 'FAILED']]);
    expect((await git(['rev-parse', branch])).trim()).toBe(one.merged_commit);

    // The dependent task starts from the goal branch; then a human changes the same line there.
    await runOnce(td);
    const reset = ids['reset-a'] as string;
    const fake = await FakeHarness.connect(td, { agentKey: 'be-3' });
    await td.operator.post(td.operator.projectPath(`/tasks/${reset}/assign`), { agent_key: 'be-3' });
    const start = (await fake.waitFor('task.start', 20_000)).params as TaskStartParams;
    await eventually(
      () => taskOf(td, reset),
      (t) => t.status === 'RUNNING',
      'reset-a to run',
    );
    const human = path.join(ws().root, 'human');
    await git(['worktree', 'add', '-q', human, branch]);
    writeFileSync(path.join(human, 'src', 'a.mjs'), 'export const a = 3;\n');
    await deterministicGit(human, { startEpoch: 1_767_226_000 }).commitAll('a human sets a to 3');
    await git(['worktree', 'remove', human]);
    const moved = (await git(['rev-parse', branch])).trim();

    writeFileSync(path.join(start.working_directory, 'src', 'a.mjs'), 'export const a = 0;\n');
    await fake.client.reportResult({
      task_id: reset,
      run_id: start.run_id,
      status: 'completed_claim',
      summary: 'a is 0',
      changed_paths: ['src/a.mjs'],
      checks: [],
    });
    await fake.close();
    const v = await td.operator.post<{ task: TaskView }>(
      td.operator.projectPath(`/tasks/${reset}/verify`),
      {},
      { timeoutMs: 120_000 },
    );
    expect(v.task.status).toBe('COMPLETED');
    const three = await integrationOf(td, reset);
    expect(three).toMatchObject({ status: 'conflicted', conflicts: ['src/a.mjs'], base_commit: moved });
    expect((await git(['rev-parse', branch])).trim()).toBe(moved);

    const escalations = td.daemon.state.store
      .readSince(td.project.project_id, 0, { types: ['escalation.requested'] })
      .map((e) => (e.payload as { escalation: { kind: string; task_id: string } }).escalation);
    expect(escalations.map((e) => [e.kind, e.task_id])).toEqual([
      ['integration_failed', ids['raise-b']],
      ['integration_conflict', ids['reset-a']],
    ]);
    await runOnce(td);
    expect((await td.operator.get<GoalDetail>(td.operator.projectPath(`/goals/${goalId}`))).goal.status).toBe('ACTIVE');
  });

  it('never integrates a merge whose checks changed the files they checked (review F04)', async () => {
    const td = await project(REPAIRING_CHECKS, { 'scripts/check.cjs': REPAIRING_CHECK });
    const { goalId, ids } = await goalWith(td, [
      { key: 'raise-a', summary: 'Raise a to 2', write: ['src/a.mjs'] },
      { key: 'raise-b', summary: 'Raise b to 2', write: ['src/b.mjs'] },
    ]);
    const branch = `friday/goal-${goalId}`;
    const ra = await begin(td, 'be-1', ids['raise-a'] as string);
    const rb = await begin(td, 'be-2', ids['raise-b'] as string);
    await finish(td, ra, { 'src/a.mjs': 'export const a = 2;\n' });
    const one = await integrationOf(td, ids['raise-a'] as string);
    expect(one.status).toBe('integrated');

    // Each change passes alone, and its check changes nothing. Merged, a + b = 4: the check lowers b
    // in Friday's checkout and then passes, so what passed is not the merged revision.
    await finish(td, rb, { 'src/b.mjs': 'export const b = 2;\n' });
    const two = await integrationOf(td, ids['raise-b'] as string);
    expect(two).toMatchObject({ status: 'failed', merged_commit: null });
    expect(two.summary).toMatch(/changed src\/b\.mjs/);
    expect((await git(['rev-parse', branch])).trim()).toBe(one.merged_commit);
    const value = async (f: string) => Number(/= (\d+)/.exec(await git(['show', `${branch}:${f}`]))?.[1]);
    expect((await value('src/a.mjs')) + (await value('src/b.mjs'))).toBeLessThanOrEqual(3);
  });

  it('lands only the tree that was verified, even when the worktree changes during integration (review F04)', async () => {
    const td = await project();
    const { goalId, ids } = await goalWith(td, [{ key: 'raise-a', summary: 'Raise a to 2', write: ['src/a.mjs'] }]);
    const id = ids['raise-a'] as string;
    const w = await begin(td, 'be-1', id);
    const dir = realpathSync(w.start.working_directory);
    const same = (a: string, b: string) =>
      process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    // Right after integration reads the worktree (the task is COMPLETED by then), a writer changes it.
    const contentTree = GitRoot.prototype.contentTree;
    let changed = false;
    const spy = vi.spyOn(GitRoot.prototype, 'contentTree').mockImplementation(async function (
      this: GitRoot,
      ...args: Parameters<GitRoot['contentTree']>
    ) {
      const r = await contentTree.apply(this, args);
      const status = td.daemon.state.q.task(td.project.project_id, id).status;
      if (!changed && same(this.root, dir) && status === 'COMPLETED') {
        changed = true;
        writeFileSync(path.join(dir, 'src', 'a.mjs'), 'export const a = 99; // BAD unverified\n');
      }
      return r;
    });
    try {
      await finish(td, w, { 'src/a.mjs': 'export const a = 2;\n' });
      const one = await integrationOf(td, id);
      expect(changed).toBe(true);
      // Integration commits the tree the verification recorded, an object, never the folder: the
      // change made after its read cannot land, and stays in the worktree as an uncommitted edit.
      // (Until M7.1's follow-up review, a second read made this attempt fail instead; see R04.)
      const landed = await git(['show', `friday/goal-${goalId}:src/a.mjs`]).catch(() => '');
      expect(landed).not.toContain('BAD');
      expect(landed.trim()).toBe('export const a = 2;');
      expect(one.status).toBe('integrated');
      expect(readFileSync(path.join(dir, 'src', 'a.mjs'), 'utf8')).toContain('BAD unverified');
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * `a + b` may not exceed 3, unless a flag outside the repository says otherwise: a condition of
   * the merged revision that is not in the task's content, and goes away by itself.
   */
  const LIMIT = [
    "const fs = require('node:fs');",
    "const num = (f) => Number(/= (\\d+)/.exec(fs.readFileSync(f, 'utf8'))[1]);",
    "process.exit(num('src/a.mjs') + num('src/b.mjs') <= 3 || fs.existsSync(process.env.FLAG || '') ? 0 : 1);",
    '',
  ].join('\n');
  const limitChecks = (flag: string) =>
    `  checks:\n    - name: limit\n      command: node\n      args: ["scripts/limit.cjs"]\n      env: { FLAG: "${flag}" }\n`;
  const retry = (td: TestDaemon, taskId: string, body: Record<string, unknown> = {}) =>
    td.operator
      .post<{ integration: IntegrationView }>(td.operator.projectPath(`/tasks/${taskId}/integrate`), body, {
        timeoutMs: 120_000,
      })
      .then((r) => r.integration);

  it('retries a failed integration from the verified commit Friday made, and refuses work changed since (review M7.1 R04)', async () => {
    const flag = path.join(ws().root, 'merged-ok').replace(/\\/g, '/');
    const td = await project(limitChecks(flag), { 'scripts/limit.cjs': LIMIT });
    const { goalId, ids } = await goalWith(td, [
      { key: 'raise-a', summary: 'Raise a to 2', write: ['src/a.mjs'] },
      { key: 'raise-b', summary: 'Raise b to 2', write: ['src/b.mjs'] },
    ]);
    const branch = `friday/goal-${goalId}`;
    const ra = await begin(td, 'be-1', ids['raise-a'] as string);
    const rb = await begin(td, 'be-2', ids['raise-b'] as string);
    await finish(td, ra, { 'src/a.mjs': 'export const a = 2;\n' });
    expect((await integrationOf(td, ids['raise-a'] as string)).status).toBe('integrated');
    // Alone b = 2 passes; merged, a + b = 4 fails while the flag is absent.
    await finish(td, rb, { 'src/b.mjs': 'export const b = 2;\n' });
    const failed = await integrationOf(td, ids['raise-b'] as string);
    expect(failed).toMatchObject({ status: 'failed' });
    expect(failed.checks.map((c) => [c.name, c.status])).toEqual([['limit', 'FAILED']]);
    // Friday committed exactly the verified tree on the task branch.
    const worktree = rb.start.working_directory;
    expect(failed.task_commit).toBe((await runGit(worktree, ['rev-parse', 'HEAD'])).stdout.trim());

    // An edit made since the verification is still refused.
    writeFileSync(path.join(worktree, 'src', 'b.mjs'), 'export const b = 0;\n');
    const edited = await retry(td, ids['raise-b'] as string);
    expect(edited.status).toBe('failed');
    expect(edited.summary).toMatch(/changed after it was verified/);
    await runGit(worktree, ['checkout', '--', 'src/b.mjs']);

    // The cause was outside the task: once it is gone, the same verified commit is integrated.
    writeFileSync(flag, 'ok');
    const retried = await retry(td, ids['raise-b'] as string);
    expect(retried).toMatchObject({ status: 'integrated', task_commit: failed.task_commit });
    expect(retried.checks.map((c) => [c.name, c.status])).toEqual([['limit', 'PASSED']]);
    expect((await git(['show', `${branch}:src/b.mjs`])).trim()).toBe('export const b = 2;');
    expect((await git(['show', `${branch}:src/a.mjs`])).trim()).toBe('export const a = 2;');
  });

  it('resumes an integration interrupted after Friday committed the verified tree (review M7.1 R04)', async () => {
    const td = await project();
    const pid = td.project.project_id;
    const { goalId, ids } = await goalWith(td, [{ key: 'raise-a', summary: 'Raise a to 2', write: ['src/a.mjs'] }]);
    const id = ids['raise-a'] as string;
    // The daemon stops right after committing the verified work, before it records the integration.
    const integration = td.daemon.integration;
    const real = integration.completed.bind(integration);
    let committed = false;
    integration.completed = async (taskId: string) => {
      const v = td.daemon.state.q.latestVerification(taskId) as VerificationView;
      const wt = td.daemon.state.q.worktreeForTask(taskId);
      if (wt && v.tree) await commitContent(wt.path, v.tree, v.commit_sha, 'Raise a to 2', FRIDAY_IDENTITY);
      committed = true;
      return null;
    };
    const w = await begin(td, 'be-1', id);
    await finish(td, w, { 'src/a.mjs': 'export const a = 2;\n' });
    await eventually(
      () => committed,
      (v) => v,
      'the verified work to be committed',
    );
    expect(td.daemon.state.q.latestIntegration(pid, id)).toBeUndefined();
    // The next start sweeps completed tasks that wait for integration.
    integration.completed = real;
    await integration.sweep();
    const done = await integrationOf(td, id);
    expect(done).toMatchObject({ status: 'integrated' });
    expect((await git(['show', `friday/goal-${goalId}:src/a.mjs`])).trim()).toBe('export const a = 2;');
  });

  it('integrates a conflict a human repaired on the task branch only after verifying the repaired revision (review M7.1 R04)', async () => {
    const td = await project();
    const { goalId, ids } = await goalWith(td, [
      { key: 'raise-a', summary: 'Raise a to 2', write: ['src/a.mjs'] },
      { key: 'reset-a', summary: 'Set a to 0', write: ['src/a.mjs'], depends_on: ['raise-a'] },
    ]);
    const branch = `friday/goal-${goalId}`;
    await work(td, 'be-1', ids['raise-a'] as string, { 'src/a.mjs': 'export const a = 2;\n' });
    expect((await integrationOf(td, ids['raise-a'] as string)).status).toBe('integrated');
    await runOnce(td);
    const reset = ids['reset-a'] as string;
    const w = await begin(td, 'be-2', reset);
    // A human changes the same line on the goal branch meanwhile.
    const human = path.join(ws().root, 'human');
    await git(['worktree', 'add', '-q', human, branch]);
    writeFileSync(path.join(human, 'src', 'a.mjs'), 'export const a = 3;\n');
    await deterministicGit(human, { startEpoch: 1_767_226_000 }).commitAll('a human sets a to 3');
    await git(['worktree', 'remove', human]);
    await finish(td, w, { 'src/a.mjs': 'export const a = 0;\n' });
    const conflicted = await integrationOf(td, reset);
    expect(conflicted).toMatchObject({ status: 'conflicted', conflicts: ['src/a.mjs'] });

    // A human resolves the conflict on the task branch: the goal branch merged in, a chosen.
    const dir = w.start.working_directory;
    const who = {
      GIT_AUTHOR_NAME: 'A Human',
      GIT_AUTHOR_EMAIL: 'human@example.invalid',
      GIT_COMMITTER_NAME: 'A Human',
      GIT_COMMITTER_EMAIL: 'human@example.invalid',
    };
    expect((await runGit(dir, ['merge', '-q', branch], { okCodes: [1], env: who })).code).toBe(1);
    writeFileSync(path.join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
    await runGit(dir, ['add', 'src/a.mjs']);
    await runGit(dir, ['commit', '-q', '--no-edit'], { env: who });
    const repaired = (await runGit(dir, ['rev-parse', 'HEAD'])).stdout.trim();

    // Integrating again without saying it is a repair is refused: the work changed after it was verified.
    expect((await retry(td, reset)).summary).toMatch(/changed after it was verified/);
    // Said to be a repair, it is verified on the merged revision before the goal branch moves.
    const done = await retry(td, reset, { repaired: true });
    expect(done, JSON.stringify(done)).toMatchObject({ status: 'integrated', merged_commit: repaired });
    expect(done.checks.map((c) => [c.name, c.status])).toEqual([['tests', 'PASSED']]);
    expect(done.summary).toMatch(/repair/);
    expect((await git(['rev-parse', branch])).trim()).toBe(repaired);
    expect((await git(['show', `${branch}:src/a.mjs`])).replace(/\r\n/g, '\n').trim()).toBe('export const a = 1;');
  });

  it('lets an integration in flight finish when the daemon stops, so none is cut off in the checkout', async () => {
    // A slow check: the merged revision's checks are still running when the daemon is told to stop.
    const td = await project(
      `${CHECKS}    - name: slow\n      command: node\n      args: ["-e", "setTimeout(() => {}, 2500)"]\n`,
      { 'src/c.mjs': 'export const c = 1;\n' },
    );
    const { ids } = await goalWith(td, [
      { key: 'one', summary: 'Raise a', write: ['src/a.mjs'] },
      { key: 'two', summary: 'Raise c', write: ['src/c.mjs'] },
    ]);
    // Both from the same base: once one is integrated, the other needs a merge, checked again.
    const wOne = await begin(td, 'be-1', ids.one as string);
    const wTwo = await begin(td, 'fe-1', ids.two as string);
    await finish(td, wOne, { 'src/a.mjs': 'export const a = 2;\n' });
    expect((await integrationOf(td, ids.one as string)).status).toBe('integrated');
    await finish(td, wTwo, { 'src/c.mjs': 'export const c = 2;\n' });
    // The second integration has just begun its merge checks; the daemon stops now.
    await td.daemon.close('stopped during an integration');
    const db = openDatabase(path.join(ws().projectDir, '.friday', 'project.db'));
    try {
      const after = new FridayState({ db }).q.latestIntegration(td.project.project_id, ids.two as string);
      expect(after?.status).toBe('integrated');
    } finally {
      closeDatabase(db);
    }
  });
});
