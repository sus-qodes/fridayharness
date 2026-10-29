/**
 * Claude Code in spawn mode (ADR-0032 §11): Friday's adapter starts the installed Claude Code
 * headless for each run attempt, here a scripted Claude Code that speaks the same stream-json and
 * runs Friday's real hook launcher for every tool call (`tests/fixtures/claude/fake-claude.mjs`).
 * The session is restricted to the tools Friday's hooks judge, with no settings of the user's or
 * the repository's and no MCP server; what a human decides is declined until one has; the turn's
 * structured result becomes a claim, a blocked result or an error.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bundledHookPath,
  CLAUDE_SPAWN_RULES,
  ClaudeSpawnAdapter,
  claudeCodeHooks,
  claudeEnvironment,
  SPAWN_TOOLS,
} from '@friday/adapter-claude';
import { SPAWNED_AGENT_TOOLS } from '@friday/mcp-server';
import type { TaskStartParams, TaskView } from '@friday/protocol';
import type { DaemonClient } from '@friday/sdk';
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

const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'claude', 'fake-claude.mjs');

type Step = Record<string, unknown>;
interface Script {
  model?: string;
  extraTools?: string[];
  mcpServers?: string[];
  plugins?: string[];
  skills?: string[];
  omitInit?: string[];
  initAfterResult?: boolean;
  turns: Step[][];
  resume?: Step[];
}

/** A Claude Code agent working for Friday in spawn mode, its host scripted. */
function claude(
  td: TestDaemon,
  agent: string,
  script: Script,
  opts: { harnessKey?: string; dir?: string; bootstrap?: DaemonClient; stateDir?: string } = {},
) {
  const sent: string[] = [];
  const dir = opts.dir ?? path.join(ws().root, `claude-${agent}`);
  mkdirSync(dir, { recursive: true });
  const scriptFile = path.join(dir, 'script.json');
  writeFileSync(scriptFile, JSON.stringify(script));
  const log = path.join(dir, 'log.jsonl');
  const work = path.join(dir, 'work');
  const adapter = new ClaudeSpawnAdapter({
    bootstrap: opts.bootstrap ?? td.bootstrap,
    // What the adapter wrote to its host, as it wrote it.
    trace: (direction: 'send' | 'receive', line: string) => {
      if (direction === 'send') sent.push(line);
    },
    ...(opts.stateDir ? { stateDir: opts.stateDir } : {}),
    projectId: td.project.project_id,
    agentKey: agent,
    role: 'backend',
    host: { command: process.execPath, args: [FAKE], version: '2.1.300' },
    hostEnv: {
      ...claudeEnvironment(process.env),
      // Friday's hook launcher finds the test daemon through the test's own state folder.
      FRIDAY_STATE_DIR: ws().stateDir,
      FAKE_CLAUDE_SCRIPT: scriptFile,
      FAKE_CLAUDE_LOG: log,
      FAKE_CLAUDE_WORK: work,
    },
    hook: { command: process.execPath, args: [bundledHookPath()] },
    workDir: path.join(dir, 'attempts'),
    maxBudgetUsd: 0.5,
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
const daemon = (opts: { clock?: FakeClock; extraConfig?: string } = {}) =>
  startTestDaemon(ws(), { git: true, brain: false, extensions: [claudeCodeHooks()], ...opts });

describe('Claude Code in spawn mode', () => {
  it('restricts the session, judges every tool call through Friday’s hooks, and claims the work', async () => {
    const td = await daemon();
    const pid = td.project.project_id;
    const c = claude(td, 'cl-1', {
      model: 'claude-fake-sonnet',
      turns: [
        [
          { op: 'write', path: 'src/ok.ts', text: 'export const ok = 1;\n' },
          { op: 'write', path: 'docs/no.md', text: 'not mine\n' },
          { op: 'read', path: '.friday/run/daemon.json' },
          { op: 'bash', command: 'node --test' },
          { op: 'bash', command: 'git push' },
          { op: 'bash', command: 'git commit -m wip' },
          { op: 'bash', command: 'git commit -m wip' },
          { op: 'tool', name: 'TodoWrite', input: { todos: [] } },
          { op: 'final', status: 'completed', summary: 'wrote ok', changed_paths: ['src/ok.ts'] },
        ],
      ],
    });
    await c.adapter.start();
    const id = await assigned(td, 'cl-1', ['src/**']);
    await eventually(
      () => status(td, id).status,
      (s) => s === 'READY_FOR_VERIFICATION',
      'the claim',
    );
    const run = td.daemon.state.q.findRun(status(td, id).current_run_id as string);
    const root = run?.execution_root as string;

    // The session Friday started: headless, restricted, Friday's hooks for every tool, no MCP server.
    const flags = (c.entries().find((e) => e.flags)?.flags ?? {}) as Record<string, string | boolean>;
    expect(flags).toMatchObject({
      '-p': true,
      '--input-format': 'stream-json',
      '--output-format': 'stream-json',
      '--restricted': true,
      '--tools': SPAWN_TOOLS.join(','),
      '--strict-mcp-config': true,
      '--permission-prompts': 'none',
      '--disable-slash-commands': true,
      '--replay-user-messages': true,
      '--max-budget-usd': '0.5',
    });
    expect(flags['--session-id']).toBe(run?.session_ref);
    expect(JSON.parse(String(flags['--json-schema'])).required).toEqual(
      expect.arrayContaining(['status', 'summary', 'changed_paths', 'blocked_reason']),
    );
    // The routed model is applied, and the one the session reports is recorded.
    const started = c.adapter.received.find((m) => m.method === 'task.start')?.params as TaskStartParams;
    if (started.model) expect(flags['--model']).toBe(started.model);
    // Friday's rules and the task's context, naming none of Friday's own tools.
    const hooks = (c.entries().find((e) => e.flags) as { args: string[] }).args;
    expect(hooks).toContain('--append-system-prompt-file');

    // Every tool call was Friday's decision.
    const decisions = c
      .entries()
      .filter((e) => e.hook === 'PreToolUse')
      .map((e) => {
        const input = e.input as { file_path?: string; command?: string };
        const what =
          e.tool === 'StructuredOutput'
            ? 'the final answer'
            : (input.command ?? (input.file_path ? path.basename(input.file_path) : 'no target'));
        return [e.tool, what, e.decision];
      });
    expect(decisions).toEqual([
      ['Write', 'ok.ts', 'allow'],
      ['Write', 'no.md', 'deny'],
      ['Read', 'daemon.json', 'deny'],
      [expect.any(String), 'node --test', 'allow'],
      [expect.any(String), 'git push', 'deny'],
      [expect.any(String), 'git commit -m wip', 'deny'],
      [expect.any(String), 'git commit -m wip', 'deny'],
      // A tool Friday does not judge is refused, should a session ever have one.
      ['TodoWrite', 'no target', 'deny'],
      // The final answer comes back through Claude Code's StructuredOutput tool, which Friday lets through.
      ['StructuredOutput', 'the final answer', 'allow'],
    ]);
    expect(String(c.entries().find((e) => e.tool === 'TodoWrite')?.reason)).toMatch(
      /TodoWrite is not a tool Friday judges/,
    );
    expect(existsSync(path.join(root, 'src', 'ok.ts'))).toBe(true);
    expect(existsSync(path.join(root, 'docs', 'no.md'))).toBe(false);
    // A commit is a human's decision: one pending approval, however often the session asks.
    const commitReason = String(
      c
        .entries()
        .filter((e) => e.hook === 'PreToolUse' && (e.input as { command?: string }).command === 'git commit -m wip')
        .at(-1)?.reason,
    );
    expect(commitReason).toMatch(/A human decides this \(approval apr_/);
    const pending = td.daemon.state.q.approvals(pid, 'pending').filter((a) => a.capability === 'shell.git.commit');
    expect(pending).toHaveLength(1);

    // The claim lists what changed; the session's settings and the model it ran are recorded.
    const claim = run?.claim as { changed_paths: string[]; summary: string };
    expect(claim.summary).toBe('wrote ok');
    expect(claim.changed_paths).toEqual(expect.arrayContaining(['src/ok.ts']));
    const events = td.daemon.state.store.readByRef(pid, 'task', id);
    const settings = events.find(
      (e) => e.type === 'agent.event' && (e.payload as { event_type: string }).event_type === 'host.settings',
    )?.payload as { data?: Record<string, unknown> } | undefined;
    expect(settings?.data).toMatchObject({
      // Friday's own server, which the adapter serves, adds Friday's tools and nothing else.
      tools: [...SPAWN_TOOLS, 'StructuredOutput', ...SPAWNED_AGENT_TOOLS.map((t) => `mcp__friday__${t}`)],
      mcp_servers: ['friday'],
      // Claude Code's own plugins are recorded and accepted; they add no tool.
      plugins: ['cc-plugin-agents-md', 'cc-plugin-telemetry', 'cc-plugin-plugin-authoring'],
      skills: [],
      repository_config: 'ignored',
    });
    const observed = td.daemon.state.store
      .readByRef(pid, 'run', run?.run_id as string)
      .filter((e) => e.type === 'run.model_observed')
      .map((e) => (e.payload as { model: string }).model);
    expect(observed).toContain(started.model ?? 'claude-fake-sonnet');
    // The attempt's session ended with the attempt.
    expect(c.adapter.running(run?.run_id as string)).toBe(false);
  });

  it('gives the session Friday’s rules, its packet and Friday’s hooks, and leaves nothing behind', async () => {
    const td = await daemon();
    const c = claude(td, 'cl-1', {
      turns: [[{ op: 'waitMessage' }, { op: 'final', status: 'completed', summary: 'done', changed_paths: [] }]],
    });
    await c.adapter.start();
    const id = await assigned(td, 'cl-1', ['src/**']);
    await eventually(
      () => status(td, id).status,
      (s) => s === 'RUNNING',
      'the task to run',
    );
    // While the attempt runs, its files are in the adapter's folder for the attempt.
    const attempt = path.join(c.dir, 'attempts', status(td, id).current_run_id as string);
    const rules = readFileSync(path.join(attempt, 'instructions.md'), 'utf8');
    expect(rules.startsWith(CLAUDE_SPAWN_RULES.split('\n')[0] as string)).toBe(true);
    expect(rules).toContain(id);
    // Its instructions name only the Friday tools the session has (review M8-R06).
    const named = new Set(rules.match(/friday_[a-z_]+/g) ?? []);
    expect(
      [...named].every((t) => (SPAWNED_AGENT_TOOLS as readonly string[]).includes(t)),
      [...named].join(),
    ).toBe(true);
    expect(rules).not.toMatch(/friday:\/\//);
    // Its only MCP server is Friday's own, served by the adapter on this machine, for this attempt.
    const mcp = JSON.parse(readFileSync(path.join(attempt, 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>;
    };
    expect(Object.keys(mcp.mcpServers)).toEqual(['friday']);
    expect(mcp.mcpServers.friday?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/run_/);
    // Without the attempt's secret, or from a web page, the tools do not answer.
    const url = mcp.mcpServers.friday?.url as string;
    expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(401);
    expect(
      (
        await fetch(url, {
          method: 'POST',
          body: '{}',
          headers: { ...mcp.mcpServers.friday?.headers, origin: 'http://evil.example' },
        })
      ).status,
    ).toBe(404);
    const settings = JSON.parse(readFileSync(path.join(attempt, 'settings.json'), 'utf8')) as {
      hooks: Record<string, { matcher?: string; hooks: Record<string, unknown>[] }[]>;
    };
    expect(settings.hooks.PreToolUse?.[0]).toMatchObject({
      matcher: '*',
      hooks: [{ command: process.execPath, args: [bundledHookPath(), 'PreToolUse'], onFailure: 'block' }],
    });
    expect(Object.keys(settings.hooks).sort()).toEqual(
      ['PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'SessionEnd', 'SessionStart'].sort(),
    );
    // The turn goes on, and the attempt's files go with it.
    await td.operator.post(td.operator.projectPath('/messages'), {
      to: 'cl-1',
      mode: 'notification',
      content: 'go on',
    });
    await eventually(
      () => status(td, id).status,
      (s) => s === 'READY_FOR_VERIFICATION',
      'the claim',
    );
    await eventually(
      () => existsSync(attempt),
      (x) => !x,
      'the attempt files to go',
    );
  });

  it('reports a blocked turn as blocked, a failed one as an error, and refuses a session with tools Friday did not give it', async () => {
    const td = await daemon();
    const blocked = claude(td, 'cl-1', {
      turns: [[{ op: 'final', status: 'blocked', summary: 'stopped', blocked_reason: 'which database to use' }]],
    });
    const failing = claude(td, 'cl-2', { turns: [[{ op: 'fail', message: 'the model quit' }]] });
    const widened = claude(td, 'cl-3', {
      extraTools: ['WebFetch'],
      mcpServers: ['someone'],
      plugins: ['helper'],
      skills: ['deploy'],
      turns: [
        [
          { op: 'write', path: 'src/x.ts', text: 'x' },
          { op: 'final', status: 'completed', summary: 'x', changed_paths: [] },
        ],
      ],
    });
    for (const x of [blocked, failing, widened]) await x.adapter.start();
    const one = await assigned(td, 'cl-1', ['src/**'], 'needs a decision');
    const two = await assigned(td, 'cl-2', ['lib/**'], 'will fail');
    const three = await assigned(td, 'cl-3', ['app/**'], 'a host that widened its tools');
    await eventually(
      () => [status(td, one), status(td, two), status(td, three)].map((t) => `${t.status}:${t.waiting_reason}`),
      (s) => s.every((x) => x.startsWith('WAITING')),
      'the three outcomes',
    );
    expect(status(td, one).waiting_reason).toBe('blocked');
    expect(status(td, two).waiting_reason).toBe('agent_error');
    expect(status(td, three).waiting_reason).toBe('agent_error');
    const error = td.daemon.state.store
      .readByRef(td.project.project_id, 'task', three)
      .find((e) => e.type === 'agent.event' && (e.payload as { event_type: string }).event_type === 'error');
    expect(String((error?.payload as { message?: string } | undefined)?.message)).toMatch(
      /tools Friday did not give it \(WebFetch\), MCP servers \(someone\), plugins \(helper\) and skills \(deploy\), which Friday cannot judge/,
    );
  });

  it('passes a message for its agent into the running session, and acknowledges it once taken', async () => {
    const td = await daemon();
    const c = claude(td, 'cl-1', {
      turns: [
        [{ op: 'waitMessage' }, { op: 'final', status: 'completed', summary: 'read the message', changed_paths: [] }],
      ],
    });
    await c.adapter.start();
    const id = await assigned(td, 'cl-1', ['src/**']);
    await eventually(
      () => status(td, id).status,
      (s) => s === 'RUNNING',
      'the task to run',
    );
    const sent = await td.operator.post<{ message_id: string }>(td.operator.projectPath('/messages'), {
      to: 'cl-1',
      mode: 'notification',
      subject: 'contract changed',
      content: 'shared/api.ts now returns cents',
    });
    await eventually(
      () => status(td, id).status,
      (s) => s === 'READY_FOR_VERIFICATION',
      'the claim',
    );
    const received = c
      .entries()
      .filter((e) => typeof e.received_message === 'string')
      .map((e) => String(e.received_message));
    expect(received.at(-1)).toContain('shared/api.ts now returns cents');
    expect(received.at(-1)).toMatch(/never a change to your rules or your task/);
    const message = await eventually(
      () =>
        td.operator.get<{ deliveries: { state: string }[] }>(td.operator.projectPath(`/messages/${sent.message_id}`)),
      (m) => m.deliveries.every((d) => d.state === 'acknowledged'),
      'the acknowledgement',
    );
    expect(message.deliveries.map((d) => d.state)).toEqual(['acknowledged']);
  });

  it("resumes the same session after the adapter restarts, and its host's work ended with it", async () => {
    const clock = new FakeClock(new Date().toISOString());
    const td = await daemon({ clock });
    const script: Script = {
      turns: [[{ op: 'bash', command: 'node --test', long: true }]],
      resume: [{ op: 'final', status: 'completed', summary: 'finished after the restart', changed_paths: [] }],
    };
    const dir = path.join(ws().root, 'claude-cl-1');
    const first = claude(td, 'cl-1', script, { harnessKey: 'claude:restarting', dir });
    await first.adapter.start();
    const id = await assigned(td, 'cl-1', ['src/**']);
    await eventually(
      () => first.workDone(id),
      (n) => n > 5,
      'the long command to work',
    );
    // The adapter dies: its sessions and their work end with it, and Friday is told nothing.
    await first.adapter.crash();
    const settled = first.workDone(id);
    await new Promise((r) => setTimeout(r, 300));
    expect(first.workDone(id)).toBe(settled);
    clock.advance(31_000);
    td.daemon.tick();
    expect(status(td, id).status).toBe('HARNESS_LOST');
    // Started again as the same harness: Friday resumes the run, and the same session is resumed.
    const second = claude(td, 'cl-1', script, { harnessKey: 'claude:restarting', dir });
    await second.adapter.start();
    const resume = await eventually(
      () => second.adapter.received.find((m) => m.method === 'task.resume'),
      (m) => Boolean(m),
      'task.resume',
    );
    const sessionRef = (resume?.params as TaskStartParams | undefined)?.session_ref;
    expect(sessionRef).toMatch(/^[0-9a-f-]{36}$/);
    await eventually(
      () => status(td, id).status,
      (s) => s === 'READY_FOR_VERIFICATION',
      'the claim after resuming',
    );
    const resumed = second
      .entries()
      .filter((e) => e.flags)
      .at(-1)?.flags as Record<string, string>;
    expect(resumed['--resume']).toBe(sessionRef);
  });

  it('starts no turn for a start Friday no longer wants (review M8-R03)', async () => {
    const td = await daemon();
    const x = interceptedBootstrap(td);
    const c = claude(
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
    const turnSent = () => c.sent.some((l) => l.includes(`Task ${taskId}`));
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
      c.entries().some((e) => typeof e.received_message === 'string' && e.received_message.includes(taskId)),
      'what the host received',
    ).toBe(false);
  });

  it('keeps serving Friday after a poll fails, so a cancellation still stops the work (review M8-R02)', async () => {
    const td = await daemon();
    const x = interceptedBootstrap(td);
    const c = claude(
      td,
      'h-1',
      { turns: [[{ op: 'bash', command: 'node --test', long: true }]] },
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
    const td = await daemon();
    const final = { op: 'final', status: 'completed', summary: 'done', changed_paths: [] };
    // The first report never reaches Friday.
    const a = interceptedBootstrap(td);
    a.on(method('agent.result'), notDelivered);
    const one = claude(td, 'h-1', { turns: [[final]] }, { bootstrap: a.client });
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
    const two = claude(td, 'h-2', { turns: [[final]] }, { bootstrap: b.client });
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

  it('reports the result of a finished attempt after the adapter restarts, without a new turn (review M8-R05)', async () => {
    const td = await daemon();
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
    const one = claude(td, 'h-1', script, { bootstrap: x.client, harnessKey: 'claude-code:restart-r05', stateDir });
    await one.adapter.start();
    const id = await assigned(td, 'h-1', ['src/**']);
    await reports.promise;
    await one.adapter.crash();
    stopFailing();
    expect(status(td, id).status).toBe('RUNNING');
    // The same harness comes back, with the same state folder.
    const two = claude(td, 'h-1', script, {
      harnessKey: 'claude-code:restart-r05',
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

  it('refuses a session that started with tools Friday did not give it, whatever arrives first (review M8-R04)', async () => {
    const td = await daemon();
    const x = interceptedBootstrap(td);
    // The adapter's record of the session's settings is held while the turn ends at once.
    const held = gate();
    x.on(
      method('agent.event', (p) => p.event_type === 'host.settings'),
      async (_call, forward) => {
        await held.promise;
        return forward();
      },
    );
    const c = claude(
      td,
      'h-1',
      {
        extraTools: ['UnjudgedExtraTool'],
        turns: [[{ op: 'final', status: 'completed', summary: 'claimed anyway', changed_paths: [] }]],
      },
      { bootstrap: x.client },
    );
    await c.adapter.start();
    const id = await assigned(td, 'h-1', ['src/**']);
    await eventually(
      () => status(td, id),
      (t) => t.status === 'READY_FOR_VERIFICATION' || t.waiting_reason === 'agent_error',
      'the outcome',
      15_000,
    );
    held.open();
    expect(status(td, id)).toMatchObject({ status: 'WAITING', waiting_reason: 'agent_error' });
    const claimed = td.daemon.state.store
      .readByRef(td.project.project_id, 'task', id)
      .filter((e) => e.type === 'task.completion_claimed');
    expect(claimed).toHaveLength(0);
  });

  it('refuses a session that reports no tools, or a result before its report (review M8-R04)', async () => {
    const td = await daemon();
    const final = { op: 'final', status: 'completed', summary: 'claimed', changed_paths: [] };
    const silent = claude(td, 'h-1', { omitInit: ['tools'], turns: [[final]] });
    const early = claude(td, 'h-2', { initAfterResult: true, turns: [[final]] });
    for (const c of [silent, early]) await c.adapter.start();
    const one = await assigned(td, 'h-1', ['src/**']);
    const two = await assigned(td, 'h-2', ['lib/**']);
    for (const id of [one, two]) {
      await eventually(
        () => status(td, id),
        (t) => t.status === 'READY_FOR_VERIFICATION' || t.waiting_reason === 'agent_error',
        'the outcome',
        15_000,
      );
      expect(status(td, id), id).toMatchObject({ status: 'WAITING', waiting_reason: 'agent_error' });
    }
  });

  it('stops its hosts when Friday is not heard for a lease, and resumes the same run once it is (review M8-R02)', async () => {
    const td = await daemon({ extraConfig: 'leases:\n  heartbeat_interval_ms: 1000\n  lease_ttl_ms: 2000\n' });
    const x = interceptedBootstrap(td);
    const c = claude(
      td,
      'h-1',
      {
        turns: [[{ op: 'bash', command: 'node --test', long: true }]],
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
});
