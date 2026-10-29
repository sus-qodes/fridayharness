/**
 * What the Notch shows, derived from the store (plan §7.8). Pure functions: the island, its tests,
 * the header's count and status sentence, the title badge, the rail, the tray's line and the
 * notifier read the same rules.
 *
 * "Waiting for you" (review §4, owner decision 6): an unexpired pending approval, a pending
 * question, an agent waiting for a human, a proposed plan, a message that waits for the human's
 * reply, memories that need review, and a policy loosening this clone has not trusted. One rule,
 * one list (`waitingItems`), one count: the rail lists exactly what the header counts.
 */
import type {
  ApprovalRow,
  EscalationView,
  RunView,
  SnapshotInboxItem,
  SnapshotTask,
  UiSnapshot,
  VerificationView,
} from '@friday/protocol';
import { type StatusLook, statusLook, waitsForHuman } from '../model/status.js';
import { visible } from '../model/text.js';
import type { ActivityState, Connection, RootState } from '../store/state.js';
import { basename, cleanText, plural, shortId, truncate } from '../ui/format.js';
import type { IslandSnapshot } from './island-fsm.js';

/** Something that waits for a human, in the order the card and the rail show them. */
export type WaitingItem =
  | { kind: 'approval'; key: string; id: string; taskId: string | null; approval: ApprovalRow }
  | { kind: 'question'; key: string; id: string; taskId: string | null; escalation: EscalationView }
  | { kind: 'waiting'; key: string; id: string; taskId: string; task: SnapshotTask }
  /** A plan version proposed for a goal that is still open; `id` is the goal's. */
  | {
      kind: 'plan';
      key: string;
      id: string;
      taskId: null;
      goalId: string;
      planId: string;
      version: number;
      request: string;
    }
  /** An agent's message the human has not replied to (a request, or one the sender blocks on). */
  | { kind: 'message'; key: string; id: string; taskId: string | null; message: SnapshotInboxItem }
  /** One row for every memory that needs review. */
  | { kind: 'memory'; key: string; id: string; taskId: null; count: number }
  /** The project's policy loosens Friday's defaults and this clone has not trusted it. */
  | { kind: 'policy'; key: string; id: string; taskId: null };

export type WaitingKind = WaitingItem['kind'];

export const MEMORY_REVIEW_KEY = 'memory:review';
export const POLICY_UNTRUSTED_KEY = 'policy:untrusted';

