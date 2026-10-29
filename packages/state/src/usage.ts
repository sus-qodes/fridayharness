/**
 * The token baseline (plan M10a): one usage row per run attempt, joined from Friday's own log.
 *
 * A row brings together what nothing else joins: the host's `host.usage` report (tokens, cache,
 * cost, turns), the context packets delivered to the attempt and their weight, the attempt's
 * context requests and tool calls by kind, and the verification verdict. Every later change to
 * context handling is judged against these rows, so the rules here are deterministic and say
 * where each number comes from. A value the host did not report is null, never 0. Beside the cost
 * stands the task's spending cap the attempt reached, when it did (`budget.exceeded`, plan M11.5).
 */
import type { SqlDatabase, SqlValue } from '@friday/db';
import type { RunView, UsageReport, UsageRowView, UsageToolKinds, VerificationView } from '@friday/protocol';
import type { Queries } from './queries.js';
import { type RunRow, toRunView } from './rows.js';

export interface UsageReportOptions {
  goalId?: string | undefined;
  taskId?: string | undefined;
  /** How many of the newest attempts the unfiltered report holds (default 500). */
  limit?: number | undefined;
}

export const USAGE_DEFAULT_LIMIT = 500;

/** SQLite binds at most 999 variables in older builds; `IN (...)` lists stay under it. */
const IN_CHUNK = 400;

/** A tool's kind from its name, as the hooks router (`Read`), Codex (`fileChange`) and MCP (`mcp__friday__…`) name them. */
export function toolKind(tool: string | null | undefined): keyof UsageToolKinds {
  const name = String(tool ?? '').trim();
  if (!name) return 'other';
  if (name.startsWith('mcp__friday__')) return 'friday';
  switch (name.toLowerCase()) {
    case 'read':
    case 'glob':
    case 'grep':
    case 'ls':
    case 'notebookread':
    case 'fileread':
    case 'filesearch':
    case 'search':
      return 'read';
    case 'edit':
    case 'multiedit':
    case 'write':
    case 'notebookedit':
    case 'filechange':
    case 'apply_patch':
    case 'applypatch':
      return 'edit';
    case 'bash':
    case 'powershell':
    case 'shell':
    case 'commandexecution':
    case 'exec_command':
      return 'shell';
    case 'webfetch':
    case 'websearch':
    case 'web_search':
    case 'web_fetch':
      return 'web';
    default:
      return 'other';
  }
}

interface EventRow {
  sequence: number;
  run_id: string;
  event_type: string;
  tool: string | null;
  /** The `data` object of a `host.usage` event as JSON text; null for tool events. */
  data_json: string | null;
  /** The session that made the call, when the recorder named it (the hooks router does). */
  harness_id: string | null;
  /** 1 for a Read of a line range, 0 for one of the whole file, null when the record does not say. */
  read_ranged: number | null;
}

interface RequestRow {
  run_id: string;
  kind: string | null;
  harness_id: string | null;
}

interface PacketRow {
  task_id: string;
  recipient_id: string;
  created_at: string;
  run_id: string | null;
  harness_id: string | null;
  tokens: number | null;
  chars: number | null;
  purpose: string | null;
  source_tokens: number | null;
}

/**
 * Whether something recorded for a session belongs to an attempt: it named no session (an older
 * record, or a spawn adapter's report, which Friday already checked against the run), or it named
 * the attempt's own. A second live session of the same agent (a shadow, or one restarted during
 * the reconnect grace) reads and gets packets for the same task, and none of that is the attempt's.
 */
const ofAttempt = (harnessId: string | null, run: RunView): boolean =>
  harnessId === null || harnessId === run.harness_id;

interface RunUsage {
  tools: { total: number; failed: number; by_kind: UsageToolKinds; reads: { whole_file: number; ranged: number } };
  host: UsageRowView['host'];
  requests: Map<string, number>;
  packets: {
    count: number;
    tokens: number;
    chars: number | null;
    source_tokens: number;
    requestKinds: Map<string, number>;
  };
}

const emptyKinds = (): UsageToolKinds => ({ read: 0, edit: 0, shell: 0, web: 0, friday: 0, other: 0 });
const unknownHost = (): UsageRowView['host'] => ({
  reported: false,
  input_tokens: null,
  output_tokens: null,
  cache_read_input_tokens: null,
  cache_creation_input_tokens: null,
  cost_usd: null,
  cap_usd: null,
  turns: null,
  model: null,
});

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};
const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += IN_CHUNK) out.push(items.slice(i, i + IN_CHUNK));
  return out;
}

