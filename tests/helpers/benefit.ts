/**
 * The benefit comparison (docs/measurements/README.md): the same goal done three ways on the same
 * host and model, judged by the same hidden checks afterwards. What the live test
 * `tests/scenarios/benefit.live.test.ts` runs and measures lives here as small functions, so the
 * grader and the prompts are tested offline (`tests/scenarios/benefit.helpers.test.ts`).
 *
 * The three ways:
 * - `plain-one`: Claude Code alone, one session given the whole goal;
 * - `plain-two`: two Claude Code sessions at once in the same folder, one task each, the usual way
 *   to work in parallel without Friday;
 * - `friday`: Friday plans the goal from the same tasks, gives each to a spawned Claude Code agent
 *   in its own worktree, verifies each claim with the project's tests, sends a failed one back once,
 *   and integrates verified work into the goal's branch;
 * - `friday-one`: the same, with the plan the Master Brain proposes for this goal (plan M13.1): its
 *   two tasks run one after another on the shared contract, so they are one task for one agent.
 *
 * Two goals (`BENEFIT_GOALS`): `contract`, whose two tasks both change the shared contract, and
 * `trap` (plan M14.3), whose obvious solutions go wrong: the shop's price formatter is relied on by
 * another area, and the shop's rules (no floating point on money, neither side importing the other)
 * are written in its decisions and checked by its own script, which no task text mentions.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FINAL_SCHEMA } from '@friday/adapter-generic';
import { consolidatePlan, formatIssues, PlanDraft } from '@friday/planner';
import { deterministicGit, killTree } from '@friday/test-support';
import { REPO_ROOT } from './cli.js';
import type { Msg } from './live-claude.js';
import type { TraceLine, TurnBudget } from './token-baseline.js';

export const BENEFIT_PLAN_FILE = path.join(REPO_ROOT, 'tests', 'fixtures', 'benefit', 'plan.json');
export const BENEFIT_HIDDEN_TESTS = path.join(REPO_ROOT, 'tests', 'fixtures', 'benefit', 'acceptance.hidden.test.mjs');
export const BENEFIT_ARMS = ['plain-one', 'plain-two', 'friday', 'friday-one'] as const;
export type BenefitArm = (typeof BENEFIT_ARMS)[number];

/** The spawned agents of the Friday arm, each of the role of the task it takes. */
export const BENEFIT_AGENTS = [
  { key: 'fe-1', role: 'frontend', task: 'giftcard-frontend' },
  { key: 'be-1', role: 'backend', task: 'discount-backend' },
] as const;

/** The hidden checks of each task; `contract` belongs to both. */
export const TASK_CHECKS: Record<string, string[]> = {
  'giftcard-frontend': [
    'contract: the existing fields are kept',
    'frontend: the contract carries the gift card and the amount applied',
    'frontend: no gift card gives no line',
    'frontend: an amount of 0 gives no line',
    'frontend: an amount gives the formatted line',
  ],
  'discount-backend': [
    'contract: the existing fields are kept',
    'backend: the contract carries the discount code',
    'backend: SAVE10 takes 10% off',
    'backend: codes match without regard to case',
    'backend: the discount is rounded down to a whole minor unit',
    'backend: an unknown, empty or missing code changes nothing',
  ],
};

const TRAP_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'benefit-trap');

/** A goal the comparison runs: its plan, its hidden checks, its agents, and how its shop is made. */
export interface BenefitGoal {
  name: 'contract' | 'trap';
  planFile: string;
  hiddenTests: string;
  /** The spawned agents of the Friday arm, each of the role of the task it takes. */
  agents: readonly { key: string; role: string; task: string }[];
  /** The hidden checks of each task. */
  taskChecks: Record<string, string[]>;
  /** The arms that apply: `friday-one` only where the plan's tasks merge into one. */
  arms: readonly BenefitArm[];
  /** Changes a fresh copy of the fixture shop before an arm starts, and commits the change. */
  prepare?: (root: string) => Promise<void>;
}

/** The shop's rules, appended to its decisions in the trap goal. */
const TRAP_DECISION = [
  '',
  '## ADR-003 Each side keeps to its own code, and the rules are checked',
  'Code both sides need lives in `shared/`: the backend never imports from `frontend/`, as the frontend never',
  'imports from `backend/` (ADR-002). Money is formatted from its integer minor units, never through floating',
  'point: no `toFixed`, `parseFloat`, `Intl.NumberFormat` or `toLocaleString` on amounts (ADR-001).',
  '`node scripts/check.mjs` checks both rules; run it with the tests before you hand in a change.',
  '',
].join('\n');

