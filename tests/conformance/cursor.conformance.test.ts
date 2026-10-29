/**
 * The vendor-neutral conformance suite (M3.5) against Cursor in spawn mode (plan M8b.2), its host a
 * scripted Cursor CLI (`tests/fixtures/cursor/fake-agent.mjs`) that speaks the documented stream-json
 * and runs Friday's real hook launcher for its hooks, through the platform's shell as Cursor runs a
 * hook command. Its work is a real process a command Friday allowed started, so case 9 proves that
 * cancellation stops it, not only the task's status. After the 11 cases: what an attempt does.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundledHookPath, bundledHookSource, claudeCodeHooks } from '@friday/adapter-claude';
import {
  applyCursorPlan,
  CURSOR_HOOK_EVENTS,
  CURSOR_SPAWN_RULES,
  CursorSpawnAdapter,
  cursorEnvironment,
  planCursor,
} from '@friday/adapter-cursor';
import { SPAWNED_AGENT_TOOLS } from '@friday/mcp-server';
import type { OutboundMessage, TaskStartParams, TaskView, UsageReport } from '@friday/protocol';
import { deterministicGit, FakeClock, useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { type ConformanceHarness, runHarnessConformance } from './harness-conformance.js';

const ws = useTestWorkspace();
const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'cursor', 'fake-agent.mjs');
let counter = 0;

type Step = Record<string, unknown>;
interface Script {
  model?: string;
  usage?: Record<string, unknown> | null;
  cwd?: string;
  createChatFails?: boolean;
  turns: Step[][];
  resume?: Step[];
}

/** Each turn starts a long command Friday allows, which works until something stops it. */
const SCRIPT: Script = {
  turns: [[{ op: 'shell', command: 'node --test', long: true }]],
  resume: [{ op: 'shell', command: 'node --test', long: true }],
};

