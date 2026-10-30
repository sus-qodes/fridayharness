/**
 * The exploration measurement on a large repository (docs/measurements/2026-10-20-exploration.md):
 * what a coding session spends on finding its way, whether Friday's packet changes that, and
 * whether the change is still right. Tasks of the context evals (tests/evals/context-evals.json),
 * each done on a fresh clone of this repository (about 1,200 files) by a Claude Code session on
 * claude-haiku-5-5, restricted as the benefit comparison's plain sessions are, in three ways:
 *   plain    the task as the prompt, nothing else;
 *   packet   the same, with Friday's packet for the task (compiled by the real compiler, at the
 *            budget a spawned session gets) appended to the session's instructions;
 *   minimal  the same, with only the task, its criteria and what it may change, and one line
 *            against exploring broadly: no read scope, no related code, no history.
 * The ways run in a different order for each run, so none always goes first. Each session's
 * transcript is read by tests/helpers/exploration.ts (its calls, its input, what its searches and
 * reads of files it never changed cost), and its change is judged on a judge clone with the
 * dependencies installed: the build, the task's own tests and the hidden checks of
 * tests/fixtures/exploration/acceptance.hidden.test.mjs, and whether it changed files outside the
 * task's write scope.
 *
 * It runs only when the owner allows it, never in CI:
 *   FRIDAY_EXPLORE=1            the live sessions, on the owner's Claude login
 *   FRIDAY_EXPLORE_OUT          a folder outside the repository for the figures and transcripts
 *   FRIDAY_EXPLORE_TASKS        which tasks, comma-separated (cli-usage-read-share,verification-scope-glob)
 *   FRIDAY_EXPLORE_ARMS         which ways, comma-separated (plain,packet,minimal; slim is the packet
 *                              without its related code and recent commits)
 *   FRIDAY_EXPLORE_RUNS         how many times each way runs per task (2)
 *   FRIDAY_EXPLORE_TURNS        the turns all sessions together may start (12)
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { claudeEnvironment, detectClaudeCode } from '@friday/adapter-claude';
import { buildGraph, type CodeGraph, memoryFactsCache } from '@friday/code-graph';
import { ContextCache, type ContextDeps, compileContext } from '@friday/context';
import { sequentialIds } from '@friday/core';
import { openDatabase } from '@friday/db';
import { GitRoot } from '@friday/git';
import { type Actor, HarnessRegisterParams } from '@friday/protocol';
import { renderContextMarkdown } from '@friday/sdk';
import { FridayState } from '@friday/state';
import { FakeClock, useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { plainArgs, runPlainSession } from '../helpers/benefit.js';
import { REPO_ROOT } from '../helpers/cli.js';
import {
  ACCEPTANCE_TESTS,
  conditionSummary,
  type ExplorationFigures,
  explorationFigures,
  type Judgement,
  judgeChange,
  prepareJudge,
  type SessionRow,
  sessionTable,
} from '../helpers/exploration.js';
import { redactionSwaps, sanitize } from '../helpers/live-claude.js';
import { BASELINE_MODEL, outsideRepository, TurnBudget } from '../helpers/token-baseline.js';

const run = promisify(execFile);
const LIVE = process.env.FRIDAY_EXPLORE === '1';
const OUT = process.env.FRIDAY_EXPLORE_OUT;
const TASKS = (process.env.FRIDAY_EXPLORE_TASKS ?? 'cli-usage-read-share,verification-scope-glob').split(',');
type Arm = 'plain' | 'packet' | 'minimal' | 'slim';
const ARMS = (process.env.FRIDAY_EXPLORE_ARMS ?? 'plain,packet,minimal').split(',') as Arm[];
const RUNS = Number(process.env.FRIDAY_EXPLORE_RUNS ?? 2);
/** What the slim packet leaves out: the files the graph relates to the task, and recent commits. */
const SLIM_DROPS = ['code.related', 'repo.recent_commits'];
const TURNS = Number(process.env.FRIDAY_EXPLORE_TURNS ?? 12);
const SESSION_MS = 20 * 60_000;
const CAP_USD = 0.5;
/** What a spawned session's packet is rendered at (the Codex and OpenCode adapters' cap). */
const PACKET_CHARS = 12_000;
const PROJECT = 'proj_0000000000000000000000ex';
const human: Actor = { kind: 'human', id: 'local-operator' };
const HIDDEN = path.join(REPO_ROOT, 'tests', 'fixtures', 'exploration', 'acceptance.hidden.test.mjs');
const PREFACE = "Friday, which manages this project, compiled this task's context for you:\n\n";

