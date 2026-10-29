/**
 * The ingestion dispatcher (handoff Part 07 §4, plan §7.2): applies what an event shows between
 * snapshots (tool activity, file ticker, pulses, logs, usage, reactions, stale line counts, the
 * arrival and removal of approvals) and says whether the event changed domain state, in which case
 * the snapshot is read again. It derives no other domain state (plan FD-08).
 *
 * Approvals are the one place it edits the board itself: a requested approval is shown from its
 * event payload in the same tick, and a decided or revoked one leaves the pending list at once, on
 * every surface, before the re-read. `reconcile` keeps those edits over a snapshot read before
 * them, until a snapshot at or after their event replaces them.
 */
import type { ApprovalRow, DomainEvent, UiSnapshot } from '@friday/protocol';
import type { ActivityState, AgentActivity, FridayStore, LogLine, ReactionKind, ToolKind } from '../store/state.js';
import { cleanText, truncate } from '../ui/format.js';

/** Events that change no view of the snapshot: shown from the stream only. */
const TRANSIENT = new Set([
  'policy.evaluated',
  'agent.event',
  'run.paths_observed',
  'agent.turn_ended',
  'context.compiled',
  'scope.violation',
  'ownership.conflict',
  'command.rejected',
  'approval.used',
  'ui.session_started',
  'ui.session_ended',
  'laya.answered',
  'laya.unavailable',
  'routing.decided',
  'routing.outcome_recorded',
  'harness.session_bound',
  'agent.process_output',
]);

const LOG_LIMIT = 300;
const FILES_LIMIT = 12;
const PULSE_LIMIT = 80;
const REACTION_LIMIT = 20;
/** Local approval edits remembered for `reconcile` (they end when a later snapshot arrives). */
const LOCAL_LIMIT = 400;
const DURATION_AGENTS_LIMIT = 500;

export function isDomainEvent(type: string): boolean {
  return !TRANSIENT.has(type);
}

