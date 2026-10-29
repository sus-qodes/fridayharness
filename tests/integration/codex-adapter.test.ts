/**
 * The Codex adapter (ADR-0032) driving a scripted app-server that speaks the protocol recorded in
 * M3.5 (`tests/fixtures/codex/fake-app-server.mjs`): Friday's settings pinned on every thread,
 * approvals answered through Friday's policy, the model the host reports, messages steered into
 * the running turn, and a turn's end reported as a claim, a blocked result or an error.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEX_RULES, CodexAdapter } from '@friday/adapter-codex';
import { createDaemon } from '@friday/daemon';
import { SPAWNED_AGENT_TOOLS } from '@friday/mcp-server';
import type { TaskStartParams, TaskView } from '@friday/protocol';
import { DaemonClient, firstTaskMessage, loadProject } from '@friday/sdk';
import { FakeClock, useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { answerLost, gate, interceptedBootstrap, method, notDelivered } from '../helpers/faults.js';

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
  mcpServers?: string[];
  keepServers?: boolean;
  approvalPolicy?: string;
}

/** A Codex agent working for Friday, its host scripted. */
function codex(
  td: TestDaemon,
  agent: string,
  script: Script,
  opts: { harnessKey?: string; dir?: string; bootstrap?: DaemonClient; stateDir?: string } = {},
) {
  const sent: string[] = [];
  const dir = opts.dir ?? path.join(ws().root, `codex-${agent}`);
  mkdirSync(dir, { recursive: true });
  const scriptFile = path.join(dir, 'script.json');
  writeFileSync(scriptFile, JSON.stringify(script));
  const log = path.join(dir, 'log.jsonl');
  const work = path.join(dir, 'work');
  const adapter = new CodexAdapter({
    bootstrap: opts.bootstrap ?? td.bootstrap,
    // What the adapter wrote to its host, as it wrote it.
    trace: (direction: 'send' | 'receive', line: string) => {
      if (direction === 'send') sent.push(line);
    },
    ...(opts.stateDir ? { stateDir: opts.stateDir } : {}),
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
  return { adapter, entries, workDone, dir, sent };
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

/** The `host.usage` records of a task's attempts, as Friday kept them (plan M11.4). */
const usageEvents = (td: TestDaemon, id: string) =>
  td.daemon.state.store
    .readByRef(td.project.project_id, 'task', id)
    .filter((e) => e.type === 'agent.event' && (e.payload as { event_type: string }).event_type === 'host.usage')
    .map((e) => {
      const p = e.payload as { run_id?: string; data?: Record<string, unknown> };
      return { run_id: p.run_id, data: p.data };
    });

/** The model the thread reports: the one Friday routed the run to, else the scripted host's own. */
const threadModel = (c: ReturnType<typeof codex>) =>
  (c.adapter.received.find((m) => m.method === 'task.start')?.params as TaskStartParams | undefined)?.model ??
  'gpt-fake';

/** The host's last count of the thread's tokens (`total`), as the scripted app-server logged it. */
const lastTotal = (c: ReturnType<typeof codex>) =>
  c
    .entries()
    .filter((e) => e.tokenUsage)
    .at(-1)?.tokenUsage as Record<string, number> | undefined;

/** The usage record every host's spend is recorded in, from the host's count (none: unknown, never 0). */
const usageFrom = (total: Record<string, number> | undefined, model: string) => ({
  cost_usd: null,
  input_tokens: total?.inputTokens ?? null,
  output_tokens: total?.outputTokens ?? null,
  cache_read_input_tokens: total?.cachedInputTokens ?? null,
  cache_creation_input_tokens: total?.cacheWriteInputTokens ?? null,
  turns: 1,
  model,
});

describe('the Codex adapter', () => {
  it("pins Friday's settings on its threads, answers approvals by Friday's policy, and claims the work", async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    const pid = td.project.project_id;
    const c = codex(td, 'cx-1', {
      model: 'gpt-fake',
      mcpServers: ['user_repl'],
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
    // The instructions hold the task's contract, so the first turn's message points at it instead
    // of repeating it (plan M10b.2).
    expect(String(started.developerInstructions)).toContain('[task.contract');
    const firstTurn = c.entries().find((e) => e.request === 'turn/start')?.params as { input: { text: string }[] };
    expect(firstTurn.input[0]?.text).toBe(
      firstTaskMessage({ task_id: id, instruction: '', acceptance_criteria: [] }, true),
    );
    // Its instructions name only the Friday tools the thread has (the M8a live check, review M8-R06).
    const named = new Set(String(started.developerInstructions).match(/friday_[a-z_]+/g) ?? []);
    expect(
      [...named].every((t) => (SPAWNED_AGENT_TOOLS as readonly string[]).includes(t)),
      [...named].join(),
    ).toBe(true);
    expect(String(started.developerInstructions)).not.toMatch(/friday:\/\//);
    // ...and those tools are the thread's, served by the adapter.
    // The project declares no operation, so the thread is not given friday_run_operation (plan M13.5).
    expect((started.dynamicTools as { name: string }[]).map((t) => t.name)).toEqual(
      SPAWNED_AGENT_TOOLS.filter((t) => t !== 'friday_run_operation'),
    );
    expect(String(started.developerInstructions)).not.toContain('friday_run_operation');
    // Each tool is told in one line (plan M13.5).
    for (const t of started.dynamicTools as { description: string }[]) expect(t.description.length).toBeLessThan(260);
    expect(c.entries().find((e) => e.request === 'initialize')?.params).toMatchObject({
      capabilities: { experimentalApi: true },
    });
    expect(String(started.developerInstructions)).toContain("Finish as the instructions from Friday's adapter");
    // Nothing of the host's own that Friday cannot judge: the checkout, and the main checkout Codex
    // keys a worktree's trust by, are untrusted for the thread (the repository's Codex files do not
    // apply, nothing is recorded in the user's Codex configuration); plugins, apps, tool
    // suggestions, web search and the configured MCP servers are off, and Codex confirmed it.
    const config = started.config as {
      projects: Record<string, { trust_level: string }>;
      features: Record<string, boolean>;
      web_search: string;
      mcp_servers: Record<string, { enabled: boolean }>;
    };
    const untrusted = Object.entries(config.projects)
      .filter(([, v]) => v.trust_level === 'untrusted')
      .map(([k]) => path.resolve(k).toLowerCase());
    expect(untrusted).toEqual(
      expect.arrayContaining([path.resolve(root).toLowerCase(), realpathSync.native(ws().projectDir).toLowerCase()]),
    );
    expect(config.features).toEqual({ plugins: false, apps: false, tool_suggest: false });
    expect(config.web_search).toBe('disabled');
    expect(config.mcp_servers).toEqual({ user_repl: { enabled: false } });
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
    // What the thread really runs with is recorded, as Codex reported it.
    const settings = events.find(
      (e) => e.type === 'agent.event' && (e.payload as { event_type: string }).event_type === 'host.settings',
    )?.payload as { data?: Record<string, unknown> } | undefined;
    expect(settings?.data).toMatchObject({
      sandbox: 'workspaceWrite',
      network_access: false,
      approval_policy: 'untrusted',
      approvals_reviewer: 'user',
      mcp_servers_disabled: ['user_repl'],
      repository_config: 'untrusted',
    });

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
    // What the thread cost (plan M11.4): the `total` of the host's last token count (one per model
    // response, the last before the turn ended), the turn this adapter ran, and the model the
    // thread reported last (the reroute), recorded once with the claim against the run that spent
    // it; the app-server names no cost.
    const total = lastTotal(c);
    expect(total?.inputTokens).toBeGreaterThan(0);
    expect(c.entries().filter((e) => e.tokenUsage).length).toBeGreaterThan(1);
    expect(usageEvents(td, id)).toEqual([{ run_id: run?.run_id, data: usageFrom(total, 'gpt-fake-mini') }]);
    // ...and the attempt's usage row shows a host that reported, in full.
    expect(td.daemon.state.q.usageReport(pid, { taskId: id }).rows[0]?.host).toMatchObject({
      reported: true,
      ...usageFrom(total, 'gpt-fake-mini'),
    });
    // The attempt's host ended with the attempt.
    expect(c.adapter.running(run?.run_id as string)).toBe(false);
  });

  it('starts no turn in a thread that keeps tools Friday cannot judge, or that applies another approval policy', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    const done = [[{ op: 'final', status: 'completed', summary: 'never runs', changed_paths: [] }]];
    const kept = codex(td, 'cx-1', { mcpServers: ['user_repl'], keepServers: true, turns: done });
    const policy = codex(td, 'cx-2', { approvalPolicy: 'never', turns: done });
    await kept.adapter.start();
    await policy.adapter.start();
    const one = await assigned(td, 'cx-1', ['src/**'], 'a host that keeps its servers');
    const two = await assigned(td, 'cx-2', ['lib/**'], 'a host with another policy');
    const refusal = async (id: string) => {
      const e = await eventually(
        () => td.daemon.state.store.readByRef(td.project.project_id, 'task', id).find((x) => x.type === 'run.declined'),
        (x) => Boolean(x),
        `the refusal of ${id}`,
      );
      return (e?.payload as { transition?: { trigger?: string } } | undefined)?.transition?.trigger;
    };
    expect(await refusal(one)).toMatch(/MCP servers in Friday's thread.*user_repl \(connected\)/);
    expect(await refusal(two)).toMatch(/did not apply Friday's settings: approval policy "never"/);
    // Before any turn: the model was never asked anything, and the hosts are gone.
    for (const c of [kept, policy]) expect(c.entries().some((e) => e.request === 'turn/start')).toBe(false);
    expect(status(td, one).status).toBe('READY');
    expect(status(td, two).status).toBe('READY');
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
    // Both attempts record what they cost with their report (plan M11.4): the blocked turn the
    // host's last count; the failed one, whose model never answered, every count unknown, never 0,
    // and the turn and the model all the same.
    const counted = lastTotal(blocked);
    expect(counted?.inputTokens).toBeGreaterThan(0);
    expect(usageEvents(td, one).map((e) => e.data)).toEqual([usageFrom(counted, threadModel(blocked))]);
    expect(usageEvents(td, two).map((e) => e.data)).toEqual([usageFrom(undefined, threadModel(failing))]);
    expect(td.daemon.state.q.usageReport(td.project.project_id, { taskId: two }).rows[0]?.host).toMatchObject({
      reported: true,
      input_tokens: null,
      output_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      cost_usd: null,
      turns: 1,
      model: threadModel(failing),
    });
  });

  it('continues the thread that did the work for a rework, and starts a new one when it is gone (plan M13.2)', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    const done = (summary: string) => ({ op: 'final', status: 'completed', summary, blocked_reason: '' });
    const c = codex(td, 'cx-1', { turns: [[done('first')], [done('again')], [done('third')]] });
    await c.adapter.start();
    expect(c.adapter.descriptor().capabilities).toMatchObject({ resume_session: true });
    const id = await assigned(td, 'cx-1', ['src/**']);
    const claimed = (what: string) =>
      eventually(
        () => status(td, id).status,
        (s) => s === 'READY_FOR_VERIFICATION',
        what,
      );
    const refuse = async (reason: string) => {
      await td.operator.post(td.operator.projectPath(`/tasks/${id}/verify`), { result: 'failed', note: 'not yet' });
      await td.operator.post(td.operator.projectPath(`/tasks/${id}/rework`), { reason });
      await td.operator.post(td.operator.projectPath(`/tasks/${id}/assign`), { agent_key: 'cx-1' });
    };
    const requests = (m: string) => c.entries().filter((e) => e.request === m) as { params: Record<string, unknown> }[];
    await claimed('the first claim');
    const thread = td.daemon.state.q.findRun(status(td, id).current_run_id as string)?.session_ref;
    await refuse('cover the edge case');
    await claimed('the second claim');
    // The rework resumed the first thread with the instructions it started with; its turn is the reason.
    expect(requests('thread/resume')[0]?.params).toMatchObject({ threadId: thread });
    expect(requests('thread/resume')[0]?.params.developerInstructions).toBe(
      requests('thread/start')[0]?.params.developerInstructions,
    );
    const turns = requests('turn/start').map((r) => (r.params.input as { text: string }[])[0]?.text);
    expect(turns[1]).toMatch(/refused your completion claim[\s\S]*Why: cover the edge case/);
    // The thread is gone: the next rework starts a new thread, given the task as a new attempt is.
    const second = td.daemon.state.q.findRun(status(td, id).current_run_id as string)?.session_ref;
    rmSync(path.join(c.dir, 'work', `thread-${second}.json`));
    await refuse('once more');
    await claimed('the claim of the new thread');
    expect(requests('thread/start')).toHaveLength(2);
    expect(
      requests('turn/start')
        .map((r) => (r.params.input as { text: string }[])[0]?.text)
        .at(-1),
    ).toBe(firstTaskMessage({ task_id: id, instruction: '', acceptance_criteria: [] }, true));
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

  it('starts no turn for a start Friday no longer wants (review M8-R03)', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    const x = interceptedBootstrap(td);
    const c = codex(
      td,
      'h-1',
      { turns: [[{ op: 'final', status: 'completed', summary: 'x', changed_paths: [] }]] },
      {
        bootstrap: x.client,
      },
    );
    let taskId = '';
    const polls = gate();
    const acked = gate();
    const isStart = (p: Record<string, unknown>) =>
      (p.acks as { message_id: string }[]).some((a) =>
        c.adapter.received.some((m) => m.message_id === a.message_id && m.method === 'task.start'),
      );
    // Friday cancels the task just before the adapter's acknowledgement of task.start reaches it,
    // and the adapter's later polls wait: the cancellation reaches it late.
    x.on(method('harness.ack', isStart), async (_call, forward) => {
      await td.operator.post(td.operator.projectPath(`/tasks/${taskId}/cancel`), { reason: 'not wanted any more' });
      x.on(
        method('harness.poll'),
        async (_c, fwd) => {
          await polls.promise;
          return fwd();
        },
        Number.POSITIVE_INFINITY,
      );
      const res = await forward();
      acked.open();
      return res;
    });
    await c.adapter.start();
    taskId = await assigned(td, 'h-1', ['src/**']);
    await acked.promise;
    const runId =
      (c.adapter.received.find((m) => m.method === 'task.start')?.params as TaskStartParams | undefined)?.run_id ?? '';
    const turnSent = () => c.sent.some((l) => l.includes('"method":"turn/start"'));
    // Either the adapter starts the turn, or it gives the attempt up: whichever happens first.
    await eventually(() => turnSent() || !c.adapter.running(runId), Boolean, 'the turn, or the attempt given up');
    polls.open();
    await eventually(
      () => c.adapter.running(runId),
      (r) => !r,
      'the attempt ended',
    );
    expect(status(td, taskId).status).toBe('CANCELLED');
    expect(turnSent(), 'what the adapter sent its host').toBe(false);
    expect(
      c.entries().some((e) => e.request === 'turn/start'),
      'what the host received',
    ).toBe(false);
  });

  it('keeps serving Friday after a poll fails, so a cancellation still stops the work (review M8-R02)', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    const x = interceptedBootstrap(td);
    const c = codex(
      td,
      'h-1',
      { turns: [[{ op: 'command', command: 'node --test', long: true }]] },
      { bootstrap: x.client },
    );
    await c.adapter.start();
    const id = await assigned(td, 'h-1', ['src/**']);
    await eventually(
      () => c.workDone(id),
      (n) => n > 0,
      'the work',
    );
    const runId = status(td, id).current_run_id as string;
    // One poll never reaches Friday; the heartbeat keeps working.
    const failed = gate();
    x.on(method('harness.poll'), async (call, forward) => {
      failed.open();
      return notDelivered(call, forward);
    });
    await failed.promise;
    await td.operator.post(td.operator.projectPath(`/tasks/${id}/cancel`), { reason: 'stop it' });
    expect(status(td, id).status).toBe('CANCELLED');
    // The cancellation reaches the adapter, which ends the host and everything it started.
    await eventually(
      () => c.adapter.running(runId),
      (r) => !r,
      'the attempt ended',
      15_000,
    );
    // Its group ends with the attempt: the writer stops growing.
    await eventually(
      async () => {
        const size = c.workDone(id);
        await new Promise((r) => setTimeout(r, 300));
        return c.workDone(id) === size;
      },
      Boolean,
      'the writer to stop',
      10_000,
    );
  });

  it('records a completion claim whose report failed, exactly once (review M8-R05)', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    const final = { op: 'final', status: 'completed', summary: 'done', changed_paths: [] };
    // The first report never reaches Friday.
    const a = interceptedBootstrap(td);
    a.on(method('agent.result'), notDelivered);
    const one = codex(td, 'h-1', { turns: [[final]] }, { bootstrap: a.client });
    await one.adapter.start();
    const first = await assigned(td, 'h-1', ['src/**']);
    await eventually(
      () => status(td, first).status,
      (s) => s === 'READY_FOR_VERIFICATION',
      'the first claim',
      15_000,
    );
    // The second is recorded, and its answer is lost on the way back.
    const b = interceptedBootstrap(td);
    b.on(method('agent.result'), answerLost);
    const two = codex(td, 'h-2', { turns: [[final]] }, { bootstrap: b.client });
    await two.adapter.start();
    const second = await assigned(td, 'h-2', ['lib/**']);
    await eventually(
      () => status(td, second).status,
      (s) => s === 'READY_FOR_VERIFICATION',
      'the second claim',
      15_000,
    );
    await eventually(
      () => b.calls.filter((c) => c.method === 'agent.result').length,
      (n) => n >= 2,
      'the retry',
    );
    for (const id of [first, second]) {
      const claimed = td.daemon.state.store
        .readByRef(td.project.project_id, 'task', id)
        .filter((e) => e.type === 'task.completion_claimed');
      expect(claimed, id).toHaveLength(1);
    }
  });

  it("keeps the host's count of what the turn cost with the result until Friday records both (plan M11.4, review M8-R05)", async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    const pid = td.project.project_id;
    const x = interceptedBootstrap(td);
    // Friday is out of reach the moment the turn ends: the usage record does not get through.
    x.on(
      method('agent.event', (p) => p.event_type === 'host.usage'),
      notDelivered,
    );
    const c = codex(
      td,
      'h-1',
      { turns: [[{ op: 'final', status: 'completed', summary: 'done', changed_paths: [] }]] },
      { bootstrap: x.client },
    );
    await c.adapter.start();
    const id = await assigned(td, 'h-1', ['src/**']);
    await eventually(
      () => status(td, id).status,
      (s) => s === 'READY_FOR_VERIFICATION',
      'the claim',
      15_000,
    );
    // The record was tried again and recorded, once, before the claim it belongs with.
    const events = td.daemon.state.store.readByRef(pid, 'task', id);
    const usage = events.filter(
      (e) => e.type === 'agent.event' && (e.payload as { event_type: string }).event_type === 'host.usage',
    );
    expect(usage).toHaveLength(1);
    const claimed = events.find((e) => e.type === 'task.completion_claimed');
    expect(usage[0]?.sequence).toBeLessThan(claimed?.sequence as number);
    expect(
      x.calls.filter((call) => call.method === 'agent.event' && call.params.event_type === 'host.usage'),
    ).toHaveLength(2);
    // The attempt's row shows what the host counted (one response: the scripted host's first
    // figures), not a host that said nothing.
    expect(td.daemon.state.q.usageReport(pid, { taskId: id }).rows[0]?.host).toMatchObject({
      reported: true,
      input_tokens: 10200,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 1024,
      cost_usd: null,
      turns: 1,
      model: threadModel(c),
    });
  });

  it('reports the result of a finished attempt after the adapter restarts, without a new turn (review M8-R05)', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    const stateDir = path.join(ws().root, 'adapter-state');
    const x = interceptedBootstrap(td);
    // Friday is unreachable for the report, and the adapter stops before it gets through.
    const reports = gate();
    const stopFailing = x.on(
      method('agent.result'),
      async (call, forward) => {
        reports.open();
        return notDelivered(call, forward);
      },
      Number.POSITIVE_INFINITY,
    );
    const script = { turns: [[{ op: 'final', status: 'completed', summary: 'done', changed_paths: [] }]] };
    const one = codex(td, 'h-1', script, { bootstrap: x.client, harnessKey: 'codex:restart-r05', stateDir });
    await one.adapter.start();
    const id = await assigned(td, 'h-1', ['src/**']);
    await reports.promise;
    await one.adapter.crash();
    stopFailing();
    expect(status(td, id).status).toBe('RUNNING');
    // The same harness comes back, with the same state folder.
    const two = codex(td, 'h-1', script, {
      harnessKey: 'codex:restart-r05',
      stateDir,
      dir: path.join(ws().root, 'again'),
    });
    await two.adapter.start();
    await eventually(
      () => status(td, id).status,
      (s) => s === 'READY_FOR_VERIFICATION',
      'the claim',
      15_000,
    );
    const claimed = td.daemon.state.store
      .readByRef(td.project.project_id, 'task', id)
      .filter((e) => e.type === 'task.completion_claimed');
    expect(claimed).toHaveLength(1);
    // The host was not asked to work again.
    expect(two.sent, 'what the second adapter sent a host').toEqual([]);
  });

  it('stops its hosts when Friday is not heard for a lease, and resumes the same run once it is (review M8-R02)', async () => {
    const td = await startTestDaemon(ws(), {
      git: true,
      brain: false,
      extraConfig: 'leases:\n  heartbeat_interval_ms: 1000\n  lease_ttl_ms: 2000\n',
    });
    const x = interceptedBootstrap(td);
    const c = codex(
      td,
      'h-1',
      {
        turns: [[{ op: 'command', command: 'node --test', long: true }]],
        resume: [{ op: 'final', status: 'completed', summary: 'resumed', changed_paths: [] }],
      },
      { bootstrap: x.client },
    );
    await c.adapter.start();
    const id = await assigned(td, 'h-1', ['src/**']);
    await eventually(
      () => c.workDone(id),
      (n) => n > 0,
      'the work',
    );
    const runId = status(td, id).current_run_id as string;
    // Friday cannot be reached for instructions for longer than a lease: no cancellation would
    // reach this adapter, so it stops its hosts.
    const stopFailing = x.on(method('harness.poll'), notDelivered, Number.POSITIVE_INFINITY);
    await eventually(
      () => c.adapter.running(runId),
      (r) => !r,
      'the hosts stopped',
      15_000,
    );
    // Its group ends with the attempt: the writer stops growing.
    await eventually(
      async () => {
        const size = c.workDone(id);
        await new Promise((r) => setTimeout(r, 300));
        return c.workDone(id) === size;
      },
      Boolean,
      'the writer to stop',
      10_000,
    );
    // Friday answers again: the adapter registers again, and Friday resumes the same run.
    stopFailing();
    await eventually(
      () => status(td, id).status,
      (s) => s === 'READY_FOR_VERIFICATION',
      'the claim after resuming',
      20_000,
    );
    expect(td.daemon.state.q.findRun(runId)?.outcome).toBe('completed_claim');
    expect(
      c.adapter.received.some((m) => m.method === 'task.resume' && (m.params as TaskStartParams).run_id === runId),
    ).toBe(true);
  });

  it('finds Friday started again on another port, and still stops the work it is told to (review M8-R02)', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    // As `friday harness run` makes it: from the project's discovery files.
    const bootstrap = DaemonClient.forProject(loadProject(ws().projectDir), 'bootstrap');
    const c = codex(td, 'h-1', { turns: [[{ op: 'command', command: 'node --test', long: true }]] }, { bootstrap });
    await c.adapter.start();
    const id = await assigned(td, 'h-1', ['src/**']);
    await eventually(
      () => c.workDone(id),
      (n) => n > 0,
      'the work',
    );
    const runId = status(td, id).current_run_id as string;
    await td.daemon.close('started again');
    const again = await createDaemon({
      projectRoot: ws().projectDir,
      stateDir: ws().stateDir,
      tickMs: 0,
      pollIntervalMs: 25,
      logToFile: true,
    });
    ws().track({ close: () => again.close('test cleanup') });
    const operator = new DaemonClient({
      baseUrl: again.url,
      token: again.tokens.operator,
      tokenClass: 'operator',
      projectId: again.project.project_id,
    });
    await operator.post(operator.projectPath(`/tasks/${id}/cancel`), { reason: 'stop it' });
    await eventually(
      () => c.adapter.running(runId),
      (r) => !r,
      'the attempt ended',
      20_000,
    );
    // Its group ends with the attempt: the writer stops growing.
    await eventually(
      async () => {
        const size = c.workDone(id);
        await new Promise((r) => setTimeout(r, 300));
        return c.workDone(id) === size;
      },
      Boolean,
      'the writer to stop',
      10_000,
    );
  });
});