/** The runs the report covers: the attempts (accepted runs, ADR-0026) of a task, of a goal's tasks, or the newest ones. */
function selectRuns(
  db: SqlDatabase,
  q: Queries,
  projectId: string,
  opts: UsageReportOptions,
): { runs: RunView[]; truncated: boolean; limit: number | null } {
  if (opts.taskId) {
    q.task(projectId, opts.taskId);
    return { runs: q.attemptsOf(opts.taskId), truncated: false, limit: null };
  }
  if (opts.goalId) {
    q.goal(projectId, opts.goalId);
    const runs = q.goalTasks(projectId, opts.goalId).flatMap((t) => q.attemptsOf(t.task_id));
    return { runs, truncated: false, limit: null };
  }
  const limit = Math.max(1, Math.floor(opts.limit ?? USAGE_DEFAULT_LIMIT));
  // One more than the limit tells whether anything was left out.
  const newest = db
    .prepare(
      `SELECT * FROM task_runs WHERE project_id = ? AND accepted_at IS NOT NULL
        ORDER BY created_at DESC, run_id DESC LIMIT ?`,
    )
    .all<RunRow>(projectId, limit + 1)
    .map(toRunView);
  return { runs: newest.slice(0, limit), truncated: newest.length > limit, limit };
}

/**
 * The attempts' tool calls and host reports, read from `agent.event` observations through the
 * index on (project, type, sequence) the way `toolCallCounts` does. The hooks router puts the tool
 * name at the payload's top (`tool`) and names the session (`harness_id`); spawn adapters report
 * the tool inside `data` (`data.tool`), and the daemon has already refused their events for a run
 * of another session.
 */
function readEvents(
  db: SqlDatabase,
  projectId: string,
  runs: Map<string, RunView>,
  usage: Map<string, RunUsage>,
): void {
  for (const ids of chunks([...runs.keys()])) {
    const marks = ids.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT sequence,
                json_extract(payload_json, '$.run_id') AS run_id,
                json_extract(payload_json, '$.event_type') AS event_type,
                COALESCE(json_extract(payload_json, '$.tool'), json_extract(payload_json, '$.data.tool')) AS tool,
                CASE WHEN json_extract(payload_json, '$.event_type') = 'host.usage'
                     THEN json_extract(payload_json, '$.data') END AS data_json,
                json_extract(payload_json, '$.harness_id') AS harness_id,
                COALESCE(json_extract(payload_json, '$.read.ranged'), json_extract(payload_json, '$.data.read.ranged')) AS read_ranged
           FROM events
          WHERE project_id = ? AND type = 'agent.event'
            AND json_extract(payload_json, '$.event_type') IN ('tool.completed', 'tool.failed', 'host.usage')
            AND json_extract(payload_json, '$.run_id') IN (${marks})
          ORDER BY sequence`,
      )
      .all<EventRow>(projectId, ...(ids as SqlValue[]));
    for (const r of rows) {
      const run = runs.get(r.run_id);
      const u = usage.get(r.run_id);
      if (!run || !u || !ofAttempt(r.harness_id, run)) continue;
      if (r.event_type === 'host.usage') {
        // The last report wins: a host that reports more than once ends with its final figures.
        // Older events lack the cache keys and the model; a missing key is unknown, not 0.
        let d: Record<string, unknown> = {};
        try {
          d = (r.data_json ? JSON.parse(r.data_json) : {}) as Record<string, unknown>;
        } catch {
          d = {};
        }
        u.host = {
          reported: true,
          input_tokens: int(d.input_tokens),
          output_tokens: int(d.output_tokens),
          cache_read_input_tokens: int(d.cache_read_input_tokens),
          cache_creation_input_tokens: int(d.cache_creation_input_tokens),
          cost_usd: num(d.cost_usd),
          // Friday's figure, not the host's: kept across the host's reports.
          cap_usd: u.host.cap_usd,
          turns: int(d.turns),
          model: text(d.model),
        };
        continue;
      }
      u.tools.total += 1;
      if (r.event_type === 'tool.failed') u.tools.failed += 1;
      u.tools.by_kind[toolKind(r.tool)] += 1;
      // A Read of a line range against one of the whole file: only the hooks' record says which
      // (`read.ranged`); a tool event without it counts for neither.
      if (r.read_ranged !== null && r.read_ranged !== undefined) {
        if (Number(r.read_ranged) === 1) u.tools.reads.ranged += 1;
        else u.tools.reads.whole_file += 1;
      }
    }
  }
}

/**
 * The attempts that reached the task's spending cap (`budget.exceeded`, plan M11.5), whether Friday
 * then ended them or their claim still arrived: the cap stands beside the cost the host reported.
 * Friday records it once per attempt, so the first record is the record; an attempt that reached no
 * cap keeps null.
 */
function readCaps(db: SqlDatabase, projectId: string, runs: Map<string, RunView>, usage: Map<string, RunUsage>): void {
  for (const ids of chunks([...runs.keys()])) {
    const marks = ids.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT json_extract(payload_json, '$.run_id') AS run_id,
                json_extract(payload_json, '$.cap_usd') AS cap_usd
           FROM events
          WHERE project_id = ? AND type = 'budget.exceeded'
            AND json_extract(payload_json, '$.run_id') IN (${marks})
          ORDER BY sequence`,
      )
      .all<{ run_id: string; cap_usd: number | null }>(projectId, ...(ids as SqlValue[]));
    for (const r of rows) {
      const u = usage.get(r.run_id);
      const cap = num(r.cap_usd);
      if (u && cap !== null && u.host.cap_usd === null) u.host.cap_usd = cap;
    }
  }
}

