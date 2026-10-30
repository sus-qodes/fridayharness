/**
 * OpenCode checkpoint D (plan M14.4): the worker lifecycle against a scripted OpenCode server
 * (`tests/fixtures/opencode/fake-opencode.mjs` with its prompt scripts) and a real daemon. A task
 * goes to a new bound session as one prompt with its packet, its calls are judged for that task and
 * run, and the final answer is the claim; a cancellation stops a busy session with no call after
 * it and ends its server; a restarted worker resumes the run in a new session under the policy of
 * that moment; nothing an ended attempt still says is recorded. No model is called.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPENCODE_CLOSING, OPENCODE_RULES, OpenCodeWorker } from '@friday/adapter-opencode';
import type { TaskStartParams, TaskView } from '@friday/protocol';
import { FakeClock, useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli } from '../helpers/cli.js';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';

/** A model the owner's static ranking (ADR-0031) lists for OpenCode: GLM 5.3, backend rank 5. */
const OPENCODE_MODEL = 'z-ai/glm-5.3';

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

const FAKE = fileURLToPath(new URL('../fixtures/opencode/fake-opencode.mjs', import.meta.url));
type Step = Record<string, unknown>;

function dependencies(root: string): string {
  const dir = path.join(root, 'deps');
  mkdirSync(path.join(dir, 'node_modules/@opencode-ai/plugin'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { '@opencode-ai/plugin': '1.19.3' } }));
  writeFileSync(
    path.join(dir, 'package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { '@opencode-ai/plugin': '1.19.3' } },
        'node_modules/@opencode-ai/plugin': { version: '1.19.3' },
      },
    }),
  );
  writeFileSync(path.join(dir, 'node_modules/@opencode-ai/plugin/package.json'), '{"version":"1.19.3"}');
  return dir;
}

/** An OpenCode worker for Friday, its server scripted: each prompt runs the next script of `prompts`. */
function worker(
  td: TestDaemon,
  agent: string,
  prompts: Step[][],
  opts: { dir?: string; harnessKey?: string; missPolls?: number } = {},
) {
  const dir = opts.dir ?? path.join(ws().root, `opencode-${agent}`);
  mkdirSync(dir, { recursive: true });
  const log = path.join(dir, 'host.jsonl');
  const fixture = path.join(dir, 'fixture.json');
  writeFileSync(
    fixture,
    JSON.stringify({ log, prompts, counter: path.join(dir, 'counter.txt'), missPolls: opts.missPolls ?? 0 }),
  );
  const w = new OpenCodeWorker({
    bootstrap: td.bootstrap,
    projectId: td.project.project_id,
    agentKey: agent,
    role: 'backend',
    host: { command: process.execPath, args: [FAKE, '--fixture', fixture] },
    dependenciesDir: existsSync(path.join(dir, 'deps')) ? path.join(dir, 'deps') : dependencies(dir),
    inference: { baseURL: 'http://127.0.0.1:9/v1', model: OPENCODE_MODEL },
    workDir: dir,
    hostEnv: { ...process.env },
    ...(opts.harnessKey ? { harnessKey: opts.harnessKey } : {}),
    ...(process.env.FRIDAY_TEST_DEBUG ? { log: (m: string) => console.error(`[${agent}] ${m}`) } : {}),
  });
  ws().track({ close: () => w.close() });
  const entries = (): Record<string, unknown>[] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  return { worker: w, entries, dir };
}

/** Waits for a state; 60 s, since a scripted host on a busy machine is several times slower (LESSONS T-110). */
async function eventually<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, what: string, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v).slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function assigned(td: TestDaemon, agent: string, write: string[], summary = `work of ${agent}`) {
  const t = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
    summary,
    scope: { write, read: [] },
    ready: true,
  });
  await td.operator.post(td.operator.projectPath(`/tasks/${t.task_id}/assign`), { agent_key: agent });
  return t.task_id;
}

const status = (td: TestDaemon, id: string) => td.daemon.state.q.task(td.project.project_id, id);
const events = (td: TestDaemon, id: string) => td.daemon.state.store.readByRef(td.project.project_id, 'task', id);
const agentEvents = (td: TestDaemon, id: string, type: string) =>
  events(td, id)
    .filter((e) => e.type === 'agent.event' && (e.payload as { event_type: string }).event_type === type)
    .map((e) => e.payload as { run_id?: string; data?: Record<string, unknown> });
