// The hidden checks of the exploration measurement (docs/measurements/2026-10-20-exploration.md):
// whether a session's change to this repository does what its task asked. They run on the judge
// clone, built with the session's change applied, with EXPLORE_TREE naming its folder; no session
// sees this file. Each check names its task, and loads what it needs from the clone's built output.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const root = process.env.EXPLORE_TREE;
if (!root) throw new Error('EXPLORE_TREE must name the judge clone');
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);

// cli-usage-read-share: the usage table's READS W/R column is followed by the whole-file share.
const usageRow = (whole, ranged) => ({
  task_id: 'task_00000000000000000000000001',
  task_summary: 'a task',
  goal_id: null,
  run_id: 'run_00000000000000000000000001',
  attempt: 1,
  agent_key: 'dev-1',
  harness_vendor: 'claude-code',
  harness_mode: 'spawn',
  model_requested: null,
  model_observed: null,
  model_basis: null,
  packets: { count: 1, tokens: 2000, chars: 8000, source_tokens: 500 },
  context_requests: { count: 0, kinds: {} },
  tool_calls: {
    total: whole + ranged,
    failed: 0,
    by_kind: { read: whole + ranged, edit: 0, shell: 0, web: 0, friday: 0, other: 0 },
    reads: { whole_file: whole, ranged },
  },
  verification: null,
  started_at: '2026-10-14T10:00:00.000Z',
  ended_at: null,
  duration_ms: null,
  host: {
    reported: false,
    input_tokens: null,
    output_tokens: null,
    cache_read_input_tokens: null,
    cache_creation_input_tokens: null,
    cost_usd: null,
    cap_usd: null,
    turns: null,
    model: null,
  },
});
const usageReport = (rows) => ({
  rows,
  totals: {
    attempts: rows.length,
    host_reported: 0,
    reporters: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: 0 },
    input_tokens: null,
    output_tokens: null,
    cache_read_input_tokens: null,
    cache_creation_input_tokens: null,
    cost_usd: null,
    tool_calls: rows.reduce((a, r) => a + r.tool_calls.total, 0),
  },
  truncated: false,
  limit: 500,
});
/**
 * The cell after the READS W/R column on the row's line of the table: found by the column, since
 * the TOOLS cell earlier on the line (`0/0/0/0`) holds the same digits.
 */
function cellAfterReads(text, w, r) {
  const lines = text.split('\n');
  const header = lines.find((l) => l.includes('READS W/R'));
  const line = lines.find((l) => l.includes('task_0000'));
  assert.ok(header && line, `no table with a READS W/R column and a row in:\n${text}`);
  const cells = (l) => l.trim().split(/\s{2,}/);
  const column = cells(header).indexOf('READS W/R');
  const row = cells(line);
  assert.equal(row[column], `${w}/${r}`, `the READS W/R cell of the row: ${line}`);
  return row[column + 1] ?? '';
}

test('cli-usage-read-share: the whole-file share follows READS W/R as a percentage', async () => {
  const { renderUsage } = await load('apps/cli/dist/usage.js');
  assert.equal(cellAfterReads(renderUsage(usageReport([usageRow(3, 1)])), 3, 1), '75%');
  assert.equal(cellAfterReads(renderUsage(usageReport([usageRow(2, 2)])), 2, 2), '50%');
});

test('cli-usage-read-share: an attempt whose reads Friday did not see shows a dash', async () => {
  const { renderUsage } = await load('apps/cli/dist/usage.js');
  assert.equal(cellAfterReads(renderUsage(usageReport([usageRow(0, 0)])), 0, 0), '-');
});

// verification-scope-glob: a file outside the write scope is reported with the nearest scope glob.
const diffInput = (changed, write) => ({
  changed: changed.map((p) => ({ path: p, change: 'modified' })),
  write,
  claimed: null,
  shared: false,
  inScope: (p) => write.some((g) => p.startsWith(g.replace('**', ''))),
  protectedClass: () => null,
  expectsChanges: true,
});
const count = (text, needle) => text.split(needle).length - 1;

test('verification-scope-glob: a file outside the scope is reported with the nearest glob', async () => {
  const { analyzeDiff } = await load('packages/verification/dist/analysis.js');
  const write = ['frontend/src/**', 'backend/src/**'];
  for (const [file, nearest, other] of [
    ['backend/lib/db.ts', 'backend/src/**', 'frontend/src/**'],
    ['frontend/lib/theme.ts', 'frontend/src/**', 'backend/src/**'],
  ]) {
    const finding = analyzeDiff(diffInput([file], write)).find((f) => f.rule === 'diff.outside_scope');
    assert.ok(finding, `no outside-scope finding for ${file}`);
    const text = JSON.stringify(finding);
    assert.ok(text.includes(nearest), `${file}: the finding does not name ${nearest}: ${text}`);
    // Named as the nearest, over and above any list of every scope glob.
    assert.ok(count(text, nearest) > count(text, other), `${file}: ${nearest} is not singled out: ${text}`);
  }
});

test('verification-scope-glob: the findings keep their rules and paths', async () => {
  const { analyzeDiff } = await load('packages/verification/dist/analysis.js');
  const findings = analyzeDiff(diffInput(['src/a.ts', 'infra/deploy.json'], ['src/**']));
  assert.deepEqual(
    findings.map((f) => [f.rule, f.severity, f.paths]),
    [['diff.outside_scope', 'fail', ['infra/deploy.json']]],
  );
});
