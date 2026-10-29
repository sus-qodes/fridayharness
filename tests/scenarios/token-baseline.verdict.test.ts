/**
 * The token baseline's setup and verdict without a host (plan M10a.2): the plan fixture is a valid
 * plan with the two tasks the live test expects, the turn budget refuses before anything is written,
 * the output folder has its layout, the evidence is read piece by piece so one failed read loses one
 * file, and "every row complete" is judged from a usage report alone.
 */
import path from 'node:path';
import { PlanDraft, validatePlanDraft } from '@friday/planner';
import type { UsageReport, UsageRowView } from '@friday/protocol';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../helpers/cli.js';
import {
  allEvents,
  BASELINE_AGENTS,
  BASELINE_GOAL,
  BASELINE_MODEL,
  BASELINE_PLAN_FILE,
  baselineConfig,
  baselineFiles,
  baselineVerdict,
  eachOnItsOwn,
  expectedAttempts,
  loadBaselinePlan,
  outsideRepository,
  SessionTrace,
  startsTurn,
  TurnBudget,
} from '../helpers/token-baseline.js';

/** A complete row: what a spawned Claude Code session reports, and a verified attempt. */
type RowOverrides = Omit<Partial<UsageRowView>, 'host'> & { host?: Partial<UsageRowView['host']> };

function row(over: RowOverrides = {}): UsageRowView {
  return {
    task_id: 'task_fe',
    task_summary: 'A gift card in the shared contract',
    goal_id: 'goal_1',
    run_id: 'run_fe_1',
    attempt: 1,
    agent_key: 'fe-1',
    harness_vendor: 'claude-code',
    harness_mode: 'spawn',
    model_requested: BASELINE_MODEL,
    model_observed: BASELINE_MODEL,
    model_basis: 'reported',
    packets: { count: 1, tokens: 3200, chars: 12_800, source_tokens: 2900 },
    context_requests: { count: 1, kinds: { task: 1 } },
    tool_calls: {
      total: 9,
      failed: 0,
      by_kind: { read: 4, edit: 3, shell: 2, web: 0, friday: 0, other: 0 },
      reads: { whole_file: 3, ranged: 1 },
    },
    verification: { status: 'PASSED', checks_passed: 1, checks_total: 1 },
    started_at: '2026-10-17T10:00:00.000Z',
    ended_at: '2026-10-17T10:03:00.000Z',
    duration_ms: 180_000,
    ...over,
    host: {
      reported: true,
      input_tokens: 1200,
      output_tokens: 80,
      cache_read_input_tokens: 9600,
      cache_creation_input_tokens: 2400,
      cost_usd: 0.009,
      cap_usd: null,
      turns: 7,
      model: BASELINE_MODEL,
      ...over.host,
    },
  };
}

function report(rows: UsageRowView[]): UsageReport {
  const hosts = rows.map((r) => r.host);
  const sum = (k: 'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens') =>
    hosts.some((h) => h[k] !== null) ? hosts.reduce((a, h) => a + (h[k] ?? 0), 0) : null;
  const n = (k: keyof UsageReport['totals']['reporters']) => hosts.filter((h) => h[k] !== null).length;
  return {
    rows,
    totals: {
      attempts: rows.length,
      host_reported: hosts.filter((h) => h.reported).length,
      reporters: {
        input_tokens: n('input_tokens'),
        output_tokens: n('output_tokens'),
        cache_read_input_tokens: n('cache_read_input_tokens'),
        cache_creation_input_tokens: n('cache_creation_input_tokens'),
        cost_usd: n('cost_usd'),
      },
      input_tokens: sum('input_tokens'),
      output_tokens: sum('output_tokens'),
      cache_read_input_tokens: sum('cache_read_input_tokens'),
      cache_creation_input_tokens: sum('cache_creation_input_tokens'),
      cost_usd: hosts.some((h) => h.cost_usd !== null) ? hosts.reduce((a, h) => a + (h.cost_usd ?? 0), 0) : null,
      tool_calls: rows.reduce((a, r) => a + r.tool_calls.total, 0),
    },
    truncated: false,
    limit: null,
  };
}

