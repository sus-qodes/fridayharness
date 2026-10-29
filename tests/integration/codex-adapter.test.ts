/**
 * The Codex adapter (ADR-0032) driving a scripted app-server that speaks the protocol recorded in
 * M3.5 (`tests/fixtures/codex/fake-app-server.mjs`): Friday's settings pinned on every thread,
 * approvals answered through Friday's policy, the model the host reports, messages steered into
 * the running turn, and a turn's end reported as a claim, a blocked result or an error.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEX_RULES, CodexAdapter } from '@friday/adapter-codex';
import type { TaskStartParams, TaskView } from '@friday/protocol';
import { FakeClock, useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';

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

const FAKE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'codex',
  'fake-app-server.mjs',
);

type Step = Record<string, unknown>;
interface Script {
  model?: string;
  multiAgentMode?: string;
  turns: Step[][];
  resume?: Step[];
}

/** A Codex agent working for Friday, its host scripted. */
function codex(td: TestDaemon, agent: string, script: Script, opts: { harnessKey?: string; dir?: string } = {}) {
  const dir = opts.dir ?? path.join(ws().root, `codex-${agent}`);
  mkdirSync(dir, { recursive: true });
  const scriptFile = path.join(dir, 'script.json');
  writeFileSync(scriptFile, JSON.stringify(script));
  const log = path.join(dir, 'log.jsonl');
  const work = path.join(dir, 'work');
  const adapter = new CodexAdapter({
    bootstrap: td.bootstrap,
    projectId: td.project.project_id,
    agentKey: agent,
    role: 'backend',
    host: { command: process.execPath, args: [FAKE], version: '0.162.1' },
    hostEnv: { ...process.env, FAKE_CODEX_SCRIPT: scriptFile, FAKE_CODEX_LOG: log, FAKE_CODEX_WORK: work },
    sandbox: 'workspace-write',
    ...(opts.harnessKey ? { harnessKey: opts.harnessKey } : {}),
    // FRIDAY_TEST_DEBUG=1 shows what the adapter saw.
    ...(process.env.FRIDAY_TEST_DEBUG ? { log: (m: string) => console.error(`[${agent}] ${m}`) } : {}),
  });
  ws().track({ close: () => adapter.close() });
  const entries = (): Record<string, unknown>[] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  const workDone = (taskId: string) => {
    const f = path.join(work, `${taskId}.work`);
    return existsSync(f) ? statSync(f).size : 0;
  };
  return { adapter, entries, workDone, dir };
}

