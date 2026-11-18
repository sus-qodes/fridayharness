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
  /**
   * Work an agent claimed that waits for a person to verify it: automatic checks are off, or they
   * are on and the task has sat there all the same (`VERIFY_STUCK_MS`). Without this row the default
   * setup stalled with "0 waiting for you" (2026-11-17).
   */
  | { kind: 'verify'; key: string; id: string; taskId: string; task: SnapshotTask }
  /**
   * A task kept for an agent its person runs themselves (Antigravity, Claude Code in an editor):
   * it starts only when that person prompts the agent there, so it is their turn (2026-11-17).
   * Before, the card said "for antigravity-1" and nothing told the person to go there.
   */
  | { kind: 'turn'; key: string; id: string; taskId: string; task: SnapshotTask; agentKey: string; host: string }
  /**
   * A task an agent its person runs holds as running, with nothing reported for `QUIET_MS`: its
   * window may be closed, or it may wait on a prompt of its own that Friday cannot see. Friday does
   * not take the task away by itself; the person looks, or gives it to another agent (2026-11-17).
   */
  | { kind: 'quiet'; key: string; id: string; taskId: string; task: SnapshotTask; agentKey: string; host: string }
  /**
   * An agent its person runs stopped in the middle of its task (2026-11-18): its turn ended and
   * nothing followed. It waits for its person in its own window, or its host failed (no capacity
   * on its servers, a used-up quota: `error`). Friday showed the task as running and said nothing;
   * the person found out by looking at the other window.
   */
  | {
      kind: 'stopped';
      key: string;
      id: string;
      taskId: string;
      task: SnapshotTask;
      agentKey: string;
      host: string;
      reason: string | null;
      error: string | null;
    }
  /**
   * A rule of Friday's made that agent's host ask its person in its own window ("Run this
   * command?"), and Friday, whose rule it is, showed nothing (2026-11-18).
   */
  | {
      kind: 'asking';
      key: string;
      id: string;
      taskId: string;
      task: SnapshotTask;
      agentKey: string;
      host: string;
      tool: string | null;
      target: string | null;
      rule: string | null;
    }
  /** A completed goal whose branch a person has not landed yet; `id` is the goal's. */
  | { kind: 'land'; key: string; id: string; taskId: null; goalId: string; request: string }
  /** An agent's message the human has not replied to (a request, or one the sender blocks on). */
  | { kind: 'message'; key: string; id: string; taskId: string | null; message: SnapshotInboxItem }
  /** One row for every memory that needs review. */
  | { kind: 'memory'; key: string; id: string; taskId: null; count: number }
  /** The project's policy loosens Friday's defaults and this clone has not trusted it. */
  | { kind: 'policy'; key: string; id: string; taskId: null };

export type WaitingKind = WaitingItem['kind'];

/** With automatic checks on, a task still waiting to be verified after this long is the person's to look at. */
export const VERIFY_STUCK_MS = 60_000;

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

/** Claimed work a person verifies, oldest first (see the `verify` kind). */
function toVerify(board: UiSnapshot, now: number): WaitingItem[] {
  const auto = board.verification?.auto_on_completion === true;
  return board.tasks
    .filter((t) => t.status === 'READY_FOR_VERIFICATION')
    .filter((t) => !auto || now - time(t.updated_at) >= VERIFY_STUCK_MS)
    .sort((a, b) => time(a.updated_at) - time(b.updated_at))
    .map(
      (t): WaitingItem => ({ kind: 'verify', key: `verify:${t.task_id}`, id: t.task_id, taskId: t.task_id, task: t }),
    );
}

const TURN_HOSTS: Record<string, string> = {
  antigravity: 'Antigravity',
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
  opencode: 'OpenCode',
};

/** The app a person goes to for a `turn` item, by the name they know it by. */
export function turnHost(host: string): string {
  return TURN_HOSTS[host] ?? 'your editor';
}

/** What they type there for the agent to take its task. */
export function turnPrompt(host: string): string {
  return host === 'claude-code' ? '/friday start' : '/friday';
}

/** After this long with nothing reported, a running task of an agent its person runs is theirs to look at. */
export const QUIET_MS = 15 * 60_000;

/**
 * A turn that ended without an error is said after this long with nothing following: an agent
 * whose person answers it at once, or that Friday holds to report its progress, goes on within it.
 */
export const STOPPED_GRACE_MS = 20_000;

