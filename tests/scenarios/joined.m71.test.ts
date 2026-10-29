/**
 * The joined scenario of the M7 review (§5): one goal through every joint M7.1 repaired, with real
 * git, real processes and real files. A human approves a plan; Friday delegates two tasks to two
 * isolated worktrees; each agent gets its own packet; one asks the other a related-work question;
 * an approved operation runs with a dummy secret the agent never sees; one claim fails its checks
 * and is reworked; verified work is integrated, and a merge verified again; an agent dies while its
 * operation writes, and recovery stops the writer and keeps its work for the next attempt; the
 * final goal branch is verified. The second test takes a backup in the middle, loses the clone,
 * and finishes the goal in a clean clone restored from that backup: a copy whose database was
 * damaged is refused before anything changes (review M7.1 R07); one attempt is continued by a new
 * agent, and a claim that waited for verification is brought over as it is and verified there
 * (`recover --action rebind`, review M7.1 R05).
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createDaemon, type Daemon } from '@friday/daemon';
import { runGit } from '@friday/git';
import type {
  ContextPacket,
  IntegrationView,
  MessageView,
  OperationResult,
  OperationRunView,
  TaskStartParams,
  TaskView,
  VerificationView,
} from '@friday/protocol';
import { DaemonClient } from '@friday/sdk';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli } from '../helpers/cli.js';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { FakeHarness } from '../helpers/fake-harness.js';

const ws = useTestWorkspace();
/** Deleting a lost clone: retried while Windows releases the last handles of its processes (LESSONS T-42). */
const LOST = { recursive: true, force: true, maxRetries: 20, retryDelay: 100 } as const;
/** A dummy key in the shape of a payment sandbox key: never a real one. */
const SECRET = `sk_test_51Hjoined${'Q7x'.repeat(10)}`;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ['FRIDAY_STATE_DIR', 'FRIDAY_TEST_SANDBOX_KEY']) saved[k] = process.env[k];
  process.env.FRIDAY_STATE_DIR = ws().stateDir;
  process.env.FRIDAY_TEST_SANDBOX_KEY = SECRET;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** `a + b` may not exceed 4. */
const SUM_TEST = [
  "import assert from 'node:assert';",
  "import { test } from 'node:test';",
  "import { a } from '../src/a.mjs';",
  "import { b } from '../src/b.mjs';",
  "test('a + b stays small', () => assert.ok(a + b <= 4));",
  '',
].join('\n');

/** The payment sandbox test: it needs the key, and prints it to see that Friday removes it. */
const SANDBOX = [
  'const k = process.env.STRIPE_SECRET_KEY;',
  "if (!k || !k.startsWith('sk_test_')) { console.error('no sandbox key'); process.exit(2); }",
  "console.log('key', k);",
  "console.log('sandbox ok');",
  '',
].join('\n');

/**
 * Writes, and starts a grandchild that writes too, then keeps going; both stop by themselves after
 * 20 s, so nothing outlives the test. The grandchild is detached on Windows: only a job holds it.
 */
const WRITER = [
  "import { spawn } from 'node:child_process';",
  "import { appendFileSync, mkdirSync } from 'node:fs';",
  "mkdirSync('notes', { recursive: true });",
  "const orphan = \"setInterval(() => require('node:fs').appendFileSync('notes/orphan.txt', 'x'), 40); setTimeout(() => process.exit(0), 20000);\";",
  "spawn(process.execPath, ['-e', orphan], { stdio: 'ignore', windowsHide: true, detached: process.platform === 'win32' }).unref();",
  "setInterval(() => appendFileSync('notes/writer.txt', 'x'), 40);",
  'setTimeout(() => process.exit(0), 20000);',
  '',
].join('\n');

const CONFIG = [
  'operations:',
  '  payments-sandbox:',
  '    description: the payment sandbox test',
  '    command: node',
  '    args: ["scripts/sandbox.mjs"]',
  '    credentials: { STRIPE_SECRET_KEY: stripe-sandbox }',
  '    roles: [backend]',
  '  writer:',
  '    command: node',
  '    args: ["scripts/writer.mjs"]',
  '    risk: low',
  '',
].join('\n');

const CHECKS = '  checks:\n    - name: tests\n      command: node\n      args: ["--test", "test/*.test.mjs"]\n';