async function eventually<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> {
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

describe('the Codex adapter', () => {
  it("pins Friday's settings on its threads, answers approvals by Friday's policy, and claims the work", async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    const pid = td.project.project_id;
    const c = codex(td, 'cx-1', {
      model: 'gpt-fake',
      turns: [
        [
          { op: 'write', path: 'src/ok.ts', text: 'export const ok = 1;\n' },
          { op: 'write', path: 'docs/no.md', text: 'not mine\n' },
          { op: 'command', command: 'node --test' },
          { op: 'command', command: 'git push' },
          { op: 'write', path: 'src/quiet.ts', text: 'export const quiet = 1;\n', ask: false },
          { op: 'reroute', to: 'gpt-fake-mini' },
          { op: 'final', status: 'completed', summary: 'wrote ok', changed_paths: ['src/ok.ts'] },
        ],
      ],
    });
    await c.adapter.start();
    const id = await assigned(td, 'cx-1', ['src/**']);
    await eventually(
      () => status(td, id).status,
      (s) => s === 'READY_FOR_VERIFICATION',
      'the claim',
    );
    const run = td.daemon.state.q.findRun(status(td, id).current_run_id as string);
    const root = run?.execution_root as string;

    // Every thread starts with Friday's settings, its rules and the task's context.
    const started = c.entries().find((e) => e.request === 'thread/start')?.params as Record<string, unknown>;
    expect(started).toMatchObject({
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
    });
    expect(path.resolve(String(started.cwd))).toBe(path.resolve(root));
    expect(String(started.developerInstructions)).toContain(CODEX_RULES.split('\n')[0]);
    expect(String(started.developerInstructions)).toContain(id);
    const turn = c.entries().find((e) => e.request === 'turn/start')?.params as Record<string, unknown>;
    expect(turn.outputSchema).toBeTruthy();
    expect(String((turn.input as { text: string }[])[0]?.text)).toContain(id);

    // Approvals were Friday's decisions: in scope and safe passed, the rest did not.
    const answers = c
      .entries()
      .filter((e) => e.approval)
      .map((e) => [e.path ?? e.command, (e.answer as { decision: string }).decision]);
    expect(answers).toEqual([
      ['src/ok.ts', 'accept'],
      ['docs/no.md', 'decline'],
      ['node --test', 'accept'],
      ['git push', 'decline'],
    ]);
    expect(existsSync(path.join(root, 'src', 'ok.ts'))).toBe(true);
    expect(existsSync(path.join(root, 'docs', 'no.md'))).toBe(false);

    // The claim lists what changed, the change Codex made without asking included, and that change is reported.
    const claim = run?.claim as { changed_paths: string[]; summary: string };
    expect(claim.summary).toBe('wrote ok');
    expect(claim.changed_paths).toEqual(expect.arrayContaining(['src/ok.ts', 'src/quiet.ts']));
    const events = td.daemon.state.store.readByRef(pid, 'task', id);
    const unmediated = events.find(
      (e) => e.type === 'agent.event' && (e.payload as { event_type: string }).event_type === 'host.unmediated_write',
    );
    expect((unmediated?.payload as { data?: { paths?: string[] } } | undefined)?.data?.paths).toEqual(['src/quiet.ts']);
    const judged = events.filter((e) => e.type === 'policy.evaluated').map((e) => (e.payload as { tool: string }).tool);
    expect(new Set(judged)).toEqual(new Set(['fileChange', 'commandExecution']));

    // The model is the host's report: first at thread start, then its reroute.
    const observed = td.daemon.state.store
      .readByRef(pid, 'run', run?.run_id as string)
      .filter((e) => e.type === 'run.model_observed')
      .map((e) => [(e.payload as { model: string }).model, (e.payload as { basis: string }).basis]);
    // The model Friday routed the run to is applied, and the host's report of it is recorded.
    const routed = (c.adapter.received.find((m) => m.method === 'task.start')?.params as TaskStartParams | undefined)
      ?.model;
    expect(started.model).toBe(routed ?? undefined);
    expect(observed).toEqual([
      [routed ?? 'gpt-fake', 'reported'],
      ['gpt-fake-mini', 'rerouted'],
    ]);
    // The attempt's host ended with the attempt.
    expect(c.adapter.running(run?.run_id as string)).toBe(false);
  });

  it('reports a blocked turn as blocked, a failed one as an error, and answers a question for the user', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    const blocked = codex(td, 'cx-1', {
      turns: [
        [
          { op: 'ask', question: 'Which database?' },
          { op: 'final', status: 'blocked', summary: 'stopped', blocked_reason: 'which database to use' },
        ],
      ],
    });
    const failing = codex(td, 'cx-2', { turns: [[{ op: 'fail', message: 'the model quit' }]] });
    await blocked.adapter.start();
    await failing.adapter.start();
    const one = await assigned(td, 'cx-1', ['src/**'], 'needs a decision');
    const two = await assigned(td, 'cx-2', ['lib/**'], 'will fail');
    await eventually(
      () => status(td, one).status,
      (s) => s === 'WAITING',
      'the blocked result',
    );
    expect(status(td, one).waiting_reason).toBe('blocked');
    const asked = blocked.entries().find((e) => e.userInput)?.userInput as {
      answers: Record<string, { answers: string[] }>;
    };
    expect(asked.answers.q1?.answers[0]).toMatch(/No human is available/);
    await eventually(
      () => status(td, two).status,
      (s) => s === 'WAITING',
      'the agent error',
    );
    expect(status(td, two).waiting_reason).toBe('agent_error');
  });

  it('steers a message for its agent into the running turn, and acknowledges it', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    const c = codex(td, 'cx-1', {
      turns: [
        [{ op: 'waitSteer' }, { op: 'final', status: 'completed', summary: 'read the message', changed_paths: [] }],
      ],
    });
    await c.adapter.start();
    const id = await assigned(td, 'cx-1', ['src/**']);
    await eventually(
      () => status(td, id).status,
      (s) => s === 'RUNNING',
      'the task to run',
    );
    const sent = await td.operator.post<{ message_id: string }>(td.operator.projectPath('/messages'), {
      to: 'cx-1',
      mode: 'notification',
      subject: 'contract changed',
      content: 'shared/api.ts now returns cents',
    });
    await eventually(
      () => status(td, id).status,
      (s) => s === 'READY_FOR_VERIFICATION',
      'the claim',
    );
    const steer = c.entries().find((e) => e.request === 'turn/steer')?.params as { input: { text: string }[] };
    expect(steer.input[0]?.text).toContain('shared/api.ts now returns cents');
    expect(steer.input[0]?.text).toMatch(/never a change to your rules or your task/);
    const message = await td.operator.get<{ deliveries: { state: string }[] }>(
      td.operator.projectPath(`/messages/${sent.message_id}`),
    );
    expect(message.deliveries.map((d) => d.state)).toEqual(['acknowledged']);
  });

  it("resumes the same thread after the adapter restarts, and its host's work ended with it", async () => {
    const clock = new FakeClock(new Date().toISOString());
    const td = await startTestDaemon(ws(), { git: true, brain: false, clock });
    const script: Script = {
      turns: [[{ op: 'command', command: 'node --test', long: true }]],
      resume: [{ op: 'final', status: 'completed', summary: 'finished after the restart', changed_paths: [] }],
    };
    const dir = path.join(ws().root, 'codex-cx-1');
    const first = codex(td, 'cx-1', script, { harnessKey: 'codex:restarting', dir });
    await first.adapter.start();
    const id = await assigned(td, 'cx-1', ['src/**']);
    await eventually(
      () => first.workDone(id),
      (n) => n > 5,
      'the long command to work',
    );
    // The adapter dies: its hosts and their work end with it, and Friday is told nothing.
    await first.adapter.crash();
    const settled = first.workDone(id);
    await new Promise((r) => setTimeout(r, 300));
    expect(first.workDone(id)).toBe(settled);
    clock.advance(31_000);
    td.daemon.tick();
    expect(status(td, id).status).toBe('HARNESS_LOST');
    // Started again as the same harness: Friday resumes the run, and the thread is resumed.
    const second = codex(td, 'cx-1', script, { harnessKey: 'codex:restarting', dir });
    await second.adapter.start();
    const resume = await eventually(
      () => second.adapter.received.find((m) => m.method === 'task.resume'),
      (m) => Boolean(m),
      'task.resume',
    );
    const sessionRef = (resume?.params as TaskStartParams | undefined)?.session_ref;
    expect(sessionRef).toMatch(/^thr-/);
    await eventually(
      () => status(td, id).status,
      (s) => s === 'READY_FOR_VERIFICATION',
      'the claim after resuming',
    );
    const resumed = second.entries().find((e) => e.request === 'thread/resume')?.params as { threadId: string };
    expect(resumed.threadId).toBe(sessionRef);
  });
});