if (!LIVE) console.info('exploration measurement: skipped, FRIDAY_EXPLORE is not set (docs/measurements/README.md)');

const ws = useTestWorkspace({ prefix: 'fri-ex-' });

interface EvalTask {
  id: string;
  summary: string;
  description: string;
  acceptance_criteria: string[];
  scope: { write: string[]; read: string[] };
  required: string[];
}

/** The prompt of a session: the task as the evals state it. No dependencies are installed in the clone. */
export function explorePrompt(t: EvalTask): string {
  return [
    `Task: ${t.summary}`,
    '',
    t.description,
    '',
    'Acceptance criteria:',
    ...t.acceptance_criteria.map((c) => `- ${c}`),
    '',
    'This copy of the repository has no dependencies installed: make the change in the code, and do not run builds or tests.',
    'When you are done, give the final answer in the structured format you were given: status "completed" and a short summary.',
  ].join('\n');
}

/**
 * The minimal packet: the task, its criteria and what it may change, and one line against exploring
 * broadly. No read scope, no related code, no history: Friday still enforces the whole scope.
 */
export function minimalPacket(t: EvalTask): string {
  return [
    'Friday, which manages this project, assigned you this task.',
    '',
    `Task: ${t.summary}`,
    '',
    'Description:',
    t.description,
    '',
    'Acceptance criteria:',
    ...t.acceptance_criteria.map((c) => `- ${c}`),
    '',
    'You may change files matching:',
    ...t.scope.write.map((g) => `- ${g}`),
    '',
    'Open files only when you need them; do not explore broadly before starting work.',
    '',
    'When finished, report the exact changed paths and the checks you actually ran.',
  ].join('\n');
}

/** A new order of the ways for each run, so none always goes first. */
function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

