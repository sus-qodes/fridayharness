/**
 * Friday's Codex adapter against the real `codex app-server` (ADR-0032, docs/integration/codex.md):
 * what only a real host can show. It runs only when the owner allows it, never in CI.
 *
 *   FRIDAY_CODEX_LIVE=dry  the real host up to the first turn, which is never sent (no model call):
 *                          the thread's settings as Codex applied them, the tools kept out of it, and
 *                          the owner's Codex configuration left as it was.
 *   FRIDAY_CODEX_LIVE=1    at most six turns on the owner's Codex login (approved 2026-10-15): the
 *                          cheapest model at low effort on the standard tier, Codex's sandbox with its
 *                          network off, in a throwaway copy of fixture-shop. No Friday project is touched.
 *
 * FRIDAY_CODEX_LIVE_OUT names a folder outside the repository for the results and the transcript;
 * nothing goes into the repository until a human has read it.
 *
 * A guard sits on the adapter's protocol trace: a turn past the budget, or on another model,
 * effort or tier, is refused before it is sent, and so is a thread on another tier.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexAdapter, findCodex, hostEnvironment } from '@friday/adapter-codex';
import { materializeFixtureShop } from '@friday/cli';
import { createDaemon, type Daemon } from '@friday/daemon';
import type { TaskStartParams, TaskView, VerificationView } from '@friday/protocol';
import { DaemonClient } from '@friday/sdk';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli } from '../helpers/cli.js';

const MODE = process.env.FRIDAY_CODEX_LIVE;
const OUT = process.env.FRIDAY_CODEX_LIVE_OUT;
const MODEL = 'gpt-5.6-luna';
const EFFORT = 'low';
const TIER = 'default';
/** Turns this run may send: the owner approved six in all, and earlier runs' turns count against them. */
const BUDGET = Number(process.env.FRIDAY_CODEX_LIVE_TURNS ?? 6);
/** `resume` (two turns: a message mid-turn, a crash, the same thread resumed) or `steer` (one turn). */
const PLAN = process.env.FRIDAY_CODEX_LIVE_PLAN === 'steer' ? 'steer' : 'resume';
/** Where the elevated Windows sandbox cannot start commands (the doctor says so): `unelevated`. */
const WINDOWS_SANDBOX = process.env.FRIDAY_CODEX_LIVE_WINDOWS_SANDBOX as 'elevated' | 'unelevated' | undefined;

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
  '// A slow check for the live Codex test: about 20 seconds of work, its progress in backend/slow.progress.',
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

type Msg = { id?: unknown; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> };

/**
 * Every protocol line of every attempt, and the budget: a turn past it, or on another model, effort
 * or tier, is refused before it is sent (the adapter calls the trace before writing).
 */
class Guard {
  turns = 0;
  refused: { method: string; why: string; params: Record<string, unknown> }[] = [];
  readonly lines: { t: number; dir: 'send' | 'receive'; msg: Msg }[] = [];
  constructor(private readonly budget: number) {}

  trace = (dir: 'send' | 'receive', line: string): void => {
    let msg: Msg | null = null;
    try {
      msg = JSON.parse(line) as Msg;
    } catch {
      return;
    }
    if (dir === 'send' && msg.method === 'turn/start') {
      const p = msg.params ?? {};
      const why =
        this.turns >= this.budget
          ? `the budget of ${this.budget} turns is spent`
          : p.model !== MODEL || p.effort !== EFFORT
            ? `a turn on ${String(p.model)} at ${String(p.effort)} effort`
            : null;
      if (why) {
        this.refused.push({ method: msg.method, why, params: { model: p.model, effort: p.effort } });
        throw new Error(`the live check refused this turn: ${why}`);
      }
      this.turns += 1;
    }
    if (dir === 'send' && (msg.method === 'thread/start' || msg.method === 'thread/resume')) {
      if (msg.params?.serviceTier !== TIER) {
        this.refused.push({ method: msg.method, why: 'not the standard tier', params: {} });
        throw new Error('the live check refused a thread that is not on the standard tier');
      }
    }
    // Streaming deltas are repeated by the completed items; account notifications stay out.
    if (/\/delta$|Delta$|^account\/|^remoteControl\//.test(msg.method ?? '')) return;
    this.lines.push({ t: Date.now(), dir, msg });
  };

  sent = (method: string) => this.lines.filter((l) => l.dir === 'send' && l.msg.method === method).map((l) => l.msg);
  notes = (method: string) =>
    this.lines.filter((l) => l.dir === 'receive' && l.msg.method === method).map((l) => l.msg.params ?? {});
  /** The answer to a request this client sent. */
  answer = (req: Msg) => this.lines.find((l) => l.dir === 'receive' && l.msg.id === req.id && !l.msg.method)?.msg;
}

/** The owner's Codex configuration: a hash and its section names, never its values. */
function codexConfig(): { sha: string; sections: string[] } {
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const s = read(path.join(home, 'config.toml')) ?? '';
  return {
    sha: createHash('sha256').update(s).digest('hex').slice(0, 16),
    sections: s.split('\n').filter((l) => l.startsWith('[')),
  };
}

/** Machine paths and account data out of a transcript. */
function sanitize(v: unknown, swaps: [string, string][]): unknown {
  if (typeof v === 'string') {
    let s = v;
    for (const [from, to] of swaps) s = s.split(from).join(to).split(from.toLowerCase()).join(to);
    return s;
  }
  if (Array.isArray(v)) return v.map((x) => sanitize(x, swaps));
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([k]) => !/email|account|planType|userId/i.test(k))
        .map(([k, x]) => [k, sanitize(x, swaps)]),
    );
  }
  return v;
}

