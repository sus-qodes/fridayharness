/**
 * The token baseline (plan M10a.2): the gift-card goal of the recorded demonstration, run on today's
 * Friday by two spawned Claude Code sessions, so that every later change to context handling is
 * judged against what these runs spent. It runs only when the owner allows it, never in CI.
 *
 *   FRIDAY_TOKEN_BASELINE=dry  the real installed Claude Code is started for both tasks with every
 *                              flag Friday passes, and the first message of each is refused before it
 *                              is written: no model call. It proves the setup: the fixture copy, the
 *                              plan proposed from the fixture and approved, each task delegated to the
 *                              agent of its role, the real Claude Code started with every flag and
 *                              stopped before it was given anything, the output folder written. Its
 *                              transcripts are empty: Claude Code prints nothing before its first
 *                              message, so whether it accepts the flags is what a live run's
 *                              `system/init` shows.
 *   FRIDAY_TOKEN_BASELINE=1    the live run on the owner's Claude login: both tasks on claude-haiku-5-5
 *                              at its default effort, each attempt capped by --max-budget-usd 0.25 and
 *                              the whole run by FRIDAY_TOKEN_BASELINE_TURNS turns (six by default);
 *                              verification by the project's own tests.
 *
 *   FRIDAY_TOKEN_BASELINE_REWORK=resume|fresh (with =1)  the rework variant (plan M13.2): the backend
 *                              task alone, its first claim failed by a human with one fixed note and
 *                              reworked by the same agent, in the first session or a new one.
 *
 * FRIDAY_TOKEN_BASELINE_OUT names a folder outside the repository for the results: the usage report
 * (`friday usage --goal <id> --json`), each agent's stream-json transcript, the events, the hosts, the
 * verifications and a verdict (`baselineFiles` in tests/helpers/token-baseline.ts). The evidence is
 * saved whatever happens: the usage report, its table and the hosts are read at the end of the run
 * even when a step before failed, each on its own (`eachOnItsOwn`), so a finished attempt's row is
 * kept when the other attempt stalls, and a read that failed is named in the results. Nothing goes
 * into the repository. A guard on each adapter's stream-json trace refuses, before it is written, a
 * message that would start a turn past the budget. The run is a gate: it passes only when every usage
 * row is complete (`baselineVerdict`), and it prints the usage table at the end whenever it was read.
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
import type { HarnessView, TaskStartParams, TaskView, UsageReport, VerificationView } from '@friday/protocol';
import { DaemonClient } from '@friday/sdk';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli, REPO_ROOT } from '../helpers/cli.js';
import { claudeState, redactionSwaps, sanitize } from '../helpers/live-claude.js';
import { incomplete, LiveBudget, type Verdict, verdict } from '../helpers/live-verdict.js';
import {
  allEvents,
  BASELINE_AGENTS,
  BASELINE_CAP_USD,
  BASELINE_GOAL,
  BASELINE_MODEL,
  BASELINE_PLAN_FILE,
  type BaselineAgent,
  baselineConfig,
  baselineFiles,
  baselineVerdict,
  type ExpectedAttempt,
  eachOnItsOwn,
  expectedAttempts,
  loadBaselinePlan,
  outsideRepository,
  SessionTrace,
  TurnBudget,
} from '../helpers/token-baseline.js';

const MODE = process.env.FRIDAY_TOKEN_BASELINE;
const OUT = process.env.FRIDAY_TOKEN_BASELINE_OUT;
/** Turns this run may start, in both sessions together: the owner approves the number. */
const TURNS = Number(process.env.FRIDAY_TOKEN_BASELINE_TURNS ?? 6);
/** Haiku keeps its default effort: one a model does not take would cost a turn. */
const EFFORT = 'default';
/** The rework variant (plan M13.2): `resume` or `fresh`; unset runs the baseline itself. */
const REWORK = process.env.FRIDAY_TOKEN_BASELINE_REWORK;
/** What the human's refusal says in both rework variants: one small, concrete addition. */
const REWORK_NOTE =
  'redeemGiftCard must also refuse a card whose balance amount is not a whole number of minor units: throw CheckoutError for it, and add a test for that case.';

if (!MODE) {
  console.info('token baseline: skipped, FRIDAY_TOKEN_BASELINE is not set (dry or 1; see docs/measurements/README.md)');
}

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

