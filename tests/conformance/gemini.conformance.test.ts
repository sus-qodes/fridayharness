/**
 * The vendor-neutral conformance suite (M3.5) against Gemini CLI in spawn mode (plan M8b.4), its
 * host a scripted Gemini CLI that speaks the documented stream-json events and runs each hook's
 * command as the host does: a PowerShell string on Windows (bash elsewhere) read from the
 * project's `.gemini/settings.json`, which `friday harness config gemini` wrote. Its work is a real
 * process a command Friday allowed started, so case 9 proves cancellation stops it, not only the
 * task's status. After the 11 cases: what is particular to Gemini CLI (every call judged through
 * the host's shell, the deny rules and only Friday's own MCP server, Friday's tools for spawned
 * agents and the messages relayed in a turn of their own, the usage row, a worktree without
 * Friday's hooks refused).
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundledHookSource, claudeCodeHooks } from '@friday/adapter-claude';
import {
  applyGeminiPlan,
  FRIDAY_SERVER,
  GeminiSpawnAdapter,
  geminiEnvironment,
  planGemini,
  SPAWN_DENIED_TOOLS,
} from '@friday/adapter-gemini';
import { SPAWNED_AGENT_TOOLS } from '@friday/mcp-server';
import type { OutboundMessage, TaskStartParams, TaskView, UsageReport } from '@friday/protocol';
import { FakeClock, type TestWorkspace, useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { initTestProject, startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { type ConformanceHarness, type ConformanceSubject, runHarnessConformance } from './harness-conformance.js';

const ws = useTestWorkspace();
const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'gemini', 'fake-gemini.mjs');
let counter = 0;

/** Each run starts a long command Friday allows, which works until something stops it. */
const SCRIPT = {
  runs: [[{ op: 'shell', command: 'node --test', long: true }]],
  resume: [{ op: 'shell', command: 'node --test', long: true }],
};

/** Friday's Gemini CLI files in the workspace's project, as `friday harness config gemini` writes them. */
function configureGemini(w: TestWorkspace): void {
  // This machine's agent key goes to the private folder, which these sessions do not need.
  const changes = planGemini({ projectDir: w.projectDir, hookSource: bundledHookSource() }).filter(
    (c) => !c.display.startsWith('(private)'),
  );
  applyGeminiPlan(changes, w.projectDir);
}