/** The trap goal's shop: the cart summary, the rule check, the decision and the check in Friday's configuration. */
export async function prepareTrapShop(root: string): Promise<void> {
  cpSync(path.join(TRAP_DIR, 'shop'), root, { recursive: true });
  const patch = (rel: string, change: (text: string) => string) => {
    const file = path.join(root, rel);
    const before = readFileSync(file, 'utf8');
    const after = change(before);
    if (after === before) throw new Error(`the trap shop could not change ${rel}`);
    writeFileSync(file, after);
  };
  patch('DECISIONS.md', (t) => `${t.trimEnd()}\n${TRAP_DECISION}`);
  patch(
    'README.md',
    (t) => `${t.trimEnd()}\n\nCheck the shop's rules with \`node scripts/check.mjs\` (DECISIONS.md ADR-003).\n`,
  );
  patch('package.json', (t) => {
    const pkg = JSON.parse(t) as { scripts: Record<string, string> };
    pkg.scripts.check = 'node scripts/check.mjs';
    return `${JSON.stringify(pkg, null, 2)}\n`;
  });
  patch('.friday/config.yaml', (t) =>
    t.replace(
      '      timeout_ms: 120000\n',
      [
        '      timeout_ms: 120000',
        '    - name: rules',
        '      kind: lint',
        '      command: node',
        '      args: ["scripts/check.mjs"]',
        '      timeout_ms: 60000',
        '',
      ].join('\n'),
    ),
  );
  await deterministicGit(root, { startEpoch: 1_767_250_000 }).commitAll("feat: cart summary and the shop's rules");
}

export const BENEFIT_GOALS: Record<BenefitGoal['name'], BenefitGoal> = {
  contract: {
    name: 'contract',
    planFile: BENEFIT_PLAN_FILE,
    hiddenTests: BENEFIT_HIDDEN_TESTS,
    agents: BENEFIT_AGENTS,
    taskChecks: TASK_CHECKS,
    arms: BENEFIT_ARMS,
  },
  trap: {
    name: 'trap',
    planFile: path.join(TRAP_DIR, 'plan.json'),
    hiddenTests: path.join(TRAP_DIR, 'acceptance.hidden.test.mjs'),
    agents: [
      { key: 'fe-1', role: 'frontend', task: 'receipt-frontend' },
      { key: 'be-1', role: 'backend', task: 'refund-backend' },
    ],
    taskChecks: {
      'receipt-frontend': [
        'shop: the shared tests are unchanged',
        'frontend: formatPrice gives what it gave',
        'frontend: the cart summary gives what it gave',
        'frontend: the existing tests are unchanged',
        "frontend: the shop's rules hold",
        'receipt: EUR, USD and GBP put the symbol first',
        'receipt: thousands are grouped with commas',
        'receipt: a negative amount puts the minus before the symbol',
        'receipt: another currency is shown as formatPrice shows it',
      ],
      'refund-backend': [
        'shop: the shared tests are unchanged',
        'backend: the existing tests are unchanged',
        "backend: the shop's rules hold",
        'refund: EUR, USD and GBP put the symbol first',
        'refund: thousands are grouped with commas',
        'refund: another currency is written with its code',
        'refund: an amount of zero or less is refused',
      ],
    },
    // Its two tasks are independent, so nothing merges: friday-one would be the friday arm again.
    arms: ['plain-one', 'plain-two', 'friday'],
    prepare: prepareTrapShop,
  },
};

/** The goal `FRIDAY_BENEFIT_GOAL` names (`contract` when unset). */
export function benefitGoal(name: string | undefined): BenefitGoal {
  const goal = BENEFIT_GOALS[(name ?? 'contract') as BenefitGoal['name']];
  if (!goal) throw new Error(`unknown goal ${name}: ${Object.keys(BENEFIT_GOALS).join(', ')}`);
  return goal;
}

/** The plan fixture, validated as `friday plan propose --file` validates it. */
export function loadBenefitPlan(file: string = BENEFIT_PLAN_FILE): PlanDraft {
  const parsed = PlanDraft.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) throw new Error(`${file} is not a plan: ${formatIssues(parsed.error).join('; ')}`);
  return parsed.data;
}

