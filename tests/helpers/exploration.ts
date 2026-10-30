/**
 * What a coding session spends on finding its way (the exploration measurement): from a Claude Code
 * stream-json transcript, every tool call sorted by what it did, with the tokens its result added to
 * the conversation and what that result cost over the calls that followed (each later call carries
 * it, mostly as cached input). The share of a session's input that searches and reads of files it
 * never changed account for is the most a better map of the code could save it. Whether the
 * session's change was right is judged apart, on a clone with the dependencies installed.
 */
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { matchesAny } from '@friday/policy';
import { parseTap } from './benefit.js';
import type { Msg } from './live-claude.js';
import type { TraceLine } from './token-baseline.js';

const run = promisify(execFile);

export type ToolClass = 'edit' | 'read-edited' | 'read-other' | 'search' | 'shell' | 'other';

export interface ToolUse {
  id: string;
  name: string;
  /** The file it read or wrote, relative to the session's folder, or its pattern or command. */
  target: string;
  /** The model call it was made in (1-based); its result enters every call after it. */
  call: number;
  result_tokens: number;
  /** What its result cost: its tokens times the calls that carried it. */
  carried_tokens: number;
  class: ToolClass;
}

export interface ClassFigures {
  calls: number;
  result_tokens: number;
  carried_tokens: number;
}

export interface ExplorationFigures {
  calls: number;
  /** Uncached input plus cache reads plus cache writes, as the session's result reports them. */
  input_side: number | null;
  output: number | null;
  cost_usd: number | null;
  /** The first call's input: the host's own instructions and tools, the prompt and any packet. */
  first_call_input: number | null;
  /** Seconds from the prompt to the first edit, or null when the session edited nothing. */
  first_edit_s: number | null;
  /** The final answer's status, or null when the session gave none. */
  claimed: 'completed' | 'blocked' | null;
  edited: string[];
  tools: ToolUse[];
  by_class: Record<ToolClass, ClassFigures>;
  /** Searches and reads of files never changed: what they cost over the session. */
  exploration_carried: number;
  /** That cost as a share of the session's input side (0 to 1), or null without a reported input. */
  exploration_share: number | null;
}

/** Tokens of a text, the rough rule of four characters to a token. */
export const tokensOf = (chars: number) => Math.ceil(chars / 4);

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const READ = new Set(['Read', 'NotebookRead']);
const EDIT = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const SEARCH = new Set(['Glob', 'Grep', 'LS']);
const SHELL = new Set(['Bash', 'PowerShell']);

function relative(cwd: string, file: string): string {
  const rel = path.relative(cwd, path.resolve(cwd, file)).split(path.sep).join('/');
  return process.platform === 'win32' ? rel.toLowerCase() : rel;
}

function resultChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content))
    return content.reduce<number>(
      (a, c) => a + (typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text.length : 0),
      0,
    );
  return JSON.stringify(content ?? '').length;
}

