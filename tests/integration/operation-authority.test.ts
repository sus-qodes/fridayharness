/**
 * The authority and the lifetime of a gateway operation (review F06, F07): an operation starts only
 * under the authority that holds when it starts, not the one checked before its credentials loaded;
 * and it ends, with every process it started, when that authority ends.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { OperationRunView, TaskStartParams, TaskView } from '@friday/protocol';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cli } from '../helpers/cli.js';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { FakeHarness } from '../helpers/fake-harness.js';

/** Holds the gateway inside credential loading until the test lets it go on. */
const gate = vi.hoisted(() => {
  let letGo: () => void = () => {};
  let signal: () => void = () => {};
  const g = {
    held: null as Promise<void> | null,
    entered: null as Promise<void> | null,
    arm() {
      g.held = new Promise<void>((r) => {
        letGo = r;
      });
      g.entered = new Promise<void>((r) => {
        signal = r;
      });
    },
    release: () => letGo(),
    enter: () => signal(),
    reset() {
      g.held = null;
      g.entered = null;
    },
  };
  return g;
});

vi.mock('@friday/sdk', async (importOriginal) => {
  const real = await importOriginal<typeof import('@friday/sdk')>();
  return {
    ...real,
    // A dummy secret, "stored" for the test: never a real one.
    hasSecret: (name: string, env?: NodeJS.ProcessEnv) => name === 'dummy' || real.hasSecret(name, env),
    resolveSecret: async (name: string, env?: NodeJS.ProcessEnv) => {
      if (name !== 'dummy') return real.resolveSecret(name, env);
      gate.enter();
      if (gate.held) await gate.held;
      return 'dummy-token-0123456789';
    },
  };
});