/** The benefit plan as the Master Brain proposes it (plan M13.1): its serial tasks merged into one. */
export function oneTaskPlan(plan: PlanDraft): { plan: PlanDraft; merged: string[] } {
  const c = consolidatePlan(plan);
  if (!c.merged) throw new Error('the benefit plan was expected to merge into one task');
  return { plan: c.draft, merged: c.merged };
}

type PlanTask = PlanDraft['tasks'][number];

const taskText = (t: PlanTask) =>
  [
    t.summary,
    '',
    t.description ?? '',
    ...(t.acceptance_criteria.length
      ? ['', 'Acceptance criteria:', ...t.acceptance_criteria.map((c) => `- ${c}`)]
      : []),
  ].join('\n');

const FINAL_LINE =
  'When you are done, give the final answer in the structured format you were given: status "completed" and a short summary, or status "blocked" with the reason in blocked_reason.';

/** The prompt of the single plain session: the goal and both tasks, as the plan states them. */
export function plainOnePrompt(plan: PlanDraft): string {
  return [
    `Goal: ${plan.objective}`,
    '',
    ...plan.tasks.flatMap((t, i) => [`Task ${i + 1}: ${taskText(t)}`, '']),
    'Do both tasks in this folder.',
    FINAL_LINE,
  ].join('\n');
}

/** The prompt of one of the two plain sessions working at once in the same folder. */
export function plainTwoPrompt(plan: PlanDraft, key: string): string {
  const t = plan.tasks.find((x) => x.key === key);
  if (!t) throw new Error(`the plan has no task ${key}`);
  const others = plan.tasks.filter((x) => x.key !== key).map((x) => x.summary);
  return [
    `Goal: ${plan.objective}`,
    '',
    `Your task: ${taskText(t)}`,
    '',
    `Another developer works at the same time in this same folder on: ${others.join('; ')}.`,
    FINAL_LINE,
  ].join('\n');
}

export interface ToolCall {
  name: string;
  error: string | null;
}

export interface SessionFigures {
  /** Model calls, counted by grouping consecutive assistant messages that carry the same usage. */
  calls: number;
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
  /** Uncached input plus cache reads plus cache writes: what the model was given across its calls. */
  input_side: number | null;
  cost_usd: number | null;
  /** The final answer's status, or null when the session gave none. */
  claimed: 'completed' | 'blocked' | null;
  tool_calls: number;
  tool_errors: string[];
  seconds: number | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** What one Claude Code session spent and said, from its stream-json lines. */
export function sessionFigures(lines: readonly TraceLine[]): SessionFigures {
  const received = lines.filter((l) => l.dir === 'receive');
  let calls = 0;
  let last = '';
  const toolNames = new Map<string, string>();
  const errors: string[] = [];
  let toolCalls = 0;
  /** A message's content blocks, or none. */
  const blocks = (content: unknown): Record<string, unknown>[] =>
    Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
  for (const l of received) {
    const m = l.msg as Msg & { message?: { usage?: unknown; content?: unknown } };
    if (m.type === 'assistant') {
      const key = JSON.stringify(m.message?.usage ?? null);
      if (key !== last) calls += 1;
      last = key;
      for (const c of blocks(m.message?.content)) {
        if (c.type === 'tool_use') {
          toolCalls += 1;
          toolNames.set(String(c.id), String(c.name));
        }
      }
    } else if (m.type === 'user') {
      for (const c of blocks(m.message?.content)) {
        if (c.type === 'tool_result' && c.is_error === true) {
          const text = typeof c.content === 'string' ? c.content : JSON.stringify(c.content);
          errors.push(`${toolNames.get(String(c.tool_use_id)) ?? 'tool'}: ${text.slice(0, 160)}`);
        }
      }
    }
  }
  const result = [...received].reverse().find((l) => l.msg.type === 'result')?.msg as
    | (Msg & {
        usage?: Record<string, unknown>;
        total_cost_usd?: unknown;
        structured_output?: unknown;
        duration_ms?: unknown;
      })
    | undefined;
  const u = result?.usage ?? {};
  const input = num(u.input_tokens);
  const read = num(u.cache_read_input_tokens);
  const write = num(u.cache_creation_input_tokens);
  const status = (result?.structured_output as { status?: unknown } | undefined)?.status;
  return {
    calls,
    input,
    output: num(u.output_tokens),
    cache_read: read,
    cache_write: write,
    input_side: input === null && read === null && write === null ? null : (input ?? 0) + (read ?? 0) + (write ?? 0),
    cost_usd: num(result?.total_cost_usd),
    claimed: status === 'completed' || status === 'blocked' ? status : null,
    tool_calls: toolCalls,
    tool_errors: errors,
    seconds: num(result?.duration_ms) === null ? null : Math.round((result?.duration_ms as number) / 100) / 10,
  };
}

/**
 * One agent's trace cut into its sessions: a session starts at a message that starts a turn (the
 * task, or a rework's new attempt), so each session's result is read on its own.
 */
export function splitSessions(lines: readonly TraceLine[]): TraceLine[][] {
  const out: TraceLine[][] = [];
  for (const l of lines) {
    const starts = l.dir === 'send' && l.msg.type === 'user' && typeof l.msg.message?.content === 'string';
    if (starts || out.length === 0) out.push([]);
    out[out.length - 1]?.push(l);
  }
  return out.filter((s) => s.some((l) => l.dir === 'receive'));
}

/** The top-level results of a `node --test --test-reporter=tap` run, by test name. */
export function parseTap(text: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const m = /^(not ok|ok) \d+ - (.+?)(?:\s+#.*)?$/.exec(line);
    if (m?.[2]) out[m[2]] = m[1] === 'ok';
  }
  return out;
}

export interface TreeVerdict {
  /** The project's own tests (`node --test "**\/test/*.test.ts"`) on the final code. */
  project: { passed: boolean; pass: number | null; fail: number | null };
  /** Each hidden check, by name. */
  checks: Record<string, boolean>;
  /** Each task: all its hidden checks and the project's tests pass. */
  tasks: Record<string, boolean>;
}

const tapCount = (text: string, what: 'pass' | 'fail') =>
  num(Number(new RegExp(`^# ${what} (\\d+)`, 'm').exec(text)?.[1]));

/** Judges a folder's final code: the project's tests, then the goal's hidden checks, each run by Node. */
export function judgeTree(dir: string, goal: BenefitGoal = BENEFIT_GOALS.contract): TreeVerdict {
  const project = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '**/test/*.test.ts'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  });
  const projectOut = `${project.stdout ?? ''}`;
  const hidden = spawnSync(process.execPath, ['--test', '--test-reporter=tap', goal.hiddenTests], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
    env: { ...process.env, BENEFIT_TREE: dir },
  });
  const checks = parseTap(`${hidden.stdout ?? ''}`);
  const passed = project.status === 0;
  const tasks = Object.fromEntries(
    Object.entries(goal.taskChecks).map(([key, names]) => [key, passed && names.every((n) => checks[n] === true)]),
  );
  return {
    project: { passed, pass: tapCount(projectOut, 'pass'), fail: tapCount(projectOut, 'fail') },
    checks,
    tasks,
  };
}

