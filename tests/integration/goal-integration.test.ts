/**
 * Integration of verified task branches into goal branches (plan M5c, ADR-0025).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GenericHarnessClient } from '@friday/adapter-generic';
import { landedGoals, landGoal, landingWatch } from '@friday/daemon';
import { closeDatabase, openDatabase } from '@friday/db';
import { commitContent, FRIDAY_IDENTITY, GitRoot, runGit } from '@friday/git';
import type {
  GoalSummary,
  IntegrationView,
  TaskStartParams,
  TaskView,
  UiSnapshot,
  VerificationView,
} from '@friday/protocol';
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
/** Work that does not fit the goal's other work asks a person at once, never its agent first. */
const ASK_AT_ONCE = 'integration:\n  back_to_agent: 0\n';

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
    const td = await project(CHECKS, {}, ASK_AT_ONCE);
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
    const td = await project(limitChecks(flag), { 'scripts/limit.cjs': LIMIT }, ASK_AT_ONCE);
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
    const td = await project(CHECKS, {}, ASK_AT_ONCE);
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

/**
 * Agents at work at the same time (2026-11-18). Until then a task waited for every running task
 * whose write scope touched one of its files, and every plan of the trial project listed the
 * changelog: seven goals, never two agents at once. Now each works in a folder of its own, Friday
 * merges their verified work, and what does not fit goes back to its agent before a person is asked.
 */