function time(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** A pending approval whose expiry has not passed (the client computes "expired", plan §2). */
export function isLiveApproval(a: ApprovalRow, now: number): boolean {
  if (a.status !== 'pending' || a.expired) return false;
  if (!a.expires_at) return true;
  const t = Date.parse(a.expires_at);
  return Number.isNaN(t) || t > now;
}

/** A message in the human's inbox that waits for a reply: the Messages drawer badges the same ones. */
export function awaitsReply(item: Pick<SnapshotInboxItem, 'mode' | 'blocking'>): boolean {
  return item.mode === 'request' || item.blocking === true;
}

/** The plans proposed for goals that are still open, in the goals' order. */
function proposedPlans(board: UiSnapshot): WaitingItem[] {
  const out: WaitingItem[] = [];
  for (const g of board.goals) {
    const proposed = board.plans[g.goal_id]?.proposed;
    if (!proposed || g.status === 'CANCELLED' || g.status === 'COMPLETED') continue;
    out.push({
      kind: 'plan',
      key: `plan:${g.goal_id}`,
      id: g.goal_id,
      taskId: null,
      goalId: g.goal_id,
      planId: proposed.plan_id,
      version: proposed.version,
      request: g.request,
    });
  }
  return out;
}

/**
 * Approvals, then questions, then waiting agents, each oldest first; then the proposed plans, the
 * messages that wait for a reply, the memories to review and the untrusted policy. A waiting task
 * whose own approval or question is already listed is not listed again (a spawned agent blocks
 * while its approval waits; that is one decision, not two).
 */
export function waitingItems(board: UiSnapshot | null, now: number): WaitingItem[] {
  if (!board) return [];
  const approvals = board.approvals
    .filter((a) => isLiveApproval(a, now))
    .sort((a, b) => time(a.created_at) - time(b.created_at));
  const questions = board.escalations
    .filter((e) => e.status === 'pending')
    .sort((a, b) => time(a.created_at) - time(b.created_at));
  const covered = new Set<string>();
  for (const a of approvals) if (a.task_id) covered.add(a.task_id);
  for (const q of questions) if (q.task_id) covered.add(q.task_id);
  const waiting = board.tasks
    .filter((t) => waitsForHuman(t) && !covered.has(t.task_id))
    .sort((a, b) => time(a.updated_at) - time(b.updated_at));
  const messages = (board.inbox ?? []).filter(awaitsReply);
  const toReview = typeof board.memories_to_review === 'number' ? Math.max(0, board.memories_to_review) : 0;
  return [
    ...approvals.map(
      (a): WaitingItem => ({
        kind: 'approval',
        key: `approval:${a.approval_id}`,
        id: a.approval_id,
        taskId: a.task_id,
        approval: a,
      }),
    ),
    ...questions.map(
      (q): WaitingItem => ({
        kind: 'question',
        key: `question:${q.escalation_id}`,
        id: q.escalation_id,
        taskId: q.task_id,
        escalation: q,
      }),
    ),
    ...waiting.map(
      (t): WaitingItem => ({ kind: 'waiting', key: `waiting:${t.task_id}`, id: t.task_id, taskId: t.task_id, task: t }),
    ),
    ...proposedPlans(board),
    ...messages.map(
      (m): WaitingItem => ({
        kind: 'message',
        key: `message:${m.delivery_id}`,
        id: m.delivery_id,
        taskId: m.task_id,
        message: m,
      }),
    ),
    ...(toReview > 0
      ? [{ kind: 'memory', key: MEMORY_REVIEW_KEY, id: 'review', taskId: null, count: toReview } as WaitingItem]
      : []),
    ...(board.policy_untrusted === true
      ? [{ kind: 'policy', key: POLICY_UNTRUSTED_KEY, id: 'untrusted', taskId: null } as WaitingItem]
      : []),
  ];
}

/** Everything that waits for a human, counted once (the header, the title, the tray, the chip). */
export function waitingCount(board: UiSnapshot | null, now: number): number {
  return waitingItems(board, now).length;
}

/** The tasks an agent is working on now, as listed (the header's Running count and the pill's). */
export function runningCount(board: UiSnapshot | null): number {
  return board ? board.tasks.filter((t) => t.status === 'RUNNING').length : 0;
}

/** What each waiting kind is called when the status sentence counts it. */
const WAITING_WORDS: Record<WaitingKind, [one: string, many: string]> = {
  approval: ['approval', 'approvals'],
  question: ['question', 'questions'],
  waiting: ['blocked agent', 'blocked agents'],
  plan: ['proposed plan', 'proposed plans'],
  message: ['message to reply to', 'messages to reply to'],
  memory: ['memory to review', 'memories to review'],
  policy: ['policy change to trust', 'policy changes to trust'],
};

const WAITING_ORDER: readonly WaitingKind[] = [
  'approval',
  'question',
  'waiting',
  'plan',
  'message',
  'memory',
  'policy',
];

/**
 * The one-line status (the Running count's tooltip in the Studio, the tray's tooltip and status
 * line on the desktop; review §4, M9k.1): what runs and what waits for you, by kind, counted by the
 * rule the header, the title, the rail and the Notch share; then what is ready, to verify or failed,
 * and how many agents are connected. One sentence, built once, so no surface words it differently.
 */
export function statusSentence(board: UiSnapshot | null, now: number): string {
  if (!board) return 'Friday is not connected';
  const count = (s: string) => board.counts[s] ?? 0;
  const items = waitingItems(board, now);
  const byKind = new Map<WaitingKind, number>();
  for (const item of items) {
    // The memory row stands for every memory that needs review.
    const n = item.kind === 'memory' ? item.count : 1;
    byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + n);
  }
  const head = `${board.control.paused ? 'Paused. ' : ''}${runningCount(board)} running, ${items.length} waiting for you`;
  const parts: string[] = [];
  const why = WAITING_ORDER.flatMap((kind) => {
    const n = byKind.get(kind) ?? 0;
    const [one, many] = WAITING_WORDS[kind];
    return n > 0 ? [plural(n, one, many)] : [];
  });
  if (why.length) parts.push(why.join(', '));
  const ready = count('READY');
  const toVerify = count('READY_FOR_VERIFICATION') + count('VERIFYING');
  const failed = count('FAILED') + count('HARNESS_LOST');
  if (ready) parts.push(`${ready} ready`);
  if (toVerify) parts.push(`${toVerify} to verify`);
  if (failed) parts.push(`${failed} failed or lost`);
  const agents = board.agents.filter((a) => a.status !== 'DISCONNECTED' && a.status !== 'TERMINATED').length;
  parts.push(`${plural(agents, 'agent')} connected`);
  return `${head}: ${parts.join('; ')}`;
}