describe.skipIf(!MODE)('the Codex adapter against the real Codex app-server', () => {
  if (!(BUDGET >= 0 && BUDGET <= 6)) throw new Error('FRIDAY_CODEX_LIVE_TURNS must be between 0 and 6');
  async function setup(guard: Guard) {
    if (!OUT) throw new Error('set FRIDAY_CODEX_LIVE_OUT to a folder outside the repository');
    mkdirSync(OUT, { recursive: true });
    const install = findCodex();
    if (!install.binary) throw new Error(install.problem ?? 'Codex was not found');
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
      brain: { autoStart: false },
    });
    ws().track({ close: () => daemon.close('test cleanup') });
    const base = { baseUrl: daemon.url, projectId: daemon.project.project_id };
    const op = new DaemonClient({ ...base, token: daemon.tokens.operator, tokenClass: 'operator' });
    const bootstrap = new DaemonClient({ ...base, token: daemon.tokens.bootstrap, tokenClass: 'bootstrap' });
    const logs: string[] = [];
    const adapter = () => {
      const a = new CodexAdapter({
        bootstrap,
        projectId: daemon.project.project_id,
        agentKey: 'cx-1',
        role: 'backend',
        harnessKey: `codex:${daemon.project.project_id}:cx-1`,
        host: {
          command: install.binary as string,
          args: ['app-server'],
          ...(install.version ? { version: install.version } : {}),
        },
        hostEnv: hostEnvironment(),
        sandbox: 'workspace-write',
        effort: EFFORT,
        serviceTier: TIER,
        ...(WINDOWS_SANDBOX ? { windowsSandbox: WINDOWS_SANDBOX } : {}),
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
      await op.post(op.projectPath(`/tasks/${t.task_id}/assign`), { agent_key: 'cx-1' });
      return t.task_id;
    };
    const rootOf = (id: string) =>
      eventually(
        () => daemon.state.q.findRun(task(id).current_run_id ?? '')?.execution_root ?? null,
        (r): r is string => typeof r === 'string' && r !== root,
        `the worktree of ${id}`,
      ) as Promise<string>;
    const events = (id: string, type?: string) =>
      daemon.state.store
        .readByRef(pid, 'task', id)
        .filter((e) =>
          type ? e.type === 'agent.event' && (e.payload as { event_type: string }).event_type === type : true,
        );
    const swaps: [string, string][] = [
      [ws().root, '<workspace>'],
      [os.homedir(), '<home>'],
    ];
    const save = (name: string, results: unknown) => {
      writeFileSync(path.join(OUT, `${name}-results.json`), `${JSON.stringify(sanitize(results, swaps), null, 2)}\n`);
      writeFileSync(
        path.join(OUT, `${name}-transcript.jsonl`),
        `${guard.lines.map((l) => JSON.stringify(sanitize(l, swaps))).join('\n')}\n`,
      );
      writeFileSync(path.join(OUT, `${name}-adapter.log`), `${logs.join('\n')}\n`);
    };
    return { install, root, daemon, op, adapter, task, assign, rootOf, events, save, logs };
  }

  it.runIf(MODE === 'dry')(
    'opens a thread with Friday’s settings, keeps out what Friday cannot judge, and sends no turn',
    async () => {
      const guard = new Guard(0);
      const before = codexConfig();
      const s = await setup(guard);
      const cx = s.adapter();
      await cx.start();
      const id = await s.assign('Dry run', 'No turn is ever sent for this task.', []);
      const collect = () => {
        const started = guard.sent('thread/start')[0];
        const opened = started ? guard.answer(started) : undefined;
        const after = codexConfig();
        return {
          mode: 'dry',
          codex: s.install.version,
          task_status: s.task(id).status,
          waiting_reason: s.task(id).waiting_reason,
          turns_sent: guard.turns,
          refused: guard.refused,
          requests: guard.lines.filter((l) => l.dir === 'send' && l.msg.method).map((l) => l.msg.method),
          thread_start: started?.params ? { ...started.params, developerInstructions: '<packet>' } : null,
          thread_answer: opened?.result
            ? {
                model: opened.result.model,
                serviceTier: opened.result.serviceTier,
                reasoningEffort: opened.result.reasoningEffort,
                approvalPolicy: opened.result.approvalPolicy,
                approvalsReviewer: opened.result.approvalsReviewer,
                sandbox: opened.result.sandbox,
                instructionSources: opened.result.instructionSources,
                multiAgentMode: (opened.result as { multiAgentMode?: unknown }).multiAgentMode,
              }
            : (opened ?? null),
          host_settings:
            (s.events(id, 'host.settings')[0]?.payload as { data?: Record<string, unknown> } | undefined)?.data ?? null,
          mcp_servers_started: guard.notes('mcpServer/startupStatus/updated'),
          events: s.events(id).map((e) => e.type),
          codex_config_changed: before.sha !== after.sha,
          codex_config_sections_added: after.sections.filter((x) => !before.sections.includes(x)),
        };
      };
      try {
        // The adapter's first turn is refused before it is sent: the attempt ends as an agent error.
        await eventually(
          () => s.task(id).status,
          (x) => x === 'WAITING',
          'the refused turn',
          150_000,
        );
      } finally {
        s.save('dry', collect());
      }
      const results = collect();
      const settings = { data: results.host_settings };
      const startup = results.mcp_servers_started;
      expect(guard.turns).toBe(0);
      expect(guard.refused.map((r) => r.params)).toEqual([{ model: MODEL, effort: EFFORT }]);
      expect(settings?.data).toMatchObject({
        sandbox: 'workspaceWrite',
        network_access: false,
        approval_policy: 'untrusted',
        approvals_reviewer: 'user',
        repository_config: 'untrusted',
      });
      expect(startup).toEqual([]);
      expect(results.codex_config_sections_added).toEqual([]);
    },
    5 * 60_000,
  );

  it.runIf(MODE === '1')(
    'works a task end to end, takes a message mid-turn, and resumes its thread after a crash, in at most six turns',
    async () => {
      const guard = new Guard(BUDGET);
      const before = codexConfig();
      const s = await setup(guard);
      const results: Record<string, unknown> = { mode: 'live', codex: s.install.version, model: MODEL, effort: EFFORT };
      const turnEnds = () =>
        guard.notes('turn/completed').map((p) => (p.turn as { id?: string; status?: string; error?: unknown }) ?? {});
      const usage = () => guard.notes('thread/tokenUsage/updated').map((p) => p.tokenUsage);
      const finals = () =>
        guard
          .notes('item/completed')
          .map((p) => p.item as { type?: string; text?: string })
          .filter((i) => i?.type === 'agentMessage')
          .map((i) => i.text ?? '');
      const verify = (id: string) =>
        s.op.post<{ task: TaskView; verification: VerificationView }>(
          s.op.projectPath(`/tasks/${id}/verify`),
          {},
          { timeoutMs: 180_000 },
        );
      const settle = (id: string, what: string) =>
        eventually(
          () => s.task(id).status,
          (x) => ['READY_FOR_VERIFICATION', 'WAITING', 'CANCELLED'].includes(x),
          what,
          8 * 60_000,
        );
      let cx = s.adapter();
      try {
        await cx.start();
        // Turn 1: a slow check, then a file with its result. A message arrives while the check runs
        // and is steered into the turn; then the harness dies, and its work must stop with it.
        const c = await s.assign(
          'Slow report',
          [
            // In one process: Codex's unelevated Windows sandbox lets no command start another (live turn 5).
            'Run the slow report check with `node --test --test-isolation=none backend/checks/slow-report.check.mjs` (it takes about 20 seconds).',
            'Then write the line of its output that starts with "report:" into backend/report.md.',
          ].join(' '),
          ['backend/report.md holds the report line'],
        );
        const cRoot = await s.rootOf(c);
        const progress = path.join(cRoot, 'backend', 'slow.progress');
        const ended = () => ['READY_FOR_VERIFICATION', 'WAITING', 'CANCELLED'].includes(s.task(c).status);
        const running = await eventually(
          () => size(progress) || (ended() ? -1 : 0),
          (n) => n >= 3 || n < 0,
          'the slow check to run',
          8 * 60_000,
        );
        const commands = () =>
          guard
            .notes('item/completed')
            .map((p) => p.item as { type?: string; command?: string; exitCode?: number; status?: string })
            .filter((i) => i?.type === 'commandExecution')
            .map((i) => ({ command: i.command, status: i.status, exitCode: i.exitCode }));
        const approvals = () =>
          guard.lines
            .filter((l) => l.dir === 'receive' && /requestApproval$/.test(l.msg.method ?? ''))
            .map((l) => ({ method: l.msg.method, command: l.msg.params?.command ?? null }));
        const answers = () =>
          guard.lines
            .filter((l) => l.dir === 'send' && l.msg.result && 'decision' in (l.msg.result as object))
            .map((l) => (l.msg.result as { decision: string }).decision);
        if (running < 0) {
          results.turn1 = {
            task_status: s.task(c).status,
            approvals: approvals(),
            answers: answers(),
            commands: commands(),
            final_message: finals().at(-1) ?? null,
          };
          results.stopped = 'the turn ended before the slow check ran; the remaining turn was not spent';
          return;
        }
        const sent = await s.op.post<{ message_id: string }>(s.op.projectPath('/messages'), {
          to: 'cx-1',
          mode: 'notification',
          subject: 'one more line',
          content: 'Please also put the line `checked-by: friday-steer` on the second line of backend/report.md.',
        });
        const delivery = () =>
          s.op
            .get<{ deliveries: { state: string }[] }>(s.op.projectPath(`/messages/${sent.message_id}`))
            .then((m) => m.deliveries.map((d) => d.state));
        const acked = await eventually(
          delivery,
          (d) => d.includes('acknowledged') || ended(),
          'the steer',
          60_000,
        ).catch(() => null);
        const steers = guard.sent('turn/steer');
        const run1 = s.task(c).current_run_id as string;
        const thread1 = guard.sent('thread/start').at(-1);
        const threadId = (guard.answer(thread1 as Msg)?.result?.thread as { id?: string } | undefined)?.id;
        const turn1Running = !ended();
        if (PLAN === 'steer') {
          // One turn: the message reaches the running turn, and the turn ends with a claim.
          const end = await settle(c, 'turn 1');
          results.turn1 = {
            task_status: end,
            waiting_reason: s.task(c).waiting_reason,
            approvals: approvals(),
            answers: answers(),
            commands: commands(),
            file_changes: guard
              .notes('item/completed')
              .map((p) => p.item as { type?: string; status?: string; changes?: { path?: string }[] })
              .filter((i) => i?.type === 'fileChange')
              .map((i) => ({ status: i.status, paths: (i.changes ?? []).map((x) => x.path) })),
            unmediated: s.events(c, 'host.unmediated_write').map((e) => (e.payload as { data: unknown }).data),
            settings: s.events(c, 'host.settings').map((e) => (e.payload as { data: unknown }).data),
            steered: steers.length,
            steer_answer: steers[0] ? (guard.answer(steers[0])?.result ?? guard.answer(steers[0])) : null,
            delivery: acked,
            still_running_when_steered: turn1Running,
            report: read(path.join(cRoot, 'backend', 'report.md')),
            final_message: finals().at(-1) ?? null,
            claim: s.daemon.state.q.findRun(s.task(c).current_run_id ?? '')?.claim ?? null,
          };
          if (end === 'READY_FOR_VERIFICATION') {
            const v = await verify(c);
            results.turn1_verification = {
              status: v.task.status,
              checks: v.verification.checks.map((x) => ({ name: x.name, status: x.status, summary: x.summary })),
            };
          }
          return;
        }
        await cx.crash();
        const atCrash = size(progress);
        await sleep(2000);
        const after2s = size(progress);
        await sleep(3000);
        const after5s = size(progress);
        results.turn1 = {
          approvals: approvals(),
          answers: answers(),
          commands: commands(),
          settings: s.events(c, 'host.settings').map((e) => (e.payload as { data: unknown }).data),
          steered: steers.length,
          steer_answer: steers[0] ? (guard.answer(steers[0])?.result ?? guard.answer(steers[0])) : null,
          delivery: acked,
          still_running_at_crash: turn1Running,
          progress: { atCrash, after2s, after5s },
          work_stopped: after5s === after2s,
        };
        if (!turn1Running) {
          results.stopped = 'the turn ended before the crash; the remaining turn was not spent';
          return;
        }

        // Turn 2: Friday judges the harness lost, recovery recommends reconnecting, and the restarted
        // adapter resumes the same run in the same thread.
        await eventually(
          () => s.task(c).status,
          (x) => x === 'HARNESS_LOST',
          'the lost lease',
        );
        const assessed = await cli(['--project', s.root, 'recover', c]);
        cx = s.adapter();
        await cx.start();
        const resume = await eventually(
          () => cx.received.find((m) => m.method === 'task.resume'),
          (m) => Boolean(m),
          'task.resume',
        );
        const cEnd = await settle(c, 'turn 2');
        const resumed = guard.sent('thread/resume')[0];
        results.turn2 = {
          recommended_reconnect: /reconnect/.test(assessed.stdout),
          recover_output: assessed.stdout.slice(0, 1500),
          same_run: (resume?.params as TaskStartParams | undefined)?.run_id === run1,
          session_ref: (resume?.params as TaskStartParams | undefined)?.session_ref ?? null,
          thread_started: threadId ?? null,
          thread_resumed: (resumed?.params as { threadId?: string } | undefined)?.threadId ?? null,
          resume_answer: resumed ? (guard.answer(resumed)?.result ? 'ok' : guard.answer(resumed)) : null,
          task_status: cEnd,
          waiting_reason: s.task(c).waiting_reason,
          approvals: approvals(),
          answers: answers(),
          commands: commands(),
          file_changes: guard
            .notes('item/completed')
            .map((p) => p.item as { type?: string; status?: string; changes?: { path?: string }[] })
            .filter((i) => i?.type === 'fileChange')
            .map((i) => ({ status: i.status, paths: (i.changes ?? []).map((x) => x.path) })),
          unmediated: s.events(c, 'host.unmediated_write').map((e) => (e.payload as { data: unknown }).data),
          report: read(path.join(cRoot, 'backend', 'report.md')),
          final_message: finals().at(-1) ?? null,
          claim: s.daemon.state.q.findRun(s.task(c).current_run_id ?? '')?.claim ?? null,
        };
        if (cEnd === 'READY_FOR_VERIFICATION') {
          const v = await verify(c);
          results.turn2_verification = {
            status: v.task.status,
            checks: v.verification.checks.map((x) => ({ name: x.name, status: x.status, summary: x.summary })),
          };
        }
      } finally {
        await cx.close().catch(() => undefined);
        const after = codexConfig();
        results.turns_sent = guard.turns;
        results.refused = guard.refused;
        results.turn_ends = turnEnds();
        results.token_usage = usage();
        results.models = guard.lines
          .filter((l) => l.dir === 'receive' && (l.msg.result as { model?: string } | undefined)?.model)
          .map((l) => (l.msg.result as { model: string }).model);
        results.reroutes = guard.notes('model/rerouted');
        results.final_messages_are_json = finals().map((f) => {
          try {
            const v = JSON.parse(f) as Record<string, unknown>;
            return ['status', 'summary', 'changed_paths', 'blocked_reason'].every((k) => k in v);
          } catch {
            return false;
          }
        });
        results.codex_config_changed = before.sha !== after.sha;
        results.codex_config_sections_added = after.sections.filter((x) => !before.sections.includes(x));
        results.mcp_servers_started = guard.notes('mcpServer/startupStatus/updated');
        s.save('live', results);
      }
      expect(guard.turns).toBeLessThanOrEqual(BUDGET);
      expect(results.codex_config_sections_added).toEqual([]);
      expect(results.mcp_servers_started).toEqual([]);
    },
    25 * 60_000,
  );
});