/** What a host's error means for its person, in a few words; null when it is none of the known ones. */
export function stopWords(error: string | null): 'quota' | 'busy' | null {
  if (!error) return null;
  if (/quota|usage limit|limit reached|resets? in \d/i.test(error)) return 'quota';
  if (/capacity|unavailable|\b503\b|high traffic|overloaded|try again/i.test(error)) return 'busy';
  return null;
}

/** Running tasks whose agent, one its person runs, stopped or asks in its own window (`SnapshotTask.attention`). */
function toAttention(board: UiSnapshot, now: number): WaitingItem[] {
  const hosts = new Map(board.harnesses.map((x) => [x.harness_id, x]));
  const out: WaitingItem[] = [];
  for (const t of board.tasks) {
    const a = t.attention;
    if (!a || t.status !== 'RUNNING' || !t.agent_key) continue;
    const agent = board.agents.find((x) => x.agent_key === t.agent_key);
    const host = agent?.harness_id ? hosts.get(agent.harness_id) : undefined;
    if (!host || host.attach_mode === 'spawn') continue;
    const base = { id: t.task_id, taskId: t.task_id, task: t, agentKey: t.agent_key, host: host.vendor };
    if (a.kind === 'asking') {
      out.push({
        kind: 'asking',
        key: `asking:${t.task_id}:${a.at}`,
        ...base,
        tool: a.tool ?? null,
        target: a.target ?? null,
        rule: a.rule ?? null,
      });
      continue;
    }
    const error = a.error ?? null;
    // An error is said at once; a turn that just ended may be about to go on.
    if (!error && now - time(a.at) < STOPPED_GRACE_MS) continue;
    out.push({ kind: 'stopped', key: `stopped:${t.task_id}:${a.at}`, ...base, reason: a.reason ?? null, error });
  }
  return out;
}

/** Running tasks of agents their person runs that have reported nothing for `QUIET_MS` (see the `quiet` kind). */
function toQuiet(board: UiSnapshot, now: number): WaitingItem[] {
  const hosts = new Map(board.harnesses.map((x) => [x.harness_id, x]));
  const out: WaitingItem[] = [];
  for (const t of board.tasks) {
    if (t.status !== 'RUNNING' || !t.agent_key) continue;
    const last = Math.max(time(t.updated_at), time(t.started_at));
    if (!last || now - last < QUIET_MS) continue;
    // Said already, and better: it stopped, or it asks in its own window.
    if (t.attention) continue;
    const agent = board.agents.find((a) => a.agent_key === t.agent_key);
    const host = agent?.harness_id ? hosts.get(agent.harness_id) : undefined;
    // An agent Friday starts is watched by its adapter and by recovery.
    if (!host || host.attach_mode === 'spawn') continue;
    out.push({
      kind: 'quiet',
      key: `quiet:${t.task_id}`,
      id: t.task_id,
      taskId: t.task_id,
      task: t,
      agentKey: t.agent_key,
      host: host.vendor,
    });
  }
  return out;
}

/** Tasks kept for an agent its person runs themselves, oldest first (see the `turn` kind). */
function toTurn(board: UiSnapshot): WaitingItem[] {
  const hosts = new Map(board.harnesses.map((x) => [x.harness_id, x]));
  const out: WaitingItem[] = [];
  const kept = board.tasks
    .filter((t) => t.status === 'READY' && t.reserved_for_agent_key)
    .sort((a, b) => time(a.updated_at) - time(b.updated_at));
  for (const t of kept) {
    const key = t.reserved_for_agent_key as string;
    const agent = board.agents.find((a) => a.agent_key === key);
    const host = agent?.harness_id ? hosts.get(agent.harness_id) : undefined;
    // An agent Friday starts takes its task by itself: nothing for the person to do.
    if (!host || host.attach_mode === 'spawn') continue;
    out.push({
      kind: 'turn',
      key: `turn:${t.task_id}`,
      id: t.task_id,
      taskId: t.task_id,
      task: t,
      agentKey: key,
      host: host.vendor,
    });
  }
  return out;
}

/**
 * Completed goals whose branch waits to be landed, in the goals' order. Work made in the project
 * folder itself is not listed: it is already there, and nothing tells Friday when it was committed.
 */
