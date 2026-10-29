/**
 * Friday's tools in sessions Friday starts itself (review M8-R06, ADR-0032 §8): a spawned Codex
 * thread and a spawned Claude Code session, on two tasks of one goal, ask each other questions and
 * answer them with facts, each answer correlated with the question it answers, without operator
 * credentials and without a human speaking for them. An agent with no related work is not reached;
 * context and permission requests go through the same tools. Both hosts are scripted; the
 * daemon, the adapters, Friday's hook launcher and the MCP endpoint are real.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundledHookPath, ClaudeSpawnAdapter, claudeCodeHooks, claudeEnvironment } from '@friday/adapter-claude';
import { CodexAdapter } from '@friday/adapter-codex';
import type { MessageView } from '@friday/protocol';
import { useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
type Step = Record<string, unknown>;

const entriesOf = (log: string): Record<string, unknown>[] =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];

function codexAgent(td: TestDaemon, agent: string, turn: Step[]) {
  const dir = path.join(ws().root, `codex-${agent}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'script.json'), JSON.stringify({ turns: [turn] }));
  const log = path.join(dir, 'log.jsonl');
  const adapter = new CodexAdapter({
    bootstrap: td.bootstrap,
    projectId: td.project.project_id,
    agentKey: agent,
    role: 'backend',
    host: {
      command: process.execPath,
      args: [path.join(FIXTURES, 'codex', 'fake-app-server.mjs')],
      version: '0.162.1',
    },
    hostEnv: {
      ...process.env,
      FAKE_CODEX_SCRIPT: path.join(dir, 'script.json'),
      FAKE_CODEX_LOG: log,
      FAKE_CODEX_WORK: path.join(dir, 'work'),
    },
    sandbox: 'workspace-write',
  });
  ws().track({ close: () => adapter.close() });
  return { adapter, entries: () => entriesOf(log) };
}

function claudeAgent(td: TestDaemon, agent: string, turn: Step[]) {
  const dir = path.join(ws().root, `claude-${agent}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'script.json'), JSON.stringify({ turns: [turn] }));
  const log = path.join(dir, 'log.jsonl');
  const adapter = new ClaudeSpawnAdapter({
    bootstrap: td.bootstrap,
    projectId: td.project.project_id,
    agentKey: agent,
    role: 'frontend',
    host: { command: process.execPath, args: [path.join(FIXTURES, 'claude', 'fake-claude.mjs')], version: '2.1.300' },
    hostEnv: {
      ...claudeEnvironment(process.env),
      FRIDAY_STATE_DIR: ws().stateDir,
      FAKE_CLAUDE_SCRIPT: path.join(dir, 'script.json'),
      FAKE_CLAUDE_LOG: log,
      FAKE_CLAUDE_WORK: path.join(dir, 'work'),
    },
    hook: { command: process.execPath, args: [bundledHookPath()] },
    workDir: path.join(dir, 'attempts'),
  });
  ws().track({ close: () => adapter.close() });
  return { adapter, entries: () => entriesOf(log) };
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

/** A goal with two tasks a human wrote and approved: the agents' work is related. */
async function goalOfTwo(td: TestDaemon) {
  const op = td.operator;
  const goal = await op.post<{ goal_id: string }>(op.projectPath('/goals'), { request: 'Show totals', plan: false });
  const v1 = await op.post<{ plan_id: string; version: number }>(op.projectPath(`/goals/${goal.goal_id}/plans`), {
    draft: {
      objective: 'Show checkout totals',
      summary: 'A backend total and its display',
      tasks: [
        {
          key: 'backend',
          summary: 'Compute the total',
          acceptance_criteria: ['tests pass'],
          scope: { write: ['backend/**'], read: ['**'] },
        },
        {
          key: 'frontend',
          summary: 'Display the total',
          acceptance_criteria: ['tests pass'],
          scope: { write: ['frontend/**'], read: ['**'] },
        },
      ],
    },
  });
  await op.post(op.projectPath(`/plans/${v1.plan_id}/versions/${v1.version}/approve`), {});
  const detail = await op.get<{ active: { tasks: { key: string; task_id: string }[] } }>(
    op.projectPath(`/goals/${goal.goal_id}`),
  );
  return Object.fromEntries(detail.active.tasks.map((t) => [t.key, t.task_id])) as Record<
    'backend' | 'frontend',
    string
  >;
}

const status = (td: TestDaemon, id: string) => td.daemon.state.q.task(td.project.project_id, id);