async function eventually<T>(
  fn: () => T | Promise<T>,
  ok: (v: T) => boolean,
  what: string,
  ms = 60_000,
  every = 200,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${String(JSON.stringify(v)).slice(0, 400)}`);
    await sleep(every);
  }
}

/** `friday goal show --json`, the part the baseline reads. */
interface GoalDetail {
  goal: { goal_id: string; status: string };
  active: { tasks: { key: string; task_id: string | null; role: string; agent_key: string | null }[] } | null;
}

interface Verified {
  task: TaskView;
  verification: VerificationView;
}

describe.skipIf(!MODE)('the token baseline: the gift-card goal on two spawned Claude Code sessions', () => {
  if (!(TURNS >= 0 && TURNS <= 12)) throw new Error('FRIDAY_TOKEN_BASELINE_TURNS must be between 0 and 12');

  async function setup(turns: TurnBudget) {
    if (!OUT) throw new Error('set FRIDAY_TOKEN_BASELINE_OUT to a folder outside the repository');
    if (!outsideRepository(OUT, REPO_ROOT)) {
      throw new Error(`FRIDAY_TOKEN_BASELINE_OUT must name a folder outside the repository, not ${OUT}`);
    }
    mkdirSync(OUT, { recursive: true });
    const files = baselineFiles(OUT);
    const install = detectClaudeCode();
    if (!install) throw new Error('Claude Code was not found');
    // The fixture is read once here so a wrong field stops the run before any host starts.
    const plan = loadBaselinePlan();
    const { root } = materializeFixtureShop(path.join(ws().root, 'shop'));
    appendFileSync(path.join(root, '.friday', 'config.yaml'), baselineConfig(BASELINE_MODEL));
    await deterministicGit(root, { startEpoch: 1_767_300_000 }).commitAll('the baseline configuration');
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
    const logs = new Map<string, string[]>();
    /** A spawned Claude Code agent of one role, its sessions traced under the run's turn budget. */
    const adapter = (agent: BaselineAgent, extra: { resumeSessions?: boolean } = {}) => {
      const trace = new SessionTrace(agent.key, turns);
      traces.set(agent.key, trace);
      const log: string[] = [];
      logs.set(agent.key, log);
      const a = new ClaudeSpawnAdapter({
        bootstrap,
        projectId: pid,
        agentKey: agent.key,
        role: agent.role,
        harnessKey: `claude-code:${pid}:spawn:${agent.key}`,
        host: { command: install.binary, ...(install.version ? { version: install.version } : {}) },
        hostEnv: { ...claudeEnvironment(), FRIDAY_STATE_DIR: ws().stateDir },
        hook: { command: process.execPath, args: [bundledHookPath()] },
        maxBudgetUsd: BASELINE_CAP_USD,
        workDir: path.join(ws().root, 'attempts', agent.key),
        log: (m) => log.push(`${new Date().toISOString()} ${m}`),
        trace: trace.trace,
        ...extra,
      });
      ws().track({ close: () => a.close() });
      return a;
    };
    const friday = (...args: string[]) => cli(['--project', root, ...args]);
    /** A command's output, or an error naming the command: a failed read is never an empty file. */
    const fridayText = async (...args: string[]): Promise<string> => {
      const r = await friday(...args);
      if (r.code !== 0) throw new Error(`friday ${args.join(' ')} failed (${r.code}): ${r.stderr || r.stdout}`);
      return r.stdout;
    };
    const fridayJson = async <T>(...args: string[]): Promise<T> => JSON.parse(await fridayText(...args, '--json')) as T;
    const task = (id: string) => daemon.state.q.task(pid, id);
    const eventData = (id: string, type: string) =>
      daemon.state.store
        .readByRef(pid, 'task', id)
        .filter((e) => e.type === 'agent.event' && (e.payload as { event_type: string }).event_type === type)
        .map(
          (e) =>
            (e.payload as { data?: unknown; message?: unknown }).data ?? (e.payload as { message?: unknown }).message,
        );
    /** The goal with no planner, the plan from the fixture, approved: the two tasks, READY. */
    const proposePlan = async (
      planFile: string = BASELINE_PLAN_FILE,
      agents: readonly BaselineAgent[] = BASELINE_AGENTS,
    ) => {
      const created = await fridayJson<GoalDetail>('goal', 'create', BASELINE_GOAL, '--no-plan');
      const goalId = created.goal.goal_id;
      await fridayJson('plan', 'propose', '--goal', goalId, '--file', planFile);
      await fridayJson('plan', 'approve', '--goal', goalId);
      const detail = () => fridayJson<GoalDetail>('goal', 'show', goalId);
      const expected = expectedAttempts((await detail()).active?.tasks ?? [], agents);
      return { goalId, expected, detail };
    };
    /** The Master Brain's delegation, run until every task has left READY (an agent's harness must be live first). */
    const delegate = async (expected: readonly ExpectedAttempt[]) => {
      const steps: unknown[] = [];
      await eventually(
        async () => {
          const r = await fridayJson<{ steps: unknown[] }>('brain', 'run-once');
          steps.push(...r.steps);
          return expected.map((e) => task(e.task_id).status);
        },
        (s) => s.every((x) => x !== 'READY'),
        'the delegation of both tasks',
        60_000,
        1000,
      );
      return steps;
    };
    const settle = (id: string, what: string) =>
      eventually(
        () => task(id).status,
        (x) => ['READY_FOR_VERIFICATION', 'WAITING', 'CANCELLED'].includes(x),
        what,
        25 * 60_000,
        500,
      );
    const verify = (id: string) => fridayJson<Verified>('verify', id);
    /**
     * The usage report, its table and the hosts, each read on its own: the run reads them at its end
     * whatever it reached, so a read that fails loses one file and names itself, not the others.
     */
    const evidence = (goalId: string) =>
      eachOnItsOwn({
        report: () => fridayJson<UsageReport>('usage', '--goal', goalId),
        table: () => fridayText('usage', '--goal', goalId),
        hosts: () => fridayJson<HarnessView[]>('harnesses', '--all'),
      });
    const sessions = () =>
      Object.fromEntries(
        [...traces].map(([agent, t]) => [
          agent,
          {
            inits: t
              .received('system', 'init')
              .map((m) => ({ model: m.model, tools: m.tools, mcp_servers: m.mcp_servers })),
            result: t.received('result').at(-1) ?? null,
            received: t.lines.filter((l) => l.dir === 'receive').map((l) => `${l.msg.type}/${l.msg.subtype ?? ''}`),
          },
        ]),
      );
    const swaps = redactionSwaps(ws().root);
    const json = (v: unknown) => `${JSON.stringify(sanitize(v, swaps), null, 2)}\n`;
    const lines = (items: unknown[]) => `${items.map((x) => JSON.stringify(sanitize(x, swaps))).join('\n')}\n`;
    /** Everything the run showed, whatever happened: nothing of it goes into the repository. */
    const save = (
      results: Record<string, unknown>,
      v: Verdict,
      extra: {
        report?: UsageReport | null;
        table?: string | null;
        hosts?: HarnessView[] | null;
        verifications?: unknown;
      },
    ) => {
      writeFileSync(files.results, json({ ...results, verdict: v }));
      writeFileSync(files.verdict, json(v));
      for (const [agent, t] of traces) {
        // Rate-limit messages describe the owner's plan and its usage, not the session.
        writeFileSync(files.transcript(agent), lines(t.lines.filter((l) => l.msg.type !== 'rate_limit_event')));
        writeFileSync(files.adapterLog(agent), `${(logs.get(agent) ?? []).join('\n')}\n`);
      }
      writeFileSync(files.events, lines(allEvents(daemon.state.store, pid)));
      if (extra.report) writeFileSync(files.usage, json(extra.report));
      if (extra.table) writeFileSync(files.usageTable, extra.table.replace(/\r\n/g, '\n'));
      if (extra.hosts) writeFileSync(files.hosts, json(extra.hosts));
      if (extra.verifications) writeFileSync(files.verifications, json(extra.verifications));
    };
    return {
      install,
      plan,
      root,
      daemon,
      adapter,
      friday,
      fridayJson,
      task,
      eventData,
      proposePlan,
      delegate,
      settle,
      verify,
      evidence,
      sessions,
      save,
      files,
    };
  }

  it.runIf(MODE === 'dry')(
    'starts the real Claude Code for both tasks with every flag Friday passes, and sends it nothing',
    async () => {
      const turns = new TurnBudget(0);
      const before = claudeState();
      const s = await setup(turns);
      const results: Record<string, unknown> = {
        mode: 'dry',
        claude: s.install.version,
        model: BASELINE_MODEL,
        effort: EFFORT,
        cap_usd: BASELINE_CAP_USD,
        approved_turns: 0,
        plan_tasks: s.plan.tasks.map((t) => t.key),
      };
      let v: Verdict = incomplete('the dry run stopped before its end');
      let goalId: string | null = null;
      let evidence: Awaited<ReturnType<typeof s.evidence>> | null = null;
      const adapters = BASELINE_AGENTS.map((a) => s.adapter(a));
      try {
        const proposed = await s.proposePlan();
        goalId = proposed.goalId;
        const { expected } = proposed;
        Object.assign(results, { goal_id: goalId, tasks: expected });
        for (const a of adapters) await a.start();
        results.delegation = await s.delegate(expected);
        // Each first message is refused before it is written: both attempts end as agent errors.
        await Promise.all(
          expected.map((e) =>
            eventually(
              () => s.task(e.task_id).status,
              (x) => x === 'WAITING',
              `the refused turn of ${e.key}`,
              120_000,
            ),
          ),
        );
        const errors = Object.fromEntries(expected.map((e) => [e.key, s.eventData(e.task_id, 'error')[0] ?? null]));
        evidence = await s.evidence(goalId);
        const report = evidence.values.report;
        if (!report) throw new Error(`the usage report could not be read: ${evidence.failures.report}`);
        const rowOf = (e: ExpectedAttempt) => report.rows.find((r) => r.task_id === e.task_id);
        Object.assign(results, {
          task_status: Object.fromEntries(
            expected.map((e) => [e.key, `${s.task(e.task_id).status} (${s.task(e.task_id).waiting_reason ?? ''})`]),
          ),
          errors,
          sessions: s.sessions(),
          usage_rows: report.rows,
        });
        v = verdict({
          'the plan was approved with its two tasks': expected.length === 2,
          'each task was delegated to the agent of its role': expected.every(
            (e) => rowOf(e)?.agent_key === e.agent_key,
          ),
          'no turn started': turns.turns === 0,
          'both first messages were refused by the budget, not by Claude Code':
            turns.refused.length === 2 &&
            Object.values(errors).every((m) => /the token baseline refused this turn/.test(String(m))),
          'one usage row per attempt, its host unknown':
            report.rows.length === 2 && report.rows.every((r) => r.host.reported === false),
        });
      } finally {
        // What the run showed is read here when a step before failed, before anything is closed.
        evidence ??= goalId ? await s.evidence(goalId) : null;
        for (const a of adapters) await a.close().catch(() => undefined);
        const after = claudeState();
        Object.assign(results, {
          turns_started: turns.turns,
          refused: turns.refused,
          evidence_failures: evidence?.failures ?? {},
          claude_projects_added: after.projects.filter((k) => !before.projects.includes(k)),
          claude_session_folders_added: after.sessions.filter((k) => !before.sessions.includes(k)),
        });
        s.save(results, v, { ...evidence?.values });
        // The table as `friday usage --goal <id>` prints it: every host figure `-`, since no turn ran.
        if (evidence?.values.table) console.log(`\n${evidence.values.table}\nSaved under ${OUT}`);
      }
      expect(turns.turns).toBe(0);
      expect(v, JSON.stringify(v)).toMatchObject({ status: 'passed' });
    },
    10 * 60_000,
  );

  /** One budget for the run: the live case needs a turn per task, and a failure keeps the rest unspent. */
  const budget = new LiveBudget(TURNS);

  /**
   * The rework variant (plan M13.2): the backend task alone; its first claim, whatever its checks
   * say, is failed by a human with one fixed note and reworked by the same agent, whose second
   * attempt either continues the first session (`resume`) or starts a new one (`fresh`). The two
   * variants differ only in that, so the second attempt's figures compare the two.
   */
  it.runIf(MODE === '1' && Boolean(REWORK))(
    'reworks a refused claim of the backend task in the same session or a new one, and records both attempts',
    async () => {
      if (REWORK !== 'resume' && REWORK !== 'fresh') throw new Error('FRIDAY_TOKEN_BASELINE_REWORK is resume or fresh');
      const refused = budget.refuse(2);
      if (refused) expect.fail(refused);
      const turns = new TurnBudget(TURNS);
      const before = claudeState();
      const s = await setup(turns);
      const backend = BASELINE_AGENTS.find((a) => a.key === 'be-1') as BaselineAgent;
      const planFile = path.join(ws().root, 'rework-plan.json');
      writeFileSync(planFile, JSON.stringify({ ...s.plan, tasks: s.plan.tasks.filter((t) => t.key === backend.task) }));
      const results: Record<string, unknown> = {
        mode: `live-rework-${REWORK}`,
        claude: s.install.version,
        model: BASELINE_MODEL,
        effort: EFFORT,
        cap_usd: BASELINE_CAP_USD,
        approved_turns: TURNS,
        note: REWORK_NOTE,
        started_at: new Date().toISOString(),
      };
      let v: Verdict = incomplete('the run stopped before its end');
      let goalId: string | null = null;
      let evidence: Awaited<ReturnType<typeof s.evidence>> | null = null;
      const verifications: Record<string, Verified | null> = {};
      const a = s.adapter(backend, { resumeSessions: REWORK === 'resume' });
      try {
        const proposed = await s.proposePlan(planFile, [backend]);
        goalId = proposed.goalId;
        const { expected } = proposed;
        const [e] = expected;
        if (!e || expected.length !== 1) throw new Error('the rework plan has one task');
        Object.assign(results, { goal_id: goalId, tasks: expected });
        await a.start();
        await s.delegate(expected);
        const first = await s.settle(e.task_id, 'the first attempt');
        if (first !== 'READY_FOR_VERIFICATION') throw new Error(`the first attempt ended ${first}, not with a claim`);
        // A human refuses the claim with the same note in both variants, before any check runs (a
        // verified task is COMPLETED and can no longer be refused), and sends the task back.
        verifications.attempt1 = await s.fridayJson<Verified>(
          'verify',
          e.task_id,
          '--result',
          'failed',
          '--note',
          REWORK_NOTE,
        );
        await s.fridayJson('task', 'rework', e.task_id, '--reason', REWORK_NOTE);
        await s.delegate(expected);
        const second = await s.settle(e.task_id, 'the rework');
        verifications.attempt2 = second === 'READY_FOR_VERIFICATION' ? await s.verify(e.task_id) : null;
        const runs = s.daemon.state.q.runs(e.task_id);
        const start2 = a.received.filter((m) => m.method === 'task.start').at(-1)?.params as
          | TaskStartParams
          | undefined;
        Object.assign(results, {
          runs: runs.map((r) => ({ attempt: r.attempt, session_ref: r.session_ref, status: r.status })),
          continued: runs.length === 2 && runs[0]?.session_ref === runs[1]?.session_ref,
          continue_session: start2?.continue_session ?? null,
          verifications: Object.fromEntries(
            Object.entries(verifications).map(([k, x]) => [
              k,
              x && {
                status: x.task.status,
                checks: x.verification.checks.map((c) => ({ name: c.name, status: c.status, summary: c.summary })),
              },
            ]),
          ),
        });
        evidence = await s.evidence(goalId);
        results.sessions = s.sessions();
        const report = evidence.values.report;
        if (!report) throw new Error(`the usage report could not be read: ${evidence.failures.report}`);
        const rows = report.rows.filter((r) => r.task_id === e.task_id).sort((x, y) => x.attempt - y.attempt);
        v = verdict({
          'two attempts of the backend task, both by be-1':
            rows.length === 2 && rows.every((r) => r.agent_key === 'be-1'),
          'both attempts reported their usage': rows.every((r) => r.host.reported),
          'the rework was verified': rows[1]?.verification?.status === 'PASSED',
          [REWORK === 'resume' ? 'the rework continued the first session' : 'the rework started a new session']:
            REWORK === 'resume' ? results.continued === true : results.continued === false,
        });
      } finally {
        evidence ??= goalId ? await s.evidence(goalId) : null;
        await a.close().catch(() => undefined);
        budget.settle('rework', turns.turns, v);
        const after = claudeState();
        Object.assign(results, {
          turns_started: turns.turns,
          refused: turns.refused,
          evidence_failures: evidence?.failures ?? {},
          claude_projects_added: after.projects.filter((k) => !before.projects.includes(k)),
          claude_session_folders_added: after.sessions.filter((k) => !before.sessions.includes(k)),
          ended_at: new Date().toISOString(),
        });
        s.save(results, v, { ...evidence?.values, verifications });
        if (evidence?.values.table) console.log(`\n${evidence.values.table}\nSaved under ${OUT}`);
      }
      expect(turns.turns).toBeLessThanOrEqual(TURNS);
      expect(v, JSON.stringify(v)).toMatchObject({ status: 'passed' });
    },
    60 * 60_000,
  );

  it.runIf(MODE === '1' && !REWORK)(
    'runs the gift-card goal on two spawned sessions, verifies both tasks, and records every usage row complete',
    async () => {
      const refused = budget.refuse(BASELINE_AGENTS.length);
      if (refused) expect.fail(refused);
      const turns = new TurnBudget(TURNS);
      const before = claudeState();
      const s = await setup(turns);
      const results: Record<string, unknown> = {
        mode: 'live',
        claude: s.install.version,
        model: BASELINE_MODEL,
        effort: EFFORT,
        cap_usd: BASELINE_CAP_USD,
        approved_turns: TURNS,
        plan_tasks: s.plan.tasks.map((t) => t.key),
        started_at: new Date().toISOString(),
      };
      let v: Verdict = incomplete('the run stopped before its end');
      let goalId: string | null = null;
      let evidence: Awaited<ReturnType<typeof s.evidence>> | null = null;
      const verifications: Record<string, Verified | null> = {};
      const adapters = BASELINE_AGENTS.map((a) => s.adapter(a));
      try {
        const proposed = await s.proposePlan();
        goalId = proposed.goalId;
        const { expected, detail } = proposed;
        Object.assign(results, { goal_id: goalId, tasks: expected });
        for (const a of adapters) await a.start();
        // The Master Brain gives each task to the agent of its role; both turns run at once.
        results.delegation = await s.delegate(expected);
        const ended = await Promise.all(expected.map((e) => s.settle(e.task_id, `the turn of ${e.key}`)));
        results.task_status = Object.fromEntries(
          expected.map((e, i) => [e.key, { status: ended[i], waiting_reason: s.task(e.task_id).waiting_reason }]),
        );
        results.errors = Object.fromEntries(expected.map((e) => [e.key, s.eventData(e.task_id, 'error')]));
        // Verification by the project's own tests, in each task's worktree; verified work is integrated.
        for (const e of expected) {
          verifications[e.key] =
            ended[expected.indexOf(e)] === 'READY_FOR_VERIFICATION' ? await s.verify(e.task_id) : null;
        }
        results.verifications = Object.fromEntries(
          Object.entries(verifications).map(([k, x]) => [
            k,
            x && {
              status: x.task.status,
              checks: x.verification.checks.map((c) => ({ name: c.name, status: c.status, summary: c.summary })),
            },
          ]),
        );
        // The Master Brain's last pass completes the goal once every task is verified and integrated.
        await s.friday('brain', 'run-once');
        results.goal_status = (await detail()).goal.status;
        evidence = await s.evidence(goalId);
        results.sessions = s.sessions();
        const report = evidence.values.report;
        if (!report) throw new Error(`the usage report could not be read: ${evidence.failures.report}`);
        v = baselineVerdict(report, expected);
      } finally {
        // The usage rows, the table and the hosts are read here when a step before failed (a stalled
        // session, a verification that would not run), before anything is closed: the finished
        // attempt's row, with the turn the owner spent on it, is saved whatever the other did.
        evidence ??= goalId ? await s.evidence(goalId) : null;
        for (const a of adapters) await a.close().catch(() => undefined);
        budget.settle('baseline', turns.turns, v);
        const after = claudeState();
        Object.assign(results, {
          turns_started: turns.turns,
          refused: turns.refused,
          evidence_failures: evidence?.failures ?? {},
          claude_projects_added: after.projects.filter((k) => !before.projects.includes(k)),
          claude_session_folders_added: after.sessions.filter((k) => !before.sessions.includes(k)),
          ended_at: new Date().toISOString(),
        });
        s.save(results, v, { ...evidence?.values, verifications });
        // The usage table, as `friday usage --goal <id>` prints it: the baseline's numbers, read by a human.
        if (evidence?.values.table) console.log(`\n${evidence.values.table}\nSaved under ${OUT}`);
      }
      expect(turns.turns).toBeLessThanOrEqual(TURNS);
      expect(v, JSON.stringify(v)).toMatchObject({ status: 'passed' });
    },
    60 * 60_000,
  );
});