/** Milliseconds until the next listed approval expires (the pin is re-derived then), or null. */
export function nextExpiryIn(board: UiSnapshot | null, now: number): number | null {
  if (!board) return null;
  let next: number | null = null;
  for (const a of board.approvals) {
    if (!isLiveApproval(a, now) || !a.expires_at) continue;
    const t = Date.parse(a.expires_at);
    if (Number.isNaN(t)) continue;
    if (next === null || t < next) next = t;
  }
  return next === null ? null : Math.max(0, next - now);
}

/**
 * What a card shows of an item: when this changes, the card is built again, which re-arms its
 * decision buttons (plan FD-28).
 */
export function itemSignature(item: WaitingItem): string {
  switch (item.kind) {
    case 'approval': {
      const a = item.approval;
      return [item.key, a.capability, a.target, a.purpose, a.risk, a.reuse, a.expires_at].join('\u0000');
    }
    case 'question': {
      const e = item.escalation;
      return [item.key, e.kind, e.question, JSON.stringify(e.options ?? []), JSON.stringify(e.details ?? null)].join(
        '\u0000',
      );
    }
    case 'waiting': {
      const t = item.task;
      return [item.key, t.status, t.waiting_reason, t.waiting_note, t.current_run_id].join('\u0000');
    }
    case 'plan':
      return [item.key, item.planId, String(item.version)].join('\u0000');
    case 'message': {
      const m = item.message;
      return [item.key, m.subject, m.preview, m.from.agent_key, m.priority, String(m.blocking)].join('\u0000');
    }
    case 'memory':
      return [item.key, String(item.count)].join('\u0000');
    case 'policy':
      return item.key;
  }
}

/**
 * Where the Studio opens for an item: a task, an approval, the plan review of a goal, or one of its
 * drawers (the Messages drawer at a message, Project memory at Needs review, Settings → Policy).
 */
export interface StudioTarget {
  task_id?: string;
  approval_id?: string;
  /**
   * A drawer (Settings, the agents drawer at `tab`, the diff of `task_id` at `path`, Messages at
   * `id`, Project memory) or the plan review dialog of the goal `id`.
   */
  panel?: 'settings' | 'agents' | 'diff' | 'inbox' | 'memory' | 'plan-review';
  /** What the panel opens on: a delivery for Messages, a goal for the plan review. */
  id?: string;
  tab?: string;
  path?: string;
}

/** Where an item is opened in the Studio. */
export function studioTarget(item: WaitingItem | null, activeTaskId: string | null): StudioTarget {
  if (item?.kind === 'approval') {
    return item.taskId ? { task_id: item.taskId, approval_id: item.id } : { approval_id: item.id };
  }
  if (item?.kind === 'plan') return { panel: 'plan-review', id: item.goalId };
  // The delivery too: with two open messages the drawer opens on this one, as the rail's row does.
  if (item?.kind === 'message') return { panel: 'inbox', id: item.id };
  if (item?.kind === 'memory') return { panel: 'memory', tab: 'review' };
  if (item?.kind === 'policy') return { panel: 'settings', tab: 'policy' };
  const task = item?.taskId ?? activeTaskId;
  return task ? { task_id: task } : {};
}

const ACTIVE_ORDER = ['RUNNING', 'WAITING', 'VERIFYING', 'READY_FOR_VERIFICATION', 'ASSIGNED'] as const;

/**
 * The task the pill follows: the one an agent touched last (tool activity or a changed file), if
 * it is still live; otherwise the newest running task, then waiting, verifying, claimed, assigned.
 */
export function activeTask(board: UiSnapshot | null, activity: ActivityState): SnapshotTask | null {
  if (!board) return null;
  const byId = new Map(board.tasks.map((t) => [t.task_id, t]));
  let best: { at: number; id: string } | null = null;
  for (const agent of Object.values(activity.agents)) {
    const c = agent.current;
    if (c?.taskId && byId.has(c.taskId) && (!best || c.at > best.at)) best = { at: c.at, id: c.taskId };
  }
  for (const [taskId, files] of Object.entries(activity.files)) {
    const at = files[0]?.at;
    if (at !== undefined && byId.has(taskId) && (!best || at > best.at)) best = { at, id: taskId };
  }
  if (best) {
    const task = byId.get(best.id);
    if (task && !statusLook(task.status).terminal) return task;
  }
  for (const status of ACTIVE_ORDER) {
    const candidates = board.tasks
      .filter((t) => t.status === status)
      .sort((a, b) => time(b.updated_at) - time(a.updated_at));
    if (candidates[0]) return candidates[0];
  }
  return null;
}