/** The commands a plain session may run without a prompt (Claude Code's rule syntax for each shell). */
export const PLAIN_ALLOWED = [
  ...[
    'node',
    'cd',
    'pwd',
    'ls',
    'cat',
    'head',
    'tail',
    'grep',
    'find',
    'wc',
    'git status',
    'git diff',
    'git log',
    'git show',
  ].map((c) => `Bash(${c}:*)`),
  ...[
    'node',
    'cd',
    'Set-Location',
    'Get-Location',
    'Get-ChildItem',
    'Get-Content',
    'Select-String',
    'git status',
    'git diff',
    'git log',
    'git show',
  ].map((c) => `PowerShell(${c} *)`),
];

/** The flags of a plain Claude Code session: Claude Code alone, as near Friday's spawned sessions as fairness allows. */
export function plainArgs(model: string, capUsd: number): string[] {
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    // No settings of the user's or the folder's, and no MCP server: the same start as Friday's sessions.
    '--restricted',
    '--strict-mcp-config',
    '--tools',
    'Read,Glob,Grep,Edit,Write,NotebookEdit,Bash,PowerShell',
    // File edits in the folder, and the commands Friday's policy lets its agents run without asking
    // (running the tests, moving between folders, reading files and git), in both shells the
    // session has; nothing else. A narrower list refused the plain sessions' own test runs.
    '--permission-mode',
    'acceptEdits',
    '--allowedTools',
    ...PLAIN_ALLOWED,
    '--permission-prompts',
    'none',
    '--disable-slash-commands',
    '--json-schema',
    JSON.stringify(FINAL_SCHEMA),
    '--model',
    model,
    '--max-budget-usd',
    String(capUsd),
  ];
}

export interface PlainSession {
  key: string;
  lines: TraceLine[];
  startedAt: number;
  endedAt: number;
  exit: number | null;
  stderr: string;
}

