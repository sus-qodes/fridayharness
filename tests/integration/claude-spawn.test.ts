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

const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'claude', 'fake-claude.mjs');

type Step = Record<string, unknown>;
interface Script {
  model?: string;
  extraTools?: string[];
  mcpServers?: string[];
  plugins?: string[];
  skills?: string[];
  turns: Step[][];
  resume?: Step[];
}

/** A Claude Code agent working for Friday in spawn mode, its host scripted. */
function claude(td: TestDaemon, agent: string, script: Script, opts: { harnessKey?: string; dir?: string } = {}) {
  const dir = opts.dir ?? path.join(ws().root, `claude-${agent}`);
  mkdirSync(dir, { recursive: true });
  const scriptFile = path.join(dir, 'script.json');
  writeFileSync(scriptFile, JSON.stringify(script));
  const log = path.join(dir, 'log.jsonl');
  const work = path.join(dir, 'work');
  const adapter = new ClaudeSpawnAdapter({
    bootstrap: td.bootstrap,
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
const daemon = (opts: { clock?: FakeClock } = {}) =>
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
      '--mcp-config': JSON.stringify({ mcpServers: {} }),
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
      tools: [...SPAWN_TOOLS, 'StructuredOutput'],
      mcp_servers: [],
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
    // The session has none of Friday's own tools, so its instructions name none.
    expect(rules).not.toMatch(/friday_[a-z]+|friday:\/\//);
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
});