/** The exploration figures of one session, from its stream-json lines; `cwd` is the folder it worked in. */
export function explorationFigures(lines: readonly TraceLine[], cwd: string): ExplorationFigures {
  const received = lines.filter((l) => l.dir === 'receive');
  const sentAt = lines.find((l) => l.dir === 'send')?.t ?? null;
  let calls = 0;
  let last = '';
  let firstInput: number | null = null;
  let firstEditAt: number | null = null;
  const uses = new Map<string, ToolUse>();
  const order: ToolUse[] = [];
  const blocks = (content: unknown): Record<string, unknown>[] =>
    Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
  for (const l of received) {
    const m = l.msg as Msg & { message?: { usage?: Record<string, unknown>; content?: unknown } };
    if (m.type === 'assistant') {
      const key = JSON.stringify(m.message?.usage ?? null);
      if (key !== last) {
        calls += 1;
        if (calls === 1) {
          const u = m.message?.usage ?? {};
          firstInput =
            (num(u.input_tokens) ?? 0) +
            (num(u.cache_read_input_tokens) ?? 0) +
            (num(u.cache_creation_input_tokens) ?? 0);
        }
      }
      last = key;
      for (const c of blocks(m.message?.content)) {
        if (c.type !== 'tool_use') continue;
        const input = (c.input ?? {}) as Record<string, unknown>;
        const name = String(c.name);
        if (EDIT.has(name) && firstEditAt === null) firstEditAt = l.t;
        const file =
          typeof input.file_path === 'string'
            ? input.file_path
            : typeof input.notebook_path === 'string'
              ? input.notebook_path
              : null;
        const target = file
          ? relative(cwd, file)
          : String(input.pattern ?? input.command ?? input.path ?? '').slice(0, 300);
        const use: ToolUse = {
          id: String(c.id),
          name,
          target,
          call: calls,
          result_tokens: 0,
          carried_tokens: 0,
          class: 'other',
        };
        uses.set(use.id, use);
        order.push(use);
      }
    } else if (m.type === 'user') {
      for (const c of blocks(m.message?.content)) {
        if (c.type !== 'tool_result') continue;
        const use = uses.get(String(c.tool_use_id));
        if (use) use.result_tokens = tokensOf(resultChars(c.content));
      }
    }
  }
  const edited = [...new Set(order.filter((u) => EDIT.has(u.name)).map((u) => u.target))].sort();
  const by_class = Object.fromEntries(
    (['edit', 'read-edited', 'read-other', 'search', 'shell', 'other'] as const).map((k) => [
      k,
      { calls: 0, result_tokens: 0, carried_tokens: 0 },
    ]),
  ) as Record<ToolClass, ClassFigures>;
  for (const u of order) {
    u.class = EDIT.has(u.name)
      ? 'edit'
      : READ.has(u.name)
        ? edited.includes(u.target)
          ? 'read-edited'
          : 'read-other'
        : SEARCH.has(u.name)
          ? 'search'
          : SHELL.has(u.name)
            ? 'shell'
            : 'other';
    // Its result is in the input of every call after the one that asked for it.
    u.carried_tokens = u.result_tokens * Math.max(0, calls - u.call);
    const f = by_class[u.class];
    f.calls += 1;
    f.result_tokens += u.result_tokens;
    f.carried_tokens += u.carried_tokens;
  }
  const result = [...received].reverse().find((l) => l.msg.type === 'result')?.msg as
    | (Msg & { usage?: Record<string, unknown>; total_cost_usd?: unknown; structured_output?: unknown })
    | undefined;
  const usage = result?.usage ?? {};
  const input = num(usage.input_tokens);
  const read = num(usage.cache_read_input_tokens);
  const write = num(usage.cache_creation_input_tokens);
  const input_side =
    input === null && read === null && write === null ? null : (input ?? 0) + (read ?? 0) + (write ?? 0);
  const exploration_carried = by_class['read-other'].carried_tokens + by_class.search.carried_tokens;
  const status = (result?.structured_output as { status?: unknown } | undefined)?.status;
  return {
    calls,
    input_side,
    output: num(usage.output_tokens),
    cost_usd: num(result?.total_cost_usd),
    first_call_input: firstInput,
    first_edit_s: sentAt !== null && firstEditAt !== null ? Math.round((firstEditAt - sentAt) / 100) / 10 : null,
    claimed: status === 'completed' || status === 'blocked' ? status : null,
    edited,
    tools: order,
    by_class,
    exploration_carried,
    exploration_share: input_side ? Math.round((exploration_carried / input_side) * 1000) / 1000 : null,
  };
}

/** The project's own tests that a task's acceptance criteria name, run on the judge clone. */
export const ACCEPTANCE_TESTS: Record<string, string[]> = {
  'cli-usage-read-share': ['tests/integration/usage.test.ts', 'apps/cli/src/usage.test.ts'],
  'verification-scope-glob': ['packages/verification/src/analysis.test.ts'],
};

