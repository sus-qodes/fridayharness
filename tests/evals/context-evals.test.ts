/**
 * The context evals (plan M12.6): the M4 exit evidence on a realistic workload, Friday's own
 * repository. Every task of tests/evals/context-evals.json is created against a clean clone of
 * this repository, its packet compiled with the real compiler in this process, and scored:
 * required-context recall, forbidden-source exclusion, the packet's size against its budget and
 * the deterministic share. Each task is compiled four ways: with the read scope it declares and
 * with an open one, at the budget `friday_task_claim` delivers and at the SessionStart hook's.
 * The figures go to tests/.artifacts/context-evals.json and tables are printed;
 * docs/measurements/2026-10-18-context-evals.md holds the record.
 *
 * Gated like the compiler's timing test: FRIDAY_TEST_BENCH=1 runs it, otherwise it is skipped with
 * a one-line reason. Nothing here calls a model.
 *
 *   TERMINAL, at C:\friday:  $env:FRIDAY_TEST_BENCH = "1"; pnpm vitest run --config tests/evals/vitest.config.ts
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildGraph, type CodeGraph, memoryFactsCache } from '@friday/code-graph';
import { ContextCache, type ContextDeps, compileContext } from '@friday/context';
import { sequentialIds } from '@friday/core';
import { openDatabase } from '@friday/db';
import { GitRoot } from '@friday/git';
import { globsOverlap, matchesAny } from '@friday/policy';
import { type Actor, HarnessRegisterParams } from '@friday/protocol';
import { renderContextMarkdown } from '@friday/sdk';
import { FridayState } from '@friday/state';
import { ARTIFACTS_DIR, FakeClock, useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import {
  ALWAYS_FORBIDDEN_GLOBS,
  type EvalTask,
  errorScore,
  parseEvalSet,
  renderTable,
  type ScopeMode,
  scoreTask,
  type TaskScore,
  totals,
} from './score.js';

const run = promisify(execFile);
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const EVAL_SET = path.join(REPO_ROOT, 'tests', 'evals', 'context-evals.json');
const RECORD = path.join(ARTIFACTS_DIR, 'context-evals.json');
const PROJECT = 'proj_0000000000000000000000ev';
const BENCH = process.env.FRIDAY_TEST_BENCH === '1';
/** What `friday_task_claim` delivers (the compiler's default) and what the SessionStart hook delivers. */
const CLAIM_BUDGET = 20_000;
const SESSION_START_BUDGET = 9000;
/** The MCP tool renders the packet as Markdown at this cap (packages/mcp-server/src/tools.ts). */
const RENDER_CAP = 8000;
const human: Actor = { kind: 'human', id: 'local-operator' };
/** A credential-shaped value planted in the clone's .env: it must appear nowhere in any packet. */
const DECOY_SECRET = 'sk-eval-decoy-0000000000000000000000';

const ws = useTestWorkspace({ prefix: 'fri-ev-' });

function loadEvalSet(): EvalTask[] {
  return parseEvalSet(JSON.parse(readFileSync(EVAL_SET, 'utf8')));
}

describe('the context eval set (tests/evals/context-evals.json)', () => {
  it('holds at least fifteen well-formed tasks whose required files exist, inside their read scopes', () => {
    const tasks = loadEvalSet();
    expect(tasks.length).toBeGreaterThanOrEqual(15);
    const missing = tasks.flatMap((t) =>
      t.required.filter((f) => !existsSync(path.join(REPO_ROOT, f))).map((f) => `${t.id}: ${f}`),
    );
    expect(missing).toEqual([]);
    // Every required file is readable under the task's declared scopes, and never forbidden.
    const outside = tasks.flatMap((t) =>
      t.required.filter((f) => !matchesAny(f, [...t.scope.read, ...t.scope.write])).map((f) => `${t.id}: ${f}`),
    );
    expect(outside).toEqual([]);
    const contradictions = tasks.flatMap((t) =>
      t.required.filter((f) => matchesAny(f, [...ALWAYS_FORBIDDEN_GLOBS, ...t.forbidden])).map((f) => `${t.id}: ${f}`),
    );
    expect(contradictions).toEqual([]);
    // A forbidden glob lies outside the declared scopes, so a hit under them is a permission failure.
    const overlapping = tasks.flatMap((t) =>
      t.forbidden.filter((g) => globsOverlap([g], [...t.scope.read, ...t.scope.write])).map((g) => `${t.id}: ${g}`),
    );
    expect(overlapping).toEqual([]);
  });

  it('refuses a malformed set, naming the task and the field', () => {
    const ok = {
      id: 'a',
      summary: 's',
      description: 'd',
      scope: { write: ['x'], read: ['y'] },
      required: ['a.ts'],
      acceptance_criteria: [],
      forbidden: [],
    };
    expect(() => parseEvalSet({ tasks: [{ id: 'Bad Id' }] })).toThrow(/"id"/);
    expect(() => parseEvalSet({ tasks: [{ ...ok, required: ['src/**'] }] })).toThrow(/not a glob/);
    expect(() => parseEvalSet({ tasks: [{ ...ok, scope: { write: ['x'] } }] })).toThrow(/"read"/);
    expect(() => parseEvalSet({ tasks: [ok, ok] })).toThrow(/appears twice/);
    expect(parseEvalSet({ tasks: [ok] })).toHaveLength(1);
  });
});

