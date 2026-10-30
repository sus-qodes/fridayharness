/**
 * Cost classes, live (plan M14.2, approved by the owner 2026-10-19): two spawned Claude Code agents
 * of one role, `be-cheap` limited to claude-haiku-5-5 (a cheap model in the registry) and `be-std`
 * limited to claude-sonnet-5-5 (standard). A small, low-risk task must go to the cheap agent; its
 * claim, refused by a human with one fixed note before any check runs, must be reworked by the
 * standard agent, and that rework is verified by the project's tests.
 *
 *   FRIDAY_COST_LIVE=1          the live run, on the owner's Claude login (two attempts per run)
 *   FRIDAY_COST_LIVE_OUT        a folder outside the repository for the results and transcripts
 *   FRIDAY_COST_LIVE_TURNS      the turns the run may start (default 2)
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
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
import type { TaskView, UsageReport, VerificationView } from '@friday/protocol';
import { DaemonClient } from '@friday/sdk';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli, REPO_ROOT } from '../helpers/cli.js';
import { redactionSwaps, sanitize } from '../helpers/live-claude.js';
import { allEvents, loadBaselinePlan, outsideRepository, SessionTrace, TurnBudget } from '../helpers/token-baseline.js';

const LIVE = process.env.FRIDAY_COST_LIVE === '1';
const OUT = process.env.FRIDAY_COST_LIVE_OUT;
const TURNS = Number(process.env.FRIDAY_COST_LIVE_TURNS ?? 2);
const CHEAP = 'claude-haiku-5-5';
const STANDARD = 'claude-sonnet-5-5';
/** The human's refusal, the same in every run: one small, concrete addition. */
const NOTE =
  'redeemGiftCard must also refuse a card whose balance amount is not a whole number of minor units: throw CheckoutError for it, and add a test for that case.';

