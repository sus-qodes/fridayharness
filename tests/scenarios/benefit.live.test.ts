/**
 * The benefit comparison (docs/measurements/README.md): one goal whose two tasks both change the
 * shared contract, done three ways on the same host and model, then judged by the same hidden checks
 * (tests/fixtures/benefit/acceptance.hidden.test.mjs) that no agent sees:
 *
 *   plain-one  Claude Code alone, one session given the whole goal;
 *   plain-two  two Claude Code sessions at once in the same folder, one task each;
 *   friday     Friday: the same tasks planned, given to two spawned Claude Code agents in their own
 *              worktrees, each claim verified by the project's tests, a refused claim sent back once,
 *              verified work integrated into the goal's branch.
 *
 * It runs only when the owner allows it, never in CI:
 *
 *   FRIDAY_BENEFIT=1           the live runs, on the owner's Claude login, claude-haiku-5-5 at its
 *                              default effort, each session capped by --max-budget-usd (0.25 a task);
 *   FRIDAY_BENEFIT_OUT         a folder outside the repository for every arm's figures, transcripts
 *                              and verdict, and the summary;
 *   FRIDAY_BENEFIT_RUNS        how many times each arm runs (2);
 *   FRIDAY_BENEFIT_ARMS        which arms, comma-separated (all three);
 *   FRIDAY_BENEFIT_TURNS       the turns all runs together may start (16): a session's first message
 *                              past it is refused before it is written.
 *
 * Every arm's figures are written as soon as the arm ends, so a later failure loses nothing.
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
import {
  type ArmFigures,
  BENEFIT_AGENTS,
  BENEFIT_ARMS,
  BENEFIT_PLAN_FILE,
  type BenefitArm,
  judgeTree,
  loadBenefitPlan,
  plainArgs,
  plainOnePrompt,
  plainTwoPrompt,
  runPlainSession,
  type SessionFigures,
  sessionFigures,
  splitSessions,
  summaryTable,
  totalsOf,
} from '../helpers/benefit.js';
import { cli, REPO_ROOT } from '../helpers/cli.js';
import { claudeState, redactionSwaps, sanitize } from '../helpers/live-claude.js';
import {
  allEvents,
  BASELINE_CAP_USD,
  BASELINE_MODEL,
  baselineConfig,
  outsideRepository,
  SessionTrace,
  type TraceLine,
  TurnBudget,
} from '../helpers/token-baseline.js';

const MODE = process.env.FRIDAY_BENEFIT;
const OUT = process.env.FRIDAY_BENEFIT_OUT;
const RUNS = Number(process.env.FRIDAY_BENEFIT_RUNS ?? 2);
const ARMS = (process.env.FRIDAY_BENEFIT_ARMS ?? BENEFIT_ARMS.join(','))
  .split(',')
  .map((x) => x.trim()) as BenefitArm[];
const TURNS = Number(process.env.FRIDAY_BENEFIT_TURNS ?? 16);
const SESSION_MS = 20 * 60_000;

if (!MODE) console.info('benefit comparison: skipped, FRIDAY_BENEFIT is not set (see docs/measurements/README.md)');

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

interface GoalDetail {
  goal: { goal_id: string; status: string };
  active: { tasks: { key: string; task_id: string | null; role: string; agent_key: string | null }[] } | null;
}
interface Verified {
  task: TaskView;
  verification: VerificationView;
}

describe.skipIf(MODE !== '1')('the benefit comparison: one goal, three ways, the same hidden checks', () => {
  it(
    'runs each arm, judges its final code, and writes the figures',
    async () => {
      if (!OUT || !outsideRepository(OUT, REPO_ROOT))
        throw new Error('set FRIDAY_BENEFIT_OUT to a folder outside the repository');
      for (const a of ARMS) if (!BENEFIT_ARMS.includes(a)) throw new Error(`unknown arm ${a}`);
      mkdirSync(OUT, { recursive: true });
      const install = detectClaudeCode();
      if (!install) throw new Error('Claude Code was not found');
      const plan = loadBenefitPlan();
      const budget = new TurnBudget(TURNS);
      const before = claudeState();
      const swaps = redactionSwaps(ws().root);
      const json = (v: unknown) => `${JSON.stringify(sanitize(v, swaps), null, 2)}\n`;
      const jsonl = (items: unknown[]) => `${items.map((x) => JSON.stringify(sanitize(x, swaps))).join('\n')}\n`;
      const env = claudeEnvironment();
      const rows: ArmFigures[] = [];

      const record = (
        row: ArmFigures,
        folder: string,
        transcripts: Record<string, TraceLine[]>,
        extra: Record<string, unknown> = {},
      ) => {
        mkdirSync(folder, { recursive: true });
        writeFileSync(path.join(folder, 'figures.json'), json(row));
        for (const [k, lines] of Object.entries(transcripts)) {
          writeFileSync(
            path.join(folder, `transcript-${k}.jsonl`),
            jsonl(lines.filter((l) => l.msg.type !== 'rate_limit_event')),
          );
        }
        for (const [k, v] of Object.entries(extra))
          writeFileSync(path.join(folder, k), typeof v === 'string' ? v : json(v));
        rows.push(row);
        writeFileSync(path.join(OUT, 'summary.json'), json(rows));
        writeFileSync(path.join(OUT, 'summary.txt'), `${summaryTable(rows)}\n`);
      };

      const fresh = async (name: string) => {
        const { root } = materializeFixtureShop(path.join(ws().root, name));
        return root;
      };

      const plainOne = async (run: number) => {
        const dir = await fresh(`r${run}-one`);
        const started = Date.now();
        const s = await runPlainSession({
          key: 'solo',
          binary: install.binary,
          cwd: dir,
          prompt: plainOnePrompt(plan),
          args: plainArgs(BASELINE_MODEL, BASELINE_CAP_USD * plan.tasks.length),
          env,
          budget,
          timeoutMs: SESSION_MS,
        });
        const seconds = Math.round((Date.now() - started) / 1000);
        const fig = sessionFigures(s.lines);
        const v = judgeTree(dir);
        const claimed = fig.claimed === 'completed' ? plan.tasks.map((t) => t.key) : [];
        record(
          {
            arm: 'plain-one',
            run,
            seconds,
            sessions: { solo: fig },
            totals: totalsOf([fig]),
            verdict: v,
            claimed_done: claimed,
            false_done: claimed.filter((k) => !v.tasks[k]),
          },
          path.join(OUT, `run${run}-plain-one`),
          { solo: s.lines },
          { 'stderr.txt': s.stderr },
        );
      };

      const plainTwo = async (run: number) => {
        const dir = await fresh(`r${run}-two`);
        const started = Date.now();
        const sessions = await Promise.all(
          plan.tasks.map((t) =>
            runPlainSession({
              key: t.key,
              binary: install.binary,
              cwd: dir,
              prompt: plainTwoPrompt(plan, t.key),
              args: plainArgs(BASELINE_MODEL, BASELINE_CAP_USD),
              env,
              budget,
              timeoutMs: SESSION_MS,
            }),
          ),
        );
        const seconds = Math.round((Date.now() - started) / 1000);
        const figs = Object.fromEntries(sessions.map((s) => [s.key, sessionFigures(s.lines)]));
        const v = judgeTree(dir);
        const claimed = Object.entries(figs)
          .filter(([, f]) => f.claimed === 'completed')
          .map(([k]) => k);
        record(
          {
            arm: 'plain-two',
            run,
            seconds,
            sessions: figs,
            totals: totalsOf(Object.values(figs)),
            verdict: v,
            claimed_done: claimed,
            false_done: claimed.filter((k) => !v.tasks[k]),
          },
          path.join(OUT, `run${run}-plain-two`),
          Object.fromEntries(sessions.map((s) => [s.key, s.lines])),
          { 'stderr.txt': sessions.map((s) => `== ${s.key}\n${s.stderr}`).join('\n') },
        );
      };

      const withFriday = async (run: number) => {
        const root = await fresh(`r${run}-fr`);
        appendFileSync(path.join(root, '.friday', 'config.yaml'), baselineConfig(BASELINE_MODEL));
        await deterministicGit(root, { startEpoch: 1_767_300_000 }).commitAll('the comparison configuration');
        const daemon: Daemon = await createDaemon({
          projectRoot: root,
          stateDir: ws().stateDir,
          tickMs: 500,
          pollIntervalMs: 50,
          logToFile: true,
          extensions: [claudeCodeHooks()],
          brain: { autoStart: false },
        });
        const pid = daemon.project.project_id;
        const bootstrap = new DaemonClient({
          baseUrl: daemon.url,
          projectId: pid,
          token: daemon.tokens.bootstrap,
          tokenClass: 'bootstrap',
        });
        const traces = new Map<string, SessionTrace>();
        const adapters = BENEFIT_AGENTS.map((agent) => {
          const trace = new SessionTrace(agent.key, budget);
          traces.set(agent.key, trace);
          return new ClaudeSpawnAdapter({
            bootstrap,
            projectId: pid,
            agentKey: agent.key,
            role: agent.role,
            harnessKey: `claude-code:${pid}:spawn:${agent.key}`,
            host: { command: install.binary, ...(install.version ? { version: install.version } : {}) },
            hostEnv: { ...env, FRIDAY_STATE_DIR: ws().stateDir },
            hook: { command: process.execPath, args: [bundledHookPath()] },
            maxBudgetUsd: BASELINE_CAP_USD,
            workDir: path.join(ws().root, `r${run}-attempts`, agent.key),
            trace: trace.trace,
          });
        });
        const friday = (...args: string[]) => cli(['--project', root, ...args]);
        const fridayJson = async <T>(...args: string[]): Promise<T> => {
          const r = await friday(...args, '--json');
          if (r.code !== 0) throw new Error(`friday ${args.join(' ')} failed (${r.code}): ${r.stderr || r.stdout}`);
          return JSON.parse(r.stdout) as T;
        };
        const started = Date.now();
        let refused = 0;
        let claims = 0;
        const reworked = new Set<string>();
        const gaveUp = new Set<string>();
        let goalId = '';
        let report: UsageReport | null = null;
        const verifications: unknown[] = [];
        try {
          const created = await fridayJson<GoalDetail>('goal', 'create', plan.objective, '--no-plan');
          goalId = created.goal.goal_id;
          await fridayJson('plan', 'propose', '--goal', goalId, '--file', BENEFIT_PLAN_FILE);
          await fridayJson('plan', 'approve', '--goal', goalId);
          const detail = await fridayJson<GoalDetail>('goal', 'show', goalId);
          const ids = (detail.active?.tasks ?? []).map((t) => ({ key: t.key, id: t.task_id as string }));
          for (const a of adapters) await a.start();
          const deadline = Date.now() + 40 * 60_000;
          for (;;) {
            await friday('brain', 'run-once');
            for (const t of ids) {
              const status = daemon.state.q.task(pid, t.id).status;
              if (status === 'READY_FOR_VERIFICATION') {
                claims += 1;
                const v = await fridayJson<Verified>('verify', t.id);
                verifications.push({
                  key: t.key,
                  status: v.task.status,
                  checks: v.verification.checks.map((c) => ({ name: c.name, status: c.status, summary: c.summary })),
                });
                if (v.task.status === 'FAILED') {
                  refused += 1;
                  if (!reworked.has(t.id)) {
                    reworked.add(t.id);
                    const failed = v.verification.checks
                      .filter((c) => c.status !== 'PASSED')
                      .map((c) => `${c.name}: ${c.summary ?? ''}`.slice(0, 300));
                    await friday(
                      'task',
                      'rework',
                      t.id,
                      '--reason',
                      `Verification failed. ${failed.join(' | ')}`.slice(0, 900),
                    );
                  } else gaveUp.add(t.id);
                }
              } else if (status === 'WAITING' || status === 'CANCELLED') gaveUp.add(t.id);
            }
            const done = ids.every((t) => daemon.state.q.task(pid, t.id).status === 'COMPLETED' || gaveUp.has(t.id));
            if (done || Date.now() > deadline) break;
            await sleep(3000);
          }
          // The goal completes once its verified work is in the goal branch.
          for (let i = 0; i < 40; i += 1) {
            await friday('brain', 'run-once');
            if ((await fridayJson<GoalDetail>('goal', 'show', goalId)).goal.status === 'COMPLETED') break;
            if (gaveUp.size) break;
            await sleep(3000);
          }
          report = await fridayJson<UsageReport>('usage', '--goal', goalId).catch(() => null);
        } finally {
          for (const a of adapters) await a.close().catch(() => undefined);
        }
        const seconds = Math.round((Date.now() - started) / 1000);
        // The final code is the goal branch; without it, nothing of the goal was integrated.
        const judgeDir = path.join(ws().root, `r${run}-fr-goal`);
        const g = deterministicGit(root);
        const branch = `friday/goal-${goalId}`;
        const hasBranch = (await g.exitCode(['rev-parse', '--verify', '--quiet', branch])) === 0;
        if (hasBranch) await g.run(['worktree', 'add', '--detach', judgeDir, branch]);
        const v = judgeTree(hasBranch ? judgeDir : root);
        const sessions: Record<string, SessionFigures> = {};
        const transcripts: Record<string, TraceLine[]> = {};
        for (const [agent, trace] of traces) {
          splitSessions(trace.lines).forEach((lines, i) => {
            sessions[`${agent}#${i + 1}`] = sessionFigures(lines);
            transcripts[`${agent}-${i + 1}`] = lines;
          });
        }
        const keyOf = new Map(
          (await fridayJson<GoalDetail>('goal', 'show', goalId).catch(() => null))?.active?.tasks.map((t) => [
            t.task_id,
            t.key,
          ]) ?? [],
        );
        const completed = [...keyOf.entries()]
          .filter(([id]) => id && daemon.state.q.task(pid, id).status === 'COMPLETED')
          .map(([, key]) => key);
        record(
          {
            arm: 'friday',
            run,
            seconds,
            sessions,
            totals: totalsOf(Object.values(sessions)),
            verdict: v,
            claimed_done: completed,
            false_done: completed.filter((k) => !v.tasks[k]),
            refused_claims: refused,
            reworks: reworked.size,
          },
          path.join(OUT, `run${run}-friday`),
          transcripts,
          {
            'usage.json': report ?? {},
            'verifications.json': verifications,
            'events.jsonl': jsonl(allEvents(daemon.state.store, pid)),
            'claims.json': { claims, refused, reworked: reworked.size, gave_up: gaveUp.size, integrated: hasBranch },
          },
        );
        await daemon.close('the comparison');
      };

      try {
        for (let run = 1; run <= RUNS; run += 1) {
          for (const arm of ARMS) {
            if (arm === 'plain-one') await plainOne(run);
            if (arm === 'plain-two') await plainTwo(run);
            if (arm === 'friday') await withFriday(run);
          }
        }
      } finally {
        const after = claudeState();
        writeFileSync(
          path.join(OUT, 'run.json'),
          json({
            claude: install.version,
            model: BASELINE_MODEL,
            cap_usd_per_task: BASELINE_CAP_USD,
            runs: RUNS,
            arms: ARMS,
            turns_approved: TURNS,
            turns_started: budget.turns,
            refused: budget.refused,
            claude_session_folders_added: after.sessions.filter((k) => !before.sessions.includes(k)).length,
          }),
        );
        console.log(`\n${summaryTable(rows)}\nSaved under ${OUT}`);
      }
      expect(rows.length).toBe(RUNS * ARMS.length);
    },
    4 * 60 * 60_000,
  );
});