/** A Cursor agent working for Friday in spawn mode, its host scripted. */
function cursorAgent(td: TestDaemon, agent: string, script: Script, opts: { harnessKey?: string; dir?: string } = {}) {
  counter += 1;
  const dir = opts.dir ?? path.join(ws().root, `cursor-${agent}-${counter}`);
  mkdirSync(dir, { recursive: true });
  const scriptFile = path.join(dir, 'script.json');
  writeFileSync(scriptFile, JSON.stringify(script));
  const log = path.join(dir, 'log.jsonl');
  const work = path.join(dir, 'work');
  const adapter = new CursorSpawnAdapter({
    bootstrap: td.bootstrap,
    projectId: td.project.project_id,
    agentKey: agent,
    harnessKey: opts.harnessKey ?? `cursor:conformance:${process.pid}:${counter}`,
    host: { command: process.execPath, args: [FAKE], version: '2026.10.16-e3cb207' },
    hostEnv: {
      ...cursorEnvironment(process.env),
      // Friday's hook launcher finds the test daemon through the test's own state folder.
      FRIDAY_STATE_DIR: ws().stateDir,
      FAKE_CURSOR_SCRIPT: scriptFile,
      FAKE_CURSOR_LOG: log,
      FAKE_CURSOR_WORK: work,
    },
    hook: { command: process.execPath, args: [bundledHookPath()] },
    workDir: path.join(dir, 'attempts'),
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

class CursorSubject implements ConformanceHarness {
  constructor(
    readonly adapter: CursorSpawnAdapter,
    private readonly td: TestDaemon,
    private readonly work: (taskId: string) => number,
  ) {}
  get harnessId() {
    return this.adapter.harnessId;
  }
  get token() {
    return this.adapter.registration.harness_token;
  }
  get client() {
    return this.adapter.client;
  }
  async waitFor(method: OutboundMessage['method'], timeoutMs = 5000): Promise<OutboundMessage> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.adapter.received.find((m) => m.method === method);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`the Cursor adapter got no ${method} within ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  crash() {
    return this.adapter.crash();
  }
  reconnect() {
    return this.adapter.reconnect();
  }
  async rawRpc(method: string, params: unknown, token: string = this.token) {
    const res = await fetch(`${this.td.url}/protocol/v1/rpc`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'raw-1', method, params }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  workDone(taskId: string): number {
    return this.work(taskId);
  }
}

runHarnessConformance('Cursor in spawn mode (scripted Cursor CLI)', async () => {
  const clock = new FakeClock(new Date().toISOString());
  const td = await startTestDaemon(ws(), { clock, extensions: [claudeCodeHooks()] });
  // One folder for every harness of the case, so a second harness can resume the first one's chat.
  const dir = path.join(ws().root, 'cursor');
  return {
    td,
    clock,
    attach: async (opts = {}) => {
      const c = cursorAgent(td, opts.agentKey ?? 'dev-1', SCRIPT, {
        dir,
        ...(opts.key ? { harnessKey: opts.key } : {}),
      });
      await c.adapter.start();
      return new CursorSubject(c.adapter, td, c.workDone);
    },
  };
});

// ---- what an attempt does ------------------------------------------------------------------------------

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
const daemon = () => startTestDaemon(ws(), { git: true, brain: false, extensions: [claudeCodeHooks()] });
/** The fake's permission-hook decisions, as `[event, tool, what, decision]`. */
const decisions = (entries: Record<string, unknown>[]) =>
  entries
    .filter((e) => typeof e.hook === 'string' && 'decision' in e && e.hook !== 'sessionStart')
    .map((e) => {
      const input = (e.input ?? {}) as {
        tool_input?: unknown;
        command?: string;
        file_path?: string;
        tool_name?: string;
      };
      const tin = (typeof input.tool_input === 'object' && input.tool_input ? input.tool_input : {}) as {
        path?: string;
        command?: string;
      };
      const what =
        input.command ??
        tin.command ??
        (tin.path ? path.basename(tin.path) : e.hook === 'beforeMCPExecution' ? input.tool_name : '');
      return [e.hook, e.tool, what, e.decision];
    });
const agentEvent = (td: TestDaemon, id: string, type: string) =>
  td.daemon.state.store
    .readByRef(td.project.project_id, 'task', id)
    .find((e) => e.type === 'agent.event' && (e.payload as { event_type: string }).event_type === type)?.payload as
    | { data?: Record<string, unknown> }
    | undefined;

describe('Cursor in spawn mode: what an attempt does (plan M8b.2)', () => {
  it("judges each call through Friday's hooks, serves Friday's tools, claims the work and records what it cost", async () => {
    const td = await daemon();
    const pid = td.project.project_id;
    const c = cursorAgent(td, 'cu-1', {
      turns: [
        [
          { op: 'write', path: 'src/ok.ts', text: 'export const ok = 1;\n' },
          { op: 'write', path: 'docs/no.md', text: 'not mine\n' },
          { op: 'read', path: '.friday/run/daemon.json' },
          { op: 'shell', command: 'node --test' },
          { op: 'shell', command: 'git commit -m wip' },
          { op: 'friday', tool: 'friday_request_context', args: { kind: 'task' } },
          { op: 'message', text: 'Wrote the file.' },
          { op: 'final', status: 'completed', summary: 'wrote ok', changed_paths: ['src/ok.ts'], prose: 'All set.' },
        ],
      ],
    });
    await c.adapter.start();
    const id = await assigned(td, 'cu-1', ['src/**']);
    await eventually(
      () => status(td, id).status,
      (s) => s === 'READY_FOR_VERIFICATION',
      'the claim',
    );
    const run = td.daemon.state.q.findRun(status(td, id).current_run_id as string);
    const root = run?.execution_root as string;

    // The run Friday started: print mode, stream-json, trusted, the task's worktree, the attempt's chat.
    const started = c.adapter.received.find((m) => m.method === 'task.start')?.params as TaskStartParams;
    const first = c.entries().find((e) => e.flags) as {
      flags: Record<string, string | boolean>;
      plugin_dirs: string[];
      prompt: string;
    };
    expect(first.flags).toMatchObject({
      '-p': true,
      '--output-format': 'stream-json',
      '--trust': true,
      '--approve-mcps': true,
      '--workspace': root,
      '--resume': run?.session_ref,
    });
    expect(first.flags['--force']).toBeUndefined();
    if (started.model) expect(first.flags['--model']).toBe(started.model);
    expect(first.plugin_dirs).toHaveLength(1);
    // Its prompt: Friday's rules, the packet naming only the tools the session has, the task.
    expect(first.prompt.startsWith(CURSOR_SPAWN_RULES.split('\n')[0] as string)).toBe(true);
    expect(first.prompt).toContain(id);
    const named = new Set(first.prompt.match(/friday_[a-z_]+/g) ?? []);
    expect(
      [...named].every((t) => (SPAWNED_AGENT_TOOLS as readonly string[]).includes(t)),
      [...named].join(),
    ).toBe(true);
    // The chat was made before the run, so its first hook already found this harness.
    expect(
      c
        .entries()
        .filter((e) => e.create_chat)
        .map((e) => e.create_chat),
    ).toEqual([run?.session_ref]);

    // Every hook came from the attempt's plugin; each call was Friday's decision once.
    expect(c.entries().find((e) => e.hooks)?.hooks).toEqual([
      { source: 'project', events: [] },
      { source: 'plugin', events: [...CURSOR_HOOK_EVENTS] },
    ]);
    expect(decisions(c.entries())).toEqual([
      ['preToolUse', 'Write', 'ok.ts', 'allow'],
      ['preToolUse', 'Write', 'no.md', 'deny'],
      ['preToolUse', 'Read', 'daemon.json', 'deny'],
      // Shell and MCP calls are left by preToolUse to their own hooks, which judge them.
      ['preToolUse', 'Shell', 'node --test', 'allow'],
      ['beforeShellExecution', 'Shell', 'node --test', 'allow'],
      ['preToolUse', 'Shell', 'git commit -m wip', 'allow'],
      ['beforeShellExecution', 'Shell', 'git commit -m wip', 'deny'],
      // Friday's own tools get no decision: the protocol behind each judges it.
      ['preToolUse', 'MCP:friday_request_context', '', 'allow'],
      ['beforeMCPExecution', 'MCP:friday_request_context', 'friday_request_context', 'allow'],
    ]);
    expect(existsSync(path.join(root, 'src', 'ok.ts'))).toBe(true);
    expect(existsSync(path.join(root, 'docs', 'no.md'))).toBe(false);
    // A commit is a human's decision, and no human is at a spawned session: one pending approval.
    const commit = c.entries().find((e) => e.hook === 'beforeShellExecution' && e.decision === 'deny');
    expect(String(commit?.reason)).toMatch(/^Friday: .*A human decides this \(approval apr_/);
    expect(td.daemon.state.q.approvals(pid, 'pending').filter((a) => a.capability === 'shell.git.commit')).toHaveLength(
      1,
    );
    // Friday's tools came from the adapter's own server, by the attempt's secret.
    expect(c.entries().find((e) => e.mcp)?.mcp).toEqual({ friday: [...SPAWNED_AGENT_TOOLS] });
    expect(c.entries().find((e) => e.toolCall === 'friday_request_context')).toMatchObject({ success: true });

    // The claim: the JSON at the end of the last message, with the paths the session wrote.
    const claim = run?.claim as { changed_paths: string[]; summary: string };
    expect(claim.summary).toBe('wrote ok');
    expect(claim.changed_paths).toEqual(expect.arrayContaining(['src/ok.ts']));
    expect(agentEvent(td, id, 'host.settings')?.data).toMatchObject({
      chat_id: run?.session_ref,
      session_id: run?.session_ref,
      hooks_from_project: [],
      hooks_from_plugin: [...CURSOR_HOOK_EVENTS],
      repository_config: 'applies',
    });
    const observed = td.daemon.state.store
      .readByRef(pid, 'run', run?.run_id as string)
      .filter((e) => e.type === 'run.model_observed')
      .map((e) => (e.payload as { model: string }).model);
    expect(observed).toContain(started.model ?? 'Fake Model 1');
    // What the attempt cost: the result's counts, the run, and the model; no cost, which Cursor does not name.
    const report = await td.operator.get<UsageReport>(td.operator.projectPath(`/usage?task=${id}`));
    expect(report.rows[0]).toMatchObject({
      harness_vendor: 'cursor',
      harness_mode: 'spawn',
      host: {
        reported: true,
        input_tokens: 5200,
        output_tokens: 140,
        cache_read_input_tokens: 3100,
        cache_creation_input_tokens: 600,
        cost_usd: null,
        turns: 1,
        model: started.model ?? 'Fake Model 1',
      },
    });
    // The attempt's session and folder ended with it.
    expect(c.adapter.running(run?.run_id as string)).toBe(false);
    await eventually(
      () => existsSync(path.join(c.dir, 'attempts', run?.run_id as string)),
      (x) => !x,
      'the attempt folder to go',
    );
  });

  it("leaves to the worktree's own Friday hooks the events they cover, so each call is judged once", async () => {
    const td = await daemon();
    // The project is set up for Cursor and committed, so the task's worktree carries Friday's hooks.
    applyCursorPlan(
      planCursor({
        projectDir: ws().projectDir,
        hookSource: bundledHookSource(),
        env: { FRIDAY_STATE_DIR: ws().stateDir },
      }),
      ws().projectDir,
    );
    await deterministicGit(ws().projectDir).commitAll('cursor setup');
    const c = cursorAgent(td, 'cu-2', {
      turns: [
        [
          { op: 'shell', command: 'node --test' },
          { op: 'write', path: 'src/two.ts', text: 'export const two = 2;\n' },
          { op: 'final', status: 'completed', summary: 'two', changed_paths: ['src/two.ts'] },
        ],
      ],
    });
    await c.adapter.start();
    const id = await assigned(td, 'cu-2', ['src/**']);
    await eventually(
      () => status(td, id).status,
      (s) => s === 'READY_FOR_VERIFICATION',
      'the claim',
    );
    expect(c.entries().find((e) => e.hooks)?.hooks).toEqual([
      { source: 'project', events: [...CURSOR_HOOK_EVENTS] },
      { source: 'plugin', events: [] },
    ]);
    // Each call ran the project's hook once and no other.
    const judged = c.entries().filter((e) => e.hook === 'preToolUse' || e.hook === 'beforeShellExecution');
    expect(judged.map((e) => [e.hook, e.decision, e.sources])).toEqual([
      ['preToolUse', 'allow', ['project']],
      ['beforeShellExecution', 'allow', ['project']],
      ['preToolUse', 'allow', ['project']],
    ]);
    expect(agentEvent(td, id, 'host.settings')?.data).toMatchObject({
      hooks_from_project: [...CURSOR_HOOK_EVENTS],
      hooks_from_plugin: [],
    });
  });

  it('gives messages that arrive while a run works a turn of their own, and acknowledges them once taken', async () => {
    const td = await daemon();
    const c = cursorAgent(td, 'cu-3', {
      turns: [
        [
          { op: 'wait', ms: 2500 },
          { op: 'final', status: 'completed', summary: 'first answer', changed_paths: [] },
        ],
        [{ op: 'final', status: 'completed', summary: 'read the message', changed_paths: [] }],
      ],
    });
    await c.adapter.start();
    const id = await assigned(td, 'cu-3', ['src/**']);
    await eventually(
      () => status(td, id).status,
      (s) => s === 'RUNNING',
      'the task to run',
    );
    // While the attempt runs, its plugin holds Friday's server, which answers only with the attempt's secret.
    const attempt = path.join(c.dir, 'attempts', status(td, id).current_run_id as string);
    const mcpFile = path.join(attempt, 'plugin', 'mcp.json');
    await eventually(
      () => existsSync(mcpFile),
      (x) => x,
      'the attempt plugin',
    );
    const mcp = JSON.parse(readFileSync(mcpFile, 'utf8')) as {
      mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
    };
    expect(Object.keys(mcp.mcpServers)).toEqual(['friday']);
    expect(mcp.mcpServers.friday?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/run_/);
    expect((await fetch(mcp.mcpServers.friday?.url as string, { method: 'POST', body: '{}' })).status).toBe(401);
    const sent = await td.operator.post<{ message_id: string }>(td.operator.projectPath('/messages'), {
      to: 'cu-3',
      mode: 'notification',
      subject: 'contract changed',
      content: 'shared/api.ts now returns cents',
    });
    await eventually(
      () => status(td, id).status,
      (s) => s === 'READY_FOR_VERIFICATION',
      'the claim',
    );
    const run = td.daemon.state.q.findRun(status(td, id).current_run_id as string);
    // The second run resumed the same chat with the message; its answer is the claim.
    const runs = c.entries().filter((e) => e.flags) as { flags: Record<string, string>; prompt: string }[];
    expect(runs.map((r) => r.flags['--resume'])).toEqual([run?.session_ref, run?.session_ref]);
    expect(runs[1]?.prompt).toContain('shared/api.ts now returns cents');
    expect((run?.claim as { summary?: string } | undefined)?.summary).toBe('read the message');
    const message = await eventually(
      () =>
        td.operator.get<{ deliveries: { state: string }[] }>(td.operator.projectPath(`/messages/${sent.message_id}`)),
      (m) => m.deliveries.every((d) => d.state === 'acknowledged'),
      'the acknowledgement',
    );
    expect(message.deliveries.map((d) => d.state)).toEqual(['acknowledged']);
    // Both runs counted.
    const report = await td.operator.get<UsageReport>(td.operator.projectPath(`/usage?task=${id}`));
    expect(report.rows[0]?.host).toMatchObject({ turns: 2, input_tokens: 10_400, output_tokens: 280 });
  });

  it('reports a blocked answer as blocked, a failed run or one outside the worktree as an error, and declines a run without a chat', async () => {
    const td = await daemon();
    const blocked = cursorAgent(td, 'cu-4', {
      turns: [[{ op: 'final', status: 'blocked', summary: 'stopped', blocked_reason: 'which database to use' }]],
    });
    const failing = cursorAgent(td, 'cu-5', { turns: [[{ op: 'fail', message: 'the model quit' }]] });
    const elsewhere = cursorAgent(td, 'cu-6', {
      cwd: ws().root,
      turns: [
        [
          { op: 'wait', ms: 5000 },
          { op: 'final', status: 'completed', summary: 'x', changed_paths: [] },
        ],
      ],
    });
    const noChat = cursorAgent(td, 'cu-7', { createChatFails: true, usage: null, turns: [] });
    for (const x of [blocked, failing, elsewhere, noChat]) await x.adapter.start();
    const one = await assigned(td, 'cu-4', ['src/**'], 'needs a decision');
    const two = await assigned(td, 'cu-5', ['lib/**'], 'will fail');
    const three = await assigned(td, 'cu-6', ['app/**'], 'works elsewhere');
    const four = await assigned(td, 'cu-7', ['web/**'], 'no chat');
    await eventually(
      () => [status(td, one), status(td, two), status(td, three)].map((t) => `${t.status}:${t.waiting_reason}`),
      (s) => s.every((x) => x.startsWith('WAITING')),
      'the three outcomes',
    );
    expect(status(td, one).waiting_reason).toBe('blocked');
    expect(status(td, two).waiting_reason).toBe('agent_error');
    expect(status(td, three).waiting_reason).toBe('agent_error');
    const error = (id: string) =>
      String(
        (
          td.daemon.state.store
            .readByRef(td.project.project_id, 'task', id)
            .find((e) => e.type === 'agent.event' && (e.payload as { event_type: string }).event_type === 'error')
            ?.payload as { message?: string } | undefined
        )?.message,
      );
    expect(error(two)).toMatch(/Cursor stopped: the model quit/);
    expect(error(three)).toMatch(/not in the task's worktree/);
    const declined = await eventually(
      () => td.daemon.state.store.readByRef(td.project.project_id, 'task', four).find((x) => x.type === 'run.declined'),
      (x) => Boolean(x),
      'the refusal',
    );
    expect((declined?.payload as { transition?: { trigger?: string } } | undefined)?.transition?.trigger).toMatch(
      /create-chat" gave no chat id.*Authentication required/,
    );
    expect(status(td, four).status).toBe('READY');
  });
});