/**
 * One plain Claude Code session: the prompt as its only message, under the run's turn budget, read
 * until its result; stopped, with everything it started, at the deadline.
 */
export async function runPlainSession(o: {
  key: string;
  binary: string;
  cwd: string;
  prompt: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  budget: TurnBudget;
  timeoutMs: number;
}): Promise<PlainSession> {
  o.budget.start(o.prompt);
  const lines: TraceLine[] = [];
  const startedAt = Date.now();
  const child = spawn(o.binary, o.args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  let buffered = '';
  let gotResult = false;
  child.stderr.on('data', (d: Buffer) => {
    stderr += d.toString('utf8');
  });
  child.stdout.on('data', (d: Buffer) => {
    buffered += d.toString('utf8');
    let nl = buffered.indexOf('\n');
    while (nl >= 0) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      nl = buffered.indexOf('\n');
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as Msg;
        lines.push({ t: Date.now(), dir: 'receive', msg });
        if (msg.type === 'result' && !gotResult) {
          gotResult = true;
          child.stdin.end();
        }
      } catch {
        // not a stream-json line
      }
    }
  });
  const message = { type: 'user', message: { role: 'user', content: o.prompt } };
  lines.push({ t: Date.now(), dir: 'send', msg: message as Msg });
  child.stdin.write(`${JSON.stringify(message)}\n`);
  const exit = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      void killTree(child.pid).finally(() => resolve(null));
    }, o.timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  // A session that gave its result but left a child running is ended with it.
  if (child.pid && exit === null) await killTree(child.pid).catch(() => undefined);
  return { key: o.key, lines, startedAt, endedAt: Date.now(), exit, stderr: stderr.slice(-2000) };
}

export interface ArmFigures {
  arm: BenefitArm;
  run: number;
  seconds: number;
  sessions: Record<string, SessionFigures>;
  totals: {
    input_side: number | null;
    output: number | null;
    cost_usd: number | null;
    calls: number;
    sessions: number;
    tool_errors: number;
  };
  verdict: TreeVerdict;
  /** Tasks whose session (or Friday) said they were done. */
  claimed_done: string[];
  /** Claimed done, but its hidden checks or the project's tests fail on the final code. */
  false_done: string[];
  /** Friday only: claims its verification refused, and the reworks that followed. */
  refused_claims?: number;
  reworks?: number;
  /** Friday only: the agents' requests for more authority a human refused, and the writes and commands Friday's hooks refused. */
  refused_requests?: number;
  refused_calls?: number;
  /** The hidden checks that failed on the final code. */
  failed_checks?: string[];
}

const sum = (xs: (number | null)[]): number | null =>
  xs.every((x) => x === null) ? null : xs.reduce<number>((a, x) => a + (x ?? 0), 0);

/** The totals of an arm's sessions. */
export function totalsOf(sessions: readonly SessionFigures[]): ArmFigures['totals'] {
  return {
    input_side: sum(sessions.map((s) => s.input_side)),
    output: sum(sessions.map((s) => s.output)),
    cost_usd: sum(sessions.map((s) => s.cost_usd)),
    calls: sessions.reduce((a, s) => a + s.calls, 0),
    sessions: sessions.length,
    tool_errors: sessions.reduce((a, s) => a + s.tool_errors.length, 0),
  };
}

/** One line per arm and run, for the record. */
export function summaryTable(rows: readonly ArmFigures[]): string {
  const head = [
    'ARM',
    'RUN',
    'TASKS OK',
    'PROJECT TESTS',
    'FALSE DONE',
    'INPUT SIDE',
    'OUTPUT',
    'CALLS',
    'SESSIONS',
    'TOOL ERRORS',
    'SECONDS',
  ];
  const body = rows.map((r) => [
    r.arm,
    String(r.run),
    `${Object.values(r.verdict.tasks).filter(Boolean).length}/${Object.keys(r.verdict.tasks).length}`,
    r.verdict.project.passed ? 'pass' : 'FAIL',
    String(r.false_done.length),
    r.totals.input_side === null ? '-' : String(r.totals.input_side),
    r.totals.output === null ? '-' : String(r.totals.output),
    String(r.totals.calls),
    String(r.totals.sessions),
    String(r.totals.tool_errors),
    String(r.seconds),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => (b[i] ?? '').length)));
  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  return [fmt(head), fmt(widths.map((w) => '-'.repeat(w))), ...body.map(fmt)].join('\n');
}