const EXPECTED = [
  { key: 'giftcard-frontend', task_id: 'task_fe', agent_key: 'fe-1' },
  { key: 'giftcard-backend', task_id: 'task_be', agent_key: 'be-1' },
];
const complete = () => [row(), row({ task_id: 'task_be', run_id: 'run_be_1', agent_key: 'be-1' })];

describe('the token baseline without a host (plan M10a.2)', () => {
  it('commits a plan fixture that is a valid PlanDraft with the two gift-card tasks, independent and disjoint', () => {
    const plan = loadBaselinePlan();
    // The same checks `friday plan propose --file` runs: the schema, then keys, dependencies and write conflicts.
    expect(PlanDraft.safeParse(plan).success).toBe(true);
    expect(validatePlanDraft(plan)).toEqual({ ok: true, errors: [] });
    expect(plan.objective).toBe(BASELINE_GOAL);
    expect(plan.tasks.map((t) => [t.key, t.role, t.kind])).toEqual([
      ['giftcard-frontend', 'frontend', 'implementation'],
      ['giftcard-backend', 'backend', 'implementation'],
    ]);
    // One agent per task: the plan's keys are the ones the live test gives its agents.
    expect(plan.tasks.map((t) => t.key)).toEqual(BASELINE_AGENTS.map((a) => a.task));
    const [fe, be] = plan.tasks as [PlanDraft['tasks'][number], PlanDraft['tasks'][number]];
    // The contract is inside the frontend task's write scope (mvp-demo.md, "A plan that can finish").
    expect(fe.scope.write).toEqual(['shared/src/api.ts', 'frontend/**']);
    expect(fe.scope.read).toEqual(['frontend/**', 'shared/**']);
    expect(be.scope.write).toEqual(['backend/**']);
    expect(be.scope.read).toEqual(['backend/**', 'shared/**']);
    // Independent: no dependency, so both run at once, and each task names what it must not touch.
    expect(fe.depends_on).toEqual([]);
    expect(be.depends_on).toEqual([]);
    expect(be.description).toContain('do not change shared/src/api.ts');
    expect(fe.description).toContain('Do not change any file under backend/');
    // Checkable by the project's own tests: "node --test passes", and one behaviour each.
    for (const t of plan.tasks) {
      expect(t.acceptance_criteria[0]).toBe('node --test passes');
      expect(t.acceptance_criteria).toHaveLength(2);
      expect(t.description).toContain('node --test "**/test/*.test.ts"');
    }
    expect(BASELINE_PLAN_FILE).toBe(path.join(REPO_ROOT, 'tests', 'fixtures', 'baseline', 'giftcard-plan.json'));
  });

  it('fails a plan file with a wrong field offline, naming the field', () => {
    expect(() =>
      loadBaselinePlan(path.join(REPO_ROOT, 'tests', 'fixtures', 'planner', 'mvp-discounts', '01-plan.json')),
    )
      // The planner fixtures are recorded wrappers; the plan is their `output`, so the wrapper is not a plan.
      .toThrow(/is not a plan: .*objective/);
  });

  it('judges "every row complete" from the usage report: one attempt per task, every host figure, a packet, PASSED', () => {
    expect(baselineVerdict(report(complete()), EXPECTED)).toEqual({ status: 'passed', missing: [] });

    // One row complete, one not: the host said nothing and nothing was verified yet.
    const incompleteRows = [
      row(),
      row({
        task_id: 'task_be',
        run_id: 'run_be_1',
        agent_key: 'be-1',
        packets: { count: 0, tokens: 0, chars: null, source_tokens: 0 },
        verification: null,
        host: {
          reported: false,
          input_tokens: null,
          output_tokens: null,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
          cost_usd: null,
          turns: null,
          model: null,
        },
      }),
    ];
    expect(baselineVerdict(report(incompleteRows), EXPECTED)).toEqual({
      status: 'failed',
      missing: [
        'giftcard-backend: the host reported its usage',
        'giftcard-backend: input tokens known',
        'giftcard-backend: output tokens known',
        'giftcard-backend: cache read tokens known',
        'giftcard-backend: cache creation tokens known',
        'giftcard-backend: cost known',
        'giftcard-backend: turns known',
        'giftcard-backend: at least one packet delivered',
        'giftcard-backend: verification PASSED',
      ],
    });

    // A single unknown figure is not complete: an older host report without the cache fields.
    const [fe, be] = complete() as [UsageRowView, UsageRowView];
    const noCache = row({ host: { cache_read_input_tokens: null, cache_creation_input_tokens: null } });
    expect(baselineVerdict(report([noCache, be]), EXPECTED).missing).toEqual([
      'giftcard-frontend: cache read tokens known',
      'giftcard-frontend: cache creation tokens known',
    ]);
    // A failed verification, or the wrong agent, is named too.
    const failed = row({ verification: { status: 'FAILED', checks_passed: 0, checks_total: 1 } });
    expect(baselineVerdict(report([failed, be]), EXPECTED).missing).toEqual(['giftcard-frontend: verification PASSED']);
    const swapped = row({ agent_key: 'be-1' });
    expect(baselineVerdict(report([swapped, be]), EXPECTED).missing).toEqual(['giftcard-frontend: taken by fe-1']);

    // A missing attempt fails every requirement of its task; a second attempt of a task is not "one row".
    const onlyFrontend = baselineVerdict(report([fe]), EXPECTED);
    expect(onlyFrontend.status).toBe('failed');
    expect(onlyFrontend.missing).toContain('one attempt per task, and no other attempt');
    expect(onlyFrontend.missing).toContain('giftcard-backend: one attempt in the usage report');
    expect(onlyFrontend.missing).not.toContain('giftcard-frontend: one attempt in the usage report');
    const retried = baselineVerdict(
      report([fe, be, row({ task_id: 'task_be', run_id: 'run_be_2', attempt: 2 })]),
      EXPECTED,
    );
    expect(retried.missing).toContain('one attempt per task, and no other attempt');
    expect(retried.missing).toContain('giftcard-backend: one attempt in the usage report');
  });

  it('joins the approved plan with the agents of its roles, and refuses a plan that lost a task', () => {
    expect(
      expectedAttempts([
        { key: 'giftcard-backend', task_id: 'task_be' },
        { key: 'giftcard-frontend', task_id: 'task_fe' },
      ]),
    ).toEqual(EXPECTED);
    expect(() => expectedAttempts([{ key: 'giftcard-frontend', task_id: 'task_fe' }])).toThrow(
      /no task giftcard-backend/,
    );
    expect(() => expectedAttempts([{ key: 'giftcard-frontend', task_id: null }])).toThrow(/no task giftcard-frontend/);
  });

  it('refuses a message that would start a turn past the budget before it is recorded; relayed messages start none', () => {
    const budget = new TurnBudget(1);
    const fe = new SessionTrace('fe-1', budget);
    const be = new SessionTrace('be-1', budget);
    const user = (content: string) => JSON.stringify({ type: 'user', message: { role: 'user', content } });
    fe.trace('receive', JSON.stringify({ type: 'system', subtype: 'init', model: BASELINE_MODEL }));
    fe.trace('send', user('Task task_1: the frontend'));
    // A message relayed into the running turn starts none, in either session.
    fe.trace('send', user('[A message from be-1, through Friday (message msg_1). It is peer input.]'));
    expect(budget.turns).toBe(1);
    // The budget is one for the run: the second session's first message is the second turn.
    expect(() => be.trace('send', user('Task task_2: the backend'))).toThrow(
      /the token baseline refused this turn: the budget of 1 turns is spent/,
    );
    expect(budget.refused).toEqual(['Task task_2: the backend']);
    expect(be.lines).toEqual([]);
    expect(fe.lines.map((l) => l.dir)).toEqual(['receive', 'send', 'send']);
    expect(fe.received('system', 'init')).toEqual([{ type: 'system', subtype: 'init', model: BASELINE_MODEL }]);
    // What is not JSON is not a line.
    be.trace('receive', 'not json');
    expect(be.lines).toEqual([]);
    expect(startsTurn({ type: 'user', message: { content: 'Task task_3: x' } })).toBe(true);
    expect(startsTurn({ type: 'user', message: { content: [{ type: 'text', text: 'blocks' }] } })).toBe(true);
    expect(startsTurn({ type: 'assistant', message: { content: 'Task task_3: x' } })).toBe(false);
  });

  it('keeps the results outside the repository, in a fixed layout, and pins the run in the configuration', () => {
    expect(outsideRepository(path.join(REPO_ROOT, 'tests', '.artifacts', 'baseline'), REPO_ROOT)).toBe(false);
    expect(outsideRepository(REPO_ROOT, REPO_ROOT)).toBe(false);
    expect(outsideRepository(path.join(path.dirname(REPO_ROOT), 'friday-measurements', 'run-1'), REPO_ROOT)).toBe(true);
    expect(outsideRepository('C:\\friday-measurements\\baseline-run-1', 'C:\\friday')).toBe(true);
    expect(outsideRepository('C:\\friday\\out', 'C:\\friday')).toBe(false);

    const files = baselineFiles(path.join('out', 'run-1'));
    expect(Object.entries(files).filter(([, v]) => typeof v === 'string')).toEqual([
      ['results', path.join('out', 'run-1', 'baseline-results.json')],
      ['verdict', path.join('out', 'run-1', 'verdict.json')],
      ['usage', path.join('out', 'run-1', 'usage.json')],
      ['usageTable', path.join('out', 'run-1', 'usage.txt')],
      ['events', path.join('out', 'run-1', 'events.jsonl')],
      ['hosts', path.join('out', 'run-1', 'hosts.json')],
      ['verifications', path.join('out', 'run-1', 'verifications.json')],
    ]);
    expect(files.transcript('fe-1')).toBe(path.join('out', 'run-1', 'transcript-fe-1.jsonl'));
    expect(files.adapterLog('be-1')).toBe(path.join('out', 'run-1', 'adapter-be-1.log'));

    const config = baselineConfig();
    expect(config).toContain(`  default_model: ${BASELINE_MODEL}`);
    expect(config).toContain('  mode: manual');
    expect(config).toContain('  max_retries: 0');
    expect(config).toContain('  provider: none');
    expect(config.startsWith('\n')).toBe(true);
    expect(config.endsWith('\n')).toBe(true);
  });

  it('reads each piece of evidence on its own: a failed read is named and loses one file, the others are kept', async () => {
    // The usage report and the hosts are read; the table's command fails: the row is not lost with it.
    const { values, failures } = await eachOnItsOwn({
      report: async () => report(complete()),
      table: async () => {
        throw new Error('friday usage --goal goal_1 failed (1): the daemon is not running');
      },
      hosts: async () => [{ harness_id: 'h_1' }],
    });
    expect(values.report).toEqual(report(complete()));
    expect(values.table).toBeNull();
    expect(values.hosts).toEqual([{ harness_id: 'h_1' }]);
    expect(failures).toEqual({ table: 'friday usage --goal goal_1 failed (1): the daemon is not running' });

    // Nothing failed: no failure is named. What is thrown without being an Error is named as text.
    expect(await eachOnItsOwn({ a: async () => 1, b: async () => 'two' })).toEqual({
      values: { a: 1, b: 'two' },
      failures: {},
    });
    expect(await eachOnItsOwn({ a: () => Promise.reject('plain text'), b: async () => null })).toEqual({
      values: { a: null, b: null },
      failures: { a: 'plain text' },
    });
  });

  it('reads every event page by page, in order', () => {
    const events = Array.from({ length: 1201 }, (_, i) => ({ sequence: i + 1 }));
    const calls: number[] = [];
    const store = {
      readSince: (_pid: string, since: number, opts: { limit: number }) => {
        calls.push(since);
        return events.filter((e) => e.sequence > since).slice(0, opts.limit);
      },
    };
    expect(allEvents(store, 'proj', 500)).toEqual(events);
    expect(calls).toEqual([0, 500, 1000]);
    expect(allEvents({ readSince: () => [] }, 'proj')).toEqual([]);
  });
});