const text = (f: string) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const same = (a: string, b: string) =>
  process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : a === b;
const size = (f: string) => (existsSync(f) ? statSync(f).size : 0);
async function stillWriting(file: string, ms = 500): Promise<boolean> {
  const before = size(file);
  await sleep(ms);
  return size(file) > before;
}

async function eventually<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${String(JSON.stringify(v)).slice(0, 400)}`);
    await sleep(50);
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

/** Every text Friday keeps about the project: its database, artifacts and logs. */
function everythingStored(td: TestDaemon, fridayDir: string): string {
  const db = td.daemon.state.db;
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all<{ name: string }>();
  const parts = tables.map((t) => JSON.stringify(db.prepare(`SELECT * FROM "${t.name}"`).all()));
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else parts.push(readFileSync(p).toString('utf8'));
    }
  };
  walk(path.join(fridayDir, 'artifacts'));
  walk(path.join(fridayDir, 'logs'));
  return parts.join('\n');
}

/**
 * The project: sources, a test, two scripts, the operations trusted and the dummy key stored. The
 * Master Brain coordinates when the scenario asks it to (`brain run-once`), so which agent is free
 * at that moment, and so who gets which task, does not depend on timing.
 */
async function project() {
  const td = await startTestDaemon(ws(), {
    git: true,
    brain: { autoStart: false },
    extraConfig: CONFIG,
    editConfig: (y) => y.replace('  checks: []\n', CHECKS).replace(/provider: anthropic(\s+#)/, 'provider: none$1'),
  });
  const dir = ws().projectDir;
  for (const [rel, body] of Object.entries({
    'src/a.mjs': 'export const a = 1;\n',
    'src/b.mjs': 'export const b = 1;\n',
    'test/sum.test.mjs': SUM_TEST,
    'scripts/sandbox.mjs': SANDBOX,
    'scripts/writer.mjs': WRITER,
  })) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  await deterministicGit(dir, { startEpoch: 1_767_225_700 }).commitAll('sources, a test and two scripts');
  expect((await cli(['--project', dir, 'policy', 'trust', '--yes'])).code).toBe(0);
  const stored = await cli(['secrets', 'set', 'stripe-sandbox', '--from-env', 'FRIDAY_TEST_SANDBOX_KEY']);
  expect(stored.code, stored.stderr).toBe(0);
  // The team's remote: it has the main branch, and none of Friday's.
  const remote = path.join(ws().root, 'remote.git');
  await deterministicGit(ws().root).run(['init', '-q', '--bare', remote]);
  await deterministicGit(dir).run(['push', '-q', remote, 'HEAD:refs/heads/main']);
  const mainHead = (await deterministicGit(dir).run(['rev-parse', 'HEAD'])).trim();
  return { td, dir, remote, mainHead };
}

interface GoalDetail {
  goal: { goal_id: string; status: string };
  active: { tasks: { key: string; task_id: string | null; status: string | null }[] } | null;
}

/** A goal with a human-written plan of three tasks, approved by a human on the CLI. */
async function approvedGoal(td: TestDaemon, dir: string) {
  const op = td.operator;
  const goal = await op.post<{ goal_id: string }>(op.projectPath('/goals'), {
    request: 'Tune the checkout limits and document them',
    plan: false,
  });
  const scope = (write: string[]) => ({ write, read: ['**'] });
  await op.post(op.projectPath(`/goals/${goal.goal_id}/plans`), {
    draft: {
      objective: 'Tune the checkout limits and document them',
      summary: 'Raise a, keep a + b at most 4, document the limits',
      tasks: [
        {
          key: 'api',
          summary: 'Raise a to 2',
          role: 'backend',
          acceptance_criteria: ['tests pass'],
          scope: scope(['src/a.mjs']),
        },
        {
          key: 'ui',
          summary: 'Set b so that a + b stays at most 4',
          role: 'frontend',
          acceptance_criteria: ['tests pass'],
          scope: scope(['src/b.mjs']),
        },
        {
          key: 'docs',
          summary: 'Document the limits',
          role: 'backend',
          acceptance_criteria: ['the limits are written down'],
          scope: scope(['docs/**', 'notes/**']),
          depends_on: ['api'],
        },
      ],
    },
  });
  const approved = await cli(['--project', dir, 'plan', 'approve']);
  expect(approved.code, approved.stderr).toBe(0);
  const detail = await op.get<GoalDetail>(op.projectPath(`/goals/${goal.goal_id}`));
  const ids = Object.fromEntries((detail.active?.tasks ?? []).map((t) => [t.key, t.task_id as string])) as Record<
    'api' | 'ui' | 'docs',
    string
  >;
  return { goalId: goal.goal_id, branch: `friday/goal-${goal.goal_id}`, ids };
}

const startOf = async (fake: FakeHarness, taskId: string, not?: string) =>
  (
    await fake.waitFor('task.start', 30_000, (m) => {
      const p = m.params as TaskStartParams;
      return p.task_id === taskId && p.run_id !== not;
    })
  ).params as TaskStartParams;

const taskOf = (td: TestDaemon, id: string) =>
  td.operator.get<{ task: TaskView }>(td.operator.projectPath(`/tasks/${id}`)).then((r) => r.task);

async function claim(fake: FakeHarness, start: TaskStartParams, files: Record<string, string>, summary: string) {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(start.working_directory, rel)), { recursive: true });
    writeFileSync(path.join(start.working_directory, rel), body);
  }
  await fake.client.reportResult({
    task_id: start.task_id,
    run_id: start.run_id,
    status: 'completed_claim',
    summary,
    changed_paths: Object.keys(files),
    checks: [{ name: 'tests', kind: 'test', outcome: 'passed' }],
  });
}

const verify = (td: TestDaemon, id: string) =>
  td.operator.post<{ task: TaskView; verification: VerificationView }>(
    td.operator.projectPath(`/tasks/${id}/verify`),
    {},
    { timeoutMs: 120_000 },
  );

const integrationOf = (td: TestDaemon, taskId: string) =>
  eventually(
    () => td.daemon.state.q.latestIntegration(td.project.project_id, taskId),
    (i): i is IntegrationView => i !== undefined,
    `the integration of ${taskId}`,
    60_000,
  ) as Promise<IntegrationView>;

async function settle(fake: FakeHarness, r: OperationResult): Promise<OperationResult> {
  let res = r;
  for (let i = 0; res.status === 'running' && i < 10; i++) {
    res = await fake.client.call('operation.status', {
      operation_run_id: res.operation_run_id as string,
      wait_ms: 20_000,
    });
  }
  return res;
}

/** The goal branch checked out on its own: its tests run with exit code 0. */
async function verifyGoalBranch(dir: string, branch: string, where: string) {
  await runGit(dir, ['worktree', 'add', '-q', '--detach', where, branch]);
  try {
    const r = spawnSync(process.execPath, ['--test', 'test/sum.test.mjs'], { cwd: where, encoding: 'utf8' });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    return { a: text(path.join(where, 'src', 'a.mjs')), b: text(path.join(where, 'src', 'b.mjs')), where };
  } finally {
    await runGit(dir, ['worktree', 'remove', '--force', where]).catch(() => undefined);
  }
}

/** One pass of the Master Brain's coordinator: readies what its dependencies allow, and delegates. */
const coordinate = async (td: TestDaemon) => {
  await td.operator.post(td.operator.projectPath('/brain/run-once'), {});
  await td.operator.post(td.operator.projectPath('/brain/run-once'), {});
};

const authors = async (dir: string, branch: string) =>
  (await runGit(dir, ['log', '--format=%an', branch])).stdout.split('\n').filter(Boolean);

describe('the joined scenario (M7 review §5)', () => {
  it('approve → delegate → packets → a question → an approved secret operation → claims → a failure and its rework → integration → a writer stopped by recovery → the integrated goal verified', async () => {
    const { td, dir, mainHead } = await project();
    const op = td.operator;
    const be1 = await FakeHarness.connect(td, { agentKey: 'be-1', role: 'backend' });
    const fe1 = await FakeHarness.connect(td, { agentKey: 'fe-1', role: 'frontend' });
    ws().track({ close: () => Promise.all([be1.close(), fe1.close()]) });

    // 1. Approval: the Master Brain delegates the two independent tasks by role, each to its own
    // worktree; the dependent one waits; the main checkout is untouched.
    const { goalId, branch, ids } = await approvedGoal(td, dir);
    await coordinate(td);
    const api = await startOf(be1, ids.api);
    const ui = await startOf(fe1, ids.ui);
    expect(same(api.working_directory, ui.working_directory)).toBe(false);
    for (const s of [api, ui]) expect(td.daemon.state.inThisClone(s.working_directory)).toBe(true);
    expect((await taskOf(td, ids.docs)).status).toBe('PROPOSED');
    expect((await runGit(dir, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(mainHead);
    expect((await runGit(dir, ['status', '--porcelain'])).stdout.trim()).toBe('');

    // 2. Each agent asks for the file it changes: its own packet, within the size it asked for.
    const packetA = (await be1.client.requestContext({
      task_id: ids.api,
      run_id: api.run_id,
      kind: 'file',
      paths: ['src/a.mjs'],
      max_chars: 6000,
    })) as ContextPacket;
    const packetB = (await fe1.client.requestContext({
      task_id: ids.ui,
      run_id: ui.run_id,
      kind: 'file',
      paths: ['src/b.mjs'],
      max_chars: 6000,
    })) as ContextPacket;
    const body = (p: ContextPacket) => p.sections.map((s) => s.content).join('\n');
    expect(packetA.task_id).toBe(ids.api);
    expect(packetB.task_id).toBe(ids.ui);
    expect(body(packetA)).toContain('Raise a to 2');
    expect(body(packetA)).toContain('export const a = 1;');
    expect(body(packetB)).toContain('export const b = 1;');
    for (const p of [packetA, packetB]) expect(JSON.stringify(p).length).toBeLessThanOrEqual(6000);

    // 3. A related-work question and its answer, through Friday, acknowledged on both sides.
    const asked = await fe1.client.communicate({
      to: `task:${ids.api}`,
      mode: 'request',
      subject: 'the limit',
      content: 'Will a be 2? Then b must be at most 2.',
      task_id: ids.ui,
    });
    const inboxA = await be1.client.call('message.inbox', { wait_ms: 5000 });
    const question = inboxA.items.find((i) => i.message_id === asked.message_id);
    expect(question).toMatchObject({ mode: 'request', from: { agent_key: 'fe-1' } });
    const answer = await be1.client.communicate({
      to: 'fe-1',
      mode: 'response',
      response_to: asked.message_id,
      content: 'Yes, a is 2.',
      task_id: ids.api,
    });
    const inboxB = await fe1.client.call('message.inbox', { wait_ms: 5000 });
    const reply = inboxB.items.find((i) => i.message_id === answer.message_id);
    expect(reply?.body).toContain('a is 2');
    expect((await fe1.client.call('message.ack', { ids: [reply?.delivery_id as string] })).acknowledged).toHaveLength(
      1,
    );
    for (const mid of [asked.message_id, answer.message_id]) {
      const m = await op.get<MessageView>(op.projectPath(`/messages/${mid}`));
      expect(m.deliveries.map((d) => d.state)).toEqual(['acknowledged']);
    }

    // 4. The operation that needs the sandbox key: a human approves it, Friday runs it with the key,
    // and the agent gets the outcome without the key, which Friday stores nowhere.
    const first = await be1.client.call('operation.run', {
      operation: 'payments-sandbox',
      reason: 'check the new limit against the payment sandbox',
      run_id: api.run_id,
      wait_ms: 0,
    });
    expect(first.status).toBe('approval_required');
    expect((await cli(['--project', dir, 'approve', first.approval_id as string])).code).toBe(0);
    const ran = await settle(
      be1,
      await be1.client.call('operation.run', {
        operation: 'payments-sandbox',
        reason: 'check the new limit against the payment sandbox',
        run_id: api.run_id,
      }),
    );
    expect(ran).toMatchObject({ status: 'passed', exit_code: 0, approval_id: first.approval_id });
    expect(ran.output).toContain('sandbox ok');
    expect(ran.output).toContain('[REDACTED:stripe-sandbox]');
    expect(ran.output).not.toContain(SECRET);

    // 5. Claims. The frontend's first one breaks the limit: its real test fails, and it is reworked
    // in the same worktree by the same agent.
    await claim(fe1, ui, { 'src/b.mjs': 'export const b = 4;\n' }, 'b is 4');
    const failed = await verify(td, ids.ui);
    expect(failed.task.status).toBe('FAILED');
    const tests = failed.verification.checks.find((c) => c.name === 'tests');
    expect(tests).toMatchObject({ status: 'FAILED' });
    expect(tests?.exit_code).not.toBe(0);
    await op.post(op.projectPath(`/tasks/${ids.ui}/rework`), { reason: 'a + b must stay at most 4' });
    await coordinate(td);
    const ui2 = await startOf(fe1, ids.ui, ui.run_id);
    expect(same(ui2.working_directory, ui.working_directory)).toBe(true);
    expect(text(path.join(ui2.working_directory, 'src', 'b.mjs'))).toBe('export const b = 4;\n');

    // 6. The backend's claim passes and is integrated: the goal branch moves to exactly its commit.
    await claim(be1, api, { 'src/a.mjs': 'export const a = 2;\n' }, 'a is 2');
    await be1.close();
    expect((await verify(td, ids.api)).task.status).toBe('COMPLETED');
    const one = await integrationOf(td, ids.api);
    expect(one).toMatchObject({ status: 'integrated', branch });
    expect((await runGit(dir, ['show', `${branch}:src/a.mjs`])).stdout.replace(/\r\n/g, '\n')).toBe(
      'export const a = 2;\n',
    );

    // 7. The rework passes alone; merged with the backend's work it is verified again before the
    // goal branch moves.
    await claim(fe1, ui2, { 'src/b.mjs': 'export const b = 2;\n' }, 'b is 2');
    await fe1.close();
    expect((await verify(td, ids.ui)).task.status).toBe('COMPLETED');
    const two = await integrationOf(td, ids.ui);
    expect(two).toMatchObject({ status: 'integrated', base_commit: one.merged_commit });
    expect(
      two.checks.map((c) => [c.name, c.status]),
      JSON.stringify(two),
    ).toEqual([['tests', 'PASSED']]);

    // 8. The dependent task starts from the integrated work. Its agent runs a writer, then dies.
    const be2 = await FakeHarness.connect(td, { agentKey: 'be-2', role: 'backend' });
    ws().track({ close: () => be2.close() });
    await coordinate(td);
    const docs = await startOf(be2, ids.docs);
    expect(text(path.join(docs.working_directory, 'src', 'a.mjs'))).toBe('export const a = 2;\n');
    expect(text(path.join(docs.working_directory, 'src', 'b.mjs'))).toBe('export const b = 2;\n');
    mkdirSync(path.join(docs.working_directory, 'docs'), { recursive: true });
    writeFileSync(path.join(docs.working_directory, 'docs', 'limits.md'), '# Limits\n\na is 2, b is 2.\n');
    const writing = await be2.client.call('operation.run', {
      operation: 'writer',
      reason: 'collect notes',
      run_id: docs.run_id,
      wait_ms: 0,
    });
    expect(writing.status).toBe('running');
    const writer = path.join(docs.working_directory, 'notes', 'writer.txt');
    const orphan = path.join(docs.working_directory, 'notes', 'orphan.txt');
    await eventually(
      () => size(writer) > 0 && size(orphan) > 0,
      (v) => v,
      'the writer and its child to write',
    );
    await be2.crash();

    // 9. Recovery: a human reassigns. The attempt's work is preserved first, the attempt is fenced,
    // and its operation stops with everything it started.
    const recovered = await cli([
      '--project',
      dir,
      'recover',
      ids.docs,
      '--action',
      'reassign',
      '--reason',
      'its agent died while its writer ran',
    ]);
    expect(recovered.code, recovered.stderr).toBe(0);
    const stopped = await eventually(
      () => td.daemon.state.q.operationRun(writing.operation_run_id as string) as OperationRunView,
      (v) => v.status !== 'running',
      'the writer to stop',
    );
    expect(stopped.status).toBe('interrupted');
    expect(await stillWriting(writer)).toBe(false);
    expect(await stillWriting(orphan)).toBe(false);
    const preserved = `refs/friday/preserved/${ids.docs}/attempt-1`;
    expect((await runGit(dir, ['show', `${preserved}:docs/limits.md`])).stdout).toContain('a is 2, b is 2.');
    // The dead session's process is gone for good now (it never comes back to take the task).
    await be2.close();

    // 10. The next agent continues in the same worktree, with the work left there.
    const be3 = await FakeHarness.connect(td, { agentKey: 'be-3', role: 'backend' });
    ws().track({ close: () => be3.close() });
    await coordinate(td);
    const docs2 = await startOf(be3, ids.docs, docs.run_id);
    expect(same(docs2.working_directory, docs.working_directory)).toBe(true);
    expect(text(path.join(docs2.working_directory, 'docs', 'limits.md'))).toContain('a is 2, b is 2.');
    rmSync(path.join(docs2.working_directory, 'notes'), { recursive: true, force: true });
    await claim(
      be3,
      docs2,
      { 'docs/limits.md': '# Limits\n\na is 2 and b is 2, so a + b stays at most 4.\n' },
      'limits documented',
    );
    await be3.close();
    expect((await verify(td, ids.docs)).task.status).toBe('COMPLETED');
    expect((await integrationOf(td, ids.docs)).status).toBe('integrated');

    // 11. The goal: complete, its branch verified on its own, the main checkout untouched.
    await coordinate(td);
    const final = await eventually(
      () => op.get<GoalDetail>(op.projectPath(`/goals/${goalId}`)),
      (d) => d.goal.status === 'COMPLETED',
      'the goal to complete',
    );
    expect(final.active?.tasks.map((t) => t.status)).toEqual(['COMPLETED', 'COMPLETED', 'COMPLETED']);
    const checked = await verifyGoalBranch(dir, branch, path.join(ws().root, 'goal-check'));
    expect([checked.a, checked.b]).toEqual(['export const a = 2;\n', 'export const b = 2;\n']);
    expect((await runGit(dir, ['show', `${branch}:docs/limits.md`])).stdout).toContain('a + b stays at most 4');
    expect(await authors(dir, branch)).toEqual(
      expect.arrayContaining(['be-1 (via Friday)', 'fe-1 (via Friday)', 'be-3 (via Friday)']),
    );
    expect((await runGit(dir, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(mainHead);
    expect((await runGit(dir, ['status', '--porcelain'])).stdout.trim()).toBe('');
    expect(await stillWriting(orphan)).toBe(false);
    expect(everythingStored(td, ws().fridayDir).includes(SECRET)).toBe(false);
  }, 300_000);

  it('restore variant: a backup in the middle, the clone lost, the goal finished in a clean clone', async () => {
    const { td, dir, remote } = await project();
    const op = td.operator;
    const be1 = await FakeHarness.connect(td, { agentKey: 'be-1', role: 'backend' });
    const fe1 = await FakeHarness.connect(td, { agentKey: 'fe-1', role: 'frontend' });
    const { goalId, branch, ids } = await approvedGoal(td, dir);
    await coordinate(td);
    const api = await startOf(be1, ids.api);
    const ui = await startOf(fe1, ids.ui);

    // The backend's work is integrated; the frontend's first claim fails and its rework is half done.
    await claim(fe1, ui, { 'src/b.mjs': 'export const b = 4;\n' }, 'b is 4');
    expect((await verify(td, ids.ui)).task.status).toBe('FAILED');
    await op.post(op.projectPath(`/tasks/${ids.ui}/rework`), { reason: 'a + b must stay at most 4' });
    await coordinate(td);
    const ui2 = await startOf(fe1, ids.ui, ui.run_id);
    await claim(be1, api, { 'src/a.mjs': 'export const a = 2;\n' }, 'a is 2');
    await be1.close();
    expect((await verify(td, ids.api)).task.status).toBe('COMPLETED');
    const one = await integrationOf(td, ids.api);
    expect(one.status).toBe('integrated');
    // The dependent task is claimed before the backup, and waits to be verified (review M7.1 R05).
    await coordinate(td);
    expect((await taskOf(td, ids.docs)).status).toBe('READY');
    const be2a = await FakeHarness.connect(td, { agentKey: 'be-2', role: 'backend' });
    await op.post(op.projectPath(`/tasks/${ids.docs}/assign`), { agent_key: 'be-2' });
    const docsA = await startOf(be2a, ids.docs);
    await claim(be2a, docsA, { 'docs/limits.md': '# Limits\n\na is 2 and b is 2.\n' }, 'limits documented');
    await be2a.close();
    expect((await taskOf(td, ids.docs)).status).toBe('READY_FOR_VERIFICATION');
    writeFileSync(path.join(ui2.working_directory, 'src', 'b.mjs'), 'export const b = 2;\n');

    // A backup, then the disk is lost: the clone, its git repository and its worktrees.
    const backup = path.join(ws().root, 'backup');
    const made = await cli(['--project', dir, 'backup', '--into', backup]);
    expect(made.code, made.stderr).toBe(0);
    await fe1.close();
    await td.daemon.close('the disk is lost');
    for (const w of [api.working_directory, ui.working_directory, docsA.working_directory]) {
      rmSync(w, LOST);
    }
    rmSync(dir, LOST);

    // A clean clone of the team's remote, the backup restored into it, Friday started there. A copy
    // of the backup whose database was damaged is refused first, before anything changes (review
    // M7.1 R07).
    const B = path.join(ws().root, 'b');
    await deterministicGit(ws().root).run(['clone', '-q', remote, B]);
    const damaged = path.join(ws().root, 'backup-damaged');
    cpSync(backup, damaged, { recursive: true });
    writeFileSync(path.join(damaged, 'project.db'), 'THIS_IS_NOT_SQLITE');
    const refused = await cli(['--project', B, 'restore', '--from', damaged]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toMatch(/project\.db does not match its manifest/);
    expect(existsSync(path.join(B, '.friday', 'project.db'))).toBe(false);
    expect((await runGit(B, ['for-each-ref', 'refs/heads/friday', 'refs/friday'])).stdout.trim()).toBe('');
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
    expect((await runGit(B, ['rev-parse', branch])).stdout.trim()).toBe(one.merged_commit);

    // The frontend's attempt was in the lost clone: a human brings its work into this one, and
    // gives the task to an agent here (the restored state still lists the lost clone's sessions).
    const fe2 = await FakeHarness.connect(b, { agentKey: 'fe-2', role: 'frontend' });
    ws().track({ close: () => fe2.close() });
    await b.operator.post(b.operator.projectPath(`/tasks/${ids.ui}/release`), {
      reason: 'its session was in the lost clone',
    });
    const back = await cli(['--project', B, 'recover', ids.ui, '--action', 'reassign', '--reason', 'continue here']);
    expect(back.code, back.stderr).toBe(0);
    await b.operator.post(b.operator.projectPath(`/tasks/${ids.ui}/assign`), { agent_key: 'fe-2' });
    const ui3 = await startOf(fe2, ids.ui);
    expect(daemon.state.inThisClone(ui3.working_directory)).toBe(true);
    expect(text(path.join(ui3.working_directory, 'src', 'b.mjs'))).toBe('export const b = 2;\n');
    await claim(fe2, ui3, { 'src/b.mjs': 'export const b = 2;\n' }, 'b is 2');
    await fe2.close();
    expect((await verify(b, ids.ui)).task.status).toBe('COMPLETED');
    const two = await integrationOf(b, ids.ui);
    expect(two).toMatchObject({ status: 'integrated', base_commit: one.merged_commit });

    // The dependent task's claim was in the lost clone too: its work is brought here as it is, the
    // task stays READY_FOR_VERIFICATION, and its real checks run here (review M7.1 R05).
    const rebound = await cli([
      '--project',
      B,
      'recover',
      ids.docs,
      '--action',
      'rebind',
      '--reason',
      'verify it here',
    ]);
    expect(rebound.code, rebound.stderr).toBe(0);
    expect((await taskOf(b, ids.docs)).status).toBe('READY_FOR_VERIFICATION');
    const docsTree = daemon.state.q.worktreeForTask(ids.docs)?.path as string;
    expect(daemon.state.inThisClone(docsTree)).toBe(true);
    expect(text(path.join(docsTree, 'docs', 'limits.md'))).toContain('a is 2 and b is 2.');
    const docsVerified = await verify(b, ids.docs);
    expect(docsVerified.task.status).toBe('COMPLETED');
    expect(docsVerified.verification.execution_root).toBe(docsTree);
    expect((await integrationOf(b, ids.docs)).status).toBe('integrated');
    await coordinate(b);
    await eventually(
      () => b.operator.get<GoalDetail>(b.operator.projectPath(`/goals/${goalId}`)),
      (d) => d.goal.status === 'COMPLETED',
      'the goal to complete in the restored clone',
    );
    const checked = await verifyGoalBranch(B, branch, path.join(ws().root, 'goal-check-b'));
    expect([checked.a, checked.b]).toEqual(['export const a = 2;\n', 'export const b = 2;\n']);
    expect((await runGit(B, ['status', '--porcelain'])).stdout.trim()).toBe('');
  }, 300_000);
});