export interface ChecksLine {
  passed: number;
  run: number;
  text: string;
}

const FINISHED_CHECK = new Set(['PASSED', 'FAILED', 'BLOCKED']);

/** "2 of 3 checks passed" from the latest verification (plan §2: checks are named, criteria free text). */
export function checksLine(v: VerificationView | null | undefined): ChecksLine {
  if (!v) return { passed: 0, run: 0, text: 'No checks run yet' };
  const run = v.checks.filter((c) => FINISHED_CHECK.has(c.status)).length;
  const passed = v.checks.filter((c) => c.status === 'PASSED').length;
  if (v.status === 'RUNNING' || v.status === 'QUEUED') return { passed, run, text: 'Checks running…' };
  if (run === 0) return { passed, run, text: 'No checks run yet' };
  return { passed, run, text: `${passed} of ${run} ${run === 1 ? 'check' : 'checks'} passed` };
}

/** `+14 −2`, or "—" until the line counts arrive. */
export function statsText(stats: { added: number; removed: number } | null | undefined): string {
  if (!stats) return '—';
  return `+${stats.added} −${stats.removed}`;
}

export interface ConnectionLook {
  label: string;
  tone: 'good' | 'warn' | 'danger' | 'muted';
}

export function connectionLook(c: Connection): ConnectionLook {
  switch (c) {
    case 'live':
      return { label: 'Connected', tone: 'good' };
    case 'starting':
    case 'connecting':
      return { label: 'Connecting…', tone: 'warn' };
    case 'reconnecting':
      return { label: 'Reconnecting…', tone: 'warn' };
    case 'stopped':
      return { label: 'Friday stopped', tone: 'danger' };
    case 'signed-out':
      return { label: 'Signed out', tone: 'muted' };
  }
}

export interface ActiveView {
  task: SnapshotTask;
  /** The plan key (shown with visible escapes) or the short id. */
  tag: string;
  status: StatusLook;
  summary: string;
  agentKey: string | null;
  branch: string | null;
  /** The file the agent touched last (basename, visible escapes) and its full path. */
  file: { name: string; path: string } | null;
  stats: { added: number; removed: number } | null;
  checks: ChecksLine;
  run: RunView | null;
}

export interface NotchModel {
  fsm: IslandSnapshot;
  project: string;
  connection: ConnectionLook;
  active: ActiveView | null;
  items: WaitingItem[];
  muted: boolean;
  running: number;
  /** The goal that just completed (celebration), cleaned and shortened. */
  celebration: string | null;
}

export function taskTag(task: SnapshotTask): string {
  return task.plan_key ? truncate(visible(task.plan_key), 24) : shortId(task.task_id);
}

/** The newest completed goal, for the celebration. */
export function completedGoal(board: UiSnapshot | null): string | null {
  if (!board) return null;
  const done = board.goals
    .filter((g) => g.status === 'COMPLETED')
    .sort((a, b) => time(b.completed_at ?? b.updated_at) - time(a.completed_at ?? a.updated_at))[0];
  if (!done) return null;
  return truncate(cleanText(done.objective ?? done.request), 90);
}

export function projectName(board: UiSnapshot | null): string {
  const name = board?.project.name;
  return name ? truncate(cleanText(name), 40) : 'Friday';
}

export function buildModel(state: Readonly<RootState>, fsm: IslandSnapshot, now: number): NotchModel {
  const board = state.board;
  const task = activeTask(board, state.activity);
  let active: ActiveView | null = null;
  if (task && board) {
    const run = board.runs[task.task_id] ?? null;
    const latest = state.activity.files[task.task_id]?.[0];
    const stats = state.ui.stats[task.task_id];
    active = {
      task,
      tag: taskTag(task),
      status: statusLook(task.status),
      summary: truncate(cleanText(task.summary), 140),
      agentKey: task.agent_key ? truncate(cleanText(task.agent_key), 40) : null,
      branch: run?.branch_ref ? truncate(visible(run.branch_ref), 60) : null,
      file: latest ? { name: truncate(visible(basename(latest.path)), 40), path: latest.path } : null,
      stats: stats ? { added: stats.added, removed: stats.removed } : null,
      checks: checksLine(board.verifications[task.task_id]),
      run,
    };
  }
  return {
    fsm,
    project: projectName(board),
    connection: connectionLook(state.system.connection),
    active,
    items: waitingItems(board, now),
    muted: state.prefs.muted,
    running: runningCount(board),
    celebration: fsm.greeting === 'celebrate' ? completedGoal(board) : null,
  };
}