function toolKind(value: unknown): ToolKind {
  switch (value) {
    case 'read':
    case 'search':
    case 'write':
    case 'command':
    case 'network':
    case 'mcp':
    case 'capability':
      return value;
    default:
      return 'other';
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
}

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function emptyAgent(): AgentActivity {
  return { current: null, log: [], usage: null, model: null };
}

/** The pending approval row an `approval.requested` payload describes, or null when it is not one. */
export function approvalFromEvent(event: DomainEvent): ApprovalRow | null {
  const a = record(record(event.payload).approval);
  const id = str(a.approval_id);
  if (!id || (a.status !== undefined && a.status !== 'pending')) return null;
  const risk = a.risk === 'low' || a.risk === 'medium' || a.risk === 'high' ? a.risk : null;
  const reuse = a.reuse === 'run' || a.reuse === 'task' ? a.reuse : 'once';
  return {
    approval_id: id,
    project_id: event.project_id,
    task_id: str(a.task_id),
    run_id: str(a.run_id),
    requested_by_kind: event.actor?.kind ?? 'agent',
    requested_by_id: event.actor?.id ?? '',
    capability: str(a.capability) ?? 'unknown',
    target: typeof a.target === 'string' ? a.target : null,
    purpose: typeof a.purpose === 'string' ? a.purpose : null,
    risk,
    status: 'pending',
    decided_by_kind: null,
    decided_by_id: null,
    decided_at: null,
    expires_at: str(a.expires_at),
    created_at: event.occurred_at,
    reuse,
    policy_version: str(a.policy_version),
    uses: 0,
    last_used_at: null,
    note: null,
    decided_via: null,
    expired: false,
  };
}

let nextId = 1;

interface LocalEdit {
  sequence: number;
  /** Present for an approval shown before the snapshot has it; absent for a removal. */
  row: ApprovalRow | null;
}

/** How long an approval decided here stays out of older snapshots. */
const DECIDED_TTL_MS = 120_000;

export class Dispatcher {
  /** Per agent key: the tool the host asked about, waiting for its completion. */
  readonly #toolStart = new Map<string, { tool: string; at: number }>();
  /** Per agent key: how long the last tool took, from `policy.evaluated` to its completion. */
  readonly #toolDuration = new Map<string, number>();
  readonly #local = new Map<string, LocalEdit>();

  constructor(private readonly store: FridayStore) {}

  /** Applies one event; returns true when the snapshot should be read again. */
  handle(event: DomainEvent, now: number = Date.now()): boolean {
    const p = record(event.payload);
    switch (event.type) {
      case 'policy.evaluated':
        this.#tool(event, p, now);
        break;
      case 'agent.event':
        this.#agentEvent(event, p, now);
        break;
      case 'run.paths_observed':
        this.#paths(p, now);
        break;
      case 'agent.turn_ended':
        this.#log(this.#agentKeyOf(event), { at: now, sequence: event.sequence, stream: 'info', text: 'turn ended' });
        break;
      case 'scope.violation':
      case 'ownership.conflict':
      case 'command.rejected':
        this.#log(this.#agentKeyOf(event) ?? this.#agentKeyOfTask(str(p.task_id)), {
          at: now,
          sequence: event.sequence,
          stream: 'error',
          text: `${event.type}: ${truncate(cleanText(JSON.stringify(p)), 300)}`,
        });
        break;
      case 'integration.failed':
      case 'integration.conflicted': {
        const i = record(p.integration);
        const conflicts = strings(i.conflicts);
        this.#log(this.#agentKeyOfTask(str(i.task_id) ?? str(p.task_id)), {
          at: now,
          sequence: event.sequence,
          stream: 'error',
          text: `${event.type === 'integration.failed' ? 'integration failed' : 'integration conflicted'}${i.summary ? `: ${truncate(cleanText(String(i.summary)), 240)}` : ''}${conflicts.length ? ` (${conflicts.slice(0, 5).map(clean).join(', ')})` : ''}`,
        });
        break;
      }
      case 'approval.requested': {
        const row = approvalFromEvent(event);
        if (row) this.#addApproval(row, event.sequence);
        this.#react('approval', now, str(record(p.approval).capability) ?? undefined);
        break;
      }
      case 'approval.decided':
      case 'approval.revoked': {
        const id = str(p.approval_id);
        if (id) this.#removeApproval(id, event.sequence);
        break;
      }
      case 'escalation.requested':
        this.#react('question', now);
        break;
      case 'plan.proposed':
        this.#react('plan', now);
        break;
      case 'task.waiting': {
        const reason = record(p.changes).waiting_reason ?? p.waiting_reason;
        if (reason === 'blocked') this.#react('question', now);
        break;
      }
      case 'task.completed':
        this.#react('completed', now);
        break;
      case 'goal.status_changed':
        if (record(p.transition).to === 'COMPLETED') this.#react('goal-completed', now);
        break;
      case 'task.failed':
        this.#react('failed', now);
        break;
      case 'verification.finished':
        if (p.status === 'FAILED') this.#react('failed', now);
        break;
      case 'task.harness_lost':
        this.#react('lost', now);
        break;
      case 'task.created':
      case 'goal.created':
        this.#react('node', now);
        break;
      case 'harness.registered':
        // A new agent: Blip's happy hop (the label tells sounds and the mascot it was an agent).
        this.#react('approved', now, 'agent');
        break;
      case 'control.halted':
        this.#react('halt', now);
        break;
      default:
        // `brain.call_started` and every other domain event: the snapshot is read again.
        break;
    }
    return isDomainEvent(event.type);
  }

  /** A reaction started by the interface itself (an approval decided here). */
  react(kind: ReactionKind, now: number = Date.now(), label?: string): void {
    this.#react(kind, now, label);
  }

  /** How long the agent's last tool took (ms), from its policy decision to its completion. */
  lastToolDuration(agentKey: string): number | null {
    return this.#toolDuration.get(agentKey) ?? null;
  }

  /**
   * The snapshot with the approval edits of events it does not include yet (its `head` is before
   * them); edits it covers are forgotten.
   */
  reconcile(raw: UiSnapshot): UiSnapshot {
    const board = this.#withoutDecided(raw);
    if (!this.#local.size) return board;
    let approvals = board.approvals;
    let changed = false;
    for (const [id, edit] of this.#local) {
      if (edit.sequence <= board.head) {
        this.#local.delete(id);
        continue;
      }
      const has = approvals.some((a) => a.approval_id === id);
      if (edit.row && !has) {
        approvals = [...approvals, edit.row];
        changed = true;
      } else if (!edit.row && has) {
        approvals = approvals.filter((a) => a.approval_id !== id);
        changed = true;
      }
    }
    return changed ? { ...board, approvals } : board;
  }

  /**
   * Leaves out approvals this page decided while a snapshot older than the decision was read; a
   * mark ends once a snapshot no longer lists its approval, or after two minutes.
   */
  #withoutDecided(board: UiSnapshot): UiSnapshot {
    const decided = this.store.select('ui').decided;
    const ids = Object.keys(decided);
    if (!ids.length) return board;
    const now = Date.now();
    const keep: Record<string, number> = {};
    for (const id of ids) {
      const at = decided[id] ?? 0;
      if (now - at < DECIDED_TTL_MS && board.approvals.some((a) => a.approval_id === id)) keep[id] = at;
    }
    if (Object.keys(keep).length !== ids.length) this.store.patch('ui', { decided: keep });
    if (!Object.keys(keep).length) return board;
    return { ...board, approvals: board.approvals.filter((a) => !(a.approval_id in keep)) };
  }

  /** Drops pulses older than `maxAgeMs` (the canvas calls this as it draws). */
  prunePulses(now: number, maxAgeMs = 1600): void {
    const a = this.store.select('activity');
    const pulses = a.pulses.filter((x) => now - x.born < maxAgeMs);
    if (pulses.length !== a.pulses.length) this.#setActivity({ ...a, pulses });
  }

  // ------------------------------------------------------------------------------------------

  #setActivity(next: ActivityState): void {
    this.store.setState({ activity: next });
  }

  #remember(id: string, edit: LocalEdit): void {
    this.#local.delete(id);
    this.#local.set(id, edit);
    while (this.#local.size > LOCAL_LIMIT) {
      const oldest = this.#local.keys().next().value;
      if (oldest === undefined) break;
      this.#local.delete(oldest);
    }
  }

  #addApproval(row: ApprovalRow, sequence: number): void {
    const removed = this.#local.get(row.approval_id);
    if (removed && !removed.row) return; // decided before this arrived (replayed out of order)
    if (row.approval_id in this.store.select('ui').decided) return; // decided here
    const current = this.store.select('board');
    // A snapshot that already covers this event and does not list the approval: it was decided.
    if (current && sequence <= current.head && !current.approvals.some((a) => a.approval_id === row.approval_id))
      return;
    this.#remember(row.approval_id, { sequence, row });
    const board = this.store.select('board');
    if (!board || board.approvals.some((a) => a.approval_id === row.approval_id)) return;
    this.store.setState({ board: { ...board, approvals: [...board.approvals, row] } });
  }

  #removeApproval(id: string, sequence: number): void {
    this.#remember(id, { sequence, row: null });
    const board = this.store.select('board');
    if (!board?.approvals.some((a) => a.approval_id === id)) return;
    this.store.setState({ board: { ...board, approvals: board.approvals.filter((a) => a.approval_id !== id) } });
  }

  #agentKeyOf(event: DomainEvent): string | null {
    const board = this.store.select('board');
    if (!board) return null;
    const id = event.actor?.id;
    if (event.actor?.kind === 'agent') return board.agents.find((a) => a.agent_id === id)?.agent_key ?? null;
    if (event.actor?.kind === 'harness') return board.agents.find((a) => a.harness_id === id)?.agent_key ?? null;
    return null;
  }

  #agentKeyOfRun(runId: string | null): string | null {
    const board = this.store.select('board');
    if (!board || !runId) return null;
    const run = Object.values(board.runs).find((r) => r.run_id === runId);
    if (!run) return null;
    return board.agents.find((a) => a.agent_id === run.agent_id)?.agent_key ?? null;
  }

  #agentKeyOfTask(taskId: string | null): string | null {
    const board = this.store.select('board');
    if (!board || !taskId) return null;
    const task = board.tasks.find((t) => t.task_id === taskId);
    if (task?.agent_key) return task.agent_key;
    const run = board.runs[taskId];
    return run ? (board.agents.find((a) => a.agent_id === run.agent_id)?.agent_key ?? null) : null;
  }

  #taskOfRun(runId: string | null): string | null {
    const board = this.store.select('board');
    if (!board || !runId) return null;
    return Object.values(board.runs).find((r) => r.run_id === runId)?.task_id ?? null;
  }

  /** A write: the task's `+N −M` is stale until the canvas reads it again (plan §7.2). */
  #markStale(taskId: string | null, now: number): void {
    if (!taskId) return;
    const ui = this.store.select('ui');
    if (ui.staleStats[taskId] === now) return;
    this.store.patch('ui', { staleStats: { ...ui.staleStats, [taskId]: now } });
  }

  #startTool(agentKey: string, tool: string, now: number): void {
    this.#toolStart.set(agentKey, { tool, at: now });
  }

  #endTool(agentKey: string, tool: string | null, now: number): void {
    const start = this.#toolStart.get(agentKey);
    if (!start) return;
    if (tool && start.tool && tool.toLowerCase() !== start.tool.toLowerCase()) return;
    this.#toolStart.delete(agentKey);
    if (now < start.at) return;
    this.#toolDuration.delete(agentKey);
    this.#toolDuration.set(agentKey, now - start.at);
    while (this.#toolDuration.size > DURATION_AGENTS_LIMIT) {
      const oldest = this.#toolDuration.keys().next().value;
      if (oldest === undefined) break;
      this.#toolDuration.delete(oldest);
    }
  }

  #tool(event: DomainEvent, p: Record<string, unknown>, now: number): void {
    const decision = p.decision === 'deny' || p.decision === 'ask' ? p.decision : 'allow';
    const kind = toolKind(p.kind);
    const taskId = str(p.task_id);
    const targets = strings(p.targets);
    // An allowed write changes the task's files whether or not its agent is on the board yet.
    if (decision === 'allow' && kind === 'write') this.#markStale(taskId, now);
    const agentKey = this.#agentKeyOf(event);
    if (!agentKey) return;
    const tool = str(p.tool) ?? 'tool';
    const target = targets[0] ? truncate(cleanText(targets[0]), 200) : null;
    if (decision === 'deny') this.#toolStart.delete(agentKey);
    else this.#startTool(agentKey, tool, now);
    const a = this.store.select('activity');
    const agent = { ...(a.agents[agentKey] ?? emptyAgent()) };
    agent.current = { at: now, tool, kind, target, decision, taskId };
    agent.log = appendLog(agent.log, {
      at: now,
      sequence: event.sequence,
      stream: decision === 'deny' ? 'error' : 'tool',
      text: `${decision === 'allow' ? '→' : decision === 'ask' ? '?' : '✕'} ${tool}${target ? ` ${target}` : ''}${decision === 'deny' && p.reason ? ` — ${truncate(cleanText(String(p.reason)), 160)}` : ''}`,
    });
    const pulses =
      decision === 'allow' && taskId
        ? [...a.pulses, { id: nextId++, agentKey, taskId, kind, born: now }].slice(-PULSE_LIMIT)
        : a.pulses;
    const files = kind === 'write' && taskId && targets.length ? touchFiles(a.files, taskId, targets, now) : a.files;
    this.#setActivity({ ...a, agents: { ...a.agents, [agentKey]: agent }, pulses, files, lastActivityAt: now });
  }

  #agentEvent(event: DomainEvent, p: Record<string, unknown>, now: number): void {
    const runId = str(p.run_id);
    const taskId = str(p.task_id) ?? this.#taskOfRun(runId);
    const type = str(p.event_type) ?? 'event';
    const data = record(p.data);
    const changed = [...strings(p.changed_paths), ...strings(data.changed_paths)];
    const unmediated = type === 'host.unmediated_write' ? [...strings(data.paths), ...strings(p.paths)] : [];
    if ((type === 'tool.completed' && changed.length) || unmediated.length) this.#markStale(taskId, now);
    const agentKey = this.#agentKeyOf(event) ?? this.#agentKeyOfRun(runId) ?? this.#agentKeyOfTask(taskId);
    if (!agentKey) return;
    const a = this.store.select('activity');
    const agent = { ...(a.agents[agentKey] ?? emptyAgent()) };
    let line: LogLine | null = null;
    let files = a.files;
    switch (type) {
      case 'progress':
        line = {
          at: now,
          sequence: event.sequence,
          stream: 'progress',
          text: `progress: ${truncate(cleanText(String(p.note ?? '')), 300)}`,
        };
        break;
      case 'error':
        line = {
          at: now,
          sequence: event.sequence,
          stream: 'error',
          text: `error: ${truncate(cleanText(String(p.message ?? '')), 300)}`,
        };
        break;
      case 'tool.completed':
      case 'tool.failed': {
        const tool = str(p.tool) ?? str(data.tool) ?? 'tool';
        const command = str(data.command);
        line = {
          at: now,
          sequence: event.sequence,
          stream: type === 'tool.failed' ? 'error' : 'tool',
          text: `${type === 'tool.failed' ? '✕' : '✓'} ${tool}${changed.length ? ` ${changed.slice(0, 3).map(clean).join(', ')}` : ''}${command ? ` ${truncate(cleanText(command), 160)}` : ''}${p.error ? ` — ${truncate(cleanText(String(p.error)), 160)}` : ''}`,
        };
        agent.current = {
          at: now,
          tool,
          kind: changed.length ? 'write' : command ? 'command' : 'other',
          target: changed[0] ? clean(changed[0]) : command ? truncate(cleanText(command), 120) : null,
          decision: type === 'tool.failed' ? 'failed' : 'done',
          taskId,
        };
        this.#endTool(agentKey, str(p.tool) ?? str(data.tool), now);
        if (taskId && changed.length) files = touchFiles(files, taskId, changed, now);
        break;
      }
      case 'host.unmediated_write':
        line = {
          at: now,
          sequence: event.sequence,
          stream: 'error',
          text: `wrote without asking first (not judged before it happened)${unmediated.length ? `: ${unmediated.slice(0, 5).map(clean).join(', ')}` : ''}${unmediated.length > 5 ? ` and ${unmediated.length - 5} more` : ''}`,
        };
        if (taskId && unmediated.length) files = touchFiles(files, taskId, unmediated, now);
        break;
      case 'host.usage':
        agent.usage = {
          cost_usd: typeof data.cost_usd === 'number' ? data.cost_usd : null,
          input_tokens: typeof data.input_tokens === 'number' ? data.input_tokens : null,
          output_tokens: typeof data.output_tokens === 'number' ? data.output_tokens : null,
        };
        line = { at: now, sequence: event.sequence, stream: 'info', text: 'usage reported' };
        break;
      case 'model.observed':
        agent.model = str(data.model);
        line = {
          at: now,
          sequence: event.sequence,
          stream: 'info',
          text: `model: ${agent.model ? truncate(cleanText(agent.model), 120) : 'unknown'}`,
        };
        break;
      default:
        line = {
          at: now,
          sequence: event.sequence,
          stream: 'info',
          text: `${truncate(cleanText(type), 80)}${p.summary ? `: ${truncate(cleanText(String(p.summary)), 200)}` : ''}`,
        };
    }
    if (line) agent.log = appendLog(agent.log, line);
    this.#setActivity({ ...a, agents: { ...a.agents, [agentKey]: agent }, files, lastActivityAt: now });
  }

  #paths(p: Record<string, unknown>, now: number): void {
    const runId = str(p.run_id);
    const taskId = str(p.task_id) ?? this.#taskOfRun(runId);
    const paths = strings(p.paths);
    if (!taskId || !paths.length) return;
    this.#markStale(taskId, now);
    const a = this.store.select('activity');
    this.#setActivity({ ...a, files: touchFiles(a.files, taskId, paths, now), lastActivityAt: now });
  }

  #log(agentKey: string | null, line: LogLine): void {
    if (!agentKey) return;
    const a = this.store.select('activity');
    const agent = { ...(a.agents[agentKey] ?? emptyAgent()) };
    agent.log = appendLog(agent.log, line);
    this.#setActivity({ ...a, agents: { ...a.agents, [agentKey]: agent } });
  }

  #react(kind: ReactionKind, now: number, label?: string): void {
    const a = this.store.select('activity');
    const reactions = [...a.reactions, { id: nextId++, kind, at: now, ...(label ? { label } : {}) }].slice(
      -REACTION_LIMIT,
    );
    this.#setActivity({ ...a, reactions, lastActivityAt: now });
  }
}

function clean(path: string): string {
  return truncate(cleanText(path), 200);
}

function appendLog(log: LogLine[], line: LogLine): LogLine[] {
  const next = log.length >= LOG_LIMIT ? log.slice(log.length - LOG_LIMIT + 1) : log.slice();
  next.push(line);
  return next;
}

function touchFiles(
  files: ActivityState['files'],
  taskId: string,
  paths: string[],
  now: number,
): ActivityState['files'] {
  const current = files[taskId] ?? [];
  const fresh = [...new Set(paths.map((path) => cleanText(path)))].map((path) => ({ path, at: now }));
  const kept = current.filter((f) => !fresh.some((x) => x.path === f.path));
  return { ...files, [taskId]: [...fresh, ...kept].slice(0, FILES_LIMIT) };
}