if (!LIVE) console.info('cost classes, live: skipped, FRIDAY_COST_LIVE is not set (plan M14.2)');

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!LIVE)('cost classes, live: the cheap agent takes the small task, a stronger one its rework', () => {
  it(
    'gives a small, low-risk task to the cheap agent and its refused claim to the standard agent',
    async () => {
      if (!OUT || !outsideRepository(OUT, REPO_ROOT))
        throw new Error('set FRIDAY_COST_LIVE_OUT outside the repository');
      mkdirSync(OUT, { recursive: true });
      const install = detectClaudeCode();
      if (!install) throw new Error('Claude Code was not found');
      const turns = new TurnBudget(TURNS);
      // The baseline's backend task, small and low-risk: one task, one role, two agents for it.
      const base = loadBaselinePlan();
      const backend = base.tasks.find((t) => t.key === 'giftcard-backend');
      if (!backend) throw new Error('the baseline plan has no backend task');
      const planFile = path.join(ws().root, 'cost-plan.json');
      writeFileSync(planFile, JSON.stringify({ ...base, tasks: [{ ...backend, risk_level: 'low', depends_on: [] }] }));
      const { root } = materializeFixtureShop(path.join(ws().root, 'shop'));
      // No pin and no planner: routing chooses each agent's model among those it offers.
      appendFileSync(
        path.join(root, '.friday', 'config.yaml'),
        [
          '',
          'recovery:',
          '  max_retries: 0',
          '  max_same_error_retries: 0',
          'master_brain:',
          '  provider: none',
          '',
        ].join('\n'),
      );
      await deterministicGit(root, { startEpoch: 1_767_300_000 }).commitAll('the cost-class configuration');
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
      const pid = daemon.project.project_id;
      const bootstrap = new DaemonClient({
        baseUrl: daemon.url,
        projectId: pid,
        token: daemon.tokens.bootstrap,
        tokenClass: 'bootstrap',
      });
      const traces = new Map<string, SessionTrace>();
      const agent = (key: string, model: string) => {
        const trace = new SessionTrace(key, turns);
        traces.set(key, trace);
        const a = new ClaudeSpawnAdapter({
          bootstrap,
          projectId: pid,
          agentKey: key,
          role: 'backend',
          harnessKey: `claude-code:${pid}:spawn:${key}`,
          host: { command: install.binary, ...(install.version ? { version: install.version } : {}) },
          hostEnv: { ...claudeEnvironment(), FRIDAY_STATE_DIR: ws().stateDir },
          hook: { command: process.execPath, args: [bundledHookPath()] },
          maxBudgetUsd: 0.5,
          models: [model],
          workDir: path.join(ws().root, 'attempts', key),
          trace: trace.trace,
        });
        ws().track({ close: () => a.close() });
        return a;
      };
      const cheap = agent('be-cheap', CHEAP);
      const std = agent('be-std', STANDARD);
      const friday = (...args: string[]) => cli(['--project', root, ...args]);
      const json = async <T>(...args: string[]): Promise<T> => {
        const r = await friday(...args, '--json');
        if (r.code !== 0) throw new Error(`friday ${args.join(' ')} failed (${r.code}): ${r.stderr || r.stdout}`);
        return JSON.parse(r.stdout) as T;
      };
      const task = (id: string) => daemon.state.q.task(pid, id);
      const until = async (id: string, what: string, ok: (t: TaskView) => boolean, ms = 25 * 60_000) => {
        const end = Date.now() + ms;
        for (;;) {
          await json('brain', 'run-once');
          const t = task(id);
          if (ok(t)) return t;
          if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${t.status}`);
          await sleep(2000);
        }
      };
      const results: Record<string, unknown> = {
        cheap: CHEAP,
        standard: STANDARD,
        started_at: new Date().toISOString(),
      };
      const swaps = redactionSwaps(ws().root);
      const save = () => {
        writeFileSync(path.join(OUT, 'results.json'), `${JSON.stringify(sanitize(results, swaps), null, 2)}\n`);
        for (const [k, t] of traces)
          writeFileSync(
            path.join(OUT, `transcript-${k}.jsonl`),
            `${t.lines
              .filter((l) => l.msg.type !== 'rate_limit_event')
              .map((l) => JSON.stringify(sanitize(l, swaps)))
              .join('\n')}\n`,
          );
        writeFileSync(
          path.join(OUT, 'events.jsonl'),
          `${allEvents(daemon.state.store, pid)
            .map((e) => JSON.stringify(sanitize(e, swaps)))
            .join('\n')}\n`,
        );
      };
      let taskId = '';
      try {
        const goal = await json<{ goal: { goal_id: string } }>('goal', 'create', base.objective, '--no-plan');
        await json('plan', 'propose', '--goal', goal.goal.goal_id, '--file', planFile);
        await json('plan', 'approve', '--goal', goal.goal.goal_id);
        taskId = daemon.state.q.goalTasks(pid, goal.goal.goal_id)[0]?.task_id as string;
        await cheap.start();
        await std.start();
        // The first attempt: the Master Brain's delegation, then the claim.
        await until(taskId, 'the first claim', (t) =>
          ['READY_FOR_VERIFICATION', 'WAITING', 'CANCELLED'].includes(t.status),
        );
        const first = daemon.state.q.assignments(taskId)[0];
        results.first = { agent: first?.agent_key, reason: first?.reason, status: task(taskId).status };
        // A human refuses the claim before any check, with the same note every run, and sends it back.
        await json('verify', taskId, '--result', 'failed', '--note', NOTE);
        await json('task', 'rework', taskId, '--reason', NOTE);
        results.reserved_for = task(taskId).reserved_for_agent_key;
        await until(taskId, 'the rework claim', (t) =>
          ['READY_FOR_VERIFICATION', 'WAITING', 'CANCELLED'].includes(t.status),
        );
        const runs = daemon.state.q.runs(taskId);
        const second = daemon.state.q.assignments(taskId).at(-1);
        results.second = { agent: second?.agent_key, reason: second?.reason, status: task(taskId).status };
        const verified = await json<{ task: TaskView; verification: VerificationView }>('verify', taskId);
        results.rework_verification = {
          status: verified.task.status,
          checks: verified.verification.checks.map((c) => ({ name: c.name, status: c.status, summary: c.summary })),
        };
        results.runs = runs.map((r) => ({
          attempt: r.attempt,
          agent: daemon.state.q.findAgent(r.agent_id)?.agent_key,
          model_requested: r.model_requested,
          model_observed: r.model_observed,
          session_ref: r.session_ref,
        }));
        results.usage = await json<UsageReport>('usage', '--task', taskId).catch(() => null);
      } finally {
        await cheap.close().catch(() => undefined);
        await std.close().catch(() => undefined);
        results.turns_started = turns.turns;
        results.refused_turns = turns.refused;
        results.ended_at = new Date().toISOString();
        save();
      }
      const runs = results.runs as { agent: string; model_observed: string | null }[];
      expect((results.first as { agent: string }).agent).toBe('be-cheap');
      expect(results.reserved_for).toBe('be-std');
      expect((results.second as { agent: string }).agent).toBe('be-std');
      expect(runs.map((r) => r.agent)).toEqual(['be-cheap', 'be-std']);
      expect((results.rework_verification as { status: string }).status).toBe('COMPLETED');
    },
    60 * 60_000,
  );
});