class GeminiSubject implements ConformanceHarness {
  constructor(
    readonly adapter: GeminiSpawnAdapter,
    private readonly td: TestDaemon,
    private readonly work: string,
    private readonly log: string,
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
      if (Date.now() > end) throw new Error(`the Gemini CLI adapter got no ${method} within ${timeoutMs} ms`);
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
    const f = path.join(this.work, `${taskId}.work`);
    return existsSync(f) ? statSync(f).size : 0;
  }
  /** What the scripted host logged: its flags, settings, every hook it ran and what it decided. */
  entries(): Record<string, unknown>[] {
    return existsSync(this.log)
      ? readFileSync(this.log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  }
}

interface GeminiConformanceSubject extends Omit<ConformanceSubject, 'attach'> {
  attach(opts?: { key?: string; agentKey?: string }): Promise<GeminiSubject>;
}

/** The owner's static ranking (ADR-0031) lists Gemini CLI first for DevOps and not for backend work. */
const GEMINI_ROLE = 'devops';

/**
 * A daemon for a project Friday configured for Gemini CLI, and a way to attach Gemini adapters
 * whose scripted hosts play `script`. With `git`, the project is a repository whose first commit
 * holds Friday's files (or not, with `configured: false`), and each run works in its own worktree.
 */
async function subject(
  script: unknown,
  opts: { git?: boolean; configured?: boolean; machineSettings?: boolean } = {},
): Promise<GeminiConformanceSubject> {
  const clock = new FakeClock(new Date().toISOString());
  initTestProject(ws());
  if (opts.configured !== false) configureGemini(ws());
  const td = await startTestDaemon(ws(), {
    clock,
    initialized: true,
    extensions: [claudeCodeHooks()],
    ...(opts.git ? { git: true, brain: false } : {}),
  });
  const dir = path.join(ws().root, 'gemini');
  mkdirSync(dir, { recursive: true });
  const scriptFile = path.join(dir, 'script.json');
  writeFileSync(scriptFile, JSON.stringify(script));
  const work = path.join(dir, 'work');
  const home = path.join(dir, 'home');
  mkdirSync(home, { recursive: true });
  // A machine without system settings of its own, as most are; one case below has them, as an
  // administrator might keep them.
  const systemSettings = path.join(dir, 'system-settings.json');
  if (opts.machineSettings)
    writeFileSync(systemSettings, JSON.stringify({ mcpServers: { admin: { command: 'admin-server' } } }));
  return {
    td,
    clock,
    taskRole: GEMINI_ROLE,
    attach: async (o = {}) => {
      counter += 1;
      const log = path.join(dir, `log-${counter}.jsonl`);
      const adapter = new GeminiSpawnAdapter({
        bootstrap: td.bootstrap,
        projectId: td.project.project_id,
        agentKey: o.agentKey ?? 'dev-1',
        harnessKey: o.key ?? `gemini:conformance:${process.pid}:${counter}`,
        host: { command: process.execPath, args: [FAKE], version: '0.64.0' },
        hostEnv: {
          ...geminiEnvironment(process.env),
          // Friday's hook launcher finds the test daemon through the test's own state folder.
          FRIDAY_STATE_DIR: ws().stateDir,
          // The scripted host reads no settings of the real user's or the machine's.
          GEMINI_CLI_HOME: home,
          GEMINI_CLI_SYSTEM_SETTINGS_PATH: systemSettings,
          FAKE_GEMINI_SCRIPT: scriptFile,
          FAKE_GEMINI_LOG: log,
          FAKE_GEMINI_WORK: work,
        },
        workDir: path.join(dir, 'attempts'),
        // FRIDAY_TEST_DEBUG=1 shows what the adapter saw and said.
        ...(process.env.FRIDAY_TEST_DEBUG
          ? {
              log: (m: string) => console.error(`[gemini ${counter}] ${m}`),
              trace: (d: 'send' | 'receive', line: string) =>
                console.error(`[gemini ${counter}] ${d} ${line.slice(0, 300)}`),
            }
          : {}),
      });
      await adapter.start();
      ws().track({ close: () => adapter.close() });
      return new GeminiSubject(adapter, td, work, log);
    },
  };
}

runHarnessConformance('Gemini CLI in spawn mode (scripted Gemini CLI)', () => subject(SCRIPT));

async function eventually<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, what: string, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v).slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('harness conformance: Gemini CLI in spawn mode, what is particular to it', () => {
  it('judges every tool call through the command the host runs, keeps what Friday cannot judge out, and claims the work with its usage', async () => {
    const s = await subject(
      {
        model: 'gemini-fake-pro',
        runs: [
          [
            { op: 'write', path: 'src/ok.txt', text: 'mine\n' },
            { op: 'write', path: '.gemini/settings.json', text: '{"hooks":{}}\n' },
            { op: 'read', path: '.friday/run/daemon.json' },
            { op: 'shell', command: 'git commit -m wip' },
            { op: 'tool', name: 'invoke_agent', input: { agent: 'generalist', prompt: 'do it for me' } },
            { op: 'tool', name: 'write_todos', input: { todos: [] } },
            { op: 'message', text: 'Wrote the file. ' },
            { op: 'final', status: 'completed', summary: 'wrote ok', changed_paths: ['src/ok.txt'], fence: true },
          ],
        ],
      },
      { git: true },
    );
    const h = await s.attach({ agentKey: 'gm-1' });
    const pid = s.td.project.project_id;
    const t = await s.td.operator.post<TaskView>(s.td.operator.projectPath('/tasks'), {
      role: GEMINI_ROLE,
      summary: 'write ok',
      scope: { write: ['src/**'], read: [] },
      ready: true,
    });
    await s.td.operator.post(s.td.operator.projectPath(`/tasks/${t.task_id}/assign`), { agent_key: 'gm-1' });
    const start = (await h.waitFor('task.start', 30_000)).params as TaskStartParams;
    await eventually(
      () => s.td.daemon.state.q.task(pid, t.task_id).status,
      (x) => x === 'READY_FOR_VERIFICATION',
      'the claim',
    );
    const run = s.td.daemon.state.q.findRun(start.run_id);
    const root = run?.execution_root as string;
    expect(path.resolve(root)).not.toBe(path.resolve(s.td.project.root));

    // The session Friday started: headless, its own id, Gemini's approvals off, Friday's deny
    // rules, a trusted worktree, and Friday's own server for the attempt as its only one: neither
    // the project's `friday` server nor the administrator's starts.
    const flags = (h.entries().find((e) => e.flags)?.flags ?? {}) as Record<string, unknown>;
    expect(flags).toMatchObject({
      '--output-format': 'stream-json',
      '--approval-mode': 'yolo',
      '--skip-trust': true,
      '--allowed-mcp-server-names': [FRIDAY_SERVER],
    });
    expect(flags['--session-id']).toBe(run?.session_ref);
    expect(String(flags['--prompt'])).toMatch(/^<\d+ chars>$/);
    expect(h.entries().find((e) => 'denied' in e)?.denied).toEqual(SPAWN_DENIED_TOOLS.map((d) => d.tool));
    expect(h.entries().find((e) => 'mcp_servers' in e)?.mcp_servers).toEqual([FRIDAY_SERVER]);
    // The prompt carried Friday's rules, the packet and the task.
    expect(String(h.entries().find((e) => e.received_prompt)?.received_prompt)).toMatch(/^You are working on a task/);

    // Every tool call the model could make passed Friday's BeforeTool command, run through the
    // host's shell; the tools Friday cannot judge were never offered.
    const decisions = h
      .entries()
      .filter((e) => e.decision || e.excluded)
      .map((e) => [e.tool ?? e.excluded, e.decision ?? 'excluded']);
    expect(decisions).toEqual([
      ['write_file', 'allow'],
      ['write_file', 'deny'],
      ['read_file', 'deny'],
      ['run_shell_command', 'deny'],
      ['invoke_agent', 'excluded'],
      // Not Friday's to judge, and harmless: Friday gives it no decision, and the host runs it.
      ['write_todos', 'allow'],
    ]);
    const before = h.entries().filter((e) => e.hook === 'BeforeTool');
    expect(before.every((e) => e.ran === 1)).toBe(true);
    expect(String(h.entries().find((e) => e.tool === 'run_shell_command' && e.decision)?.reason)).toMatch(
      /^Friday: .*A human decides this \(approval apr_/,
    );
    expect(existsSync(path.join(root, 'src', 'ok.txt'))).toBe(true);
    expect(readFileSync(path.join(root, '.gemini', 'settings.json'), 'utf8')).toContain('hook.mjs gemini BeforeTool');
    // The session start and the tool results reached Friday through the same command line.
    expect(
      h
        .entries()
        .filter((e) => e.hook === 'SessionStart')
        .map((e) => e.ran),
    ).toEqual([1]);
    expect(h.entries().filter((e) => e.hook === 'AfterTool').length).toBe(2);

    // The claim: the fenced JSON of the last message, with what changed in the worktree.
    const claim = run?.claim as { changed_paths: string[]; summary: string };
    expect(claim.summary).toBe('wrote ok');
    expect(claim.changed_paths).toEqual(expect.arrayContaining(['src/ok.txt']));
    const events = s.td.daemon.state.store.readByRef(pid, 'task', t.task_id);
    const settings = events.find(
      (e) => e.type === 'agent.event' && (e.payload as { event_type: string }).event_type === 'host.settings',
    )?.payload as { data?: Record<string, unknown> } | undefined;
    expect(settings?.data).toMatchObject({
      session_id: run?.session_ref,
      model: start.model ?? 'gemini-fake-pro',
      approval_mode: 'yolo',
      mcp_servers: [FRIDAY_SERVER],
      hook_failure: 'fail-open',
    });

    // The attempt's row: the result's stats, with what Gemini CLI does not name left unknown.
    const report = await s.td.operator.get<UsageReport>(s.td.operator.projectPath(`/usage?task=${t.task_id}`));
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      run_id: start.run_id,
      harness_vendor: 'gemini',
      harness_mode: 'spawn',
      host: {
        reported: true,
        input_tokens: 12_000,
        output_tokens: 300,
        cache_read_input_tokens: 8000,
        cache_creation_input_tokens: null,
        cost_usd: null,
        turns: 1,
        model: start.model ?? 'gemini-fake-pro',
      },
    });
    // The attempt's session ended with the attempt.
    expect(h.adapter.running(start.run_id)).toBe(false);
  });

  it('serves Friday’s tools for spawned agents to the session, and relays a message that arrived in a turn of its own', async () => {
    const s = await subject(
      {
        runs: [
          [
            { op: 'mcp', tool: 'friday_request_context', input: { kind: 'file', query: 'README.md' } },
            {
              op: 'mcp',
              tool: 'friday_communicate',
              input: { to: 'human', mode: 'notification', content: 'starting on the cart' },
            },
            // An attached session's tool is not this session's.
            { op: 'mcp', tool: 'friday_task_claim', input: { next: true } },
            { op: 'wait', ms: 2500 },
            { op: 'final', status: 'completed', summary: 'first answer', changed_paths: [] },
          ],
        ],
        resume: [{ op: 'final', status: 'completed', summary: 'read the message', changed_paths: [] }],
      },
      { git: true },
    );
    const h = await s.attach({ agentKey: 'gm-3' });
    const pid = s.td.project.project_id;
    const t = await s.td.operator.post<TaskView>(s.td.operator.projectPath('/tasks'), {
      role: GEMINI_ROLE,
      summary: 'cart',
      scope: { write: ['src/**'], read: [] },
      ready: true,
    });
    await s.td.operator.post(s.td.operator.projectPath(`/tasks/${t.task_id}/assign`), { agent_key: 'gm-3' });
    await h.waitFor('task.start', 30_000);
    await eventually(
      () => h.entries().filter((e) => e.mcp).length,
      (n) => n >= 3,
      'the session’s tool calls',
    );
    const sent = await s.td.operator.post<{ message_id: string }>(s.td.operator.projectPath('/messages'), {
      to: 'gm-3',
      mode: 'notification',
      subject: 'contract changed',
      content: 'shared/api.ts now returns cents',
    });
    await eventually(
      () => s.td.daemon.state.q.task(pid, t.task_id).status,
      (x) => x === 'READY_FOR_VERIFICATION',
      'the claim',
    );
    const calls = h.entries().filter((e) => e.mcp) as { mcp: string; tools: string[]; result: { isError?: boolean } }[];
    // The attempt's server holds exactly the spawned set of Friday's tools, and they work.
    expect([...(calls[0]?.tools ?? [])].sort()).toEqual([...SPAWNED_AGENT_TOOLS].sort());
    expect(calls.map((c) => [c.mcp, Boolean(c.result?.isError)])).toEqual([
      ['friday_request_context', false],
      ['friday_communicate', false],
      ['friday_task_claim', true],
    ]);
    // Friday's own tools pass its BeforeTool hook with no decision, and the policy keeps them in.
    expect(
      h
        .entries()
        .filter((e) => typeof e.tool === 'string' && String(e.tool).startsWith('mcp_friday_') && e.decision)
        .map((e) => e.decision),
    ).toEqual(['allow', 'allow', 'allow']);
    // The note went out through Friday, as this agent's.
    const sentText = (calls[1]?.result as { content?: { text?: string }[] } | undefined)?.content?.[0]?.text ?? '';
    expect(sentText).toMatch(/^Message msg_[0-9a-z]+ queued for /);
    const communicated = s.td.daemon.state.store.readSince(pid, 0, { types: ['communication.sent'], limit: 100 });
    expect(communicated.some((e) => e.actor.kind === 'agent')).toBe(true);
    // The message that arrived while the turn ran had a turn of its own, in the same session.
    const run = s.td.daemon.state.q.findRun(s.td.daemon.state.q.task(pid, t.task_id).current_run_id as string);
    const turns = h.entries().filter((e) => e.flags) as { flags: Record<string, unknown> }[];
    expect(turns.map((x) => x.flags['--session-id'] ?? x.flags['--resume'])).toEqual([
      run?.session_ref,
      run?.session_ref,
    ]);
    expect(turns[1]?.flags['--resume']).toBe(run?.session_ref);
    expect(String(h.entries().filter((e) => e.received_prompt)[1]?.received_prompt)).toMatch(/^\[A message from /);
    expect((run?.claim as { summary?: string } | undefined)?.summary).toBe('read the message');
    const message = await eventually(
      () =>
        s.td.operator.get<{ deliveries: { state: string }[] }>(
          s.td.operator.projectPath(`/messages/${sent.message_id}`),
        ),
      (m) => m.deliveries.every((d) => d.state === 'acknowledged'),
      'the acknowledgement',
    );
    expect(message.deliveries.map((d) => d.state)).toEqual(['acknowledged']);
    // Both turns counted in the attempt's row.
    const report = await s.td.operator.get<UsageReport>(s.td.operator.projectPath(`/usage?task=${t.task_id}`));
    expect(report.rows[0]?.host).toMatchObject({ turns: 2, input_tokens: 24_000, output_tokens: 600 });
  });

  it('refuses a run whose worktree lacks Friday’s hooks: a session there would run every call unjudged', async () => {
    const s = await subject({ runs: [[{ op: 'final' }]] }, { git: true, configured: false });
    const h = await s.attach({ agentKey: 'gm-2' });
    const pid = s.td.project.project_id;
    const t = await s.td.operator.post<TaskView>(s.td.operator.projectPath('/tasks'), {
      role: GEMINI_ROLE,
      summary: 'never starts',
      scope: { write: ['src/**'], read: [] },
      ready: true,
    });
    await s.td.operator.post(s.td.operator.projectPath(`/tasks/${t.task_id}/assign`), { agent_key: 'gm-2' });
    await h.waitFor('task.start', 30_000);
    const declined = await eventually(
      () =>
        s.td.daemon.state.store
          .readByRef(pid, 'task', t.task_id)
          .filter((e) => e.type === 'run.declined')
          .map((e) => JSON.stringify(e.payload)),
      (x) => x.length > 0,
      'the run declined',
    );
    expect(declined[0]).toMatch(
      /Gemini CLI could not start: \.gemini\/settings\.json is missing in the task's worktree: run \\"friday harness config gemini\\"/,
    );
    // No session was started.
    expect(h.entries().find((e) => e.flags)).toBeUndefined();
  });

  it("leaves a machine's own system settings in force: no copy of them, none of Friday's tools, rules that name none", async () => {
    // Gemini CLI loads a system settings file only when Administrators or SYSTEM own it, so a copy
    // the user owns could drop the administrator's settings for the session (LESSONS HX-15).
    const s = await subject(
      { runs: [[{ op: 'final', status: 'completed', summary: 'done', changed_paths: [] }]] },
      { git: true, machineSettings: true },
    );
    const h = await s.attach({ agentKey: 'gm-4' });
    const pid = s.td.project.project_id;
    const t = await s.td.operator.post<TaskView>(s.td.operator.projectPath('/tasks'), {
      role: GEMINI_ROLE,
      summary: 'kept settings',
      scope: { write: ['src/**'], read: [] },
      ready: true,
    });
    await s.td.operator.post(s.td.operator.projectPath(`/tasks/${t.task_id}/assign`), { agent_key: 'gm-4' });
    await eventually(
      () => s.td.daemon.state.q.task(pid, t.task_id).status,
      (x) => x === 'READY_FOR_VERIFICATION',
      'the claim',
    );
    const started = h.entries().find((e) => 'system_settings' in e) as { system_settings: string | null };
    expect(path.resolve(String(started.system_settings))).toBe(
      path.resolve(ws().root, 'gemini', 'system-settings.json'),
    );
    const prompt = h.entries().find((e) => 'prompt_names_friday_tools' in e) as { prompt_names_friday_tools: boolean };
    expect(prompt.prompt_names_friday_tools).toBe(false);
  });
});
