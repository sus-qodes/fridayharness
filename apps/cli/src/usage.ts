import type { UsageReport, UsageRowView } from '@friday/protocol';
import type { Command } from 'commander';
import { type GlobalOptions, operator, out } from './context.js';
import { table } from './output.js';

/**
 * The token baseline (plan M10a): what each run attempt was given, spent and did, from Friday's own
 * log. A value the host did not report prints as "-", never as 0; so does a column with nothing to
 * show, and the legend says which is which.
 */

const dash = (v: number | string | null | undefined): string => (v === null || v === undefined ? '-' : String(v));
const money = (v: number | null): string => (v === null ? '-' : `$${v.toFixed(4)}`);

/** The model that ran, as the host named it; what Friday asked for when nothing ran yet. */
function modelOf(r: UsageRowView): string {
  if (r.host.model) return r.host.model;
  if (r.model_observed) return r.model_observed;
  return r.model_requested ? `${r.model_requested} (asked)` : '-';
}

function verifiedText(r: UsageRowView): string {
  const v = r.verification;
  return v ? `${v.status} ${v.checks_passed}/${v.checks_total}` : '-';
}

type TokenTotal = keyof UsageReport['totals']['reporters'];

/**
 * A total with the attempts it sums, when fewer than the attempts that reported usage gave that
 * field (an older report without the cache fields, an error result with a cost and no counts): a
 * cache share read off this line is sound only when the figures come from the same attempts.
 */
function total(t: UsageReport['totals'], field: TokenTotal, shown: string): string {
  const n = t.reporters[field];
  return n === t.host_reported || t[field] === null ? shown : `${shown} (from ${n} of ${t.host_reported})`;
}

export function renderUsage(report: UsageReport): string {
  if (!report.rows.length) return 'No attempts yet: the row appears once a host has run a task.';
  const t = report.totals;
  const lines = [
    table(
      [
        'TASK',
        'ATTEMPT',
        'AGENT',
        'MODEL',
        'PACKET TOK',
        'IN',
        'OUT',
        'CACHE RD',
        'CACHE WR',
        'COST',
        'TOOLS R/E/S/F',
        'VERIFIED',
      ],
      report.rows.map((r) => [
        r.task_id,
        r.attempt,
        dash(r.agent_key),
        modelOf(r),
        r.packets.count ? r.packets.tokens : '-',
        dash(r.host.input_tokens),
        dash(r.host.output_tokens),
        dash(r.host.cache_read_input_tokens),
        dash(r.host.cache_creation_input_tokens),
        money(r.host.cost_usd),
        `${r.tool_calls.by_kind.read}/${r.tool_calls.by_kind.edit}/${r.tool_calls.by_kind.shell}/${r.tool_calls.by_kind.friday}`,
        verifiedText(r),
      ]),
    ),
    'TOOLS: read/edit/shell/Friday calls the host reported; PACKET TOK: the delivered packets\' token budget; "-" under IN, OUT, CACHE and COST: the host did not report it; elsewhere: nothing to show (no packet delivered, no verdict yet, no model named, the agent record gone).',
    `${t.attempts} attempt(s), ${t.host_reported} of ${t.attempts} reported host usage: in ${total(t, 'input_tokens', dash(t.input_tokens))}, out ${total(t, 'output_tokens', dash(t.output_tokens))}, cache read ${total(t, 'cache_read_input_tokens', dash(t.cache_read_input_tokens))}, cache write ${total(t, 'cache_creation_input_tokens', dash(t.cache_creation_input_tokens))}, cost ${total(t, 'cost_usd', money(t.cost_usd))}; ${t.tool_calls} tool call(s).`,
  ];
  if (report.truncated) {
    lines.push(`Showing the newest ${report.limit} attempts; --goal <id> or --task <id> shows the others.`);
  }
  return lines.join('\n');
}

export function registerUsageCommands(program: Command, g: () => GlobalOptions): void {
  program
    .command('usage')
    .description(
      'per run attempt: host tokens and cost, delivered packets, tool calls by kind, verification (the token baseline)',
    )
    .option('--goal <goal>', "the attempts of one goal's tasks")
    .option('--task <task>', 'the attempts of one task')
    .action(async (o: { goal?: string; task?: string }) => {
      const { client } = operator(g());
      const r = await client.get<UsageReport>(client.projectPath('/usage'), {
        query: { goal: o.goal, task: o.task },
      });
      out(g(), r, () => renderUsage(r));
    });
}
