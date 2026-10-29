/**
 * Claude Code in spawn mode against the real, installed Claude Code (ADR-0032 §11): what only a
 * real host can show. It runs only when the owner allows it, never in CI.
 *
 *   FRIDAY_CLAUDE_LIVE=dry  the real Claude Code started with every flag Friday passes, its first
 *                           message refused before it is written: no model call. It shows the flags
 *                           are accepted, and what starting it records in the owner's configuration.
 *   FRIDAY_CLAUDE_LIVE=1    at most FRIDAY_CLAUDE_LIVE_TURNS turns (three by default) on the owner's
 *                           Claude login, on the cheapest model at its default effort, each attempt capped
 *                           by --max-budget-usd, in a throwaway copy of fixture-shop.
 *
 * FRIDAY_CLAUDE_LIVE_OUT names a folder outside the repository for the results and the transcript;
 * nothing goes into the repository until a human has read it. A guard on the adapter's stream-json
 * trace refuses, before it is written, a message that would start a turn past the budget; a message
 * relayed into a running turn starts none.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bundledHookPath,
  ClaudeSpawnAdapter,
  claudeCodeHooks,
  claudeEnvironment,
  detectClaudeCode,
} from '@friday/adapter-claude';
import { materializeFixtureShop } from '@friday/cli';
import { createDaemon, type Daemon } from '@friday/daemon';
import type { TaskStartParams, TaskView, VerificationView } from '@friday/protocol';
import { DaemonClient } from '@friday/sdk';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli } from '../helpers/cli.js';

const MODE = process.env.FRIDAY_CLAUDE_LIVE;
const OUT = process.env.FRIDAY_CLAUDE_LIVE_OUT;
const MODEL = 'claude-haiku-5-5';
/** Haiku keeps its default effort: one a model does not take would cost a turn. */
const EFFORT = 'default';
const CAP_USD = 0.25;
/** Turns this run may start: the owner approves a number, and earlier runs' turns count against it. */
const BUDGET = Number(process.env.FRIDAY_CLAUDE_LIVE_TURNS ?? 3);

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

/** About twenty seconds of work that writes its progress, run as a test so Friday's policy allows it. */
const SLOW_CHECK = [
  '// A slow check for the live Claude test: about 20 seconds of work, its progress in backend/slow.progress.',
  "import { appendFileSync } from 'node:fs';",
  "import { test } from 'node:test';",
  '',
  "test('the slow report', async () => {",
  "  const progress = new URL('../slow.progress', import.meta.url);",
  '  for (let n = 1; n <= 40; n += 1) {',
  "    appendFileSync(progress, '.');",
  '    await new Promise((r) => setTimeout(r, 500));',
  '  }',
  "  console.log('report: 42 items checked');",
  '});',
  '',
].join('\n');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const size = (f: string) => (existsSync(f) ? statSync(f).size : 0);
const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').replace(/\r\n/g, '\n') : null);