export interface Judgement {
  /** The files the session changed, as git lists them. */
  changed: string[];
  /** Those outside the task's write scope. */
  outside: string[];
  build_ok: boolean;
  /** The acceptance tests' result, or null when the build failed so they never ran. */
  acceptance_ok: boolean | null;
  /** Each hidden check of the task, by name. */
  checks: Record<string, boolean>;
  /** The build, the acceptance tests and every hidden check pass, and nothing outside the scope changed. */
  correct: boolean;
  /** The same, whatever the scope: what a plain session, told no scope, can be held to. */
  correct_ignoring_scope: boolean;
  notes: string[];
}

const git = (cwd: string, args: string[]) =>
  run('git', args, { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).then((r) => r.stdout);

/** Runs pnpm in a folder; on Windows through cmd.exe, since pnpm is a .cmd launcher there (the arguments are fixed words). */
const pnpm = (cwd: string, args: string[]) =>
  process.platform === 'win32'
    ? run('cmd.exe', ['/d', '/s', '/c', `pnpm ${args.join(' ')}`], {
        cwd,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
      })
    : run('pnpm', args, { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });

/** Installs the dependencies into a clone (from this machine's store, nothing fetched) and builds it. */
export async function prepareJudge(judge: string): Promise<void> {
  await pnpm(judge, ['install', '--offline', '--frozen-lockfile']);
  await pnpm(judge, ['build']);
}

/**
 * Judges a session's change: it is taken from the session's clone as a patch, applied to the judge
 * clone (reset first), built, and run through the task's acceptance tests and its hidden checks.
 */
export async function judgeChange(o: {
  judge: string;
  session: string;
  taskId: string;
  write: readonly string[];
  acceptanceTests: readonly string[];
  hidden: string;
}): Promise<Judgement> {
  const notes: string[] = [];
  await git(o.session, ['add', '-A']);
  const changed = (await git(o.session, ['diff', '--cached', '--name-only']))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .sort();
  const patch = await git(o.session, ['diff', '--cached', '--binary']);
  const outside = changed.filter((p) => !matchesAny(p, o.write));
  await git(o.judge, ['reset', '--hard', '--quiet']);
  await git(o.judge, ['clean', '-fdq']);
  const fail = (why: string): Judgement => {
    notes.push(why);
    return {
      changed,
      outside,
      build_ok: false,
      acceptance_ok: null,
      checks: {},
      correct: false,
      correct_ignoring_scope: false,
      notes,
    };
  };
  if (patch.trim()) {
    // Beside the judge, never inside it: the judge is reset and cleaned before each change.
    const file = path.join(path.dirname(o.judge), `${path.basename(o.judge)}.patch`);
    writeFileSync(file, patch);
    try {
      await git(o.judge, ['apply', '--whitespace=nowarn', file]);
    } catch (e) {
      return fail(`the change could not be applied: ${(e as Error).message.slice(0, 300)}`);
    }
  } else notes.push('the session changed nothing');
  try {
    await pnpm(o.judge, ['build']);
  } catch (e) {
    const text = `${(e as { stdout?: string }).stdout ?? ''}\n${(e as { stderr?: string }).stderr ?? ''}`;
    const errors = text.split('\n').filter((l) => /error TS\d+/.test(l));
    return fail(`the build failed: ${(errors[0] ?? text.trim().split('\n').at(-1) ?? '').slice(0, 300)}`);
  }
  let acceptance_ok = true;
  if (o.acceptanceTests.length) {
    try {
      await pnpm(o.judge, ['vitest', 'run', ...o.acceptanceTests]);
    } catch (e) {
      acceptance_ok = false;
      const text = `${(e as { stdout?: string }).stdout ?? ''}`;
      notes.push(`acceptance tests failed: ${(text.match(/Tests\s+.*$/m)?.[0] ?? '').trim()}`);
    }
  }
  const tap = await run(process.execPath, ['--test', '--test-reporter=tap', o.hidden], {
    cwd: o.judge,
    windowsHide: true,
    env: { ...process.env, EXPLORE_TREE: o.judge },
    maxBuffer: 16 * 1024 * 1024,
  }).then(
    (r) => r.stdout,
    (e: { stdout?: string }) => e.stdout ?? '',
  );
  const checks = Object.fromEntries(Object.entries(parseTap(tap)).filter(([name]) => name.startsWith(`${o.taskId}:`)));
  const checksOk = Object.keys(checks).length > 0 && Object.values(checks).every(Boolean);
  const correct_ignoring_scope = acceptance_ok && checksOk;
  return {
    changed,
    outside,
    build_ok: true,
    acceptance_ok,
    checks,
    correct: correct_ignoring_scope && outside.length === 0,
    correct_ignoring_scope,
    notes,
  };
}

export interface SessionRow {
  task: string;
  arm: string;
  run: number;
  seconds: number;
  figures: ExplorationFigures;
  packet_chars: number;
  /** Reads of files the packet named, and of files it did not. */
  reads_named_in_packet: number;
  reads_not_named: number;
  judgement: Judgement;
}

const table = (head: string[], body: string[][]): string => {
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => (b[i] ?? '').length)));
  const fmt = (cells: string[]) => cells.map((x, i) => x.padEnd(widths[i] ?? 0)).join('  ');
  return [fmt(head), ...body.map(fmt)].join('\n');
};