describe("Friday's tools in spawned sessions (review M8-R06)", () => {
  it('spawned agents ask each other through Friday and answer with facts, correlated, and reach only related work', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: { autoStart: false }, extensions: [claudeCodeHooks()] });
    const ids = await goalOfTwo(td);
    // An agent with no work related to theirs.
    const stranger = await FakeHarness.connect(td, { agentKey: 'fh-1', role: 'docs' });
    const done = { op: 'final', status: 'completed', summary: 'done', changed_paths: [] };
    const codex = codexAgent(td, 'cx-1', [
      { op: 'friday', tool: 'friday_request_context', args: { kind: 'task' } },
      {
        op: 'friday',
        tool: 'friday_communicate',
        args: { to: 'cl-1', mode: 'request', subject: 'Price units', content: 'Are prices integer minor units?' },
      },
      { op: 'friday', tool: 'friday_communicate', args: { to: 'fh-1', mode: 'request', content: 'Anything to add?' } },
      {
        op: 'friday',
        tool: 'friday_request_permission',
        args: { action_class: 'shell.git.push', command: 'git push', justification: 'publish the branch' },
      },
      // Claude's answer, then Claude's own question.
      { op: 'waitSteer', count: 1 },
      { op: 'waitSteer', count: 2 },
      {
        op: 'friday',
        tool: 'friday_communicate',
        args: {
          to: 'cl-1',
          mode: 'response',
          response_to: '$lastMessageId',
          content: 'Yes: totals are integer cents.',
          facts: [{ fact: 'checkout totals are integer cents', area: 'backend' }],
        },
      },
      done,
    ]);
    const claude = claudeAgent(td, 'cl-1', [
      { op: 'waitMessage' },
      {
        op: 'friday',
        tool: 'friday_communicate',
        args: {
          to: 'cx-1',
          mode: 'response',
          response_to: '$lastMessageId',
          content: 'Yes, integer minor units with an ISO currency.',
          facts: [{ fact: 'prices are integer minor units', area: 'shared' }],
        },
      },
      {
        op: 'friday',
        tool: 'friday_communicate',
        args: { to: 'cx-1', mode: 'request', subject: 'Totals', content: 'Are checkout totals in cents too?' },
      },
      { op: 'waitMessage' },
      done,
    ]);
    await codex.adapter.start();
    await claude.adapter.start();
    for (const [key, agent] of [
      ['backend', 'cx-1'],
      ['frontend', 'cl-1'],
    ] as const) {
      await td.operator.post(td.operator.projectPath(`/tasks/${ids[key]}/assign`), { agent_key: agent });
    }
    for (const id of [ids.backend, ids.frontend]) {
      await eventually(
        () => status(td, id).status,
        (s) => s === 'READY_FOR_VERIFICATION',
        `the claim of ${id}`,
      );
    }

    // The two questions and the two answers, each answer correlated with its question and
    // carrying facts, sent by the agents themselves.
    const all = (
      await td.operator.get<{ messages: MessageView[] }>(td.operator.projectPath('/messages'), {
        query: { limit: 50 },
      })
    ).messages;
    const by = (key: string, mode: string) => all.filter((m) => m.sender.agent_key === key && m.mode === mode);
    const [codexAsks] = by('cx-1', 'request');
    const [claudeAsks] = by('cl-1', 'request');
    const [claudeAnswers] = by('cl-1', 'response');
    const [codexAnswers] = by('cx-1', 'response');
    expect(claudeAnswers?.response_to).toBe(codexAsks?.message_id);
    expect(claudeAnswers?.facts.map((f) => f.fact)).toEqual(['prices are integer minor units']);
    expect(codexAnswers?.response_to).toBe(claudeAsks?.message_id);
    expect(codexAnswers?.facts.map((f) => f.fact)).toEqual(['checkout totals are integer cents']);
    // Each session read the other's message with its id, and how to answer it.
    const claudeRead = claude
      .entries()
      .find(
        (e) => typeof e.received_message === 'string' && e.received_message.includes('Are prices integer minor units?'),
      );
    expect(String(claudeRead?.received_message)).toContain(`message ${codexAsks?.message_id}`);
    expect(String(claudeRead?.received_message)).toContain('response_to');

    // The agent with no related work was not reached.
    const calls = codex.entries().filter((e) => e.toolCall);
    const toStranger = calls.find((e) => String(e.text).includes('fh-1') || String(e.text).includes('COS-3000'));
    expect(toStranger).toMatchObject({ success: false });
    expect(String(toStranger?.text)).toMatch(/COS-3000/);
    expect(all.some((m) => m.deliveries.some((d) => d.agent_key === 'fh-1'))).toBe(false);
    // Context and permission went through the same tools.
    const context = calls.find((e) => e.toolCall === 'friday_request_context');
    expect(context).toMatchObject({ success: true });
    expect(String(context?.text)).toContain(ids.backend);
    const permission = calls.find((e) => e.toolCall === 'friday_request_permission');
    expect(permission).toMatchObject({ success: true });
    expect(String(permission?.text)).toMatch(/apr_|Not allowed/);
    await stranger.close();
  });
});
