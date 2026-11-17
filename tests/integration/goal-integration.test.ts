/**
 * Integration of verified task branches into goal branches (plan M5c, ADR-0025).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GenericHarnessClient } from '@friday/adapter-generic';
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

async function project(checks = CHECKS, extra: Record<string, string> = {}, tail = ''): Promise<TestDaemon> {
  const td = await startTestDaemon(ws(), {
    git: true,
    brain: { autoStart: false },
    editConfig: (y) => `${y.replace('  checks: []\n', checks)}${tail}`,
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
  tasks: { key: string; summary: string; write: string[]; depends_on?: string[]; assign_to?: string }[],
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
        ...(t.assign_to ? { assign_to: t.assign_to } : {}),
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

describe('landing a completed goal', () => {
  /** A one-task goal, worked, verified, integrated and completed: its branch is ready to land. */
  async function completedGoal(td: TestDaemon) {
    const { goalId, ids } = await goalWith(td, [{ key: 'raise-a', summary: 'Raise a to 2', write: ['src/a.mjs'] }]);
    const id = ids['raise-a'] as string;
    await work(td, 'be-1', id, { 'src/a.mjs': 'export const a = 2;\n' });
    await integrationOf(td, id);
    await runOnce(td);
    expect((await td.operator.get<GoalDetail>(td.operator.projectPath(`/goals/${goalId}`))).goal.status).toBe(
      'COMPLETED',
    );
    return goalId;
  }
  const land = (td: TestDaemon, goalId: string) =>
    td.operator.post<{ status: string; into: string; head: string; branch: string; fast_forward: boolean }>(
      td.operator.projectPath(`/goals/${goalId}/land`),
      {},
    );

  it('merges the goal branch into the checked-out branch once, and says so the second time', async () => {
    const td = await project();
    const before = (await git(['rev-parse', 'HEAD'])).trim();
    const branch = (await git(['symbolic-ref', '--short', 'HEAD'])).trim();
    const goalId = await completedGoal(td);
    const landed = await land(td, goalId);
    expect(landed).toMatchObject({ status: 'landed', into: branch, branch: `friday/goal-${goalId}` });
    // The main checkout now has the goal's work, on the person's own branch.
    expect(readFileSync(path.join(ws().projectDir, 'src', 'a.mjs'), 'utf8').replace(/\r\n/g, '\n')).toBe(
      'export const a = 2;\n',
    );
    expect((await git(['rev-parse', 'HEAD'])).trim()).toBe(landed.head);
    expect(landed.head).not.toBe(before);
    expect((await git(['symbolic-ref', '--short', 'HEAD'])).trim()).toBe(branch);
    // Clean as the person's own git sees it (with this machine's line-ending settings, which the
    // test helper's git overrides).
    expect((await runGit(ws().projectDir, ['status', '--porcelain'])).stdout).toBe('');
    expect(
      td.daemon.state.store.readSince(td.project.project_id, 0, { types: ['goal.landed'], limit: 10 }),
    ).toHaveLength(1);
    // Landing again brings nothing and changes nothing.
    expect(await land(td, goalId)).toMatchObject({ status: 'already', head: landed.head });
  });

  /** What Land would do, read before anyone clicks. */
  const plan = (td: TestDaemon, goalId: string) =>
    td.operator.get<{
      state: string;
      into: string | null;
      reason: string | null;
      files: string[];
      commits: number;
      work: string;
    }>(td.operator.projectPath(`/goals/${goalId}/land`));
  const file = (rel: string) => path.join(ws().projectDir, rel);
  const text = (rel: string) => readFileSync(file(rel), 'utf8').replace(/\r\n/g, '\n');
  const head = async () => (await git(['rev-parse', 'HEAD'])).trim();
  /** A commit of the person's own on the checked-out branch: a landing after it is a real merge. */
  async function ownCommit(rel: string, content: string, message: string) {
    writeFileSync(file(rel), content);
    await deterministicGit(ws().projectDir, { startEpoch: 1_767_300_000 }).commitAll(message);
  }

  // A merge commit is made in the person's name: the daemon's git reads it from the environment here.
  const IDENTITY = {
    GIT_AUTHOR_NAME: 'Dev',
    GIT_AUTHOR_EMAIL: 'dev@example.invalid',
    GIT_COMMITTER_NAME: 'Dev',
    GIT_COMMITTER_EMAIL: 'dev@example.invalid',
  };
  let identityBefore: Record<string, string | undefined> = {};
  beforeEach(() => {
    identityBefore = Object.fromEntries(Object.keys(IDENTITY).map((k) => [k, process.env[k]]));
    Object.assign(process.env, IDENTITY);
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(identityBefore)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('says beforehand what Land would do, and the board shows the landing', async () => {
    const td = await project();
    const branch = (await git(['symbolic-ref', '--short', 'HEAD'])).trim();
    const goalId = await completedGoal(td);
    expect(await plan(td, goalId)).toMatchObject({
      state: 'ready',
      into: branch,
      commits: 1,
      work: 'branch',
      files: [],
    });
    const snapshot = () =>
      td.operator.get<{ goal_landing?: Record<string, { work: string; landed: { into: string } | null }> }>(
        td.operator.projectPath('/ui/snapshot'),
      );
    expect((await snapshot()).goal_landing?.[goalId]).toEqual({ work: 'branch', landed: null });
    // A fast-forward: the branch the folder is on had not moved since the goal started.
    expect(await land(td, goalId)).toMatchObject({ status: 'landed', fast_forward: true });
    expect(await plan(td, goalId)).toMatchObject({ state: 'landed', into: branch });
    expect((await snapshot()).goal_landing?.[goalId]).toMatchObject({ work: 'branch', landed: { into: branch } });
    // An open goal is not ready to land.
    const open = await td.operator.post<{ goal_id: string }>(td.operator.projectPath('/goals'), {
      request: 'not started',
      plan: false,
    });
    expect(await plan(td, open.goal_id)).toMatchObject({ state: 'not_completed' });
    await expect(land(td, open.goal_id)).rejects.toThrow(/only a completed goal lands/);
  });

  it('makes a merge commit when the person committed meanwhile, and learns a merge made by hand', async () => {
    const td = await project();
    const goalId = await completedGoal(td);
    await ownCommit('src/b.mjs', 'export const b = 0;\n', 'my own change');
    const mine = await head();
    const landed = await land(td, goalId);
    expect(landed).toMatchObject({ status: 'landed', fast_forward: false });
    expect(landed.head).not.toBe(mine);
    // Both sides are there, in one commit with two parents.
    expect(text('src/a.mjs')).toBe('export const a = 2;\n');
    expect(text('src/b.mjs')).toBe('export const b = 0;\n');
    expect((await git(['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ')).toHaveLength(3);
    expect((await git(['log', '-1', '--format=%s'])).trim()).toContain(`Land goal ${goalId}`);

    // A second goal, merged by the person in their own terminal: Friday records it when asked, once.
    const { goalId: second, ids } = await goalWith(td, [{ key: 'raise-b', summary: 'Raise b', write: ['src/b.mjs'] }]);
    const id = ids['raise-b'] as string;
    await work(td, 'be-2', id, { 'src/b.mjs': 'export const b = 1;\n' });
    await integrationOf(td, id);
    await runOnce(td);
    await runGit(ws().projectDir, ['merge', '--no-edit', `friday/goal-${second}`]);
    expect(await plan(td, second)).toMatchObject({ state: 'landed' });
    const landings = () =>
      td.daemon.state.store
        .readSince(td.project.project_id, 0, { types: ['goal.landed'], limit: 10 })
        .filter((e) => (e.payload as { goal_id?: string }).goal_id === second);
    expect(landings()).toHaveLength(0);
    expect(await land(td, second)).toMatchObject({ status: 'already' });
    expect(await land(td, second)).toMatchObject({ status: 'already' });
    expect(landings()).toHaveLength(1);
  });

  it('refuses before git runs when the folder has changes in the way, and names the files', async () => {
    const td = await project();
    const goalId = await completedGoal(td);
    await ownCommit('src/b.mjs', 'export const b = 0;\n', 'my own change');
    const before = await head();

    // The person is editing the file the goal changes.
    writeFileSync(file('src/a.mjs'), 'export const a = 3; // mine\n');
    expect(await plan(td, goalId)).toMatchObject({ state: 'blocked', files: ['src/a.mjs'] });
    await expect(land(td, goalId)).rejects.toThrow(/not committed, and the goal changes them too.*src\/a\.mjs/);
    expect(await head()).toBe(before);
    expect(readFileSync(file('src/a.mjs'), 'utf8')).toBe('export const a = 3; // mine\n');
    await git(['checkout', '--', 'src/a.mjs']);

    // An edit elsewhere is not in the way... unless it is staged: a merge commit must not take a
    // staged change of the person's with it.
    writeFileSync(file('src/b.mjs'), 'export const b = 0; // still mine\n');
    expect(await plan(td, goalId)).toMatchObject({ state: 'ready' });
    await git(['add', 'src/b.mjs']);
    const staged = await plan(td, goalId);
    expect(staged).toMatchObject({ state: 'blocked', files: ['src/b.mjs'] });
    expect(staged.reason).toContain('staged changes');
    await expect(land(td, goalId)).rejects.toThrow(/staged changes/);
    expect(await head()).toBe(before);
    expect((await git(['diff', '--cached', '--name-only'])).trim()).toBe('src/b.mjs');
    await git(['reset', '-q', 'HEAD', '--', 'src/b.mjs']);

    // With the unstaged edit elsewhere left as it is, the goal lands around it.
    const landed = await land(td, goalId);
    expect(landed.status).toBe('landed');
    expect(readFileSync(file('src/b.mjs'), 'utf8')).toBe('export const b = 0; // still mine\n');
    expect(text('src/a.mjs')).toBe('export const a = 2;\n');
  });

  it('refuses when a file nobody committed stands where the goal adds one', async () => {
    const td = await project();
    const { goalId, ids } = await goalWith(td, [{ key: 'add-c', summary: 'Add c', write: ['src/c.mjs'] }]);
    const id = ids['add-c'] as string;
    await work(td, 'be-1', id, { 'src/c.mjs': 'export const c = 1;\n' });
    await integrationOf(td, id);
    await runOnce(td);
    writeFileSync(file('src/c.mjs'), '// my scratch file\n');
    const before = await head();
    expect(await plan(td, goalId)).toMatchObject({ state: 'blocked', files: ['src/c.mjs'] });
    await expect(land(td, goalId)).rejects.toThrow(/src\/c\.mjs/);
    expect(await head()).toBe(before);
    expect(readFileSync(file('src/c.mjs'), 'utf8')).toBe('// my scratch file\n');
  });

  it('never touches a merge of the person in progress', async () => {
    const td = await project();
    const goalId = await completedGoal(td);
    // Two branches of the person conflict on b, and they are halfway through resolving it.
    await git(['branch', 'theirs']);
    await ownCommit('src/b.mjs', 'export const b = 5;\n', 'b is 5');
    await git(['checkout', '-q', 'theirs']);
    await ownCommit('src/b.mjs', 'export const b = 7;\n', 'b is 7');
    await git(['checkout', '-q', '-']);
    const conflicted = await runGit(ws().projectDir, ['merge', '--no-edit', 'theirs'], { okCodes: [1] });
    expect(conflicted.code).toBe(1);
    writeFileSync(file('src/b.mjs'), 'export const b = 6; // resolved by hand\n');
    await git(['add', 'src/b.mjs']);
    const mergeHead = (await git(['rev-parse', 'MERGE_HEAD'])).trim();

    const blocked = await plan(td, goalId);
    expect(blocked.state).toBe('blocked');
    expect(blocked.reason).toContain('in the middle of a merge');
    await expect(land(td, goalId)).rejects.toThrow(/in the middle of a merge/);
    // Their merge is exactly where they left it.
    expect((await git(['rev-parse', 'MERGE_HEAD'])).trim()).toBe(mergeHead);
    expect(readFileSync(file('src/b.mjs'), 'utf8')).toBe('export const b = 6; // resolved by hand\n');
    expect((await git(['diff', '--cached', '--name-only'])).trim()).toBe('src/b.mjs');
  });

  it('takes back a merge that conflicts, or that a commit hook refuses, and says which it was', async () => {
    const td = await project();
    const goalId = await completedGoal(td);
    // The person committed another value of the same line: a real conflict.
    await ownCommit('src/a.mjs', 'export const a = 0;\n', 'a is 0');
    const before = await head();
    await expect(land(td, goalId)).rejects.toThrow(/change the same lines.*Nothing was changed/s);
    expect(await head()).toBe(before);
    expect((await runGit(ws().projectDir, ['status', '--porcelain'])).stdout).toBe('');
    const merging = () => runGit(ws().projectDir, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { okCodes: [1] });
    expect((await merging()).code).toBe(1);

    // A second goal that merges cleanly, in a repository whose hook refuses every commit message.
    const { goalId: other, ids } = await goalWith(td, [{ key: 'raise-b', summary: 'Raise b', write: ['src/b.mjs'] }]);
    const id = ids['raise-b'] as string;
    await work(td, 'be-2', id, { 'src/b.mjs': 'export const b = 2;\n' });
    await integrationOf(td, id);
    await runOnce(td);
    // The person committed since, so landing needs a merge commit, which the hook then judges.
    await ownCommit('notes.txt', 'a note of mine\n', 'a note');
    const mine = await head();
    const hooks = path.join(ws().projectDir, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(path.join(hooks, 'commit-msg'), '#!/bin/sh\necho "subject must start with a ticket" >&2\nexit 1\n', {
      mode: 0o755,
    });
    await expect(land(td, other)).rejects.toThrow(/commit hook of this repository refused.*Nothing was changed/s);
    expect(await head()).toBe(mine);
    expect((await runGit(ws().projectDir, ['status', '--porcelain'])).stdout).toBe('');
    expect((await merging()).code).toBe(1);
    expect(text('src/b.mjs')).toBe('export const b = 1;\n');
  });

  it('brings work made in the project folder to the goal, starts the next task with it, and lands over it (2026-11-17)', async () => {
    // A session its person runs in the project folder (Antigravity, Claude Code in an editor); the
    // level is not what this test is about.
    const td = await project(CHECKS, {}, '\nsecurity:\n  enforcement_required: L0\n');
    const pid = td.project.project_id;
    const trust = await td.operator.get<{ policy: { loosening_hash: string } }>(td.operator.projectPath('/policy'));
    await td.operator.post(td.operator.projectPath('/policy/trust'), {
      loosening_hash: trust.policy.loosening_hash,
    });
    const mainHead = await head();
    const { goalId, ids } = await goalWith(td, [
      { key: 'raise-a', summary: 'Raise a to 2', write: ['src/a.mjs'] },
      { key: 'note-b', summary: 'Say what b is for', write: ['src/b.mjs'], depends_on: ['raise-a'] },
    ]);
    const first = ids['raise-a'] as string;
    const second = ids['note-b'] as string;
    const editor = new GenericHarnessClient(td.bootstrap, {
      harness_key: `antigravity:${pid}:pid:9911`,
      vendor: 'antigravity',
      name: 'Antigravity',
      version: '1.5.9',
      adapter_version: '0.1.0',
      attach_mode: 'attach',
      project_id: pid,
      capabilities: {},
      agent_key: 'antigravity-1',
      role: 'developer',
      host: { pid: 9911, cwd: ws().projectDir },
    });
    await editor.register();
    ws().track({ close: () => void editor.disconnect().catch(() => undefined) });
    await td.operator.post(td.operator.projectPath(`/tasks/${first}/assign`), { agent_key: 'antigravity-1' });
    const claimed = await editor.claim({ task_id: first });

    // Its work, in the folder itself, beside something of the person's own that is not the task's.
    writeFileSync(file('src/a.mjs'), 'export const a = 2;\n');
    writeFileSync(file('notes.txt'), 'my own notes\n');
    await editor.reportResult({
      task_id: first,
      run_id: claimed.run_id,
      status: 'completed_claim',
      summary: 'raised a',
      changed_paths: ['src/a.mjs'],
      checks: [],
    });
    const verified = await td.operator.post<{ task: TaskView; verification: VerificationView }>(
      td.operator.projectPath(`/tasks/${first}/verify`),
      {},
      { timeoutMs: 120_000 },
    );
    expect(verified.task.status, JSON.stringify(verified.verification.checks)).toBe('COMPLETED');

    // The task's own file reached the goal branch, checked there in Friday's own checkout; the
    // person's file did not, and the folder, its index and its branch are as they were.
    const one = await integrationOf(td, first);
    expect(one, one.summary ?? '').toMatchObject({ status: 'integrated', base_commit: mainHead });
    expect(one.checks.length).toBeGreaterThan(0);
    const branch = `friday/goal-${goalId}`;
    expect((await git(['show', `${branch}:src/a.mjs`])).trim()).toBe('export const a = 2;');
    expect(
      (await runGit(ws().projectDir, ['cat-file', '-e', `${branch}:notes.txt`], { okCodes: [1, 128] })).code,
    ).not.toBe(0);
    expect((await git(['log', '-1', '--format=%an', branch])).trim()).toBe('antigravity-1 (via Friday)');
    expect(await head()).toBe(mainHead);
    expect((await runGit(ws().projectDir, ['status', '--porcelain'])).stdout).toBe(' M src/a.mjs\n?? notes.txt\n');

    // The task that depends on it starts in a folder that has it.
    const next = await begin(td, 'be-1', second);
    expect(readFileSync(path.join(next.start.working_directory, 'src/a.mjs'), 'utf8').trim()).toBe(
      'export const a = 2;',
    );
    await finish(td, next, { 'src/b.mjs': '// b stays small\nexport const b = 1;\n' });
    expect(await integrationOf(td, second)).toMatchObject({ status: 'integrated' });
    await runOnce(td);
    await eventually(
      () => td.operator.get<GoalDetail>(td.operator.projectPath(`/goals/${goalId}`)),
      (g) => g.goal.status === 'COMPLETED',
      'the goal to complete',
    );

    // Landing: the folder already holds the goal's a.mjs, uncommitted. That is not in the way.
    const p = await plan(td, goalId);
    expect(p, p.reason ?? '').toMatchObject({ state: 'ready', work: 'branch' });
    const landed = await land(td, goalId);
    expect(landed).toMatchObject({ status: 'landed', fast_forward: true });
    expect(await head()).toBe((await git(['rev-parse', branch])).trim());
    expect(text('src/a.mjs')).toBe('export const a = 2;\n');
    expect(text('src/b.mjs')).toBe('// b stays small\nexport const b = 1;\n');
    expect(text('notes.txt')).toBe('my own notes\n');
    expect((await runGit(ws().projectDir, ['status', '--porcelain'])).stdout).toBe('?? notes.txt\n');
  });

  /** A session its person runs in the project folder, allowed to take work without hooks. */
  async function folderSession(td: TestDaemon) {
    const pid = td.project.project_id;
    const trust = await td.operator.get<{ policy: { loosening_hash: string } }>(td.operator.projectPath('/policy'));
    await td.operator.post(td.operator.projectPath('/policy/trust'), { loosening_hash: trust.policy.loosening_hash });
    const editor = new GenericHarnessClient(td.bootstrap, {
      harness_key: `antigravity:${pid}:pid:9922`,
      vendor: 'antigravity',
      name: 'Antigravity',
      version: '1.5.9',
      adapter_version: '0.1.0',
      attach_mode: 'attach',
      project_id: pid,
      capabilities: {},
      agent_key: 'antigravity-1',
      role: 'developer',
      host: { pid: 9922, cwd: ws().projectDir },
    });
    await editor.register();
    ws().track({ close: () => void editor.disconnect().catch(() => undefined) });
    return editor;
  }
  const L0 = '\nsecurity:\n  enforcement_required: L0\n';

  it("puts the goal's finished work into the project folder before a session there takes a task (2026-11-17)", async () => {
    const td = await project(CHECKS, {}, L0);
    const mainHead = await head();
    const { goalId, ids } = await goalWith(td, [
      { key: 'raise-a', summary: 'Raise a to 2', write: ['src/a.mjs'] },
      { key: 'note-b', summary: 'Say what b is for', write: ['src/b.mjs'], depends_on: ['raise-a'] },
    ]);
    const second = ids['note-b'] as string;
    // An agent Friday starts does the first task in its own folder; the goal branch has it.
    await work(td, 'be-1', ids['raise-a'] as string, { 'src/a.mjs': 'export const a = 2;\n' });
    await integrationOf(td, ids['raise-a'] as string);
    const branch = `friday/goal-${goalId}`;
    const tip = (await git(['rev-parse', branch])).trim();
    expect(text('src/a.mjs')).toBe('export const a = 1;\n');
    writeFileSync(file('notes.txt'), 'my own notes\n');

    const editor = await folderSession(td);
    await td.operator.post(td.operator.projectPath(`/tasks/${second}/assign`), { agent_key: 'antigravity-1' });
    const claimed = (await editor.claim({ next: true })) as { run_id: string; task: TaskView; note: string | null };
    expect(claimed.task.task_id).toBe(second);
    // The folder has the finished file now, as an uncommitted change; nothing else moved.
    expect(text('src/a.mjs')).toBe('export const a = 2;\n');
    expect(text('notes.txt')).toBe('my own notes\n');
    expect(await head()).toBe(mainHead);
    expect((await runGit(ws().projectDir, ['status', '--porcelain'])).stdout).toBe(' M src/a.mjs\n?? notes.txt\n');
    expect(claimed.note).toContain('put the finished work');
    expect(claimed.note).toContain('src/a.mjs');
    // The attempt starts from the goal's revision: what came in is not judged as this task's change.
    expect(td.daemon.state.q.run(claimed.run_id).base_commit).toBe(tip);
    expect(
      td.daemon.state.store.readByRef(td.project.project_id, 'task', second, { types: ['folder.synced'] })[0]?.payload,
    ).toMatchObject({ goal_head: tip, brought: ['src/a.mjs'], in_the_way: [] });

    writeFileSync(file('src/b.mjs'), '// b stays small\nexport const b = 1;\n');
    await editor.reportResult({
      task_id: second,
      run_id: claimed.run_id,
      status: 'completed_claim',
      summary: 'noted b',
      changed_paths: ['src/b.mjs'],
      checks: [],
    });
    const verified = await td.operator.post<{ task: TaskView; verification: VerificationView }>(
      td.operator.projectPath(`/tasks/${second}/verify`),
      {},
      { timeoutMs: 120_000 },
    );
    expect(verified.task.status, JSON.stringify(verified.verification.checks)).toBe('COMPLETED');
    const two = await integrationOf(td, second);
    expect(two, two.summary ?? '').toMatchObject({ status: 'integrated', base_commit: tip });
    expect((await git(['show', `${branch}:src/b.mjs`])).trim()).toBe('// b stays small\nexport const b = 1;');
    await runOnce(td);
    await eventually(
      () => td.operator.get<GoalDetail>(td.operator.projectPath(`/goals/${goalId}`)),
      (g) => g.goal.status === 'COMPLETED',
      'the goal to complete',
    );
    // Both files are in the folder already; landing moves the branch over them.
    expect(await land(td, goalId)).toMatchObject({ status: 'landed', fast_forward: true });
    expect((await runGit(ws().projectDir, ['status', '--porcelain'])).stdout).toBe('?? notes.txt\n');
    expect(text('src/a.mjs')).toBe('export const a = 2;\n');
  });

  /**
   * The run of 2026-11-17, kept: two agents Friday starts and one a person runs in the project
   * folder, on one plan. That day it needed three manual workarounds (a commit by hand, a merge
   * into a task folder, a check passed by hand); every step below is one of the places it broke.
   */
  it('takes one plan through three agents, two Friday starts and one in the project folder, with no step by hand', async () => {
    const td = await project(CHECKS, { 'src/c.mjs': 'export const c = 1;\n' }, L0);
    const pid = td.project.project_id;
    const claude = await FakeHarness.connect(td, { agentKey: 'claude-1' });
    const codex = await FakeHarness.connect(td, { agentKey: 'codex-1' });
    ws().track({ close: () => claude.close() });
    ws().track({ close: () => codex.close() });
    const editor = await folderSession(td);
    const { goalId, ids } = await goalWith(td, [
      { key: 'contract', summary: 'Raise a to 2', write: ['src/a.mjs'], assign_to: 'antigravity-1' },
      { key: 'backend', summary: 'Say what b is for', write: ['src/b.mjs'], depends_on: ['contract'] },
      { key: 'frontend', summary: 'Say what c is for', write: ['src/c.mjs'], depends_on: ['contract'] },
      {
        key: 'readme',
        summary: 'Describe a, b and c',
        write: ['README.md'],
        depends_on: ['backend', 'frontend'],
        assign_to: 'antigravity-1',
      },
    ]);
    const id = (key: string) => ids[key] as string;
    const verify = async (taskId: string) => {
      const v = await td.operator.post<{ task: TaskView; verification: VerificationView }>(
        td.operator.projectPath(`/tasks/${taskId}/verify`),
        {},
        { timeoutMs: 120_000 },
      );
      expect(v.task.status, JSON.stringify(v.verification.checks)).toBe('COMPLETED');
      expect(await integrationOf(td, taskId)).toMatchObject({ status: 'integrated' });
    };
    const inFolder = async (taskId: string, files: Record<string, string>) => {
      const claimed = (await editor.claim({ next: true })) as { run_id: string; task: TaskView; note: string | null };
      expect(claimed.task.task_id).toBe(taskId);
      for (const [rel, body] of Object.entries(files)) writeFileSync(file(rel), body);
      await editor.reportResult({
        task_id: taskId,
        run_id: claimed.run_id,
        status: 'completed_claim',
        summary: `changed ${Object.keys(files).join(', ')}`,
        changed_paths: Object.keys(files),
        checks: [],
      });
      await verify(taskId);
      return claimed;
    };

    // 1. The first task is the folder agent's. Its work reaches the goal without a commit by hand.
    await runOnce(td);
    await inFolder(id('contract'), { 'src/a.mjs': 'export const a = 2;\n' });

    // 2. The two tasks that depend on it go to the agents that start by themselves, one each, though
    // the folder agent is free and has the higher score; and each starts in a folder that has a = 2.
    await runOnce(td);
    const starts = await Promise.all(
      [claude, codex].map(async (fake) => ({
        fake,
        start: (await fake.waitFor('task.start', 20_000)).params as TaskStartParams,
      })),
    );
    expect(starts.map((x) => x.start.task_id).sort()).toEqual([id('backend'), id('frontend')].sort());
    expect((await taskOf(td, id('readme'))).status).toBe('PROPOSED');
    for (const x of starts) {
      expect(readFileSync(path.join(x.start.working_directory, 'src/a.mjs'), 'utf8').trim()).toBe(
        'export const a = 2;',
      );
      const rel = x.start.task_id === id('backend') ? 'src/b.mjs' : 'src/c.mjs';
      const name = rel === 'src/b.mjs' ? 'b' : 'c';
      await eventually(
        () => taskOf(td, x.start.task_id),
        (t) => t.status === 'RUNNING',
        `${x.start.task_id} to run`,
      );
      await finish(
        td,
        { fake: x.fake, start: x.start, taskId: x.start.task_id },
        {
          [rel]: `// ${name} stays small\nexport const ${name} = 1;\n`,
        },
      );
      expect(await integrationOf(td, x.start.task_id)).toMatchObject({ status: 'integrated' });
    }

    // 3. The last task is the folder agent's again: the others' finished work is in its folder
    // before it starts, and it is told so.
    await runOnce(td);
    expect(text('src/b.mjs')).toBe('export const b = 1;\n');
    const last = await inFolder(id('readme'), { 'README.md': '# a, b and c\n\na is 2; b and c stay small.\n' });
    expect(last.note).toContain('put the finished work');
    expect(text('src/b.mjs')).toBe('// b stays small\nexport const b = 1;\n');
    expect(text('src/c.mjs')).toBe('// c stays small\nexport const c = 1;\n');

    // 4. The goal completes and lands in one step over what the folder already holds.
    await runOnce(td);
    await eventually(
      () => td.operator.get<GoalDetail>(td.operator.projectPath(`/goals/${goalId}`)),
      (g) => g.goal.status === 'COMPLETED',
      'the goal to complete',
    );
    expect(await land(td, goalId)).toMatchObject({ status: 'landed', fast_forward: true });
    expect((await runGit(ws().projectDir, ['status', '--porcelain'])).stdout).toBe('');
    expect(await head()).toBe((await git(['rev-parse', `friday/goal-${goalId}`])).trim());
    // No attempt was repeated: one run per task, none blocked, none passed by hand.
    for (const key of ['contract', 'backend', 'frontend', 'readme']) {
      expect(td.daemon.state.q.runs(id(key)), key).toHaveLength(1);
      expect(td.daemon.state.q.latestVerification(id(key))?.checks.some((c) => c.kind === 'manual')).toBe(false);
    }
    expect(td.daemon.state.q.escalations(pid, 'pending')).toEqual([]);
  });

  it('never writes over a file the person changed in the folder, and says so to the agent', async () => {
    const td = await project(CHECKS, {}, L0);
    const mainHead = await head();
    const { ids } = await goalWith(td, [
      { key: 'raise-a', summary: 'Raise a to 2', write: ['src/a.mjs'] },
      { key: 'note-b', summary: 'Say what b is for', write: ['src/b.mjs'], depends_on: ['raise-a'] },
    ]);
    const second = ids['note-b'] as string;
    await work(td, 'be-1', ids['raise-a'] as string, { 'src/a.mjs': 'export const a = 2;\n' });
    await integrationOf(td, ids['raise-a'] as string);
    writeFileSync(file('src/a.mjs'), 'export const a = 1; // mine, not saved yet\n');
    const editor = await folderSession(td);
    await td.operator.post(td.operator.projectPath(`/tasks/${second}/assign`), { agent_key: 'antigravity-1' });
    const claimed = (await editor.claim({ task_id: second })) as { run_id: string; note: string | null };
    expect(text('src/a.mjs')).toBe('export const a = 1; // mine, not saved yet\n');
    expect(claimed.note).toContain('did not replace them');
    expect(claimed.note).toContain('src/a.mjs');
    // With something in the way the attempt starts from the folder's own commit, as before.
    expect(td.daemon.state.q.run(claimed.run_id).base_commit).toBe(mainHead);
    expect(
      td.daemon.state.store.readByRef(td.project.project_id, 'task', second, { types: ['folder.synced'] })[0]?.payload,
    ).toMatchObject({ brought: [], in_the_way: ['src/a.mjs'] });
  });

  it('keeps a folder file the person changed differently in the way of landing', async () => {
    const td = await project();
    const { goalId, ids } = await goalWith(td, [{ key: 'raise-a', summary: 'Raise a to 2', write: ['src/a.mjs'] }]);
    await work(td, 'be-1', ids['raise-a'] as string, { 'src/a.mjs': 'export const a = 2;\n' });
    await integrationOf(td, ids['raise-a'] as string);
    await runOnce(td);
    writeFileSync(file('src/a.mjs'), 'export const a = 3; // mine\n');
    const p = await plan(td, goalId);
    expect(p).toMatchObject({ state: 'blocked', files: ['src/a.mjs'] });
    await expect(land(td, goalId)).rejects.toThrow(/not committed, and the goal changes them too/);
    expect(text('src/a.mjs')).toBe('export const a = 3; // mine\n');
  });

  it('has nothing to land for work made in the project folder itself, and says to commit it', async () => {
    // Worktrees off: every run works in the main checkout, as a session attached from an editor does.
    const td = await project(CHECKS, {}, '\nworktrees:\n  mode: off\n');
    const { goalId, ids } = await goalWith(td, [{ key: 'raise-a', summary: 'Raise a to 2', write: ['src/a.mjs'] }]);
    await work(td, 'be-1', ids['raise-a'] as string, { 'src/a.mjs': 'export const a = 2;\n' });
    await runOnce(td);
    expect((await td.operator.get<GoalDetail>(td.operator.projectPath(`/goals/${goalId}`))).goal.status).toBe(
      'COMPLETED',
    );
    const p = await plan(td, goalId);
    expect(p).toMatchObject({ state: 'in_folder', work: 'folder' });
    expect(p.reason).toContain('already there');
    // What there is to review and commit.
    expect(p.files).toContain('src/a.mjs');
    await expect(land(td, goalId)).rejects.toThrow(/there is no branch to land/);
    const snapshot = await td.operator.get<{ goal_landing?: Record<string, { work: string }> }>(
      td.operator.projectPath('/ui/snapshot'),
    );
    expect(snapshot.goal_landing?.[goalId]).toMatchObject({ work: 'folder', landed: null });
  });
});

describe('checks on a merged revision', () => {
  const pnpm = spawnSync('pnpm', ['--version'], { shell: true, encoding: 'utf8' });
  /** The project's test needs an installed package, as most projects' tests do. */
  const NEEDS_TINY = [
    "import assert from 'node:assert';",
    "import { createRequire } from 'node:module';",
    "import { test } from 'node:test';",
    "import { a } from '../src/a.mjs';",
    "import { b } from '../src/b.mjs';",
    "const tiny = createRequire(import.meta.url)('tiny');",
    "test('a + b stays small', () => assert.ok(a + b <= 3 + tiny));",
    '',
  ].join('\n');

  it.skipIf(pnpm.status !== 0)(
    'run with the dependencies installed, as in a task worktree, so two parallel tasks of a goal integrate',
    async () => {
      const td = await project(CHECKS, {
        'package.json': '{"name":"shop","private":true,"dependencies":{"tiny":"file:vendor/tiny"}}\n',
        'vendor/tiny/package.json': '{"name":"tiny","version":"1.0.0"}\n',
        'vendor/tiny/index.js': 'module.exports = 0;\n',
        'test/sum.test.mjs': NEEDS_TINY,
        '.gitignore': 'node_modules/\n',
      });
      const dir = ws().projectDir;
      const lock = spawnSync('pnpm', ['install', '--lockfile-only', '--ignore-scripts', '--ignore-pnpmfile'], {
        cwd: dir,
        shell: true,
        encoding: 'utf8',
      });
      expect(lock.status, lock.stderr).toBe(0);
      await deterministicGit(dir, { startEpoch: 1_767_225_800 }).commitAll('lockfile');
      const { goalId, ids } = await goalWith(td, [
        { key: 'raise-a', summary: 'Raise a to 2', write: ['src/a.mjs'] },
        { key: 'add-c', summary: 'Add c', write: ['src/c.mjs'] },
      ]);
      // Both start from the same commit, in parallel: the second to finish needs a real merge.
      const ra = await begin(td, 'be-1', ids['raise-a'] as string);
      const rc = await begin(td, 'be-2', ids['add-c'] as string);
      await finish(td, ra, { 'src/a.mjs': 'export const a = 2;\n' });
      expect((await integrationOf(td, ids['raise-a'] as string)).status).toBe('integrated');
      await finish(td, rc, { 'src/c.mjs': 'export const c = 1;\n' });
      // The merged revision is checked in Friday's own checkout, which now has the package too:
      // without it this check failed there ("Cannot find module 'tiny'"), again on every retry.
      const two = await integrationOf(td, ids['add-c'] as string);
      expect(two.checks.map((c) => [c.name, c.status])).toEqual([['tests', 'PASSED']]);
      expect(two.status, two.summary ?? '').toBe('integrated');
      await runOnce(td);
      expect((await td.operator.get<GoalDetail>(td.operator.projectPath(`/goals/${goalId}`))).goal.status).toBe(
        'COMPLETED',
      );
      // Nothing of the install is in the revision, and the main checkout was not touched.
      expect(await git(['status', '--porcelain'])).toBe('');
    },
    240_000,
  );
});

describe('turning automatic verification on', () => {
  it('checks the work that already waits, without a restart', async () => {
    const td = await project();
    const { ids } = await goalWith(td, [{ key: 'raise-a', summary: 'Raise a to 2', write: ['src/a.mjs'] }]);
    const id = ids['raise-a'] as string;
    // An agent finishes while automatic verification is off: its claim waits for a person.
    const w = await begin(td, 'be-1', id);
    writeFileSync(path.join(w.start.working_directory, 'src', 'a.mjs'), 'export const a = 2;\n');
    await w.fake.client.reportResult({
      task_id: id,
      run_id: w.start.run_id,
      status: 'completed_claim',
      summary: 'a is 2',
      changed_paths: ['src/a.mjs'],
      checks: [],
    });
    await w.fake.close();
    await eventually(
      () => taskOf(td, id),
      (t) => t.status === 'READY_FOR_VERIFICATION',
      'the claim',
    );
    // The person turns it on in Settings, and trusts it: a setting, then this clone's trust.
    await td.operator.post(td.operator.projectPath('/config/settings'), {
      set: { 'verification.auto_on_completion': true },
    });
    expect((await taskOf(td, id)).status).toBe('READY_FOR_VERIFICATION');
    const view = await td.operator.get<{ policy: { loosening_hash: string } }>(td.operator.projectPath('/policy'));
    await td.operator.post(td.operator.projectPath('/policy/trust'), { loosening_hash: view.policy.loosening_hash });
    // The board is read again, as the page does after the switch; the waiting claim is verified.
    const done = await eventually(
      async () => {
        await td.operator.get(td.operator.projectPath('/ui/snapshot'));
        return taskOf(td, id);
      },
      (t) => t.status === 'COMPLETED',
      'the automatic verification of the waiting claim',
      60_000,
    );
    expect(done.status).toBe('COMPLETED');
  });
});