/** One line per session. */
export function sessionTable(rows: readonly SessionRow[]): string {
  const head = [
    'TASK',
    'WAY',
    'RUN',
    'CALLS',
    'INPUT SIDE',
    'COST',
    'SECONDS',
    'FIRST EDIT',
    'READS NAMED/NOT',
    'UNCHANGED READS',
    'EXPLORE',
    'CHANGED',
    'OUTSIDE',
    'BUILD',
    'TESTS',
    'CHECKS',
    'CORRECT',
  ];
  const body = rows.map((r) => {
    const f = r.figures;
    const j = r.judgement;
    return [
      r.task,
      r.arm,
      String(r.run),
      String(f.calls),
      String(f.input_side ?? '-'),
      f.cost_usd === null ? '-' : f.cost_usd.toFixed(4),
      String(r.seconds),
      f.first_edit_s === null ? '-' : `${f.first_edit_s}s`,
      `${r.reads_named_in_packet}/${r.reads_not_named}`,
      String(f.by_class['read-other'].calls),
      f.exploration_share === null ? '-' : `${Math.round(f.exploration_share * 100)}%`,
      String(j.changed.length),
      String(j.outside.length),
      j.build_ok ? 'ok' : 'FAIL',
      j.acceptance_ok === null ? '-' : j.acceptance_ok ? 'pass' : 'FAIL',
      `${Object.values(j.checks).filter(Boolean).length}/${Object.keys(j.checks).length}`,
      j.correct ? 'yes' : j.correct_ignoring_scope ? 'scope' : 'no',
    ];
  });
  return table(head, body);
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

/** The medians of each way over every task and run: what the decision reads. */
export function conditionSummary(rows: readonly SessionRow[]): string {
  const arms = [...new Set(rows.map((r) => r.arm))];
  const head = [
    'WAY',
    'SESSIONS',
    'CORRECT',
    'CORRECT (SCOPE ASIDE)',
    'MEDIAN COST',
    'MEDIAN INPUT',
    'MEDIAN UNCHANGED READS',
    'MEDIAN FIRST EDIT',
  ];
  const body = arms.map((arm) => {
    const mine = rows.filter((r) => r.arm === arm);
    const costs = mine.map((r) => r.figures.cost_usd).filter((x): x is number => x !== null);
    const inputs = mine.map((r) => r.figures.input_side).filter((x): x is number => x !== null);
    const edits = mine.map((r) => r.figures.first_edit_s).filter((x): x is number => x !== null);
    const cost = median(costs);
    const input = median(inputs);
    const edit = median(edits);
    return [
      arm,
      String(mine.length),
      `${mine.filter((r) => r.judgement.correct).length}/${mine.length}`,
      `${mine.filter((r) => r.judgement.correct_ignoring_scope).length}/${mine.length}`,
      cost === null ? '-' : cost.toFixed(4),
      input === null ? '-' : String(Math.round(input)),
      String(median(mine.map((r) => r.figures.by_class['read-other'].calls)) ?? '-'),
      edit === null ? '-' : `${Math.round(edit * 10) / 10}s`,
    ];
  });
  return table(head, body);
}