describe.skipIf(!LIVE)('the exploration measurement on this repository', () => {
  it(
    'runs each task each way on a fresh clone, reads what the sessions spent, and judges their changes',
    async () => {
      if (!OUT || !outsideRepository(OUT, REPO_ROOT)) throw new Error('set FRIDAY_EXPLORE_OUT outside the repository');
      mkdirSync(OUT, { recursive: true });
      const install = detectClaudeCode();
      if (!install) throw new Error('Claude Code was not found');
      const all = (
        JSON.parse(readFileSync(path.join(REPO_ROOT, 'tests', 'evals', 'context-evals.json'), 'utf8')) as {
          tasks: EvalTask[];
        }
      ).tasks;
      const tasks = TASKS.map((id) => {
        const t = all.find((x) => x.id === id);
        if (!t) throw new Error(`no eval task ${id}`);
        if (!ACCEPTANCE_TESTS[id]) throw new Error(`no acceptance tests are named for ${id}`);
        return t;
      });
      const budget = new TurnBudget(TURNS);
      const swaps = redactionSwaps(ws().root);
      const clone = async (name: string) => {
        const dir = path.join(ws().root, name);
        await run('git', ['clone', '--quiet', '--no-hardlinks', REPO_ROOT, dir], { windowsHide: true });
        return dir;
      };
      // The judge: a clone with the dependencies installed and built once; each change is applied to it.
      const judge = await clone('judge');
      await prepareJudge(judge);

      // Friday's packet for each task, compiled on a clone as a spawned agent of the task gets it.
      const packets = new Map<string, string>();
      const slims = new Map<string, string>();
      if (ARMS.includes('packet') || ARMS.includes('slim')) {
        const repo = await clone('packet-source');
        const state = new FridayState({
          db: openDatabase(':memory:'),
          clock: new FakeClock('2026-10-20T08:00:00.000Z'),
          ids: sequentialIds(),
        });
        state.ensureProject({ project_id: PROJECT, name: 'friday', root_path: repo });
        const root = await GitRoot.open(repo);
        const facts = memoryFactsCache();
        let graph: CodeGraph | undefined;
        const deps: ContextDeps = {
          state,
          project: {
            project_id: PROJECT,
            name: 'friday',
            root: root.root,
            config: { context: { session_start_max_chars: 9000 } },
          },
          git: async () => root,
          graph: async () => {
            const version = (await root.identity()).version;
            if (graph?.version !== version) graph = await buildGraph(root, { cache: facts });
            return graph;
          },
          stateDir: ws().stateDir,
          cache: new ContextCache(),
        };
        const reg = state.registerHarness(
          PROJECT,
          HarnessRegisterParams.parse({
            protocol_version: '1.0',
            harness_key: 'explore:dev-1',
            vendor: 'claude-code',
            name: 'explore session',
            attach_mode: 'spawn',
            project_id: PROJECT,
            capabilities: { task_start: true },
            agent: { agent_key: 'dev-1', role: 'engineer' },
          }),
        );
        for (const t of tasks) {
          const id = state.createTask(PROJECT, human, {
            summary: t.summary,
            description: t.description,
            acceptance_criteria: t.acceptance_criteria,
            scope: { write: t.scope.write, read: t.scope.read },
            assign_agent_key: 'dev-1',
          }).task_id;
          const { packet } = await compileContext(
            deps,
            {
              recipient: { kind: 'agent', id: reg.agent_id, harness_id: reg.harness_id },
              task_id: id,
              purpose: 'task_claim',
              overflow: 'raise',
            },
            { kind: 'agent', id: reg.agent_id },
          );
          packets.set(t.id, PREFACE + renderContextMarkdown(packet, PACKET_CHARS, { fridayTools: false }));
          const slim = { ...packet, sections: packet.sections.filter((x) => !SLIM_DROPS.includes(x.kind)) };
          slims.set(t.id, PREFACE + renderContextMarkdown(slim, PACKET_CHARS, { fridayTools: false }));
        }
      }
      const packetFor = (t: EvalTask, arm: Arm): string =>
        arm === 'plain'
          ? ''
          : arm === 'minimal'
            ? minimalPacket(t)
            : ((arm === 'slim' ? slims.get(t.id) : packets.get(t.id)) ?? '');

      const rows: SessionRow[] = [];
      const orders: { run: number; task: string; order: Arm[] }[] = [];
      const save = () => {
        writeFileSync(
          path.join(OUT, 'results.json'),
          `${JSON.stringify(sanitize({ orders, rows }, swaps), null, 2)}\n`,
        );
        writeFileSync(path.join(OUT, 'summary.txt'), `${sessionTable(rows)}\n\n${conditionSummary(rows)}\n`);
      };

      for (let r = 1; r <= RUNS; r += 1) {
        for (const t of tasks) {
          const order = shuffled(ARMS);
          orders.push({ run: r, task: t.id, order });
          for (const arm of order) {
            const key = `${t.id}-${arm}-${r}`;
            const dir = await clone(key);
            const packet = packetFor(t, arm);
            const args = [...plainArgs(BASELINE_MODEL, CAP_USD), ...(packet ? ['--append-system-prompt', packet] : [])];
            const started = Date.now();
            const s = await runPlainSession({
              key,
              binary: install.binary,
              cwd: dir,
              prompt: explorePrompt(t),
              args,
              env: claudeEnvironment(),
              budget,
              timeoutMs: SESSION_MS,
            });
            const seconds = Math.round((Date.now() - started) / 1000);
            const figures: ExplorationFigures = explorationFigures(s.lines, dir);
            const judgement: Judgement = await judgeChange({
              judge,
              session: dir,
              taskId: t.id,
              write: t.scope.write,
              acceptanceTests: ACCEPTANCE_TESTS[t.id] ?? [],
              hidden: HIDDEN,
            });
            const named = (file: string) => packet.toLowerCase().includes(file.toLowerCase());
            const reads = figures.tools.filter((u) => u.class === 'read-edited' || u.class === 'read-other');
            rows.push({
              task: t.id,
              arm,
              run: r,
              seconds,
              figures,
              packet_chars: packet.length,
              reads_named_in_packet: reads.filter((u) => named(u.target)).length,
              reads_not_named: reads.filter((u) => !named(u.target)).length,
              judgement,
            });
            writeFileSync(
              path.join(OUT, `transcript-${key}.jsonl`),
              `${s.lines
                .filter((l) => l.msg.type !== 'rate_limit_event')
                .map((l) => JSON.stringify(sanitize(l, swaps)))
                .join('\n')}\n`,
            );
            if (packet && r === 1) writeFileSync(path.join(OUT, `${arm}-${t.id}.md`), packet);
            save();
          }
        }
      }
      console.log(readFileSync(path.join(OUT, 'summary.txt'), 'utf8'));
      expect(rows.length).toBe(tasks.length * ARMS.length * RUNS);
    },
    4 * 60 * 60_000,
  );
});
