import type { UsageReport, UsageRowView } from '@friday/protocol';
import { describe, expect, it } from 'vitest';
import { renderUsage } from './usage.js';

/** A row whose host said nothing and to which Friday delivered nothing; each test changes what it needs. */
function row(o: Partial<Omit<UsageRowView, 'host'>> & { host?: Partial<UsageRowView['host']> } = {}): UsageRowView {
  return {
    task_id: 'task_00000000000000000000000001',
    task_summary: 'a task',
    goal_id: null,
    run_id: 'run_00000000000000000000000001',
    attempt: 1,
    agent_key: 'dev-1',
    harness_vendor: 'claude-code',
    harness_mode: 'attach',
    model_requested: null,
    model_observed: null,
    model_basis: null,
    packets: { count: 0, tokens: 0, chars: null, source_tokens: 0 },
    context_requests: { count: 0, kinds: {} },
    tool_calls: {
      total: 0,
      failed: 0,
      by_kind: { read: 0, edit: 0, shell: 0, web: 0, friday: 0, other: 0 },
      reads: { whole_file: 0, ranged: 0 },
    },
    verification: null,
    started_at: '2026-10-14T10:00:00.000Z',
    ended_at: null,
    duration_ms: null,
    ...o,
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
      ...o.host,
    },
  };
}

function report(rows: UsageRowView[], totals: Partial<UsageReport['totals']> = {}): UsageReport {
  const hosts = rows.map((r) => r.host);
  const count = (k: keyof UsageReport['totals']['reporters']) => hosts.filter((h) => h[k] !== null).length;
  return {
    rows,
    totals: {
      attempts: rows.length,
      host_reported: hosts.filter((h) => h.reported).length,
      reporters: {
        input_tokens: count('input_tokens'),
        output_tokens: count('output_tokens'),
        cache_read_input_tokens: count('cache_read_input_tokens'),
        cache_creation_input_tokens: count('cache_creation_input_tokens'),
        cost_usd: count('cost_usd'),
      },
      input_tokens: null,
      output_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      cost_usd: null,
      tool_calls: rows.reduce((a, r) => a + r.tool_calls.total, 0),
      ...totals,
    },
    truncated: false,
    limit: 500,
  };
}

describe('friday usage, the table (plan M10a)', () => {
  it("shows the task's spending cap beside the cost of an attempt Friday ended at it (plan M11.5)", () => {
    const stopped = row({ host: { reported: true, cost_usd: 0.0123, cap_usd: 0.01, turns: 3 } });
    const text = renderUsage(report([stopped], { cost_usd: 0.0123 }));
    expect(text).toMatch(/\$0\.0123 \(cap \$0\.0100\)\s+0\/0\/0\/0/);
    expect(text).toContain('COST "(cap $x)": the attempt reached the task\'s spending cap');
    // An attempt no cap ended shows its cost alone.
    expect(renderUsage(report([row({ host: { reported: true, cost_usd: 0.5 } })]))).toMatch(/\$0\.5000\s+0\/0\/0\/0/);
  });

  it('says which "-" means the host did not report and which means nothing to show', () => {
    // No packet, no verdict, no model, no agent record: four dashes the host had no part in.
    const text = renderUsage(report([row({ agent_key: null })]));
    expect(text).toMatch(/task_\S+\s+1\s+-\s+-\s+-\s+-\s+-\s+-\s+-\s+-\s+0\/0\/0\/0\s+0\/0\s+-/);
    expect(text).toContain('"-" under IN, OUT, CACHE and COST: the host did not report it');
    expect(text).toContain('READS W/R');
    expect(text).toContain(
      'elsewhere: nothing to show (no packet delivered, no verdict yet, no model named, the agent record gone)',
    );
    expect(text).toContain(
      '1 attempt(s), 0 of 1 reported host usage: in -, out -, cache read -, cache write -, cost -; 0 tool call(s).',
    );
  });

  it('says which attempts a total comes from when fewer reported that field than reported usage', () => {
    const full = row({
      host: {
        reported: true,
        input_tokens: 1200,
        output_tokens: 80,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 100,
        cost_usd: 0.0123,
        turns: 3,
        model: 'claude-haiku-5-5',
      },
    });
    // An older report without the cache fields: it counts for the token totals, not the cache ones.
    const bare = row({
      run_id: 'run_00000000000000000000000002',
      attempt: 2,
      host: { reported: true, input_tokens: 100, output_tokens: 10, cost_usd: 0.01, turns: 1 },
    });
    const text = renderUsage(
      report([full, bare], {
        input_tokens: 1300,
        output_tokens: 90,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 100,
        cost_usd: 0.0223,
      }),
    );
    expect(text).toContain(
      '2 attempt(s), 2 of 2 reported host usage: in 1300, out 90, cache read 900 (from 1 of 2), cache write 100 (from 1 of 2), cost $0.0223; 0 tool call(s).',
    );
    // When every reporter gave every field, the line says nothing more.
    const same = renderUsage(
      report([full], {
        input_tokens: 1200,
        output_tokens: 80,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 100,
        cost_usd: 0.0123,
      }),
    );
    expect(same).toContain(
      '1 attempt(s), 1 of 1 reported host usage: in 1200, out 80, cache read 900, cache write 100, cost $0.0123; 0 tool call(s).',
    );
    expect(same).not.toContain('(from');
  });
});