// Written to stdout directly: the test runner keeps a passing test's console output back.
const say = (text: string) => process.stdout.write(`${text}\n`);

if (!BENCH) say('context evals: skipped, FRIDAY_TEST_BENCH is not 1 (see docs/measurements/README.md)');

describe.skipIf(!BENCH)('the context evals on a clean checkout of this repository (FRIDAY_TEST_BENCH=1)', () => {
  it('compiles every task four ways, scores recall, exclusion, size and the deterministic share, and writes the record', async () => {
    const tasks = loadEvalSet();
    const repo = path.join(ws().root, 'repo');
    // A clone has the committed code only, so the figures are about one commit, not a working tree.
    await run('git', ['clone', '--quiet', REPO_ROOT, repo], { windowsHide: true });
    const commit = (await run('git', ['rev-parse', 'HEAD'], { cwd: repo, windowsHide: true })).stdout.trim();
    // Decoys: runtime files and a secret an agent must never see, untracked in the clone so git
    // reports them as changes the compiler has to judge.
    mkdirSync(path.join(repo, '.friday', 'logs'), { recursive: true });
    writeFileSync(path.join(repo, '.env'), `FRIDAY_EVAL_DECOY_KEY=${DECOY_SECRET}\n`);
    writeFileSync(path.join(repo, '.friday', 'project.db'), 'not a database: a decoy\n');
    writeFileSync(path.join(repo, '.friday', 'logs', 'daemon.jsonl'), '{"decoy":true}\n');

    const state = new FridayState({
      db: openDatabase(':memory:'),
      clock: new FakeClock('2026-10-18T12:00:00.000Z'),
      ids: sequentialIds(),
    });
    state.ensureProject({ project_id: PROJECT, name: 'friday', root_path: repo });
    const root = await GitRoot.open(repo);
    const facts = memoryFactsCache();
    let graph: CodeGraph | undefined;
    let graphMs = 0;
    const deps: ContextDeps = {
      state,
      project: {
        project_id: PROJECT,
        name: 'friday',
        root: root.root,
        config: { context: { session_start_max_chars: SESSION_START_BUDGET } },
      },
      git: async () => root,
      graph: async () => {
        const version = (await root.identity()).version;
        if (graph?.version !== version) {
          const started = performance.now();
          graph = await buildGraph(root, { cache: facts });
          graphMs = Math.round(performance.now() - started);
        }
        return graph;
      },
      stateDir: ws().stateDir,
      cache: new ContextCache(),
    };
    // An attached session with Friday's tools, as Claude Code over the MCP server is.
    const reg = state.registerHarness(
      PROJECT,
      HarnessRegisterParams.parse({
        protocol_version: '1.0',
        harness_key: 'eval:dev-1',
        vendor: 'generic',
        name: 'eval session',
        attach_mode: 'attach',
        project_id: PROJECT,
        capabilities: { mcp_tools: true, context_request: true },
        agent: { agent_key: 'dev-1', role: 'engineer' },
      }),
    );
    const recipient = { kind: 'agent' as const, id: reg.agent_id, harness_id: reg.harness_id };
    const actor: Actor = { kind: 'agent', id: reg.agent_id };
    const identity = await root.identity();
    const g = await deps.graph(repo);
    if (!g) throw new Error('the code graph of the clone could not be built');
    const stateDir = ws().stateDir;
    const checkoutFor = (task: EvalTask) => ({
      inGraph: (p: string) => g.nodes.has(p),
      matches: (p: string, globs: readonly string[]) => matchesAny(p, globs),
      neverInText: [DECOY_SECRET, stateDir, stateDir.replaceAll('\\', '/')],
      inScopeNodes: [...g.nodes.keys()].filter((p) => matchesAny(p, task.scope.write)).length,
    });

    // A task Friday cannot deliver a packet for is a figure of its own, not the end of the run.
    const compile = async (task: EvalTask, taskId: string, mode: ScopeMode, maxChars: number): Promise<TaskScore> => {
      const purpose = maxChars === CLAIM_BUDGET ? 'task_claim' : 'session_startup';
      try {
        const { packet, explanation } = await compileContext(
          deps,
          { recipient, task_id: taskId, purpose: `${purpose}:${mode}`, max_chars: maxChars, overflow: 'raise' },
          actor,
        );
        const rendered = renderContextMarkdown(packet, RENDER_CAP);
        return scoreTask(task, mode, { packet, explanation, rendered }, checkoutFor(task));
      } catch (e) {
        return errorScore(task, mode, maxChars, (e as Error).message);
      }
    };

    const variants: { mode: ScopeMode; budget: number; scores: TaskScore[] }[] = [
      { mode: 'declared', budget: CLAIM_BUDGET, scores: [] },
      { mode: 'declared', budget: SESSION_START_BUDGET, scores: [] },
      { mode: 'open', budget: CLAIM_BUDGET, scores: [] },
      { mode: 'open', budget: SESSION_START_BUDGET, scores: [] },
    ];
    for (const task of tasks) {
      // The same task twice: once as a plan declares it, once with an open read scope.
      const ids: Record<ScopeMode, string> = { declared: '', open: '' };
      for (const mode of ['declared', 'open'] as const) {
        ids[mode] = state.createTask(PROJECT, human, {
          summary: task.summary,
          description: task.description,
          acceptance_criteria: task.acceptance_criteria,
          scope: { write: task.scope.write, read: mode === 'declared' ? task.scope.read : [] },
          assign_agent_key: 'dev-1',
        }).task_id;
      }
      for (const v of variants) v.scores.push(await compile(task, ids[v.mode], v.mode, v.budget));
    }

    const label = (v: { mode: ScopeMode; budget: number }) =>
      `${v.mode === 'declared' ? 'declared read scope' : 'open read scope'}, ${v.budget === CLAIM_BUDGET ? 'task-claim' : 'session-start'} budget (${v.budget} chars)`;
    const record = {
      measured_at: new Date().toISOString(),
      commit,
      repository: {
        files: (await root.files()).length,
        graph: { nodes: g.nodes.size, build_ms: graphMs, source_version: identity.version },
      },
      recipient: { agent_key: 'dev-1', role: 'engineer', attach_mode: 'attach', friday_tools: true },
      budgets: { task_claim: CLAIM_BUDGET, session_start: SESSION_START_BUDGET, rendered_cap: RENDER_CAP },
      always_forbidden: ALWAYS_FORBIDDEN_GLOBS,
      variants: variants.map((v) => ({ mode: v.mode, budget: v.budget, totals: totals(v.scores), tasks: v.scores })),
    };
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
    writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}\n`);
    const lines = [
      `context evals at ${commit.slice(0, 12)}: ${tasks.length} tasks; ${record.repository.files} files, ${g.nodes.size} graph nodes built in ${graphMs} ms`,
    ];
    for (const v of record.variants) lines.push('', `Packets with the ${label(v)}:`, renderTable(v.tasks, v.totals));
    for (const v of record.variants.filter((x) => x.budget === CLAIM_BUDGET)) {
      lines.push('', `Misses with the ${label(v)}:`);
      for (const s of v.tasks) for (const m of s.missed) lines.push(`- ${s.id}: ${m.path}: ${m.why}`);
    }
    lines.push('', 'Tasks without a packet:');
    for (const v of record.variants) {
      for (const s of v.tasks.filter((x) => x.error)) lines.push(`- ${s.id}, ${label(v)}: ${s.error}`);
    }
    lines.push('', `Record written to ${RECORD}`);
    say(lines.join('\n'));

    // What the eval asserts of the compiler (the M4 exit evidence); recall is measured, not asserted.
    for (const v of record.variants) {
      const failed = v.tasks.filter((s) => !s.exclusion).map((s) => [s.id, s.protected_hits, s.scope_hits]);
      expect(v.totals.exclusion_all, `${label(v)}: ${JSON.stringify(failed)}`).toBe(true);
      expect(v.totals.within_budget_all, label(v)).toBe(true);
      expect(v.totals.deterministic_share, label(v)).toBe(1);
      // The three decoys were seen by git and kept out of every delivered packet.
      for (const s of v.tasks.filter((s) => !s.error)) {
        expect(s.withheld_by_permission, `${s.id}, ${label(v)}`).toBeGreaterThanOrEqual(3);
      }
    }
    expect(record.variants[0]?.totals.mean_recall).not.toBeNull();
  });
});