/** The claim of a task's latest attempt, as Friday recorded it. */
const claimOf = (td: TestDaemon, id: string) => td.daemon.state.q.runs(id).at(-1)?.claim;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const tools = (entries: Record<string, unknown>[]) => entries.filter((e) => e.op === 'tool');
const pids = (entries: Record<string, unknown>[]) =>
  entries.filter((e) => e.op === 'environment').map((e) => e.pid as number);

describe('OpenCode checkpoint D: the worker lifecycle (plan M14.4)', () => {
  it('takes a task as one prompt with its packet, judges its calls for that task, and claims the work', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    const o = worker(td, 'oc-1', [
      [
        { call: { tool: 'write', args: { filePath: 'src/done.ts', content: 'export const done = true;\n' } } },
        { call: { tool: 'write', args: { filePath: 'docs/outside.txt', content: 'outside\n' } } },
        { answer: 'I added src/done.ts.\n{"status":"completed","summary":"added src/done.ts"}' },
      ],
    ]);
    await o.worker.start();
    const harness = td.daemon.state.q.findHarness(o.worker.harnessId);
    expect(harness).toMatchObject({ vendor: 'opencode', attach_mode: 'spawn', enforcement_level: 'L1' });
    expect(harness?.capabilities).toMatchObject({ cost_class: 'free', models: [OPENCODE_MODEL], task_start: true });
    const id = await assigned(td, 'oc-1', ['src/**'], 'Add src/done.ts');
    const done = await eventually(
      () => status(td, id),
      (t) => t.status === 'READY_FOR_VERIFICATION',
      'the claim',
    );
    const start = o.worker.received.find((m) => m.method === 'task.start')?.params as TaskStartParams;
    // One prompt: Friday's rules, the task's packet, and the task itself.
    const prompts = o.entries().filter((e) => e.op === 'prompt');
    expect(prompts).toHaveLength(1);
    const text = String(prompts[0]?.text);
    expect(text.startsWith(OPENCODE_RULES)).toBe(true);
    // The last line tells a small model to use its tools before it answers (LESSONS HX-40).
    expect(text.endsWith(OPENCODE_CLOSING)).toBe(true);
    expect(text).toContain('<friday-context');
    expect(text).toContain('Add src/done.ts');
    // Each call was judged for this task and run: the write in scope happened, the one outside did not.
    expect(tools(o.entries()).map((e) => [e.decision, (e.args as { filePath: string }).filePath])).toEqual([
      ['allow', 'src/done.ts'],
      ['deny', 'docs/outside.txt'],
    ]);
    expect(String(tools(o.entries())[1]?.reason)).toMatch(/outside the scope/);
    expect(existsSync(path.join(start.working_directory, 'src', 'done.ts'))).toBe(true);
    expect(existsSync(path.join(start.working_directory, 'docs', 'outside.txt'))).toBe(false);
    // The claim: the summary from the final line of JSON, the changed paths from the worktree.
    const claim = claimOf(td, id) as {
      summary?: string;
      changed_paths?: string[];
      discrepancies?: unknown[];
    };
    expect(claim.summary).toBe('added src/done.ts');
    expect(claim.changed_paths).toContain('src/done.ts');
    // The session's completed write was observed before the claim named it.
    expect(td.daemon.state.q.runs(id).at(-1)?.observed_paths).toContain('src/done.ts');
    expect(claim.discrepancies).toEqual([]);
    expect(done.status).toBe('READY_FOR_VERIFICATION');
    // What the session cost, as the host counted it: nothing paid.
    expect(agentEvents(td, id, 'host.usage').map((u) => u.data)).toEqual([
      {
        cost_usd: 0,
        input_tokens: 120,
        output_tokens: 30,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        turns: 1,
        model: OPENCODE_MODEL,
      },
    ]);
    // The attempt's server ended and its private profile is gone.
    await eventually(
      () => pids(o.entries()).every((p) => !alive(p)),
      (x) => x,
      'the server to end',
    );
    expect(o.worker.running(start.run_id)).toBe(false);
  });

  it('reports a BLOCKED: answer as blocked, and any other answer as a claim with its text', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    const o = worker(td, 'oc-1', [
      [{ answer: 'BLOCKED: src/ is empty; what should it hold?' }],
      [{ answer: 'Done: nothing needed changing.' }],
    ]);
    await o.worker.start();
    const blocked = await assigned(td, 'oc-1', ['src/**'], 'first');
    await eventually(
      () => status(td, blocked).status,
      (s) => s === 'WAITING',
      'the blocked answer',
    );
    expect(status(td, blocked).waiting_reason).toBe('blocked');
    await td.operator.post(td.operator.projectPath(`/tasks/${blocked}/cancel`), { reason: 'enough' });
    const prose = await assigned(td, 'oc-1', ['src/**'], 'second');
    await eventually(
      () => status(td, prose).status,
      (s) => s === 'READY_FOR_VERIFICATION',
      'the prose claim',
    );
    const claim = claimOf(td, prose) as { summary?: string };
    expect(claim.summary).toBe('Done: nothing needed changing.');
  });

  it('stops a busy session when its task is cancelled: no call after the stop, and its server ends', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    const o = worker(td, 'oc-1', [
      [{ loop: { tool: 'write', args: { filePath: 'src/busy.ts', content: 'busy\n' }, everyMs: 30 } }],
    ]);
    await o.worker.start();
    const id = await assigned(td, 'oc-1', ['src/**']);
    await eventually(
      () => tools(o.entries()).length,
      (n) => n >= 3,
      'the session to be busy',
    );
    const run = status(td, id).current_run_id as string;
    await td.operator.post(td.operator.projectPath(`/tasks/${id}/cancel`), { reason: 'not wanted any more' });
    await eventually(
      () => o.worker.running(run),
      (r) => !r,
      'the session to stop',
    );
    const stopped = Date.now();
    const calls = tools(o.entries()).length;
    expect(o.entries().some((e) => e.op === 'abort')).toBe(true);
    await eventually(
      () => pids(o.entries()).every((p) => !alive(p)),
      (x) => x,
      'the server to end',
    );
    await new Promise((r) => setTimeout(r, 500));
    // No call after the stop, and nothing more recorded for the run.
    expect(tools(o.entries())).toHaveLength(calls);
    expect(tools(o.entries()).every((e) => (e.t as number) <= stopped)).toBe(true);
    expect(status(td, id).status).toBe('CANCELLED');
    expect(Boolean(claimOf(td, id))).toBe(false);
  });

  it('keeps a session whose host misses a few polls while the model works (LESSONS HX-41)', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    const o = worker(td, 'oc-1', [[{ wait: 500 }, { answer: 'Nothing needed changing.' }]], { missPolls: 3 });
    await o.worker.start();
    const id = await assigned(td, 'oc-1', ['src/**']);
    await eventually(
      () => status(td, id).status,
      (s) => s === 'READY_FOR_VERIFICATION',
      'the claim after the missed polls',
    );
    expect(o.entries().filter((e) => e.op === 'request' && e.path === '/session/status').length).toBeGreaterThan(3);
  });

  it('leaves no private profile behind when it is closed the moment a claim lands', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    const o = worker(td, 'oc-1', [[{ answer: 'Nothing needed changing.' }]]);
    await o.worker.start();
    const id = await assigned(td, 'oc-1', ['src/**']);
    await eventually(
      () => status(td, id).status,
      (s) => s === 'READY_FOR_VERIFICATION',
      'the claim',
    );
    // The attempt may still be ending (its server stopping, its profile being removed): close waits.
    await o.worker.close();
    expect(readdirSync(o.dir).filter((n) => n.startsWith('attempt-'))).toEqual([]);
  });

  it('drops what an ended attempt says late', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    // The session answers after a pause; the task is cancelled during it.
    const o = worker(td, 'oc-1', [[{ wait: 1500 }, { answer: '{"status":"completed","summary":"too late"}' }]]);
    await o.worker.start();
    const id = await assigned(td, 'oc-1', ['src/**']);
    await eventually(
      () => o.entries().filter((e) => e.op === 'prompt').length,
      (n) => n === 1,
      'the prompt',
    );
    await td.operator.post(td.operator.projectPath(`/tasks/${id}/cancel`), { reason: 'changed my mind' });
    await new Promise((r) => setTimeout(r, 2500));
    expect(status(td, id).status).toBe('CANCELLED');
    expect(Boolean(claimOf(td, id))).toBe(false);
    expect(agentEvents(td, id, 'host.usage')).toEqual([]);
  });

  it('is started from the command line with a model server and a model, both, and only for OpenCode', async () => {
    const other = await cli(['harness', 'run', 'codex', '--model', 'qwen2.5:7b']);
    expect(other.code).not.toBe(0);
    expect(other.stderr).toContain('--model-url and --model are for opencode');
    const half = await cli(['harness', 'run', 'opencode', '--model-url', 'http://127.0.0.1:11434/v1']);
    expect(half.code).not.toBe(0);
    expect(half.stderr).toContain('opencode takes --model-url and --model together');
  });

  it('resumes the run after a restart in a new session, under the policy of that moment', async () => {
    const clock = new FakeClock(new Date().toISOString());
    const td = await startTestDaemon(ws(), { git: true, brain: false, clock });
    const dir = path.join(ws().root, 'opencode-restarting');
    const prompts: Step[][] = [
      [{ loop: { tool: 'write', args: { filePath: 'src/first.ts', content: 'first\n' }, everyMs: 50 } }],
      [
        { call: { tool: 'write', args: { filePath: 'src/after.ts', content: 'after\n' } } },
        { call: { tool: 'write', args: { filePath: 'src/locked/x.ts', content: 'x\n' } } },
        { answer: 'I finished the files after the restart.' },
      ],
    ];
    const first = worker(td, 'oc-1', prompts, { dir, harnessKey: 'opencode:restarting' });
    await first.worker.start();
    const id = await assigned(td, 'oc-1', ['src/**']);
    await eventually(
      () => tools(first.entries()).length,
      (n) => n >= 2,
      'the first session to work',
    );
    const firstSession = first.worker.session(status(td, id).current_run_id as string);
    // The worker dies: its session and server end with it, and Friday is told nothing.
    await first.worker.crash();
    await eventually(
      () => pids(first.entries()).every((p) => !alive(p)),
      (x) => x,
      'the first server to end',
    );
    // While it is away, the project forbids a folder: the resumed session meets that rule.
    mkdirSync(path.join(ws().projectDir, '.friday', 'policies'), { recursive: true });
    writeFileSync(
      path.join(ws().projectDir, '.friday', 'policies', 'lock.yaml'),
      'deny:\n  write: ["src/locked/**"]\n',
    );
    clock.advance(31_000);
    td.daemon.tick();
    expect(status(td, id).status).toBe('HARNESS_LOST');
    const second = worker(td, 'oc-1', prompts, { dir, harnessKey: 'opencode:restarting' });
    await second.worker.start();
    const resume = await eventually(
      () => second.worker.received.find((m) => m.method === 'task.resume'),
      (m) => Boolean(m),
      'task.resume',
    );
    expect((resume?.params as TaskStartParams | undefined)?.session_ref).toBe(firstSession);
    await eventually(
      () => status(td, id).status,
      (s) => s === 'READY_FOR_VERIFICATION',
      'the claim after resuming',
    );
    const prompt = second
      .entries()
      .filter((e) => e.op === 'prompt')
      .at(-1);
    expect(String(prompt?.text)).toContain('ended unexpectedly');
    const after = tools(second.entries()).slice(-2);
    expect(after.map((e) => [e.decision, (e.args as { filePath: string }).filePath])).toEqual([
      ['allow', 'src/after.ts'],
      ['deny', 'src/locked/x.ts'],
    ]);
    const claim = claimOf(td, id) as {
      summary?: string;
      changed_paths?: string[];
    };
    expect(claim.summary).toBe('I finished the files after the restart.');
    expect(claim.changed_paths).toEqual(expect.arrayContaining(['src/after.ts', 'src/first.ts']));
    expect(claim.changed_paths).not.toContain('src/locked/x.ts');
  });
});