/**
 * `context.requested` observations that name the attempt (their payload carries `run_id`, `kind`
 * and the session that asked). The daemon records one when a request arrives, before it is
 * answered, so a request the compiler refused counts too.
 */
function readRequests(
  db: SqlDatabase,
  projectId: string,
  runs: Map<string, RunView>,
  usage: Map<string, RunUsage>,
): void {
  for (const ids of chunks([...runs.keys()])) {
    const marks = ids.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT json_extract(payload_json, '$.run_id') AS run_id,
                json_extract(payload_json, '$.kind') AS kind,
                json_extract(payload_json, '$.harness_id') AS harness_id
           FROM events
          WHERE project_id = ? AND type = 'context.requested'
            AND json_extract(payload_json, '$.run_id') IN (${marks})
          ORDER BY sequence`,
      )
      .all<RequestRow>(projectId, ...(ids as SqlValue[]));
    for (const r of rows) {
      const run = runs.get(r.run_id);
      const u = usage.get(r.run_id);
      if (!run || !u || !ofAttempt(r.harness_id, run)) continue;
      const kind = r.kind ?? 'unknown';
      u.requests.set(kind, (u.requests.get(kind) ?? 0) + 1);
    }
  }
}

/**
 * The packets delivered to each attempt, from `context_packets` (the projection of
 * `context.compiled`). A packet belongs to an attempt by one of two rules, in this order:
 *
 * 1. by run: its `recipient.run_id` names the attempt (a claim's packet, a `context.request` that
 *    named its run). A packet that names another run is never counted here.
 * 2. by lifetime: it names no run, it is about the attempt's task, its recipient is the attempt's
 *    agent, and it was compiled between the attempt's start and its end (or now, while it runs).
 *    When two attempts of one task by one agent touch at a boundary, the earlier attempt takes it,
 *    so the same packet is never counted twice.
 *
 * Under both rules a packet compiled for another session of the same agent (`recipient.harness_id`
 * names one that is not the attempt's) is not the attempt's: a shadow session gets its own packet
 * for the same task at its start, and the attempt was never given it.
 *
 * Only the fields the row needs leave SQLite: a packet's JSON can be large.
 */
function readPackets(db: SqlDatabase, projectId: string, runs: RunView[], usage: Map<string, RunUsage>): void {
  const byRun = new Map(runs.map((r) => [r.run_id, r]));
  const byTask = new Map<string, RunView[]>();
  for (const r of runs) byTask.set(r.task_id, [...(byTask.get(r.task_id) ?? []), r]);
  for (const list of byTask.values()) list.sort((a, b) => a.attempt - b.attempt || a.run_id.localeCompare(b.run_id));
  for (const taskIds of chunks([...byTask.keys()])) {
    const marks = taskIds.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT task_id, recipient_id, created_at,
                json_extract(packet_json, '$.recipient.run_id') AS run_id,
                json_extract(packet_json, '$.recipient.harness_id') AS harness_id,
                json_extract(packet_json, '$.budget.tokens') AS tokens,
                json_extract(packet_json, '$.budget.chars') AS chars,
                json_extract(packet_json, '$.purpose') AS purpose,
                (SELECT SUM(json_extract(src.value, '$.estimated_tokens'))
                   FROM json_each(packet_json, '$.sections') AS sec, json_each(sec.value, '$.sources') AS src) AS source_tokens
           FROM context_packets
          WHERE project_id = ? AND task_id IN (${marks})
          ORDER BY created_at, rowid`,
      )
      .all<PacketRow>(projectId, ...(taskIds as SqlValue[]));
    for (const p of rows) {
      let run: RunView | undefined;
      if (p.run_id) {
        run = byRun.get(p.run_id);
        if (run && run.task_id !== p.task_id) run = undefined;
      } else {
        run = (byTask.get(p.task_id) ?? []).find(
          (r) =>
            r.agent_id === p.recipient_id &&
            ofAttempt(p.harness_id, r) &&
            p.created_at >= r.created_at &&
            (r.ended_at === null || p.created_at <= r.ended_at),
        );
      }
      if (!run || !ofAttempt(p.harness_id, run)) continue;
      const u = usage.get(run.run_id);
      if (!u) continue;
      u.packets.count += 1;
      u.packets.tokens += int(p.tokens) ?? 0;
      const chars = int(p.chars);
      if (chars !== null) u.packets.chars = (u.packets.chars ?? 0) + chars;
      u.packets.source_tokens += int(p.source_tokens) ?? 0;
      // The daemon answers a `context.request` with a packet whose purpose is `request:<kind>`.
      if (p.purpose?.startsWith('request:')) {
        const kind = p.purpose.slice('request:'.length) || 'unknown';
        u.packets.requestKinds.set(kind, (u.packets.requestKinds.get(kind) ?? 0) + 1);
      }
    }
  }
}

