/**
 * Integration of verified task branches into goal branches (plan M5c, ADR-0025).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { IntegrationView, TaskStartParams, TaskView, VerificationView } from '@friday/protocol';
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

async function project(): Promise<TestDaemon> {
  const td = await startTestDaemon(ws(), {
    git: true,
    brain: { autoStart: false },
    editConfig: (y) => y.replace('  checks: []\n', CHECKS),
  });
  const dir = ws().projectDir;
  const git = deterministicGit(dir, { startEpoch: 1_767_225_700 });
  for (const [rel, text] of Object.entries({
    'src/a.mjs': 'export const a = 1;\n',
    'src/b.mjs': 'export const b = 1;\n',
    'test/sum.test.mjs': SUM_TEST,
  })) {
    const abs = path.join(dir, rel);
    (await import('node:fs')).mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  await git.commitAll('sources and tests');
  return td;
}

interface GoalDetail {
  goal: { goal_id: string; status: string };
  active: { plan_id: string; tasks: { key: string; task_id: string | null; status: string }[] } | null;
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
    expect((await td.operator.get<GoalDetail>(td.operator.projectPath(`/goals/${goalId}`))).goal.status).toBe(
      'COMPLETED',
    );
    const listed = await cli(['--project', ws().projectDir, 'integrations', '--goal', goalId]);
    expect(listed.stdout).toContain(`git merge ${branch}`);
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
});