async function eventually<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, what: string, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${String(JSON.stringify(v)).slice(0, 400)}`);
    await sleep(200);
  }
}

type Msg = Record<string, unknown> & { type?: string; subtype?: string; message?: { content?: unknown } };

/** Every stream-json line, and the budget: a message that would start a turn past it is refused before it is written. */
class Guard {
  turns = 0;
  refused: string[] = [];
  readonly lines: { t: number; dir: 'send' | 'receive'; msg: Msg }[] = [];
  constructor(private readonly budget: number) {}

  trace = (dir: 'send' | 'receive', line: string): void => {
    let msg: Msg;
    try {
      msg = JSON.parse(line) as Msg;
    } catch {
      return;
    }
    if (dir === 'send' && msg.type === 'user') {
      const text = typeof msg.message?.content === 'string' ? msg.message.content : '';
      // A message relayed into a running turn starts none; the task and a resume each start one.
      if (!text.startsWith('[A message from')) {
        if (this.turns >= this.budget) {
          this.refused.push(text.slice(0, 80));
          throw new Error(`the live check refused this turn: the budget of ${this.budget} turns is spent`);
        }
        this.turns += 1;
      }
    }
    this.lines.push({ t: Date.now(), dir, msg });
  };

  received = (type: string, subtype?: string) =>
    this.lines
      .filter((l) => l.dir === 'receive' && l.msg.type === type && (!subtype || l.msg.subtype === subtype))
      .map((l) => l.msg);
}

/** What the owner's Claude configuration records: its folders, and its session folders (names only). */
function claudeState(): { projects: string[]; sessions: string[] } {
  const home = os.homedir();
  let projects: string[] = [];
  try {
    const json = JSON.parse(readFileSync(path.join(home, '.claude.json'), 'utf8')) as { projects?: object };
    projects = Object.keys(json.projects ?? {});
  } catch {
    projects = [];
  }
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'), 'projects');
  return { projects, sessions: existsSync(dir) ? readdirSync(dir) : [] };
}

/** Machine paths and account data out of what is saved, keys included. */
function sanitize(v: unknown, swaps: [string, string][]): unknown {
  const clean = (s: string) => {
    let t = s;
    for (const [from, to] of swaps) t = t.split(from).join(to).split(from.toLowerCase()).join(to);
    // Anthropic's request and message ids point at the owner's requests.
    return t.replace(/\breq_[A-Za-z0-9]{8,}/g, 'req_<id>').replace(/\bmsg_[A-Za-z0-9]{8,}/g, 'msg_<id>');
  };
  if (typeof v === 'string') return clean(v);
  if (Array.isArray(v)) return v.map((x) => sanitize(x, swaps));
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([k]) => !/email|account|organization|apiKeySource|rate_limit/i.test(k))
        .map(([k, x]) => [clean(k), sanitize(x, swaps)]),
    );
  }
  return v;
}

describe.skipIf(!MODE)('Claude Code in spawn mode against the installed Claude Code', () => {
  if (!(BUDGET >= 0 && BUDGET <= 3)) throw new Error('FRIDAY_CLAUDE_LIVE_TURNS must be between 0 and 3');

  async function setup(guard: Guard) {
    if (!OUT) throw new Error('set FRIDAY_CLAUDE_LIVE_OUT to a folder outside the repository');
    mkdirSync(OUT, { recursive: true });
    const install = detectClaudeCode();
    if (!install) throw new Error('Claude Code was not found');
    const { root } = materializeFixtureShop(path.join(ws().root, 'shop'));
    appendFileSync(
      path.join(root, '.friday', 'config.yaml'),
      [
        '',
        'leases:',
        '  heartbeat_interval_ms: 1000',
        '  lease_ttl_ms: 3000',
        '  reconnect_window_ms: 120000',
        // A failed attempt is not tried again on its own: every turn is one this test started.
        'recovery:',
        '  max_retries: 0',
        '  max_same_error_retries: 0',
        'routing:',
        '  mode: manual',
        `  default_model: ${MODEL}`,
        'master_brain:',
        '  provider: none',
        '',
      ].join('\n'),
    );
    mkdirSync(path.join(root, 'backend', 'checks'), { recursive: true });
    writeFileSync(path.join(root, 'backend', 'checks', 'slow-report.check.mjs'), SLOW_CHECK);
    appendFileSync(path.join(root, '.gitignore'), '*.progress\n');
    await deterministicGit(root, { startEpoch: 1_767_300_000 }).commitAll('a slow check for the live test');
    const daemon: Daemon = await createDaemon({
      projectRoot: root,
      stateDir: ws().stateDir,
      tickMs: 500,
      pollIntervalMs: 50,
      logToFile: true,
      extensions: [claudeCodeHooks()],
      brain: { autoStart: false },
    });
    ws().track({ close: () => daemon.close('test cleanup') });
    const base = { baseUrl: daemon.url, projectId: daemon.project.project_id };
    const op = new DaemonClient({ ...base, token: daemon.tokens.operator, tokenClass: 'operator' });
    const bootstrap = new DaemonClient({ ...base, token: daemon.tokens.bootstrap, tokenClass: 'bootstrap' });
    const logs: string[] = [];
    const adapter = () => {
      const a = new ClaudeSpawnAdapter({
        bootstrap,
        projectId: daemon.project.project_id,
        agentKey: 'cl-1',
        role: 'backend',
        harnessKey: `claude-code:${daemon.project.project_id}:spawn:cl-1`,
        host: { command: install.binary, ...(install.version ? { version: install.version } : {}) },
        hostEnv: { ...claudeEnvironment(), FRIDAY_STATE_DIR: ws().stateDir },
        hook: { command: process.execPath, args: [bundledHookPath()] },
        maxBudgetUsd: CAP_USD,
        workDir: path.join(ws().root, 'attempts'),
        log: (m) => logs.push(`${new Date().toISOString()} ${m}`),
        trace: guard.trace,
      });
      ws().track({ close: () => a.close() });
      return a;
    };
    const pid = daemon.project.project_id;
    const task = (id: string) => daemon.state.q.task(pid, id);
    const assign = async (summary: string, description: string, criteria: string[]) => {
      const t = await op.post<TaskView>(op.projectPath('/tasks'), {
        summary,
        description,
        acceptance_criteria: criteria,
        kind: 'implementation',
        scope: { write: ['backend/**'], read: ['backend/**', 'shared/**'] },
        ready: true,
      });
      await op.post(op.projectPath(`/tasks/${t.task_id}/assign`), { agent_key: 'cl-1' });
      return t.task_id;
    };
    const rootOf = (id: string) =>
      eventually(
        () => daemon.state.q.findRun(task(id).current_run_id ?? '')?.execution_root ?? null,
        (r): r is string => typeof r === 'string' && r !== root,
        `the worktree of ${id}`,
      ) as Promise<string>;
    const eventData = (id: string, type: string) =>
      daemon.state.store
        .readByRef(pid, 'task', id)
        .filter((e) => e.type === 'agent.event' && (e.payload as { event_type: string }).event_type === type)
        .map(
          (e) =>
            (e.payload as { data?: unknown; message?: unknown }).data ?? (e.payload as { message?: unknown }).message,
        );
    const decisions = (id: string) =>
      daemon.state.store
        .readByRef(pid, 'task', id)
        .filter((e) => e.type === 'policy.evaluated')
        .map((e) => {
          const p = e.payload as { tool: string; decision: string; rule: string; targets?: string[] };
          return { tool: p.tool, decision: p.decision, rule: p.rule, targets: p.targets ?? [] };
        });
    // The user name also appears outside paths (owner columns of `ls -l`, folder names Claude Code
    // derives from paths), so it goes last; a name too short to tell from other text is left.
    const user = path.basename(os.homedir());
    const swaps: [string, string][] = [
      [ws().root, '<workspace>'],
      [os.homedir(), '<home>'],
      ...(user.length >= 3 ? [[user, '<user>'] as [string, string]] : []),
    ];
    const save = (name: string, results: unknown) => {
      writeFileSync(path.join(OUT, `${name}-results.json`), `${JSON.stringify(sanitize(results, swaps), null, 2)}\n`);
      writeFileSync(
        path.join(OUT, `${name}-transcript.jsonl`),
        `${guard.lines
          // Rate-limit messages describe the owner's plan and its usage, not the session.
          .filter((l) => l.msg.type !== 'rate_limit_event')
          .map((l) => JSON.stringify(sanitize(l, swaps)))
          .join('\n')}\n`,
      );
      writeFileSync(path.join(OUT, `${name}-adapter.log`), `${logs.join('\n')}\n`);
    };
    const verify = (id: string) =>
      op.post<{ task: TaskView; verification: VerificationView }>(
        op.projectPath(`/tasks/${id}/verify`),
        {},
        {
          timeoutMs: 180_000,
        },
      );
    const settle = (id: string, what: string) =>
      eventually(
        () => task(id).status,
        (x) => ['READY_FOR_VERIFICATION', 'WAITING', 'CANCELLED'].includes(x),
        what,
        8 * 60_000,
      );
    return { install, root, daemon, op, adapter, task, assign, rootOf, eventData, decisions, save, verify, settle };
  }

  it.runIf(MODE === 'dry')(
    'starts the real Claude Code with every flag Friday passes, and sends it nothing',
    async () => {
      const guard = new Guard(0);
      const before = claudeState();
      const s = await setup(guard);
      const cl = s.adapter();
      await cl.start();
      const id = await s.assign('Dry run', 'No message is ever sent for this task.', []);
      let error: unknown = null;
      try {
        // The first message is refused before it is written: the attempt ends as an agent error.
        await eventually(
          () => s.task(id).status,
          (x) => x === 'WAITING',
          'the refused turn',
          120_000,
        );
      } finally {
        error = s.eventData(id, 'error')[0] ?? null;
        const after = claudeState();
        s.save('dry', {
          mode: 'dry',
          claude: s.install.version,
          task_status: s.task(id).status,
          error,
          refused: guard.refused,
          received: guard.lines.filter((l) => l.dir === 'receive').map((l) => `${l.msg.type}/${l.msg.subtype ?? ''}`),
          claude_projects_added: after.projects.filter((k) => !before.projects.includes(k)),
          claude_session_folders_added: after.sessions.filter((k) => !before.sessions.includes(k)),
        });
      }
      expect(guard.turns).toBe(0);
      expect(guard.refused).toHaveLength(1);
      // Refused by the guard, not stopped by Claude Code over a flag it does not know.
      expect(String(error)).toMatch(/the live check refused this turn/);
    },
    5 * 60_000,
  );

  it.runIf(MODE === '1')(
    'works a task with a message mid-turn, then resumes its session after a crash, in at most three turns',
    async () => {
      const guard = new Guard(BUDGET);
      const before = claudeState();
      const s = await setup(guard);
      const results: Record<string, unknown> = {
        mode: 'live',
        claude: s.install.version,
        model: MODEL,
        effort: EFFORT,
      };
      const results1: Record<string, unknown> = {};
      const results2: Record<string, unknown> = {};
      let cl = s.adapter();
      try {
        await cl.start();

        // Turn 1: a change in scope with its test run, then a report file; a message arrives meanwhile.
        const a = await s.assign(
          'Discount helper and report',
          [
            'Add a function applyDiscount(amount, percent) to backend/src/discount.ts that returns the amount',
            '(integer minor units) after taking off the given percent, rounded to the nearest unit, and a',
            'node:test test for it in backend/test/discount.test.ts. Run it with `node --test backend/test/discount.test.ts`.',
            'Then write the line "done" into backend/report.md.',
          ].join(' '),
          ['node --test backend/test/discount.test.ts passes', 'backend/report.md exists'],
        );
        const aRoot = await s.rootOf(a);
        // The message goes in once the session is working (its first tool call was judged).
        await eventually(
          () => s.decisions(a).length,
          (n) => n > 0,
          'the first tool call',
          5 * 60_000,
        ).catch(() => 0);
        const sent = await s.op.post<{ message_id: string }>(s.op.projectPath('/messages'), {
          to: 'cl-1',
          mode: 'notification',
          subject: 'one more line',
          content: 'Please also put the line `checked-by: friday-message` on the second line of backend/report.md.',
        });
        const aEnd = await s.settle(a, 'turn 1');
        const delivery = (
          await s.op.get<{ deliveries: { state: string }[] }>(s.op.projectPath(`/messages/${sent.message_id}`))
        ).deliveries.map((d) => d.state);
        Object.assign(results1, {
          task_status: aEnd,
          waiting_reason: s.task(a).waiting_reason,
          decisions: s.decisions(a),
          settings: s.eventData(a, 'host.settings'),
          usage: s.eventData(a, 'host.usage'),
          message_delivery: delivery,
          report: read(path.join(aRoot, 'backend', 'report.md')),
          discount_ts: read(path.join(aRoot, 'backend', 'src', 'discount.ts')) !== null,
          result: guard.received('result').at(-1) ?? null,
          claim: s.daemon.state.q.findRun(s.task(a).current_run_id ?? '')?.claim ?? null,
        });
        if (aEnd === 'READY_FOR_VERIFICATION') {
          const v = await s.verify(a);
          results1.verification = {
            status: v.task.status,
            checks: v.verification.checks.map((c) => ({ name: c.name, status: c.status, summary: c.summary })),
          };
        }
        // A first turn that did not end with a claim says what to fix; the rest of the budget is kept.
        if (aEnd !== 'READY_FOR_VERIFICATION') {
          results2.stopped = 'turn 1 did not end with a claim; the remaining turns were not spent';
          return;
        }
        if (BUDGET < 3) return;

        // Turns 2 and 3: the harness dies during the slow check; its work stops; the same session resumes.
        const c = await s.assign(
          'Slow report',
          [
            'Run the slow report check with `node --test backend/checks/slow-report.check.mjs` (it takes about 20 seconds).',
            'Then write the line of its output that starts with "report:" into backend/report-2.md.',
          ].join(' '),
          ['backend/report-2.md holds the report line'],
        );
        const cRoot = await s.rootOf(c);
        const progress = path.join(cRoot, 'backend', 'slow.progress');
        const running = await eventually(
          () => size(progress) || (['READY_FOR_VERIFICATION', 'WAITING'].includes(s.task(c).status) ? -1 : 0),
          (n) => n >= 6 || n < 0,
          'the slow check to run',
          5 * 60_000,
        );
        if (running < 0) {
          Object.assign(results2, { stopped: 'the turn ended before the slow check ran', decisions: s.decisions(c) });
          return;
        }
        const run1 = s.task(c).current_run_id as string;
        const session1 = s.daemon.state.q.findRun(run1)?.session_ref ?? null;
        await cl.crash();
        const atCrash = size(progress);
        await sleep(2000);
        const after2s = size(progress);
        await sleep(3000);
        const after5s = size(progress);
        await eventually(
          () => s.task(c).status,
          (x) => x === 'HARNESS_LOST',
          'the lost lease',
        );
        const assessed = await cli(['--project', s.root, 'recover', c]);
        cl = s.adapter();
        await cl.start();
        const resume = await eventually(
          () => cl.received.find((m) => m.method === 'task.resume'),
          (m) => Boolean(m),
          'task.resume',
        );
        const cEnd = await s.settle(c, 'turn 3');
        Object.assign(results2, {
          progress: { atCrash, after2s, after5s },
          work_stopped: after5s === after2s,
          recommended_reconnect: /reconnect/.test(assessed.stdout),
          same_run: (resume?.params as TaskStartParams | undefined)?.run_id === run1,
          session_before: session1,
          session_resumed: (resume?.params as TaskStartParams | undefined)?.session_ref ?? null,
          task_status: cEnd,
          decisions: s.decisions(c),
          report: read(path.join(cRoot, 'backend', 'report-2.md')),
          result: guard.received('result').at(-1) ?? null,
        });
        if (cEnd === 'READY_FOR_VERIFICATION') results2.verification = { status: (await s.verify(c)).task.status };
      } finally {
        await cl.close().catch(() => undefined);
        const after = claudeState();
        Object.assign(results, {
          turn1: results1,
          turns2_3: results2,
          turns_started: guard.turns,
          refused: guard.refused,
          inits: guard
            .received('system', 'init')
            .map((m) => ({ model: m.model, tools: m.tools, mcp_servers: m.mcp_servers })),
          claude_projects_added: after.projects.filter((k) => !before.projects.includes(k)),
          claude_session_folders_added: after.sessions.filter((k) => !before.sessions.includes(k)),
        });
        s.save('live', results);
      }
      expect(guard.turns).toBeLessThanOrEqual(BUDGET);
    },
    25 * 60_000,
  );
});