/**
 * The attempt's verification: the latest one that names the run; or, for the task's newest
 * attempt only, the task's latest verification when it names no run (older records). An earlier
 * attempt never borrows a later attempt's verdict.
 */
function verificationOf(q: Queries, run: RunView, newestOfTask: boolean): UsageRowView['verification'] {
  let v: VerificationView | undefined = q.latestVerificationForRun(run.run_id);
  if (!v && newestOfTask) {
    const latest = q.latestVerification(run.task_id);
    if (latest && latest.run_id === null) v = latest;
  }
  if (!v) return null;
  return {
    status: v.status,
    checks_passed: v.checks.filter((c) => c.status === 'PASSED').length,
    checks_total: v.checks.length,
  };
}

/** Sums the values that were reported; null when none was. */
function sumReported(values: (number | null)[]): number | null {
  let seen = false;
  let total = 0;
  for (const v of values) {
    if (v === null) continue;
    seen = true;
    total += v;
  }
  return seen ? total : null;
}

/** How many of the values were reported: the attempts a total sums, which differ per field. */
const reporters = (values: (number | null)[]): number => values.filter((v) => v !== null).length;

/** Builds the report for a project, a goal's tasks or one task (the daemon's `GET /usage`). */
export function buildUsageReport(
  db: SqlDatabase,
  q: Queries,
  projectId: string,
  opts: UsageReportOptions = {},
): UsageReport {
  const selected = selectRuns(db, q, projectId, opts);
  // Oldest first, so a task's attempts read in order.
  const runs = [...selected.runs].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.run_id.localeCompare(b.run_id),
  );
  const usage = new Map<string, RunUsage>(
    runs.map((r) => [
      r.run_id,
      {
        tools: { total: 0, failed: 0, by_kind: emptyKinds(), reads: { whole_file: 0, ranged: 0 } },
        host: unknownHost(),
        requests: new Map(),
        packets: { count: 0, tokens: 0, chars: null, source_tokens: 0, requestKinds: new Map() },
      },
    ]),
  );
  const byRun = new Map(runs.map((r) => [r.run_id, r]));
  if (runs.length) {
    readEvents(db, projectId, byRun, usage);
    readCaps(db, projectId, byRun, usage);
    readRequests(db, projectId, byRun, usage);
    readPackets(db, projectId, runs, usage);
  }

  // The newest attempt of each task, which alone may take the task's run-less verification.
  const newestAttempt = new Map<string, RunView>();
  for (const r of runs) {
    const seen = newestAttempt.get(r.task_id);
    if (!seen || r.attempt > seen.attempt) newestAttempt.set(r.task_id, r);
  }
  const tasks = new Map<string, ReturnType<Queries['findTask']>>();
  const agents = new Map<string, ReturnType<Queries['findAgent']>>();
  const harnesses = new Map<string, ReturnType<Queries['findHarness']>>();

  const rows: UsageRowView[] = runs.map((run) => {
    if (!tasks.has(run.task_id)) tasks.set(run.task_id, q.findTask(projectId, run.task_id));
    if (!agents.has(run.agent_id)) agents.set(run.agent_id, q.findAgent(run.agent_id));
    if (!harnesses.has(run.harness_id)) harnesses.set(run.harness_id, q.findHarness(run.harness_id));
    const task = tasks.get(run.task_id);
    const agent = agents.get(run.agent_id);
    const harness = harnesses.get(run.harness_id);
    const u = usage.get(run.run_id) as RunUsage;
    // A `context.requested` observation names the kind directly; when none was recorded for the
    // attempt, the packets that answered its requests count instead, so no request counts twice.
    const kinds = u.requests.size ? u.requests : u.packets.requestKinds;
    const started_at = run.accepted_at ?? run.created_at;
    const ended_at = run.ended_at;
    const duration = ended_at ? Date.parse(ended_at) - Date.parse(started_at) : Number.NaN;
    return {
      task_id: run.task_id,
      task_summary: task?.summary ?? '',
      goal_id: task?.goal_id ?? null,
      run_id: run.run_id,
      attempt: run.attempt,
      agent_key: agent?.agent_key ?? null,
      harness_vendor: harness?.vendor ?? null,
      harness_mode: harness?.attach_mode ?? null,
      model_requested: run.model_requested ?? null,
      model_observed: run.model_observed ?? null,
      model_basis: run.model_basis ?? null,
      packets: {
        count: u.packets.count,
        tokens: u.packets.tokens,
        chars: u.packets.chars,
        source_tokens: u.packets.source_tokens,
      },
      context_requests: {
        count: [...kinds.values()].reduce((a, b) => a + b, 0),
        kinds: Object.fromEntries([...kinds.entries()].sort(([a], [b]) => a.localeCompare(b))),
      },
      host: u.host,
      tool_calls: u.tools,
      verification: verificationOf(q, run, newestAttempt.get(run.task_id)?.run_id === run.run_id),
      started_at,
      ended_at,
      duration_ms: Number.isFinite(duration) ? Math.max(0, Math.round(duration)) : null,
    };
  });

  const hosts = rows.map((r) => r.host);
  const field = (
    k: 'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens' | 'cost_usd',
  ) => hosts.map((h) => h[k]);
  const cost = sumReported(field('cost_usd'));
  return {
    rows,
    totals: {
      attempts: rows.length,
      host_reported: hosts.filter((h) => h.reported).length,
      // A host may report some fields and not others (an older report without the cache fields, an
      // error result with a cost and no counts), so each total says how many attempts it sums.
      reporters: {
        input_tokens: reporters(field('input_tokens')),
        output_tokens: reporters(field('output_tokens')),
        cache_read_input_tokens: reporters(field('cache_read_input_tokens')),
        cache_creation_input_tokens: reporters(field('cache_creation_input_tokens')),
        cost_usd: reporters(field('cost_usd')),
      },
      input_tokens: sumReported(field('input_tokens')),
      output_tokens: sumReported(field('output_tokens')),
      cache_read_input_tokens: sumReported(field('cache_read_input_tokens')),
      cache_creation_input_tokens: sumReported(field('cache_creation_input_tokens')),
      // Summed money carries binary noise (0.1 + 0.2); a millionth of a dollar is below any report.
      cost_usd: cost === null ? null : Math.round(cost * 1e6) / 1e6,
      tool_calls: rows.reduce((a, r) => a + r.tool_calls.total, 0),
    },
    truncated: selected.truncated,
    limit: selected.limit,
  };
}
