/**
 * The token baseline (plan M10a.2): what the live test `tests/scenarios/token-baseline.live.test.ts`
 * sets up and judges, as small functions with no host behind them, so a unit test and the test's dry
 * mode prove the setup, the output folder and the verdict without a model call.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { formatIssues, PlanDraft } from '@friday/planner';
import type { UsageReport, UsageRowView } from '@friday/protocol';
import { REPO_ROOT } from './cli.js';
import type { Msg } from './live-claude.js';
import { type Verdict, verdict } from './live-verdict.js';

/** The gift-card goal of the recorded demonstration (docs/integration/mvp-demo.md, "Recorded live"). */
export const BASELINE_GOAL =
  "Customers can pay part of an order with a gift card: the backend redeems the card's balance and the frontend shows the amount applied";
/** Both tasks run on spawned Claude Code pinned to this model; the Codex adapter reports no usage. */
export const BASELINE_MODEL = 'claude-haiku-5-5';
/** Each attempt's session is capped here (`--max-budget-usd`). */
export const BASELINE_CAP_USD = 0.25;
/** The hand-written plan, committed as a fixture in the shape of `PlanDraft`. */
export const BASELINE_PLAN_FILE = path.join(REPO_ROOT, 'tests', 'fixtures', 'baseline', 'giftcard-plan.json');

/** The two spawned agents, each of the role of the task it takes. */
export const BASELINE_AGENTS = [
  { key: 'fe-1', role: 'frontend', task: 'giftcard-frontend' },
  { key: 'be-1', role: 'backend', task: 'giftcard-backend' },
] as const;
export type BaselineAgent = (typeof BASELINE_AGENTS)[number];

/** The plan fixture, validated as `friday plan propose --file` validates it; a wrong field fails here, offline. */
export function loadBaselinePlan(file: string = BASELINE_PLAN_FILE): PlanDraft {
  const parsed = PlanDraft.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) throw new Error(`${file} is not a plan: ${formatIssues(parsed.error).join('; ')}`);
  return parsed.data;
}

/**
 * What the baseline appends to the fixture copy's `.friday/config.yaml`: the model pin for every
 * run, no automatic retry (every turn is one the test started), and no planner (the plan comes from
 * the fixture; the Master Brain still delegates).
 */
export function baselineConfig(model: string = BASELINE_MODEL): string {
  return [
    '',
    '# The token baseline (tests/scenarios/token-baseline.live.test.ts).',
    'recovery:',
    '  max_retries: 0',
    '  max_same_error_retries: 0',
    'routing:',
    '  mode: manual',
    `  default_model: ${model}`,
    'master_brain:',
    '  provider: none',
    '',
  ].join('\n');
}

/** True when `out` is not inside the repository: the results never go into it. */
export function outsideRepository(out: string, repoRoot: string = REPO_ROOT): boolean {
  const rel = path.relative(path.resolve(repoRoot), path.resolve(out));
  return rel === '' ? false : rel.startsWith('..') || path.isAbsolute(rel);
}

/** The files one run saves under `FRIDAY_TOKEN_BASELINE_OUT`; a second run gets its own folder. */
export interface BaselineFiles {
  /** What was observed, step by step, with the verdict. */
  results: string;
  /** The verdict alone: which steps were observed, and what was missing. */
  verdict: string;
  /** `friday usage --goal <id> --json`: the usage report of plan M10a.1. */
  usage: string;
  /** `friday usage --goal <id>`: the same as the table the test prints. */
  usageTable: string;
  /** Every event of the run's project, one JSON object per line. */
  events: string;
  /** `friday harnesses --all --json`: the hosts, with versions and levels. */
  hosts: string;
  /** Each task's verification: the verdict and its checks. */
  verifications: string;
  /** The stream-json transcript of one agent's sessions, both ways. */
  transcript: (agent: string) => string;
  /** The adapter's own log for one agent. */
  adapterLog: (agent: string) => string;
}

export function baselineFiles(out: string): BaselineFiles {
  const at = (name: string) => path.join(out, name);
  return {
    results: at('baseline-results.json'),
    verdict: at('verdict.json'),
    usage: at('usage.json'),
    usageTable: at('usage.txt'),
    events: at('events.jsonl'),
    hosts: at('hosts.json'),
    verifications: at('verifications.json'),
    transcript: (agent) => at(`transcript-${agent}.jsonl`),
    adapterLog: (agent) => at(`adapter-${agent}.log`),
  };
}

/**
 * The turns one run may start, shared by every session of the run: a message that would start a
 * turn past the approved number is refused before the adapter writes it.
 */
export class TurnBudget {
  turns = 0;
  readonly refused: string[] = [];
  constructor(readonly approved: number) {}

  /** Counts a turn, or throws when the approved turns are spent. */
  start(text: string): void {
    if (this.turns >= this.approved) {
      this.refused.push(text.slice(0, 80));
      throw new Error(`the token baseline refused this turn: the budget of ${this.approved} turns is spent`);
    }
    this.turns += 1;
  }
}

const textOf = (msg: Msg): string => (typeof msg.message?.content === 'string' ? msg.message.content : '');