function toLand(board: UiSnapshot): WaitingItem[] {
  const out: WaitingItem[] = [];
  for (const g of board.goals) {
    const landing = board.goal_landing?.[g.goal_id];
    if (g.status !== 'COMPLETED' || !landing || landing.landed || landing.work === 'folder') continue;
    out.push({
      kind: 'land',
      key: `land:${g.goal_id}`,
      id: g.goal_id,
      taskId: null,
      goalId: g.goal_id,
      request: g.objective ?? g.request,
    });
  }
  return out;
}

/**
 * Approvals, then questions, then waiting agents, each oldest first; then the proposed plans, the
 * work to verify and the goals to land, the
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
    ...toTurn(board),
    ...toAttention(board, now),
    ...toQuiet(board, now),
    ...proposedPlans(board),
    ...toVerify(board, now),
    ...toLand(board),
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
  turn: ['task for an agent you run', 'tasks for an agent you run'],
  quiet: ['agent that has gone quiet', 'agents that have gone quiet'],
  stopped: ['agent that has stopped', 'agents that have stopped'],
  asking: ['agent asking you in its window', 'agents asking you in their windows'],
  plan: ['proposed plan', 'proposed plans'],
  verify: ['task to verify', 'tasks to verify'],
  land: ['goal to land', 'goals to land'],
  message: ['message to reply to', 'messages to reply to'],
  memory: ['memory to review', 'memories to review'],
  policy: ['policy change to trust', 'policy changes to trust'],
};

const WAITING_ORDER: readonly WaitingKind[] = [
  'approval',
  'question',
  'waiting',
  'asking',
  'stopped',
  'turn',
  'quiet',
  'plan',
  'verify',
  'land',
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
  // Those listed above as waiting for the person are not counted a second time here.
  const toVerify = Math.max(0, count('READY_FOR_VERIFICATION') - (byKind.get('verify') ?? 0)) + count('VERIFYING');
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
    case 'verify':
      return [item.key, item.task.status, item.task.current_run_id].join('\u0000');
    case 'turn':
    case 'quiet':
      return [item.key, item.agentKey, item.host, item.task.summary].join('\u0000');
    case 'stopped':
      return [item.key, item.agentKey, item.host, item.reason, item.error].join('\u0000');
    case 'asking':
      return [item.key, item.agentKey, item.host, item.tool, item.target].join('\u0000');
    case 'land':
      return item.key;
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
  panel?: 'settings' | 'agents' | 'diff' | 'inbox' | 'memory' | 'plan-review' | 'verify' | 'land';
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
  // The dialogs where each is done: the task's verification, the goal's landing.
  if (item?.kind === 'verify') return { task_id: item.taskId, panel: 'verify', id: item.taskId };
  if (item?.kind === 'land') return { panel: 'land', id: item.goalId };
  // The task itself: its inspector is where it is given to another agent.
  if (item?.kind === 'turn' || item?.kind === 'quiet' || item?.kind === 'stopped' || item?.kind === 'asking') {
    return { task_id: item.taskId };
  }
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

/**
 * An agent its person runs that stopped, or asks in its own window, in words (2026-11-18): one
 * wording for the waiting list, the Notch and the notification.
 */
export function attentionWords(
  item: Extract<WaitingItem, { kind: 'stopped' | 'asking' }>,
  hostName: string,
): { title: string; line: string } {
  if (item.kind === 'asking') {
    const what = item.target ? `“${item.target}”` : (item.tool ?? 'a step');
    return {
      title: `${hostName} is asking you something`,
      line: `It wants to run ${what} and a rule of Friday’s makes it ask you first. Answer in ${hostName}’s own window.`,
    };
  }
  const why = stopWords(item.error);
  if (why === 'quota') {
    return {
      title: `${hostName} is out of quota`,
      line: `It stopped in the middle of this task. ${item.error ?? ''} Open the task and give it to another agent, or go on in ${hostName} once it can.`.replace(
        /\s+/g,
        ' ',
      ),
    };
  }
  if (why === 'busy') {
    return {
      title: `${hostName} stopped: its servers are busy`,
      line: `It stopped in the middle of this task. Type “continue” in ${hostName} in a minute, or open the task and give it to another agent.`,
    };
  }
  if (item.error) {
    return {
      title: `${hostName} stopped on an error`,
      line: `${item.error} Type “continue” in ${hostName}, or open the task and give it to another agent.`,
    };
  }
  return {
    title: `${hostName} has stopped`,
    line: `It is not working on this task now: it may be waiting for you in its own window. Answer it there or type “continue”, or open the task and give it to another agent.`,
  };
}