const ws = useTestWorkspace();
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FRIDAY_STATE_DIR;
  process.env.FRIDAY_STATE_DIR = ws().stateDir;
  gate.reset();
});
afterEach(() => {
  gate.release();
  if (saved === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = saved;
});

const MARK = [
  "import { mkdirSync, writeFileSync } from 'node:fs';",
  "mkdirSync('notes', { recursive: true });",
  "writeFileSync('notes/mark.txt', 'ran\\n');",
  '',
].join('\n');

/**
 * Writes, and starts a grandchild that writes too, then keeps going (both stop by themselves after
 * 15 s, so nothing outlives the test). The grandchild is detached on Windows: only a job holds it.
 */
const WRITER = [
  "import { spawn } from 'node:child_process';",
  "import { appendFileSync, mkdirSync } from 'node:fs';",
  "mkdirSync('notes', { recursive: true });",
  "const orphan = \"setInterval(() => require('node:fs').appendFileSync('notes/orphan.txt', 'x'), 40); setTimeout(() => process.exit(0), 15000);\";",
  "spawn(process.execPath, ['-e', orphan], { stdio: 'ignore', windowsHide: true, detached: process.platform === 'win32' }).unref();",
  "setInterval(() => appendFileSync('notes/writer.txt', 'x'), 40);",
  'setTimeout(() => process.exit(0), 15000);',
  '',
].join('\n');

const OPERATIONS = (withMark: boolean) =>
  [
    'operations:',
    ...(withMark
      ? [
          '  mark:',
          '    command: node',
          '    args: ["scripts/mark.mjs"]',
          '    credentials: { TOKEN: dummy }',
          '    risk: low',
        ]
      : []),
    '  writer:',
    '    command: node',
    '    args: ["scripts/writer.mjs"]',
    '    risk: low',
    '',
  ].join('\n');

const policyFile = () => path.join(ws().fridayDir, 'policies', 'operations.yaml');

async function project(): Promise<TestDaemon> {
  const td = await startTestDaemon(ws(), { git: true, brain: false });
  const dir = ws().projectDir;
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  writeFileSync(path.join(dir, 'scripts', 'mark.mjs'), MARK);
  writeFileSync(path.join(dir, 'scripts', 'writer.mjs'), WRITER);
  await deterministicGit(dir, { startEpoch: 1_767_225_700 }).commitAll('scripts');
  mkdirSync(path.dirname(policyFile()), { recursive: true });
  writeFileSync(policyFile(), OPERATIONS(true));
  expect((await cli(['--project', dir, 'policy', 'trust', '--yes'])).code).toBe(0);
  return td;
}

async function eventually<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${String(JSON.stringify(v)).slice(0, 300)}`);
    await sleep(50);
  }
}

const taskOf = (td: TestDaemon, id: string) =>
  td.operator.get<{ task: TaskView }>(td.operator.projectPath(`/tasks/${id}`)).then((r) => r.task);

/** A backend agent running a task in its own worktree. */
async function agentOnTask(td: TestDaemon, agentKey = 'backend-1') {
  const fake = await FakeHarness.connect(td, { agentKey, role: 'backend' });
  const task = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
    summary: 'work with operations',
    kind: 'chore',
    scope: { write: ['notes/**'], read: [] },
    ready: true,
  });
  await td.operator.post(td.operator.projectPath(`/tasks/${task.task_id}/assign`), { agent_key: agentKey });
  const start = (await fake.waitFor('task.start', 30_000)).params as TaskStartParams;
  await eventually(
    () => taskOf(td, task.task_id),
    (t) => t.status === 'RUNNING',
    'the task to run',
  );
  return { fake, client: fake.client, task, run_id: start.run_id, workdir: start.working_directory };
}

const size = (f: string) => (existsSync(f) ? statSync(f).size : 0);
async function stillWriting(file: string, ms = 400): Promise<boolean> {
  const a = size(file);
  await sleep(ms);
  return size(file) > a;
}
const same = (a: string, b: string) =>
  process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : a === b;

describe('operation authority at launch (review F06)', () => {
  it('starts no operation whose task was cancelled while its credentials loaded', async () => {
    const td = await project();
    const a = await agentOnTask(td);
    gate.arm();
    const call = a.client.call('operation.run', { operation: 'mark', reason: 'mark it', run_id: a.run_id });
    await gate.entered;
    await td.operator.post(td.operator.projectPath(`/tasks/${a.task.task_id}/cancel`), { reason: 'changed my mind' });
    gate.release();
    const r = await call;
    expect(r.status).toBe('denied');
    expect(r.reason).toContain('CANCELLED');
    await sleep(500);
    expect(existsSync(path.join(a.workdir, 'notes', 'mark.txt'))).toBe(false);
    expect(td.daemon.state.q.operationRuns(td.project.project_id, { task_id: a.task.task_id })).toEqual([]);
  });

  it('starts no operation the project stopped declaring while its credentials loaded', async () => {
    const td = await project();
    const a = await agentOnTask(td);
    gate.arm();
    const call = a.client.call('operation.run', { operation: 'mark', reason: 'mark it', run_id: a.run_id });
    await gate.entered;
    // Removing an operation tightens the policy, which applies at once.
    writeFileSync(policyFile(), OPERATIONS(false));
    await td.operator.post(td.operator.projectPath('/policy/reload'), {});
    gate.release();
    const r = await call;
    expect(r.status).toBe('denied');
    expect(r.reason).toMatch(/policy changed/);
    await sleep(500);
    expect(existsSync(path.join(a.workdir, 'notes', 'mark.txt'))).toBe(false);
  });
});

describe('operation lifetime (review F07)', () => {
  it('stops a running operation, and what it started, when its task is cancelled', async () => {
    const td = await project();
    const a = await agentOnTask(td);
    const r = await a.client.call('operation.run', {
      operation: 'writer',
      reason: 'write',
      run_id: a.run_id,
      wait_ms: 0,
    });
    expect(r.status).toBe('running');
    const writer = path.join(a.workdir, 'notes', 'writer.txt');
    const orphan = path.join(a.workdir, 'notes', 'orphan.txt');
    await eventually(
      () => size(writer) > 0 && size(orphan) > 0,
      (v) => v,
      'the operation and its child to write',
    );
    await td.operator.post(td.operator.projectPath(`/tasks/${a.task.task_id}/cancel`), { reason: 'stop it' });
    const view = await eventually(
      () => td.daemon.state.q.operationRun(r.operation_run_id as string) as OperationRunView,
      (v) => v.status !== 'running',
      'the operation to stop',
      10_000,
    );
    expect(view.status).toBe('interrupted');
    expect(view.summary).toContain('stopped');
    expect(await stillWriting(writer)).toBe(false);
    expect(await stillWriting(orphan)).toBe(false);
  }, 60_000);

  it('gives the worktree to a new attempt only once the old attempt operation stopped', async () => {
    const td = await project();
    const a = await agentOnTask(td);
    const r = await a.client.call('operation.run', {
      operation: 'writer',
      reason: 'write',
      run_id: a.run_id,
      wait_ms: 0,
    });
    expect(r.status).toBe('running');
    const writer = path.join(a.workdir, 'notes', 'writer.txt');
    const orphan = path.join(a.workdir, 'notes', 'orphan.txt');
    await eventually(
      () => size(writer) > 0 && size(orphan) > 0,
      (v) => v,
      'the operation and its child to write',
    );
    // A human takes the task back and gives it to another agent, in the same worktree.
    const b = await FakeHarness.connect(td, { agentKey: 'backend-2', role: 'backend' });
    await td.operator.post(td.operator.projectPath(`/tasks/${a.task.task_id}/release`), { reason: 'reassign' });
    await td.operator.post(td.operator.projectPath(`/tasks/${a.task.task_id}/assign`), { agent_key: 'backend-2' });
    const start = (await b.waitFor('task.start', 30_000)).params as TaskStartParams;
    expect(same(start.working_directory, a.workdir)).toBe(true);
    // When the new attempt may work there, nothing of the old one still writes.
    expect(td.daemon.state.q.operationRun(r.operation_run_id as string)?.status).toBe('interrupted');
    expect(await stillWriting(writer)).toBe(false);
    expect(await stillWriting(orphan)).toBe(false);
  }, 60_000);
});