/** Whether a user message starts a turn: the task and a resume do; a message relayed into a running turn does not. */
export function startsTurn(msg: Msg): boolean {
  return msg.type === 'user' && !textOf(msg).startsWith('[A message from');
}

export interface TraceLine {
  t: number;
  dir: 'send' | 'receive';
  msg: Msg;
}

/** One agent's stream-json lines, both ways, under the run's turn budget. */
export class SessionTrace {
  readonly lines: TraceLine[] = [];
  constructor(
    readonly agent: string,
    private readonly budget: TurnBudget,
  ) {}

  trace = (dir: 'send' | 'receive', line: string): void => {
    let msg: Msg;
    try {
      msg = JSON.parse(line) as Msg;
    } catch {
      return;
    }
    // The budget refuses before the line is recorded, and before the adapter writes it.
    if (dir === 'send' && startsTurn(msg)) this.budget.start(textOf(msg));
    this.lines.push({ t: Date.now(), dir, msg });
  };

  received(type: string, subtype?: string): Msg[] {
    return this.lines
      .filter((l) => l.dir === 'receive' && l.msg.type === type && (!subtype || l.msg.subtype === subtype))
      .map((l) => l.msg);
  }
}

/** The attempt the baseline expects for each task of the plan: the task's id, and the agent of its role. */
export interface ExpectedAttempt {
  key: string;
  task_id: string;
  agent_key: string;
}

/** Joins the approved plan's tasks (by key) with the agents of their roles; a task the plan lost is an error. */
export function expectedAttempts(
  tasks: readonly { key: string; task_id: string | null }[],
  agents: readonly BaselineAgent[] = BASELINE_AGENTS,
): ExpectedAttempt[] {
  return agents.map((a) => {
    const task = tasks.find((t) => t.key === a.task);
    if (!task?.task_id) throw new Error(`the approved plan has no task ${a.task}`);
    return { key: a.task, task_id: task.task_id, agent_key: a.key };
  });
}

/** What a complete row holds, by name; each is a requirement of the verdict. */
const HOST_FIELDS = [
  ['input_tokens', 'input tokens known'],
  ['output_tokens', 'output tokens known'],
  ['cache_read_input_tokens', 'cache read tokens known'],
  ['cache_creation_input_tokens', 'cache creation tokens known'],
  ['cost_usd', 'cost known'],
  ['turns', 'turns known'],
] as const;

/** The requirements one attempt's row meets or misses, named after its task key. */
export function rowRequirements(key: string, row: UsageRowView | undefined, agentKey: string): Record<string, boolean> {
  const req: Record<string, boolean> = {};
  req[`${key}: one attempt in the usage report`] = row !== undefined;
  req[`${key}: taken by ${agentKey}`] = row?.agent_key === agentKey;
  req[`${key}: the host reported its usage`] = row?.host.reported === true;
  for (const [field, name] of HOST_FIELDS) req[`${key}: ${name}`] = row !== undefined && row.host[field] !== null;
  req[`${key}: at least one packet delivered`] = (row?.packets.count ?? 0) >= 1;
  req[`${key}: verification PASSED`] = row?.verification?.status === 'PASSED';
  return req;
}

/**
 * "Every row complete", the exit criterion of plan M10a.2: one attempt per task of the plan, taken by
 * the agent of its role, with every host figure reported, a packet delivered and the work verified.
 */
export function baselineVerdict(report: UsageReport, expected: readonly ExpectedAttempt[]): Verdict {
  const required: Record<string, boolean> = {
    'one attempt per task, and no other attempt': report.rows.length === expected.length,
  };
  for (const e of expected) {
    const rows = report.rows.filter((r) => r.task_id === e.task_id);
    Object.assign(required, rowRequirements(e.key, rows.length === 1 ? rows[0] : undefined, e.agent_key));
  }
  return verdict(required);
}

type Reads = Record<string, () => Promise<unknown>>;
type ReadValues<T extends Reads> = { [K in keyof T]: Awaited<ReturnType<T[K]>> | null };

/**
 * Several reads of what a run showed, each on its own: a read that fails is named under `failures`
 * and its value is null, and the other reads are kept. The usage report, its table and the hosts
 * are read this way at the end of a run, whatever it reached, so one attempt's stall never loses
 * the other attempt's row.
 */
export async function eachOnItsOwn<T extends Reads>(
  reads: T,
): Promise<{ values: ReadValues<T>; failures: Record<string, string> }> {
  const values: Record<string, unknown> = {};
  const failures: Record<string, string> = {};
  for (const [name, read] of Object.entries(reads)) {
    try {
      values[name] = await read();
    } catch (e) {
      values[name] = null;
      failures[name] = e instanceof Error ? e.message : String(e);
    }
  }
  return { values: values as ReadValues<T>, failures };
}

/** Every event of a project, oldest first, read page by page from the store. */
export function allEvents<E extends { sequence: number }>(
  store: { readSince(projectId: string, since: number, opts: { limit: number }): E[] },
  projectId: string,
  pageSize = 500,
): E[] {
  const out: E[] = [];
  let since = 0;
  for (;;) {
    const page = store.readSince(projectId, since, { limit: pageSize });
    out.push(...page);
    const last = page.at(-1);
    if (!last || page.length < pageSize) return out;
    since = last.sequence;
  }
}