describe('agents at work at the same time (2026-11-18)', () => {
  const lf = (text: string) => text.replace(/\r\n/g, '\n');
  const pending = (td: TestDaemon) =>
    td.daemon.state.q.escalations(td.project.project_id, 'pending').map((e) => [e.kind, e.task_id]);
  const reworks = (td: TestDaemon, taskId: string) =>
    td.daemon.state.store
      .readByRef(td.project.project_id, 'task', taskId, { types: ['task.rework'] })
      .map((e) => (e.payload as { transition: { trigger: string; reason?: string } }).transition);
  /** The task's `n`th integration: after work went back, the first one is still on record. */
  const nthIntegration = (td: TestDaemon, taskId: string, n: number) =>
    eventually(
      () => td.daemon.state.q.integrations(td.project.project_id, { task_id: taskId }),
      (all) => all.length >= n,
      `integration ${n} of ${taskId}`,
    ).then((all) => all[n - 1] as IntegrationView);
  /** The agent that did the work is connected again and gets the task back from the coordinator. */
  async function again(td: TestDaemon, agent: string, taskId: string, attempt: number) {
    const fake = await FakeHarness.connect(td, { agentKey: agent });
    await runOnce(td);
    const start = (await fake.waitFor('task.start', 20_000, (m) => (m.params as TaskStartParams).attempt === attempt))
      .params as TaskStartParams;
    await eventually(
      () => taskOf(td, taskId),
      (t) => t.status === 'RUNNING',
      `${taskId} to run again`,
    );
    return { fake, start, taskId };
  }

  it('gives two free agents a task each though both tasks change the changelog, and keeps both entries', async () => {
    const td = await project(CHECKS, { 'CHANGELOG.md': '# Changelog\n\n- first\n' });
    const one = await FakeHarness.connect(td, { agentKey: 'claude-1' });
    const two = await FakeHarness.connect(td, { agentKey: 'codex-1' });
    const { goalId, ids } = await goalWith(td, [
      { key: 'wizard', summary: 'Add the wizard', write: ['src/a.mjs', 'CHANGELOG.md'] },
      { key: 'settings', summary: 'Add the settings', write: ['src/b.mjs', 'CHANGELOG.md'] },
    ]);
    // One pass of the coordinator: both run, each agent with one, each in a folder of its own.
    await runOnce(td);
    const s1 = (await one.waitFor('task.start', 20_000)).params as TaskStartParams;
    const s2 = (await two.waitFor('task.start', 20_000)).params as TaskStartParams;
    expect(new Set([s1.task_id, s2.task_id])).toEqual(new Set([ids.wizard, ids.settings]));
    expect(s1.working_directory).not.toBe(s2.working_directory);
    for (const id of [ids.wizard, ids.settings]) {
      await eventually(
        () => taskOf(td, id as string),
        (t) => t.status === 'RUNNING',
        `${id} to run`,
      );
    }
    // Each is told which file it shares, and how to treat it.
    const packet = await td.operator.post<{ packet: { sections: { id: string; content: string }[] } }>(
      td.operator.projectPath('/context/compile'),
      { task_id: s1.task_id },
    );
    expect(JSON.stringify(packet)).toContain('Shared with other tasks of this goal');
    expect(JSON.stringify(packet)).toContain('CHANGELOG.md');

    const mine = (start: TaskStartParams) => (start.task_id === ids.wizard ? 'wizard' : 'settings');
    const files = (which: string): Record<string, string> =>
      which === 'wizard'
        ? { 'src/a.mjs': 'export const a = 2;\n', 'CHANGELOG.md': '# Changelog\n\n- first\n- the wizard\n' }
        : { 'src/b.mjs': 'export const b = 0;\n', 'CHANGELOG.md': '# Changelog\n\n- first\n- the settings\n' };
    await finish(td, { fake: one, start: s1, taskId: s1.task_id }, files(mine(s1)));
    expect((await integrationOf(td, s1.task_id)).status).toBe('integrated');
    await finish(td, { fake: two, start: s2, taskId: s2.task_id }, files(mine(s2)));
    const second = await integrationOf(td, s2.task_id);
    // Git alone calls two additions at one place a conflict; Friday keeps both and checks the result.
    expect(second, second.summary ?? '').toMatchObject({ status: 'integrated', conflicts: [] });
    expect(second.summary).toContain("both sides' added lines were kept in CHANGELOG.md");
    expect(second.checks.map((c) => [c.name, c.status])).toEqual([['tests', 'PASSED']]);
    const branch = `friday/goal-${goalId}`;
    const log = lf((await runGit(ws().projectDir, ['show', `${branch}:CHANGELOG.md`])).stdout);
    expect(log).toBe(`# Changelog\n\n- first\n- the ${mine(s1)}\n- the ${mine(s2)}\n`);
    expect(pending(td)).toEqual([]);
    expect(reworks(td, s2.task_id)).toEqual([]);
    await runOnce(td);
    expect((await td.operator.get<GoalDetail>(td.operator.projectPath(`/goals/${goalId}`))).goal.status).toBe(
      'COMPLETED',
    );
  });

  it('sends a real collision back to its agent with both versions in the file, and integrates what it makes of them', async () => {
    const td = await project(CHECKS, { 'src/mode.mjs': 'export const mode = "none";\n' });
    const { goalId, ids } = await goalWith(td, [
      { key: 'raise-a', summary: 'Raise a', write: ['src/a.mjs', 'src/mode.mjs'] },
      { key: 'lower-b', summary: 'Lower b', write: ['src/b.mjs', 'src/mode.mjs'] },
    ]);
    const branch = `friday/goal-${goalId}`;
    const ra = await begin(td, 'be-1', ids['raise-a'] as string);
    const rb = await begin(td, 'be-2', ids['lower-b'] as string);
    await finish(td, ra, { 'src/a.mjs': 'export const a = 2;\n', 'src/mode.mjs': 'export const mode = "a";\n' });
    expect((await integrationOf(td, ids['raise-a'] as string)).status).toBe('integrated');
    await finish(td, rb, { 'src/b.mjs': 'export const b = 0;\n', 'src/mode.mjs': 'export const mode = "b";\n' });
    const lower = ids['lower-b'] as string;
    const collided = await integrationOf(td, lower);
    expect(collided).toMatchObject({ status: 'conflicted', conflicts: ['src/mode.mjs'] });

    // Nobody is asked: the task is its agent's again, with the reason, and the goal waits for it.
    expect(pending(td)).toEqual([]);
    const back = await taskOf(td, lower);
    expect(back).toMatchObject({ status: 'READY', reserved_for_agent_key: 'be-2', completed_at: null });
    expect(reworks(td, lower)).toEqual([
      expect.objectContaining({ trigger: 'integration.rework', reason: expect.stringContaining('src/mode.mjs') }),
    ]);
    await runOnce(td);
    expect((await td.operator.get<GoalDetail>(td.operator.projectPath(`/goals/${goalId}`))).goal.status).toBe('ACTIVE');

    // The agent gets it back in the folder it worked in, merged as far as git could.
    const w = await again(td, 'be-2', lower, 2);
    const dir = w.start.working_directory;
    expect(dir).toBe(rb.start.working_directory);
    expect(w.start.note).toContain('src/mode.mjs');
    expect(w.start.note).toContain('hold both versions');
    expect(lf(readFileSync(path.join(dir, 'src', 'a.mjs'), 'utf8'))).toBe('export const a = 2;\n');
    expect(lf(readFileSync(path.join(dir, 'src', 'b.mjs'), 'utf8'))).toBe('export const b = 0;\n');
    expect(lf(readFileSync(path.join(dir, 'src', 'mode.mjs'), 'utf8'))).toMatch(
      /^<<<<<<< .*\nexport const mode = "b";\n=======\nexport const mode = "a";\n>>>>>>> .*\n$/,
    );

    // It keeps what both meant, by editing: no git command of its own.
    await finish(td, w, { 'src/mode.mjs': 'export const mode = "a and b";\n' });
    const done = await nthIntegration(td, lower, 2);
    expect(done, done.summary ?? '').toMatchObject({ status: 'integrated' });
    expect(done.summary).toContain('fast-forward');
    expect(lf((await runGit(ws().projectDir, ['show', `${branch}:src/mode.mjs`])).stdout)).toBe(
      'export const mode = "a and b";\n',
    );
    expect(lf((await runGit(ws().projectDir, ['show', `${branch}:src/a.mjs`])).stdout)).toBe('export const a = 2;\n');
    expect(pending(td)).toEqual([]);
    await runOnce(td);
    expect((await td.operator.get<GoalDetail>(td.operator.projectPath(`/goals/${goalId}`))).goal.status).toBe(
      'COMPLETED',
    );
  });

  it('sends work back that passes alone and fails once merged, naming the check', async () => {
    const td = await project();
    const { goalId, ids } = await goalWith(td, [
      { key: 'raise-a', summary: 'Raise a to 2', write: ['src/a.mjs'] },
      { key: 'raise-b', summary: 'Raise b to 2', write: ['src/b.mjs'] },
    ]);
    const ra = await begin(td, 'be-1', ids['raise-a'] as string);
    const rb = await begin(td, 'be-2', ids['raise-b'] as string);
    await finish(td, ra, { 'src/a.mjs': 'export const a = 2;\n' });
    expect((await integrationOf(td, ids['raise-a'] as string)).status).toBe('integrated');
    // Alone b = 2 passes; with a = 2 the sum is 4.
    await finish(td, rb, { 'src/b.mjs': 'export const b = 2;\n' });
    const raiseB = ids['raise-b'] as string;
    expect(await integrationOf(td, raiseB)).toMatchObject({ status: 'failed' });
    expect(pending(td)).toEqual([]);
    expect(reworks(td, raiseB)).toEqual([
      expect.objectContaining({ trigger: 'integration.rework', reason: expect.stringContaining('tests') }),
    ]);
    expect(reworks(td, raiseB)[0]?.reason).toContain('merged with what other tasks');

    // Its folder now holds the other task's work, so the failing check fails there too.
    const w = await again(td, 'be-2', raiseB, 2);
    expect(lf(readFileSync(path.join(w.start.working_directory, 'src', 'a.mjs'), 'utf8'))).toBe(
      'export const a = 2;\n',
    );
    await finish(td, w, { 'src/b.mjs': 'export const b = 1;\n' });
    expect(await nthIntegration(td, raiseB, 2)).toMatchObject({ status: 'integrated' });
    expect(lf((await runGit(ws().projectDir, ['show', `friday/goal-${goalId}:src/b.mjs`])).stdout)).toBe(
      'export const b = 1;\n',
    );
    expect(pending(td)).toEqual([]);
  });

  // A check that only ran out of time on the merged work (2026-11-19, the trial's F8): a busy
  // computer, not the work. It gets a second try with twice the time; still out of time, the person
  // is asked, in those words, and the work is not sent back to its agent.
  it('asks the person, and sends nothing back, when a check only ran out of time on the merged work', async () => {
    const SLOW = [
      "const fs = require('node:fs');",
      "const num = (f) => Number(/= (\\d+)/.exec(fs.readFileSync(f, 'utf8'))[1]);",
      // Quick alone; with both raised it never ends.
      "if (num('src/a.mjs') + num('src/b.mjs') > 3) setInterval(() => {}, 1000); else process.exit(0);",
      '',
    ].join('\n');
    const td = await project(
      '  checks:\n    - name: slow\n      command: node\n      args: ["scripts/slow.cjs"]\n      timeout_ms: 1500\n',
      { 'scripts/slow.cjs': SLOW },
    );
    const { ids } = await goalWith(td, [
      { key: 'raise-a', summary: 'Raise a to 2', write: ['src/a.mjs'] },
      { key: 'raise-b', summary: 'Raise b to 2', write: ['src/b.mjs'] },
    ]);
    const ra = await begin(td, 'be-1', ids['raise-a'] as string);
    const rb = await begin(td, 'be-2', ids['raise-b'] as string);
    await finish(td, ra, { 'src/a.mjs': 'export const a = 2;\n' });
    expect((await integrationOf(td, ids['raise-a'] as string)).status).toBe('integrated');
    await finish(td, rb, { 'src/b.mjs': 'export const b = 2;\n' });
    const raiseB = ids['raise-b'] as string;
    const failed = await integrationOf(td, raiseB);
    expect(failed.status).toBe('failed');
    expect(failed.summary).toMatch(
      /^1 required check\(s\) ran out of time on the merged revision [0-9a-f]{12}, also on a second try with twice the time/,
    );
    expect(failed.summary).toContain('more time in Settings → Checks');
    expect(failed.checks?.[0]?.summary).toBe('ran out of time twice: stopped at its 2 s limit, then at 3 s');
    expect(reworks(td, raiseB)).toEqual([]);
    expect(pending(td).map(([, task]) => task)).toEqual([raiseB]);
    expect((await taskOf(td, raiseB)).status).toBe('COMPLETED');
  }, 120_000);

  it('asks the person once the work went back as often as the setting says, with a button that sends it again', async () => {
    const td = await project(CHECKS, {}, 'integration:\n  back_to_agent: 1\n');
    const { goalId, ids } = await goalWith(td, [
      { key: 'raise-a', summary: 'Raise a to 2', write: ['src/a.mjs'] },
      { key: 'reset-a', summary: 'Set a to 0', write: ['src/a.mjs'], depends_on: ['raise-a'] },
    ]);
    const branch = `friday/goal-${goalId}`;
    await work(td, 'be-1', ids['raise-a'] as string, { 'src/a.mjs': 'export const a = 2;\n' });
    expect((await integrationOf(td, ids['raise-a'] as string)).status).toBe('integrated');
    await runOnce(td);
    const reset = ids['reset-a'] as string;
    /** Somebody else changes the same line in the goal while the agent works. */
    const meanwhile = async (value: number, epoch: number) => {
      const human = path.join(ws().root, `human-${value}`);
      await git(['worktree', 'add', '-q', human, branch]);
      writeFileSync(path.join(human, 'src', 'a.mjs'), `export const a = ${value};\n`);
      await deterministicGit(human, { startEpoch: epoch }).commitAll(`a is ${value}`);
      await git(['worktree', 'remove', human]);
    };
    const w = await begin(td, 'be-2', reset);
    await meanwhile(3, 1_767_226_000);
    await finish(td, w, { 'src/a.mjs': 'export const a = 0;\n' });
    expect(await integrationOf(td, reset)).toMatchObject({ status: 'conflicted' });
    // Once by itself.
    expect(pending(td)).toEqual([]);
    const second = await again(td, 'be-2', reset, 2);
    await meanwhile(1, 1_767_227_000);
    await finish(td, second, { 'src/a.mjs': 'export const a = 0;\n' });
    expect(await nthIntegration(td, reset, 2)).toMatchObject({ status: 'conflicted' });
    // The second time the person is asked, and the task stays completed, its work kept.
    expect(pending(td)).toEqual([['integration_conflict', reset]]);
    expect((await taskOf(td, reset)).status).toBe('COMPLETED');

    // Their button: the agent tries once more. The question closes, the task is its agent's again.
    const sent = await td.operator.post<{ task: TaskView }>(
      td.operator.projectPath(`/tasks/${reset}/integrate/back`),
      {},
    );
    expect(sent.task).toMatchObject({ status: 'READY', reserved_for_agent_key: 'be-2' });
    expect(pending(td)).toEqual([]);
    expect(reworks(td, reset).map((r) => r.trigger)).toEqual(['integration.rework', 'integration.rework']);
    // A task with nothing to send back says so.
    await expect(
      td.operator.post(td.operator.projectPath(`/tasks/${ids['raise-a']}/integrate/back`), {}),
    ).rejects.toThrow(/no failed or conflicted integration/);
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

  // In the trial a goal landed into the project folder while Antigravity worked there, and nothing
  // said so (2026-11-18). The plan names who is at work; landing by itself waits; a person decides.
  it('names an agent at work in the project folder before landing, and does not land by itself meanwhile', async () => {
    const td = await project();
    const goalId = await completedGoal(td);
    // An agent its person runs, at work on a task in the project folder.
    const editor = await FakeHarness.connect(td, { agentKey: 'antigravity-1', mode: 'attach' });
    const loose = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
      summary: 'polish the docs',
      scope: { write: ['docs/**'], read: [] },
      assign_agent_key: 'antigravity-1',
    });
    await editor.client.claim({ task_id: loose.task_id });
    expect(await plan(td, goalId)).toMatchObject({ state: 'ready', busy: ['antigravity-1'] });
    const before = await head();
    await expect(landGoal(td.daemon.state, td.project, goalId, { kind: 'system', id: 'friday' })).rejects.toThrow(
      /antigravity-1 is working in the project folder right now/,
    );
    expect(await head()).toBe(before);
    // A person who pressed Land was told, and lands.
    expect(await land(td, goalId)).toMatchObject({ status: 'landed' });
    await editor.close();
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
    // In plain words, with none of Friday's ids (2026-11-19, the trial: "Integrate
    // task_1rsz5wbks9145nqfgnkqa1k4pg: …"): what the goal was, and what its tasks did.
    const message = (await git(['log', '-1', '--format=%B'])).trim();
    expect(message).toMatch(/^Merge: \S/);
    expect(message).toContain('The work of one task, checked by Friday:\n- Raise a to 2');
    const history = await git(['log', '--format=%B', `${mine}..HEAD`]);
    expect(history).toContain('Checked by Friday: its checks passed.');
    expect(history).not.toMatch(/\b(goal|task|run|ver)_[0-9a-z]{6,}|friday\/goal-|verified as/);

    // A second goal, merged by the person in their own terminal: Friday records it when asked, once.
    const { goalId: second, ids } = await goalWith(td, [{ key: 'raise-b', summary: 'Raise b', write: ['src/b.mjs'] }]);
    const id = ids['raise-b'] as string;
    await work(td, 'be-2', id, { 'src/b.mjs': 'export const b = 1;\n' });
    await integrationOf(td, id);
    await runOnce(td);
    await runGit(ws().projectDir, ['merge', '--no-edit', `friday/goal-${second}`]);
    const landings = () =>
      td.daemon.state.store
        .readSince(td.project.project_id, 0, { types: ['goal.landed'], limit: 10 })
        .filter((e) => (e.payload as { goal_id?: string }).goal_id === second);
    // Friday notices it by itself (2026-11-18): the card says "Landed" though nobody clicked. In the
    // trial a goal said "Ready to land" for half an hour after it had landed.
    const watch = landingWatch(td.daemon.state, td.project);
    expect(await watch()).toEqual([second]);
    expect(landedGoals(td.daemon.state, td.project.project_id).get(second)?.into).toBe(
      (await git(['branch', '--show-current'])).trim(),
    );
    expect((landings()[0]?.payload as { by_hand?: boolean } | undefined)?.by_hand).toBe(true);
    // Nothing changed since: nothing is read or recorded again.
    expect(await watch()).toEqual([]);
    expect(await plan(td, second)).toMatchObject({ state: 'landed' });
    expect(await land(td, second)).toMatchObject({ status: 'already' });
    expect(landings()).toHaveLength(1);
    // Neither goal says "Ready to land" on the board.
    const board = await td.operator.get<UiSnapshot>(td.operator.projectPath('/ui/snapshot'));
    expect(board.goal_landing?.[second]?.landed).toBeTruthy();
    expect(board.goal_landing?.[goalId]?.landed).toBeTruthy();
  });

  it('records a goal as landed when its dialog is opened after a merge made by hand (2026-11-18)', async () => {
    const td = await project();
    const goalId = await completedGoal(td);
    await runGit(ws().projectDir, ['merge', '--no-edit', `friday/goal-${goalId}`]);
    expect(landedGoals(td.daemon.state, td.project.project_id).has(goalId)).toBe(false);
    // Reading what Land would do is enough: the dialog has nothing left to ask the person.
    expect(await plan(td, goalId)).toMatchObject({ state: 'landed' });
    expect(landedGoals(td.daemon.state, td.project.project_id).has(goalId)).toBe(true);
    await plan(td, goalId);
    expect(
      td.daemon.state.store.readSince(td.project.project_id, 0, { types: ['goal.landed'], limit: 10 }),
    ).toHaveLength(1);
    // Not taken for landed: a goal whose task changed nothing (its branch is in the folder's history
    // from the start, with nothing to bring), nor a goal not merged yet.
    const { goalId: empty, ids: same } = await goalWith(td, [
      { key: 'keep-b', summary: 'Keep b as it is', write: ['src/b.mjs'] },
    ]);
    await work(td, 'be-2', same['keep-b'] as string, { 'src/b.mjs': 'export const b = 1;\n' });
    await integrationOf(td, same['keep-b'] as string);
    const { goalId: other, ids } = await goalWith(td, [{ key: 'lower-b', summary: 'Lower b', write: ['src/b.mjs'] }]);
    await work(td, 'be-3', ids['lower-b'] as string, { 'src/b.mjs': 'export const b = 0;\n' });
    await integrationOf(td, ids['lower-b'] as string);
    await runOnce(td);
    expect(await landingWatch(td.daemon.state, td.project)()).toEqual([]);
    expect(landedGoals(td.daemon.state, td.project.project_id).has(empty)).toBe(false);
    expect(landedGoals(td.daemon.state, td.project.project_id).has(other)).toBe(false);
    // Merged now: found.
    await runGit(ws().projectDir, ['merge', '--no-edit', `friday/goal-${other}`]);
    expect(await landingWatch(td.daemon.state, td.project)()).toEqual([other]);
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
    // It is also told, in a line each, what the two tasks it depends on did (no model call).
    const told = JSON.stringify(last);
    expect(told).toContain('Done before you by claude-1');
    expect(told).toContain('Done before you by codex-1');
    expect(told).toContain('Its work is in your folder.');
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

  describe('a file the person changed that the goal changed too (2026-11-17)', () => {
    const MINE = 'export const a = 1; // mine, not saved yet\n';
    /** The first task done by an agent Friday starts; the person then edits the same file. */
    async function inTheWay() {
      const td = await project(CHECKS, {}, L0);
      const mainHead = await head();
      const { ids } = await goalWith(td, [
        { key: 'raise-a', summary: 'Raise a to 2', write: ['src/a.mjs'] },
        { key: 'note-b', summary: 'Say what b is for', write: ['src/b.mjs'], depends_on: ['raise-a'] },
      ]);
      const second = ids['note-b'] as string;
      await work(td, 'be-1', ids['raise-a'] as string, { 'src/a.mjs': 'export const a = 2;\n' });
      await integrationOf(td, ids['raise-a'] as string);
      writeFileSync(file('src/a.mjs'), MINE);
      const editor = await folderSession(td);
      await td.operator.post(td.operator.projectPath(`/tasks/${second}/assign`), { agent_key: 'antigravity-1' });
      const conflict = () =>
        td.operator.get<{
          goal_head: string | null;
          files: { path: string; mine: string | null; theirs: string | null }[];
        }>(td.operator.projectPath(`/tasks/${second}/folder-conflict`));
      const choose = (take: 'mine' | 'theirs') =>
        td.operator.post<{ remaining: number }>(td.operator.projectPath(`/tasks/${second}/folder-conflict`), {
          path: 'src/a.mjs',
          take,
        });
      const asked = () =>
        td.daemon.state.q
          .escalations(td.project.project_id, 'pending', { task_id: second })
          .filter((e) => e.kind === 'folder_conflict');
      return { td, editor, second, mainHead, conflict, choose, asked };
    }

    it('makes the task wait and asks the person, touching nothing', async () => {
      const x = await inTheWay();
      await expect(x.editor.claim({ task_id: x.second })).rejects.toThrow(/cannot start yet.*src\/a\.mjs/s);
      expect(text('src/a.mjs')).toBe(MINE);
      expect((await taskOf(x.td, x.second)).status).toBe('READY');
      const q = x.asked();
      expect(q).toHaveLength(1);
      expect(q[0]?.question).toContain('src/a.mjs');
      // Asked once, however often the agent tries.
      await expect(x.editor.claim({ task_id: x.second })).rejects.toThrow(/cannot start yet/);
      expect(x.asked()).toHaveLength(1);
      // Both versions, for the person to compare.
      expect((await x.conflict()).files).toEqual([{ path: 'src/a.mjs', mine: MINE, theirs: 'export const a = 2;\n' }]);
    });

    it('"keep mine": the file stays, the question closes and the agent takes the task', async () => {
      const x = await inTheWay();
      await expect(x.editor.claim({ task_id: x.second })).rejects.toThrow();
      expect(await x.choose('mine')).toMatchObject({ remaining: 0 });
      expect(x.asked()).toEqual([]);
      const claimed = (await x.editor.claim({ task_id: x.second })) as { run_id: string };
      expect(text('src/a.mjs')).toBe(MINE);
      // The folder differs from the goal there, so the attempt starts from the folder's own commit.
      expect(x.td.daemon.state.q.run(claimed.run_id).base_commit).toBe(x.mainHead);
      // The same choice is not asked again.
      expect((await x.conflict()).files).toEqual([]);
    });

    it('"take the finished one": the file is replaced, and "put mine back" restores it byte for byte', async () => {
      const x = await inTheWay();
      await expect(x.editor.claim({ task_id: x.second })).rejects.toThrow();
      expect(await x.choose('theirs')).toMatchObject({ remaining: 0 });
      expect(text('src/a.mjs')).toBe('export const a = 2;\n');
      expect(x.asked()).toEqual([]);
      await x.td.operator.post(x.td.operator.projectPath(`/tasks/${x.second}/folder-conflict/undo`), {
        path: 'src/a.mjs',
      });
      expect(readFileSync(file('src/a.mjs'), 'utf8')).toBe(MINE);
      // Nothing to put back twice, and a file that is not in the way is not a choice.
      await expect(
        x.td.operator.post(x.td.operator.projectPath(`/tasks/${x.second}/folder-conflict/undo`), { path: 'src/a.mjs' }),
      ).rejects.toThrow(/no version/);
      await expect(
        x.td.operator.post(x.td.operator.projectPath(`/tasks/${x.second}/folder-conflict`), {
          path: 'src/b.mjs',
          take: 'theirs',
        }),
      ).rejects.toThrow(/not in the way/);
    });
  });

  it('saves what an agent left half-done in the project folder, and the next agent continues from it (2026-11-17)', async () => {
    const td = await project(CHECKS, {}, L0);
    const pid = td.project.project_id;
    const { ids } = await goalWith(td, [
      { key: 'raise-a', summary: 'Raise a to 2', write: ['src/a.mjs'], assign_to: 'antigravity-1' },
    ]);
    const taskId = ids['raise-a'] as string;
    const editor = await folderSession(td);
    const claimed = (await editor.claim({ next: true })) as { run_id: string };
    const HALF = 'export const a = 2; // half done\n';
    writeFileSync(file('src/a.mjs'), HALF);
    // Its hooks saw the write; then its window is closed and a person gives the task to someone else.
    const agent = td.daemon.state.q.agentByKey(pid, 'antigravity-1');
    td.daemon.state.observePaths(pid, { kind: 'agent', id: String(agent?.agent_id) }, claimed.run_id, ['src/a.mjs']);
    await editor.disconnect().catch(() => undefined);
    const recovered = await td.operator.post<{ preserved_ref: string | null }>(
      td.operator.projectPath(`/tasks/${taskId}/recover`),
      { action: 'reassign', reason: 'its window was closed' },
    );
    expect(recovered.preserved_ref).toContain(`/${taskId}/folder-attempt-1`);
    expect((await git(['show', `${recovered.preserved_ref}:src/a.mjs`])).trim()).toBe(HALF.trim());
    // The folder is as the agent left it.
    expect(text('src/a.mjs')).toBe(HALF);
    expect((await runGit(ws().projectDir, ['status', '--porcelain'])).stdout).toBe(' M src/a.mjs\n');

    // The next agent's own folder starts with that work, as edits not committed, and it is told.
    const next = await begin(td, 'be-1', taskId);
    expect(readFileSync(path.join(next.start.working_directory, 'src/a.mjs'), 'utf8').replace(/\r\n/g, '\n')).toBe(
      HALF,
    );
    expect((await runGit(next.start.working_directory, ['status', '--porcelain'])).stdout).toBe(' M src/a.mjs\n');
    expect(next.start.note).toContain('stopped part-way');
    await next.fake.close();
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

  describe('landing without a click (2026-11-17)', () => {
    const LAND_GOAL = '\nlanding:\n  mode: goal\n';
    const trust = async (td: TestDaemon) => {
      const view = await td.operator.get<{ policy: { loosening_hash: string } }>(td.operator.projectPath('/policy'));
      await td.operator.post(td.operator.projectPath('/policy/trust'), { loosening_hash: view.policy.loosening_hash });
    };
    const oneTaskDone = async (td: TestDaemon) => {
      const { goalId, ids } = await goalWith(td, [{ key: 'raise-a', summary: 'Raise a to 2', write: ['src/a.mjs'] }]);
      await work(td, 'be-1', ids['raise-a'] as string, { 'src/a.mjs': 'export const a = 2;\n' });
      await integrationOf(td, ids['raise-a'] as string);
      await runOnce(td);
      await eventually(
        () => td.operator.get<GoalDetail>(td.operator.projectPath(`/goals/${goalId}`)),
        (g) => g.goal.status === 'COMPLETED',
        'the goal to complete',
      );
      return goalId;
    };
    const tipOf = async (goalId: string) => (await git(['rev-parse', `friday/goal-${goalId}`])).trim();
    const landings = (td: TestDaemon, type: string) =>
      td.daemon.state.store.readSince(td.project.project_id, 0, { types: [type], limit: 20 });

    it('lands a finished goal by itself once this computer trusts the setting', async () => {
      const td = await project(CHECKS, {}, LAND_GOAL);
      await trust(td);
      const goalId = await oneTaskDone(td);
      const tip = await tipOf(goalId);
      await eventually(head, (h) => h === tip, 'the goal to land by itself');
      expect(text('src/a.mjs')).toBe('export const a = 2;\n');
      expect((await runGit(ws().projectDir, ['status', '--porcelain'])).stdout).toBe('');
      const landed = await eventually(
        () => landings(td, 'goal.landed'),
        (es) => es.length === 1,
        'the landing on record',
      );
      expect(landed[0]?.actor).toMatchObject({ kind: 'system' });
    });

    it('does nothing while the setting is not trusted, or where the project has no check', async () => {
      const untrusted = await project(CHECKS, {}, LAND_GOAL);
      const before = await head();
      await oneTaskDone(untrusted);
      await new Promise((r) => setTimeout(r, 1500));
      expect(await head()).toBe(before);
      expect(landings(untrusted, 'goal.landed')).toEqual([]);
    });

    it('never lands unchecked work: a project without a required check keeps its Land button', async () => {
      // Its one check is advisory: nothing whose failure would stop anything.
      const td = await project(`${CHECKS}      required: false\n`, {}, LAND_GOAL);
      await trust(td);
      const before = await head();
      const goalId = await oneTaskDone(td);
      await new Promise((r) => setTimeout(r, 1500));
      expect(await head()).toBe(before);
      expect(await plan(td, goalId)).toMatchObject({ state: 'ready' });
    });

    it('takes a choice made for one goal: each task lands as it is integrated', async () => {
      const td = await project();
      const before = await head();
      const { goalId, ids } = await goalWith(td, [
        { key: 'raise-a', summary: 'Raise a to 2', write: ['src/a.mjs'] },
        { key: 'note-b', summary: 'Say what b is for', write: ['src/b.mjs'], depends_on: ['raise-a'] },
      ]);
      await td.operator.post(td.operator.projectPath(`/goals/${goalId}/landing`), { mode: 'task' });
      await work(td, 'be-1', ids['raise-a'] as string, { 'src/a.mjs': 'export const a = 2;\n' });
      await integrationOf(td, ids['raise-a'] as string);
      // The goal is still worked on, and its first task is in the folder already.
      const tip = await tipOf(goalId);
      await eventually(head, (h) => h === tip, 'the first task to land');
      expect(tip).not.toBe(before);
      expect(text('src/a.mjs')).toBe('export const a = 2;\n');
      expect((await td.operator.get<GoalDetail>(td.operator.projectPath(`/goals/${goalId}`))).goal.status).toBe(
        'ACTIVE',
      );
      // Not "landed" on the board yet: that is said when the whole goal is in.
      expect(landings(td, 'goal.landed')).toEqual([]);
    });

    it('holds back, touching nothing, when a file of the person is in the way', async () => {
      const td = await project(CHECKS, {}, LAND_GOAL);
      await trust(td);
      const before = await head();
      writeFileSync(file('src/a.mjs'), 'export const a = 3; // mine\n');
      await oneTaskDone(td);
      const held = await eventually(
        () => landings(td, 'goal.landing_held'),
        (es) => es.length >= 1,
        'the held landing on record',
      );
      expect(String((held[0]?.payload as { reason?: string } | undefined)?.reason)).toContain('not committed');
      expect(await head()).toBe(before);
      expect(text('src/a.mjs')).toBe('export const a = 3; // mine\n');
    });
  });

  describe('files in the way, set aside (2026-11-18)', () => {
    interface WithAside {
      state: string;
      files: string[];
      in_the_way?: { count: number; left: number; left_by: string[]; working: string[] };
      set_aside?: { ref: string; commit: string; count: number; files: string[] }[];
    }
    const planOf = (td: TestDaemon, goalId: string) =>
      td.operator.get<WithAside>(td.operator.projectPath(`/goals/${goalId}/land`));
    const landAside = (td: TestDaemon, goalId: string) =>
      td.operator.post<{ status: string; set_aside?: { ref: string; count: number } }>(
        td.operator.projectPath(`/goals/${goalId}/land/set-aside`),
        {},
      );
    const putBack = (td: TestDaemon, goalId: string) =>
      td.operator.post<{ restored: string[]; skipped: string[]; failed: string[] }>(
        td.operator.projectPath(`/goals/${goalId}/set-aside/restore`),
        {},
      );
    const status = async () => (await runGit(ws().projectDir, ['status', '--porcelain'])).stdout;
    const asideRefs = async () =>
      (await runGit(ws().projectDir, ['for-each-ref', '--format=%(refname)', 'refs/friday/set-aside/'])).stdout
        .split('\n')
        .filter(Boolean);
    const events = (td: TestDaemon, type: string) =>
      td.daemon.state.store.readSince(td.project.project_id, 0, { types: [type], limit: 100 });

    /** A completed goal that changes `src/a.mjs` and adds `src/c.mjs`. */
    async function goalOfTwoFiles(td: TestDaemon) {
      const { goalId, ids } = await goalWith(td, [
        { key: 'a-and-c', summary: 'Raise a, add c', write: ['src/a.mjs', 'src/c.mjs'] },
      ]);
      const id = ids['a-and-c'] as string;
      await work(td, 'be-1', id, { 'src/a.mjs': 'export const a = 2;\n', 'src/c.mjs': 'export const c = 1;\n' });
      await integrationOf(td, id);
      await runOnce(td);
      return goalId;
    }

    it('keeps a copy of each, clears the way and lands; "put them back" writes them over what was not changed since', async () => {
      const td = await project();
      const goalId = await goalOfTwoFiles(td);
      const MINE = 'export const a = 3; // mine\n';
      const SCRATCH = '// my scratch file\n';
      writeFileSync(file('src/a.mjs'), MINE);
      writeFileSync(file('src/c.mjs'), SCRATCH);
      // An edit of the person's own elsewhere is not in the way, and is not touched.
      writeFileSync(file('src/b.mjs'), 'export const b = 1; // mine too\n');

      const blocked = await planOf(td, goalId);
      expect(blocked).toMatchObject({ state: 'blocked', files: ['src/a.mjs', 'src/c.mjs'] });
      // Nobody but the person worked in this folder: Friday claims no agent left them.
      expect(blocked.in_the_way).toEqual({ count: 2, left: 0, left_by: [], working: [] });
      // The plain landing still refuses, and changes nothing.
      await expect(land(td, goalId)).rejects.toThrow(/not committed, and the goal changes them too/);
      expect(text('src/a.mjs')).toBe(MINE);

      const landed = await landAside(td, goalId);
      expect(landed).toMatchObject({ status: 'landed', set_aside: { count: 2 } });
      expect(text('src/a.mjs')).toBe('export const a = 2;\n');
      expect(text('src/c.mjs')).toBe('export const c = 1;\n');
      expect(text('src/b.mjs')).toBe('export const b = 1; // mine too\n');
      expect(await status()).toBe(' M src/b.mjs\n');
      // The copies are a commit under a ref of Friday's own, byte for byte.
      const ref = landed.set_aside?.ref as string;
      expect(ref).toBe(`refs/friday/set-aside/${goalId}/landing`);
      expect((await git(['show', `${ref}:src/a.mjs`])).trim()).toBe(MINE.trim());
      expect((await git(['show', `${ref}:src/c.mjs`])).trim()).toBe(SCRATCH.trim());
      // No stash and no branch of the person's was made for it.
      expect((await git(['stash', 'list'])).trim()).toBe('');

      const after = await planOf(td, goalId);
      expect(after.state).toBe('landed');
      expect(after.set_aside).toMatchObject([{ ref, count: 2, files: ['src/a.mjs', 'src/c.mjs'] }]);

      // The person changed one of the landed files since: it is left alone, and its copy stays kept.
      writeFileSync(file('src/c.mjs'), 'export const c = 1; // edited since\n');
      const first = await putBack(td, goalId);
      expect(first).toMatchObject({ restored: ['src/a.mjs'], skipped: ['src/c.mjs'], failed: [] });
      expect(text('src/a.mjs')).toBe(MINE);
      expect(text('src/c.mjs')).toBe('export const c = 1; // edited since\n');
      // Written back as changes that are not committed, with nothing staged.
      expect(await status()).toBe(' M src/a.mjs\n M src/b.mjs\n M src/c.mjs\n');
      expect((await planOf(td, goalId)).set_aside).toMatchObject([{ ref, count: 1, files: ['src/c.mjs'] }]);

      // Once that file is as landed again, the rest goes back too, and nothing is left to offer.
      await git(['checkout', '--', 'src/c.mjs']);
      const second = await putBack(td, goalId);
      expect(second.skipped).toEqual([]);
      expect(second.restored.sort()).toEqual(['src/a.mjs', 'src/c.mjs']);
      expect(text('src/c.mjs')).toBe(SCRATCH);
      expect((await planOf(td, goalId)).set_aside).toBeUndefined();
      await expect(putBack(td, goalId)).rejects.toThrow(/nothing of this goal is set aside/);
      // The copy itself is never deleted by putting it back.
      expect(await asideRefs()).toEqual([ref]);
    });

    it('writes every file back when the landing does not happen after all, and keeps no trace', async () => {
      const td = await project();
      const goalId = await completedGoal(td);
      // The person committed another value for the same line, and is editing the file again.
      await ownCommit('src/a.mjs', 'export const a = 5;\n', 'my own a');
      const MINE = 'export const a = 6; // still editing\n';
      writeFileSync(file('src/a.mjs'), MINE);
      const before = await head();
      expect((await planOf(td, goalId)).in_the_way).toMatchObject({ count: 1 });

      await expect(landAside(td, goalId)).rejects.toThrow(/change the same lines.*Nothing was changed/s);
      expect(await head()).toBe(before);
      expect(text('src/a.mjs')).toBe(MINE);
      expect(await status()).toBe(' M src/a.mjs\n');
      expect(await asideRefs()).toEqual([]);
      expect(events(td, 'goal.files_set_aside')).toHaveLength(0);
      expect((await planOf(td, goalId)).set_aside).toBeUndefined();
    });

    it("says they are what an agent's ended attempt left, keeps all of that attempt's files for the next one, and lands over them", async () => {
      const td = await project(CHECKS, {}, L0);
      const pid = td.project.project_id;
      // A change of the person's own, in the task's files, from before any agent worked there.
      mkdirSync(file('src/extra'), { recursive: true });
      writeFileSync(file('src/extra/mine.mjs'), '// my own notes\n');
      await new Promise((r) => setTimeout(r, 30));
      const { goalId, ids } = await goalWith(td, [
        { key: 'raise-a', summary: 'Raise a to 2', write: ['src/a.mjs', 'src/extra/**'], assign_to: 'antigravity-1' },
      ]);
      const taskId = ids['raise-a'] as string;
      const editor = await folderSession(td);
      const claimed = (await editor.claim({ next: true })) as { run_id: string };
      const HALF = 'export const a = 2; // half done\n';
      writeFileSync(file('src/a.mjs'), HALF);
      // A command of the agent wrote this one: no hook saw it.
      writeFileSync(file('src/extra/notes.mjs'), '// half-done notes\n');
      const agent = td.daemon.state.q.agentByKey(pid, 'antigravity-1');
      td.daemon.state.observePaths(pid, { kind: 'agent', id: String(agent?.agent_id) }, claimed.run_id, ['src/a.mjs']);
      await editor.disconnect().catch(() => undefined);
      const recovered = await td.operator.post<{ preserved_ref: string | null }>(
        td.operator.projectPath(`/tasks/${taskId}/recover`),
        { action: 'reassign', reason: 'it ran out of quota' },
      );
      // Everything the attempt wrote is kept, seen by a hook or not; the person's earlier file is not.
      const kept = (await git(['diff', '--name-only', `${recovered.preserved_ref}^`, String(recovered.preserved_ref)]))
        .trim()
        .split('\n');
      expect(kept).toEqual(['src/a.mjs', 'src/extra/notes.mjs']);

      // The next agent finishes from it in a folder of its own.
      const next = await begin(td, 'be-1', taskId);
      expect(readFileSync(path.join(next.start.working_directory, 'src/extra/notes.mjs'), 'utf8')).toContain(
        'half-done',
      );
      expect(existsSync(path.join(next.start.working_directory, 'src/extra/mine.mjs'))).toBe(false);
      await finish(td, next, { 'src/a.mjs': 'export const a = 2;\n', 'src/extra/notes.mjs': '// notes\n' });
      await integrationOf(td, taskId);
      await runOnce(td);

      // The first agent's files are still in the project folder, in the way of landing.
      const blocked = await planOf(td, goalId);
      expect(blocked).toMatchObject({ state: 'blocked', files: ['src/a.mjs', 'src/extra/notes.mjs'] });
      expect(blocked.in_the_way).toEqual({ count: 2, left: 2, left_by: ['antigravity-1'], working: [] });

      expect(await landAside(td, goalId)).toMatchObject({ status: 'landed', set_aside: { count: 2 } });
      expect(text('src/a.mjs')).toBe('export const a = 2;\n');
      expect(text('src/extra/notes.mjs')).toBe('// notes\n');
      // The person's own file was never part of it.
      expect(text('src/extra/mine.mjs')).toBe('// my own notes\n');
      expect(await status()).toBe('?? src/extra/mine.mjs\n');
    });

    it('never takes files from under an agent that is working on them in the folder', async () => {
      const td = await project(CHECKS, {}, L0);
      const goalId = await completedGoal(td);
      // Another goal's task, taken by a session in the project folder, covers the same file.
      const other = await goalWith(td, [
        { key: 'again', summary: 'Raise a again', write: ['src/a.mjs'], assign_to: 'antigravity-1' },
      ]);
      const editor = await folderSession(td);
      await editor.claim({ task_id: other.ids.again as string });
      const EDITING = 'export const a = 9; // being edited\n';
      writeFileSync(file('src/a.mjs'), EDITING);
      const p = await planOf(td, goalId);
      expect(p.in_the_way).toMatchObject({ count: 1, working: ['antigravity-1'] });
      await expect(landAside(td, goalId)).rejects.toThrow(/antigravity-1 is working on some of these files/);
      expect(text('src/a.mjs')).toBe(EDITING);
      expect(await asideRefs()).toEqual([]);
    });
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

describe('a project whose checks read a settings file kept out of version control (2026-11-17)', () => {
  /** The test reads `.env`, as a project's tests read the address of their database. */
  const NEEDS_ENV = [
    "import assert from 'node:assert';",
    "import { readFileSync } from 'node:fs';",
    "import { test } from 'node:test';",
    "import { a } from '../src/a.mjs';",
    "const limit = Number(/^LIMIT=([0-9]+)$/m.exec(readFileSync(new URL('../.env', import.meta.url), 'utf8'))?.[1]);",
    "test('a stays under the limit of the settings file', () => assert.ok(a <= limit));",
    '',
  ].join('\n');
  const FILES = '\nworktrees:\n  files:\n    - from: .env.agents.local\n      to: .env\n';
  const trust = async (td: TestDaemon) => {
    const view = await td.operator.get<{ policy: { loosening_hash: string } }>(td.operator.projectPath('/policy'));
    await td.operator.post(td.operator.projectPath('/policy/trust'), { loosening_hash: view.policy.loosening_hash });
  };

  it('gives each copy the file the person chose, once trusted: the task and the merged revision both pass', async () => {
    const td = await project(CHECKS, { 'test/sum.test.mjs': NEEDS_ENV, '.gitignore': '.env\n.env.*.local\n' }, FILES);
    const dir = ws().projectDir;
    // The person's own file, with what must stay theirs, and the one kept for agents.
    writeFileSync(path.join(dir, '.env'), 'LIMIT=3\nPAYMENT_KEY=the-real-one\n');
    writeFileSync(path.join(dir, '.env.agents.local'), 'LIMIT=3\n');
    const { goalId, ids } = await goalWith(td, [
      { key: 'raise-a', summary: 'Raise a to 2', write: ['src/a.mjs'] },
      { key: 'add-c', summary: 'Add c', write: ['src/c.mjs'] },
    ]);

    // Not trusted yet: the copy has no settings file, and its agent is told why a check may fail.
    const first = await begin(td, 'be-1', ids['raise-a'] as string);
    expect(existsSync(path.join(first.start.working_directory, '.env'))).toBe(false);
    expect(first.start.note ?? '').toContain("wait for the person's approval");
    await first.fake.close();
    await td.operator.post(td.operator.projectPath(`/tasks/${ids['raise-a']}/release`), { reason: 'trust first' });

    await trust(td);
    const ra = await begin(td, 'be-2', ids['raise-a'] as string);
    const given = path.join(ra.start.working_directory, '.env');
    expect(readFileSync(given, 'utf8')).toBe('LIMIT=3\n');
    expect(ra.start.note ?? '').not.toContain('approval');
    // Both start from the same commit, so the second to finish needs a real merge, which Friday
    // checks in a checkout of its own.
    const rc = await begin(td, 'be-3', ids['add-c'] as string);
    await finish(td, ra, { 'src/a.mjs': 'export const a = 2;\n' });
    expect((await integrationOf(td, ids['raise-a'] as string)).status).toBe('integrated');
    await finish(td, rc, { 'src/c.mjs': 'export const c = 1;\n' });
    // That checkout has the file too: without it the same check failed there, and correct work
    // was sent back.
    const two = await integrationOf(td, ids['add-c'] as string);
    expect(two.checks.map((c) => [c.name, c.status])).toEqual([['tests', 'PASSED']]);
    expect(two.status, two.summary ?? '').toBe('integrated');
    await runOnce(td);
    expect((await td.operator.get<GoalDetail>(td.operator.projectPath(`/goals/${goalId}`))).goal.status).toBe(
      'COMPLETED',
    );
    // The file is in no revision, the person's own never left the project folder, and nothing of
    // either is in what Friday recorded.
    const tree = await git(['ls-tree', '-r', '--name-only', `friday/goal-${goalId}`]);
    expect(tree.split('\n')).not.toContain('.env');
    expect(readFileSync(path.join(dir, '.env'), 'utf8')).toContain('PAYMENT_KEY=the-real-one');
    const events = JSON.stringify(td.daemon.state.store.readSince(td.project.project_id, 0, { limit: 5000 }));
    expect(events).toContain('run.workspace_ready');
    expect(events).not.toContain('the-real-one');
  }, 240_000);
});

describe('trying the checks on the untouched project (2026-11-18)', () => {
  interface Trial {
    status: string;
    commit: string | null;
    problem: string | null;
    checks: { name: string; required: boolean; status: string; output_tail: string | null }[];
  }

  it('runs them on the commit the folder is on, in a copy of its own, and says which fail before any work', async () => {
    const two = `${CHECKS}    - name: lint\n      command: node\n      args: ["-e", "console.log('style is off'); process.exit(1)"]\n      required: false\n`;
    const td = await project(two);
    const at = td.operator.projectPath('/config/checks/trial');
    expect((await td.operator.get<Trial>(at)).status).toBe('idle');
    const before = await git(['status', '--porcelain']);

    expect((await td.operator.post<Trial>(at, {})).status).toBe('running');
    // A second click while it runs starts nothing new.
    expect((await td.operator.post<Trial>(at, {})).status).toBe('running');
    const done = await eventually(
      () => td.operator.get<Trial>(at),
      (t) => t.status !== 'running',
      'the trial to end',
      90_000,
    );
    expect(done.status, done.problem ?? '').toBe('done');
    expect(done.checks.map((c) => [c.name, c.required, c.status])).toEqual([
      ['tests', true, 'passed'],
      ['lint', false, 'failed'],
    ]);
    expect(done.checks[1]?.output_tail).toContain('style is off');
    expect(done.commit).toBe((await git(['rev-parse', 'HEAD'])).trim().slice(0, 12));
    // The project folder is as it was: the checks ran in Friday's own copy.
    expect(await git(['status', '--porcelain'])).toBe(before);

    // The advisory check is made required from the same page, and config.yaml says so.
    const view = await td.operator.post<{ checks: { name: string; required: boolean }[] }>(
      td.operator.projectPath('/config/checks'),
      { add: [], remove: [], strength: { name: 'lint', required: true } },
    );
    expect(view.checks.map((c) => [c.name, c.required])).toEqual([
      ['tests', true],
      ['lint', true],
    ]);
  }, 180_000);
});

describe('a lockfile a clean install refuses (2026-11-18)', () => {
  const npm = spawnSync('npm', ['--version'], { shell: true, encoding: 'utf8' });
  const lockOnly = (cwd: string) =>
    spawnSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd,
      shell: true,
      encoding: 'utf8',
    });
  const WITH_TINY = '{"name":"shop","private":true,"dependencies":{"tiny":"file:vendor/tiny"}}\n';
  const WITH_BOTH =
    '{"name":"shop","private":true,"dependencies":{"small":"file:vendor/small","tiny":"file:vendor/tiny"}}\n';

  it.skipIf(npm.status !== 0)(
    'is said to the person once when it is already in the project, and the question closes when the install works again',
    async () => {
      const td = await project(CHECKS, {
        'package.json': WITH_TINY,
        'vendor/tiny/package.json': '{"name":"tiny","version":"1.0.0"}\n',
        'vendor/small/package.json': '{"name":"small","version":"1.0.0"}\n',
        '.gitignore': 'node_modules/\n',
      });
      const dir = ws().projectDir;
      expect(lockOnly(dir).status).toBe(0);
      // The person's own commit left the lockfile behind the manifest.
      writeFileSync(path.join(dir, 'package.json'), WITH_BOTH);
      await deterministicGit(dir, { startEpoch: 1_767_225_800 }).commitAll('add small, forget the lockfile');
      const pid = td.project.project_id;
      const asked = () =>
        td.daemon.state.q.escalations(pid).filter((e) => e.kind === 'install_broken') as {
          status: string;
          question: string;
          answer: string | null;
          details_json: string;
        }[];
      const setupOf = (taskId: string) =>
        td.daemon.state.latestWorktreeSetup(pid, taskId)?.setup as { status: string } | undefined;

      const { ids } = await goalWith(td, [
        { key: 'raise-a', summary: 'Raise a to 2', write: ['src/a.mjs'] },
        { key: 'raise-b', summary: 'Lower b', write: ['src/b.mjs'] },
      ]);
      const first = await begin(td, 'be-1', ids['raise-a'] as string);
      expect(setupOf(first.taskId)?.status).toBe('failed');
      const one = asked();
      expect(one).toHaveLength(1);
      expect(one[0]?.status).toBe('pending');
      expect(one[0]?.question).toContain('package-lock.json does not match package.json');
      const details = JSON.parse(String(one[0]?.details_json)) as { lockfile: string; missing: string[] };
      expect(details.lockfile).toBe('package-lock.json');
      expect(details.missing.join(' ')).toMatch(/Missing: small@/);

      // The next folder fails the same way: it is not asked a second time.
      const second = await begin(td, 'be-2', ids['raise-b'] as string);
      expect(setupOf(second.taskId)?.status).toBe('failed');
      expect(asked()).toHaveLength(1);
      await first.fake.close();
      await second.fake.close();

      // The lockfile is written again and committed: the next folder installs, and the question closes.
      expect(lockOnly(dir).status).toBe(0);
      await deterministicGit(dir, { startEpoch: 1_767_226_800 }).commitAll('lockfile in step');
      const later = await goalWith(td, [{ key: 'add-c', summary: 'Add c', write: ['src/c.mjs'] }]);
      const third = await begin(td, 'be-1', later.ids['add-c'] as string);
      expect(setupOf(third.taskId)?.status).toBe('passed');
      const closed = asked();
      expect(closed).toHaveLength(1);
      expect(closed[0]?.status).toBe('answered');
      expect(closed[0]?.answer).toContain('the packages install again');
      await third.fake.close();
    },
    360_000,
  );

  it.skipIf(npm.status !== 0)(
    'fails the task that left it, though every check of the project passes, and passes once it is written again',
    async () => {
      const td = await project(CHECKS, {
        'package.json': WITH_TINY,
        'vendor/tiny/package.json': '{"name":"tiny","version":"1.0.0"}\n',
        'vendor/small/package.json': '{"name":"small","version":"1.0.0"}\n',
        '.gitignore': 'node_modules/\n',
      });
      const dir = ws().projectDir;
      const made = lockOnly(dir);
      expect(made.status, made.stderr).toBe(0);
      await deterministicGit(dir, { startEpoch: 1_767_225_800 }).commitAll('lockfile');
      const verify = (taskId: string) =>
        td.operator.post<{ task: TaskView; verification: VerificationView }>(
          td.operator.projectPath(`/tasks/${taskId}/verify`),
          {},
          { timeoutMs: 240_000 },
        );
      const claim = async (w: Awaited<ReturnType<typeof begin>>, paths: string[]) => {
        await w.fake.client.reportResult({
          task_id: w.taskId,
          run_id: w.start.run_id,
          status: 'completed_claim',
          summary: `changed ${paths.join(', ')}`,
          changed_paths: paths,
          checks: [],
        });
        await w.fake.close();
      };
      const installCheck = (v: VerificationView) => v.checks.find((c) => c.name === 'friday.clean_install');

      // A task that changes no package list is not asked about installs at all.
      const plain = await goalWith(td, [{ key: 'raise-a', summary: 'Raise a to 2', write: ['src/a.mjs'] }]);
      const a = await begin(td, 'be-1', plain.ids['raise-a'] as string);
      writeFileSync(path.join(a.start.working_directory, 'src/a.mjs'), 'export const a = 2;\n');
      await claim(a, ['src/a.mjs']);
      const quiet = await verify(a.taskId);
      expect(quiet.task.status, JSON.stringify(quiet.verification.checks)).toBe('COMPLETED');
      expect(installCheck(quiet.verification)).toBeUndefined();

      // The agent adds a package to package.json and never writes the lockfile again.
      const { ids } = await goalWith(td, [
        { key: 'add-small', summary: 'Use the small package', write: ['package.json', 'package-lock.json'] },
      ]);
      const taskId = ids['add-small'] as string;
      const w = await begin(td, 'be-2', taskId);
      const wt = w.start.working_directory;
      writeFileSync(path.join(wt, 'package.json'), WITH_BOTH);
      await claim(w, ['package.json']);
      const refused = await verify(taskId);
      const failed = installCheck(refused.verification);
      // The project's own tests pass: only the clean install tells.
      expect(refused.verification.checks.find((c) => c.name === 'tests')?.status).toBe('PASSED');
      expect(failed).toMatchObject({ status: 'FAILED', origin: 'friday', required: true });
      expect(failed?.summary).toContain('package-lock.json does not match package.json');
      expect(failed?.summary).toContain('Run "npm install"');
      expect(failed?.artifact_ref).toMatch(/^artifact:/);
      expect(refused.task.status).not.toBe('COMPLETED');
      // Nothing was installed by asking.
      expect(existsSync(path.join(wt, 'node_modules', 'small'))).toBe(false);

      // The lockfile is written again in the same folder: the same question now passes.
      const fixed = lockOnly(wt);
      expect(fixed.status, fixed.stderr).toBe(0);
      await td.operator.post(td.operator.projectPath(`/tasks/${taskId}/rework`), {
        reason: 'write the lockfile again',
      });
      const again = await begin(td, 'be-2', taskId);
      await claim(again, ['package.json', 'package-lock.json']);
      const passed = await verify(taskId);
      expect(installCheck(passed.verification)).toMatchObject({ status: 'PASSED' });
      expect(installCheck(passed.verification)?.summary).toBe('a clean install (npm ci) works with package-lock.json');
      expect(passed.task.status, JSON.stringify(passed.verification.checks)).toBe('COMPLETED');
    },
    360_000,
  );
});

describe('checks that fit the change (2026-11-18)', () => {
  /** The project's test, and a lint check that fails on a line ending in a space. */
  const TWO_CHECKS = [
    '  checks:',
    '    - name: tests',
    '      command: node',
    '      args: ["--test", "test/*.test.mjs"]',
    '    - name: lint',
    '      kind: lint',
    '      command: node',
    '      args: ["scripts/lint.cjs"]',
    '',
  ].join('\n');
  const LINT = [
    "const fs = require('node:fs');",
    "const bad = ['README.md', 'src/a.mjs'].filter((f) => fs.existsSync(f) && /[ \\t]$/m.test(fs.readFileSync(f, 'utf8')));",
    "if (bad.length) { console.error('trailing space in ' + bad.join(', ')); process.exit(1); }",
    '',
  ].join('\n');
  const verify = (td: TestDaemon, taskId: string) =>
    td.operator.post<{ task: TaskView; verification: VerificationView }>(
      td.operator.projectPath(`/tasks/${taskId}/verify`),
      {},
      { timeoutMs: 120_000 },
    );
  const claim = async (w: Awaited<ReturnType<typeof begin>>, files: Record<string, string>) => {
    for (const [rel, text] of Object.entries(files)) writeFileSync(path.join(w.start.working_directory, rel), text);
    await w.fake.client.reportResult({
      task_id: w.taskId,
      run_id: w.start.run_id,
      status: 'completed_claim',
      summary: Object.keys(files).length ? `changed ${Object.keys(files).join(', ')}` : 'looked, changed nothing',
      changed_paths: Object.keys(files),
      // An agent that ran nothing: with a change to code, that alone would not do.
      checks: [],
    });
    await w.fake.close();
  };
  const ran = (v: VerificationView) => v.checks.filter((c) => c.origin !== 'friday').map((c) => c.name);

  it('runs no project check for a task that changed nothing, only lint for one that changed a document, and all for code', async () => {
    const td = await project(TWO_CHECKS, { 'scripts/lint.cjs': LINT, 'README.md': '# Shop\n' });
    const { goalId, ids } = await goalWith(td, [
      { key: 'explain', summary: 'Explain how a and b add up', write: ['src/**', 'README.md'] },
      { key: 'docs', summary: 'Describe the shop in the README', write: ['README.md'], depends_on: ['explain'] },
      { key: 'code', summary: 'Raise a to 2', write: ['src/a.mjs'], depends_on: ['docs'] },
    ]);

    // Nothing changed: nothing of the project runs, and the task is done.
    const explain = await begin(td, 'be-1', ids.explain as string);
    await claim(explain, {});
    const nothing = await verify(td, explain.taskId);
    expect(nothing.task.status, JSON.stringify(nothing.verification.checks)).toBe('COMPLETED');
    expect(ran(nothing.verification)).toEqual([]);
    expect(nothing.verification.summary).toContain(
      "nothing was changed, so the project's checks were not run (tests, lint)",
    );
    await runOnce(td);

    // A document only: the lint check judges it, the tests do not run.
    const docs = await begin(td, 'be-2', ids.docs as string);
    await claim(docs, { 'README.md': '# Shop\n\nSells a and b. \n' });
    const untidy = await verify(td, docs.taskId);
    expect(ran(untidy.verification)).toEqual(['lint']);
    expect(untidy.verification.checks.find((c) => c.name === 'lint')?.status).toBe('FAILED');
    expect(untidy.task.status).not.toBe('COMPLETED');
    await td.operator.post(td.operator.projectPath(`/tasks/${docs.taskId}/rework`), { reason: 'trailing space' });
    const again = await begin(td, 'be-2', docs.taskId);
    await claim(again, { 'README.md': '# Shop\n\nSells a and b.\n' });
    const tidy = await verify(td, docs.taskId);
    expect(tidy.task.status, JSON.stringify(tidy.verification.checks)).toBe('COMPLETED');
    expect(ran(tidy.verification)).toEqual(['lint']);
    expect(tidy.verification.summary).toContain('only documents were changed, so tests was not run');
    expect((await integrationOf(td, docs.taskId)).status).toBe('integrated');
    await runOnce(td);

    // Code: every check, as before.
    const code = await begin(td, 'be-1', ids.code as string);
    await claim(code, { 'src/a.mjs': 'export const a = 2;\n' });
    const full = await verify(td, code.taskId);
    expect(full.task.status, JSON.stringify(full.verification.checks)).toBe('COMPLETED');
    expect(ran(full.verification)).toEqual(['tests', 'lint']);
    expect((await integrationOf(td, code.taskId)).status).toBe('integrated');
    await runOnce(td);
    expect((await td.operator.get<GoalDetail>(td.operator.projectPath(`/goals/${goalId}`))).goal.status).toBe(
      'COMPLETED',
    );
  }, 240_000);

  it('checks a merge that brings only a document with the lint check alone, and one that brings code with all', async () => {
    const td = await project(TWO_CHECKS, { 'scripts/lint.cjs': LINT, 'README.md': '# Shop\n' });
    // Two pairs that start from the same commit: the second of each pair to finish is a real merge.
    const { ids } = await goalWith(td, [
      { key: 'code', summary: 'Lower b', write: ['src/b.mjs'] },
      { key: 'docs', summary: 'Describe the shop', write: ['README.md'] },
      { key: 'more', summary: 'Raise a to 2', write: ['src/a.mjs'] },
    ]);
    const code = await begin(td, 'be-1', ids.code as string);
    const docs = await begin(td, 'be-2', ids.docs as string);
    await claim(code, { 'src/b.mjs': 'export const b = 0;\n' });
    expect((await verify(td, code.taskId)).task.status).toBe('COMPLETED');
    expect((await integrationOf(td, code.taskId)).status).toBe('integrated');
    const more = await begin(td, 'be-1', ids.more as string);

    // The document joins a branch that moved on: a merge, checked by the lint check alone.
    await claim(docs, { 'README.md': '# Shop\n\nSells a and b.\n' });
    expect((await verify(td, docs.taskId)).task.status).toBe('COMPLETED');
    const merged = await integrationOf(td, docs.taskId);
    expect(merged.status, merged.summary ?? '').toBe('integrated');
    expect(merged.checks.map((c) => [c.name, c.status])).toEqual([['lint', 'PASSED']]);

    // Code joins it: every check runs on what the two make together.
    await claim(more, { 'src/a.mjs': 'export const a = 2;\n' });
    expect((await verify(td, more.taskId)).task.status).toBe('COMPLETED');
    const both = await integrationOf(td, more.taskId);
    expect(both.status, both.summary ?? '').toBe('integrated');
    expect(both.checks.map((c) => c.name)).toEqual(['tests', 'lint']);
  }, 240_000);
});

describe('a question, and one task to do now (2026-11-18)', () => {
  interface Answer {
    state: string;
    question: string;
    agent_key: string | null;
    summary: string | null;
    preview: string | null;
    answer?: string | null;
    read: boolean;
  }
  type Board = {
    goals: { goal_id: string; mode: string; status: string }[];
    answers?: Record<string, Answer>;
    goal_landing?: Record<string, unknown>;
  };
  const board = (td: TestDaemon) => td.operator.get<Board>(td.operator.projectPath('/ui/snapshot'));
  const answer = (td: TestDaemon, goalId: string) =>
    td.operator.get<Answer>(td.operator.projectPath(`/goals/${goalId}/answer`));
  const make = (td: TestDaemon, request: string, mode: 'ask' | 'do') =>
    td.operator.post<{ goal_id: string; mode: string; plan_id: string | null; status: string }>(
      td.operator.projectPath('/goals'),
      { request, mode },
    );
  const onlyTask = async (td: TestDaemon, goalId: string) => {
    const detail = await td.operator.get<GoalDetail>(td.operator.projectPath(`/goals/${goalId}`));
    expect(detail.active?.tasks).toHaveLength(1);
    return (detail.active?.tasks[0]?.task_id ?? '') as string;
  };
  const LONG = `Prices are kept per outlet, and every change is a new row.\n\n${'A revision records who changed what, and when. '.repeat(120)}`;

  it('answers a question with one read-only task: no plan to approve, no project check, nothing to land', async () => {
    const td = await project();
    const QUESTION = 'How do a and b add up, and where is that tested?';
    const goal = await make(td, QUESTION, 'ask');
    expect(goal).toMatchObject({ mode: 'ask' });
    // One task, there at once, with nothing proposed for a person to read.
    const detail = await td.operator.get<GoalDetail & { proposed: unknown }>(
      td.operator.projectPath(`/goals/${goal.goal_id}`),
    );
    expect(detail.proposed ?? null).toBeNull();
    const taskId = await onlyTask(td, goal.goal_id);
    const task = await taskOf(td, taskId);
    expect(task).toMatchObject({ kind: 'research', status: 'READY', summary: QUESTION });
    expect(task.scope?.write).toEqual([]);
    expect(task.description).toContain('Change no file');
    expect(task.description).toContain(QUESTION);
    expect(await answer(td, goal.goal_id)).toMatchObject({ state: 'waiting', question: QUESTION, read: false });

    const w = await begin(td, 'be-1', taskId);
    expect((await answer(td, goal.goal_id)).state).toBe('answering');
    await w.fake.client.reportResult({
      task_id: taskId,
      run_id: w.start.run_id,
      status: 'completed_claim',
      summary: 'a and b are added in the test, which keeps their sum at 3 or less',
      answer: LONG,
      changed_paths: [],
      checks: [],
    });
    await w.fake.close();
    // Nobody presses Verify, and this computer trusts no automatic verification: the answer is
    // checked by itself, because checking it runs nothing of the project.
    const done = await eventually(
      () => taskOf(td, taskId),
      (t) => t.status === 'COMPLETED' || t.status === 'FAILED',
      'the answer to be checked',
    );
    expect(done.status).toBe('COMPLETED');
    const v = td.daemon.state.q.latestVerification(taskId);
    expect(v?.checks.map((c) => c.name)).toEqual(['friday.diff', 'friday.secrets']);

    const full = await answer(td, goal.goal_id);
    expect(full).toMatchObject({ state: 'ready', agent_key: 'be-1', read: false });
    expect(full.answer).toBe(LONG.trim());
    expect(full.summary).toContain('their sum at 3 or less');
    const b = await eventually(
      async () => {
        await runOnce(td);
        return board(td);
      },
      (x) => x.goals.find((g) => g.goal_id === goal.goal_id)?.status === 'COMPLETED',
      'the question to be done',
      15_000,
    );
    expect(b.goals.find((g) => g.goal_id === goal.goal_id)).toMatchObject({ mode: 'ask', status: 'COMPLETED' });
    // On the board: where it stands and how it begins, never the whole text; and nothing to land.
    expect(b.answers?.[goal.goal_id]).toMatchObject({ state: 'ready', read: false });
    expect(b.answers?.[goal.goal_id]?.preview).toBe(LONG.trim().slice(0, 400));
    expect(b.answers?.[goal.goal_id]?.answer).toBeUndefined();
    expect(b.goal_landing?.[goal.goal_id]).toBeUndefined();
    // No event holds the long text.
    const events = td.daemon.state.store.readSince(td.project.project_id, 0, { limit: 5000 });
    const whole = JSON.stringify(LONG.trim()).slice(1, -1);
    expect(events.some((e) => JSON.stringify(e.payload).includes(whole))).toBe(false);
    expect(Math.max(...events.map((e) => JSON.stringify(e.payload).length))).toBeLessThan(LONG.length);

    await td.operator.post(td.operator.projectPath(`/goals/${goal.goal_id}/answer/read`), {});
    await td.operator.post(td.operator.projectPath(`/goals/${goal.goal_id}/answer/read`), {});
    expect((await answer(td, goal.goal_id)).read).toBe(true);
    expect(events.filter((e) => e.type === 'goal.answer_read')).toHaveLength(0);
    expect(
      td.daemon.state.store.readSince(td.project.project_id, 0, { types: ['goal.answer_read'], limit: 10 }),
    ).toHaveLength(1);
    // Only a question has an answer to read.
    const { goalId: planned } = await goalWith(td, [{ key: 'x', summary: 'Raise a', write: ['src/a.mjs'] }]);
    await expect(answer(td, planned)).rejects.toThrow(/is not a question/);
  }, 120_000);

  it('fails a question whose agent changed a file, and takes an answer given as the summary alone', async () => {
    const td = await project();
    const changed = await make(td, 'What does a hold?', 'ask');
    const taskId = await onlyTask(td, changed.goal_id);
    const w = await begin(td, 'be-1', taskId);
    writeFileSync(path.join(w.start.working_directory, 'src/a.mjs'), 'export const a = 9;\n');
    await w.fake.client.reportResult({
      task_id: taskId,
      run_id: w.start.run_id,
      status: 'completed_claim',
      summary: 'a holds 1; I also changed it',
      answer: 'It holds 1.',
      changed_paths: ['src/a.mjs'],
      checks: [],
    });
    await w.fake.close();
    const failed = await eventually(
      () => taskOf(td, taskId),
      (t) => t.status === 'COMPLETED' || t.status === 'FAILED',
      'the check of the changed question',
    );
    expect(failed.status).toBe('FAILED');
    const v = td.daemon.state.q.latestVerification(taskId);
    const diff = v?.checks.find((c) => c.name === 'friday.diff');
    expect(diff?.details?.findings?.map((f) => f.rule)).toContain('diff.read_only_task');
    // The project's tests were not run on what it changed: nothing here was trusted to run them.
    expect(v?.checks.some((c) => c.name === 'tests')).toBe(false);
    expect((await answer(td, changed.goal_id)).state).toBe('failed');

    const terse = await make(td, 'What does b hold?', 'ask');
    const second = await onlyTask(td, terse.goal_id);
    const w2 = await begin(td, 'be-2', second);
    await w2.fake.client.reportResult({
      task_id: second,
      run_id: w2.start.run_id,
      status: 'completed_claim',
      summary: 'b holds 1.',
      changed_paths: [],
      checks: [],
    });
    await w2.fake.close();
    await eventually(
      () => taskOf(td, second),
      (t) => t.status === 'COMPLETED',
      'the short answer to be checked',
    );
    expect(await answer(td, terse.goal_id)).toMatchObject({
      state: 'ready',
      answer: 'b holds 1.',
      preview: 'b holds 1.',
    });
  }, 120_000);

  it('does one task at once, with no planner and no plan to approve, then checks and lands it as any other', async () => {
    const td = await project();
    const REQUEST = 'Raise a to 2 in src/a.mjs';
    const goal = await make(td, REQUEST, 'do');
    expect(goal.mode).toBe('do');
    const taskId = await onlyTask(td, goal.goal_id);
    expect(await taskOf(td, taskId)).toMatchObject({ kind: 'implementation', status: 'READY', summary: REQUEST });
    // No model was asked for anything.
    expect(
      td.daemon.state.store.readSince(td.project.project_id, 0, { types: ['model.called'], limit: 10 }),
    ).toHaveLength(0);
    await work(td, 'be-1', taskId, { 'src/a.mjs': 'export const a = 2;\n' });
    expect((await integrationOf(td, taskId)).status).toBe('integrated');
    await runOnce(td);
    const b = await board(td);
    expect(b.goals.find((g) => g.goal_id === goal.goal_id)).toMatchObject({ mode: 'do', status: 'COMPLETED' });
    // Work to land, like any goal's; and no answer to read.
    expect(b.goal_landing?.[goal.goal_id]).toBeDefined();
    expect(b.answers?.[goal.goal_id]).toBeUndefined();
    const landed = await td.operator.post<{ status: string }>(
      td.operator.projectPath(`/goals/${goal.goal_id}/land`),
      {},
    );
    expect(landed.status).toBe('landed');
    expect(readFileSync(path.join(ws().projectDir, 'src/a.mjs'), 'utf8').replace(/\r\n/g, '\n')).toBe(
      'export const a = 2;\n',
    );
  }, 120_000);
});
