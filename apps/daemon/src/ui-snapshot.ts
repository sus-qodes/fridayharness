import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type {
  ApprovalRow,
  BrainJobView,
  BrainStatusView,
  EscalationView,
  HarnessEntry,
  IntegrationView,
  LivePlanVersion,
  RunView,
  SnapshotInboxItem,
  SnapshotList,
  SnapshotTask,
  TaskAttention,
  TaskView,
  UiSnapshot,
  UsageView,
  VerificationView,
} from '@friday/protocol';
import { promptTokens } from '@friday/protocol';
import type { ProjectRef } from '@friday/sdk';
import type { FridayState, MemoryActor } from '@friday/state';
import type { BrainHandle } from './brain.js';
import { escalationView, liveVersion } from './brain-routes.js';
import { answersOf } from './direct-goal.js';
import { goalWork, landedGoals } from './land.js';
import { notStartedFacts, whyNotStarted } from './not-started.js';
import { whyChosen } from './why-chosen.js';

/** The interface API version this daemon speaks; a page built for another asks to be reloaded (plan §5.3). */
export const UI_API_VERSION = 1;

const TERMINAL = new Set(['COMPLETED', 'CANCELLED', 'ABANDONED']);
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Caps of every list (review SEC-14): a list that hits its cap is flagged in `truncated`. */
export const SNAPSHOT_CAPS: Record<SnapshotList, number> = {
  goals: 50,
  tasks: 500,
  agents: 200,
  harnesses: 200,
  approvals: 200,
  escalations: 200,
  inbox: 200,
  reservations: 500,
};
const PREVIEW_CHARS = 200;
const USAGE_SCAN = 500;
/** The memories the review route lists at most; the count follows the same read. */
const MEMORY_REVIEW_SCAN = 200;

/** The human at the interface reads memory as the memory routes do: every scope. */
const HUMAN_MEMORY: MemoryActor = { kind: 'human', actor: { kind: 'human', id: 'local-operator' } };

/** What the daemon knows about itself that the snapshot shows. */
export interface UiSnapshotInfo {
  has_commit: boolean;
  worktrees_mode: string;
  /**
   * The hash of config.yaml as loaded and as it is now, with what the daemon applied of the
   * difference and which changed keys still need a restart (plan M11.2).
   */
  config: UiSnapshot['config'];
  /** Claims are verified automatically (`verification.auto_on_completion`, once trusted). */
  auto_verification: boolean;
  /** When verified work lands without a click (`landing.mode`, once trusted); null: a person lands it. */
  auto_landing?: 'goal' | 'task' | null;
  /**
   * Whether the effective policy's loosening applies on this clone (`EffectivePolicy.trusted`).
   * Left out, the snapshot reports nothing untrusted: the daemon that knows its policy says so.
   */
  policy_trusted?: boolean;
}

/**
 * The hash of a file as loaded and as it is now, read again only when its modification time
 * changed (the snapshot is read up to four times a second).
 */
export function fileHasher(file: string): { loaded: string; current: () => string | null } {
  const hash = () => {
    try {
      return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);
    } catch {
      return null;
    }
  };
  const loaded = hash() ?? 'missing';
  let seen: { mtime: number; size: number; hash: string | null } | null = null;
  return {
    loaded,
    current: () => {
      try {
        const st = statSync(file);
        if (!seen || seen.mtime !== st.mtimeMs || seen.size !== st.size) {
          seen = { mtime: st.mtimeMs, size: st.size, hash: hash() };
        }
        return seen.hash;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Each task's tool calls counted so far, up to the event sequence `upTo`: a snapshot reads only the
 * events after it, so its cost follows what happened since the last read, not the whole history
 * (the snapshot is read up to four times a second). Events are never changed once written, so
 * what was counted stays right. One per daemon and project, made where its snapshot route is.
 */
export interface ToolCallTally {
  upTo: number;
  counts: Map<string, number>;
}

export function toolCallTally(): ToolCallTally {
  return { upTo: 0, counts: new Map() };
}

/** Brings the tally up to `head`; a head behind it is another log, counted again from the start. */
function countToolCalls(state: FridayState, pid: string, head: number, tally: ToolCallTally): Map<string, number> {
  if (head < tally.upTo) {
    tally.upTo = 0;
    tally.counts.clear();
  }
  if (head > tally.upTo) {
    for (const [taskId, n] of Object.entries(state.q.toolCallCounts(pid, tally.upTo, head))) {
      tally.counts.set(taskId, (tally.counts.get(taskId) ?? 0) + n);
    }
    tally.upTo = head;
  }
  return tally.counts;
}

/**
 * Everything the board needs in one synchronous read, consistent with `head` (plan M9 §5.3,
 * FD-08): the interface streams events from `head` and reads this again after domain events.
 */
export function buildUiSnapshot(deps: {
  state: FridayState;
  project: ProjectRef;
  port: number;
  daemonVersion: string;
  brain?: BrainHandle | undefined;
  info?: UiSnapshotInfo | undefined;
  /** The daemon's running count of tool calls; without one, they are counted from the start. */
  toolCalls?: ToolCallTally | undefined;
  nowMs: number;
}): UiSnapshot {
  const { state, project } = deps;
  const pid = project.project_id;
  const head = state.store.head(pid);
  const truncated: UiSnapshot['truncated'] = {};
  const cap = <T>(list: T[], name: SnapshotList, keep: 'first' | 'last' = 'first'): T[] => {
    const max = SNAPSHOT_CAPS[name];
    if (list.length <= max) return list;
    truncated[name] = true;
    return keep === 'first' ? list.slice(0, max) : list.slice(-max);
  };
  const recent = (iso: string | null | undefined, windowMs: number) => {
    const t = iso ? Date.parse(iso) : Number.NaN;
    return !Number.isNaN(t) && deps.nowMs - t < windowMs;
  };

  const allAgents = state.q.agents(pid);
  const agentKey = (id: string | null) => (id ? (allAgents.find((a) => a.agent_id === id)?.agent_key ?? null) : null);

  // What the board shows is chosen in SQL before the limit, so the newest work is never the part
  // left out; reaching the limit is flagged like any other cap (review M9i).
  const SQL_LIMIT = 5000;
  const liveTasks = state.q.tasks(pid, { limit: SQL_LIMIT, liveSince: new Date(deps.nowMs - DAY_MS).toISOString() });
  if (liveTasks.length >= SQL_LIMIT) truncated.tasks = true;
  const shownTasks = cap(
    liveTasks.filter((t) => !TERMINAL.has(t.status) || recent(t.updated_at, DAY_MS)),
    'tasks',
    'last',
  );
  // From the event log, so the count is the same after a reload (review R13); only the events
  // since the last read are counted.
  const toolCalls = countToolCalls(state, pid, head, deps.toolCalls ?? toolCallTally());
  // Why each task that has not started is not at work, from the state as it is now (2026-11-18).
  const facts = notStartedFacts(state, pid, deps.nowMs);
  const tasks: SnapshotTask[] = shownTasks.map((t) => {
    const waits = whyNotStarted(state, pid, t, facts);
    const run = t.current_run_id ? state.q.findRun(t.current_run_id) : state.q.runs(t.task_id).at(-1);
    return {
      ...t,
      why: run || t.assigned_agent_id ? whyChosen(state, pid, t, run) : null,
      agent_key: agentKey(t.assigned_agent_id),
      waiting_note: t.status === 'WAITING' ? latestReason(state, pid, t.task_id, 'task.waiting') : null,
      delegation_note: waits?.text ?? null,
      waits_for: waits?.code ?? null,
      attention: attentionOf(state, pid, t),
      tool_calls: toolCalls.get(t.task_id) ?? 0,
    };
  });

  const runs: Record<string, RunView> = {};
  const verifications: Record<string, VerificationView> = {};
  const integrations: Record<string, IntegrationView> = {};
  for (const t of tasks) {
    const run = t.current_run_id ? state.q.findRun(t.current_run_id) : state.q.runs(t.task_id).at(-1);
    if (run) runs[t.task_id] = run;
    const v = state.q.latestVerification(t.task_id);
    if (v) verifications[t.task_id] = v;
    const i = state.q.latestIntegration(pid, t.task_id);
    if (i) integrations[t.task_id] = i;
  }

  const liveGoals = state.q.goals(pid, { limit: 1000, liveSince: new Date(deps.nowMs - 7 * DAY_MS).toISOString() });
  if (liveGoals.length >= 1000) truncated.goals = true;
  const goals = cap(
    liveGoals.filter((g) => g.status === 'OPEN' || g.status === 'ACTIVE' || recent(g.updated_at, 7 * DAY_MS)),
    'goals',
    'last',
  );
  // Progress over all of a goal's tasks: `tasks` leaves out those finished more than a day ago and
  // those past its cap, so counting what it lists would lose them (review R4).
  const counted = state.q.goalProgress(
    pid,
    goals.map((g) => g.goal_id),
  );
  const goalProgress: UiSnapshot['goal_progress'] = {};
  for (const g of goals) goalProgress[g.goal_id] = counted[g.goal_id] ?? { total: 0, completed: 0 };
  // What keeps a host out of work now: a failed sign-in (until cleared), a bench (until it expires).
  const hostBlocks: NonNullable<UiSnapshot['host_blocks']> = [];
  for (const e of state.q.readinessEvidence(pid, { limit: 200 })) {
    if (e.status !== 'failed') continue;
    const kind = e.stage === 'authenticated' ? 'sign_in' : e.stage === 'benched' ? 'benched' : null;
    if (!kind) continue;
    if (e.expires_at && Date.parse(e.expires_at) <= deps.nowMs) continue;
    // The newest record of a host, model and kind is the one that counts (they come newest first).
    if (hostBlocks.some((b) => b.host === e.host && b.model === e.model && b.kind === kind)) continue;
    hostBlocks.push({
      host: e.host,
      model: e.model,
      kind,
      detail: e.detail,
      since: e.checked_at,
      until: e.expires_at,
    });
  }
  // A completed goal's card says "Landed into main", or that its work is already in the folder.
  const landed = landedGoals(state, pid);
  const goalLanding: NonNullable<UiSnapshot['goal_landing']> = {};
  for (const g of goals) {
    // A question has nothing to land.
    if (g.status !== 'COMPLETED' || g.mode === 'ask') continue;
    const l = landed.get(g.goal_id);
    goalLanding[g.goal_id] = { work: goalWork(state, pid, g.goal_id), landed: l ? { into: l.into, at: l.at } : null };
  }
  const plans: UiSnapshot['plans'] = {};
  for (const g of goals) {
    if (!g.plan_id) continue;
    const versions = state.q.planVersions(g.plan_id);
    const active = [...versions].reverse().find((v) => v.status === 'ACTIVE' || v.status === 'COMPLETED');
    const proposed = [...versions].reverse().find((v) => v.status === 'PROPOSED');
    plans[g.goal_id] = {
      active: active ? (liveVersion(state, pid, active) as LivePlanVersion) : null,
      proposed: proposed ? (liveVersion(state, pid, proposed) as LivePlanVersion) : null,
    };
  }

  const harnesses: HarnessEntry[] = cap(
    state.q.harnesses(pid).map((h) => {
      const r = state.q.harness(h.harness_id);
      return {
        ...h,
        shadow: Boolean(r.shadow),
        requested_agent_key: r.requested_agent_key ?? null,
        observed_model: r.observed_model ?? null,
        host_cwd: r.host_cwd ?? null,
      };
    }),
    'harnesses',
  );

  // A pending approval past its expiry stays pending in the table (LESSONS UI-11): the unexpired
  // ones, and those that expired within the last hour, so the interface can say they did.
  const approvals = cap(
    (state.q.approvals(pid, 'pending') as unknown as Omit<ApprovalRow, 'expired'>[])
      .map((a) => ({ ...a, expired: !!a.expires_at && Date.parse(a.expires_at) <= deps.nowMs }))
      .filter((a) => !a.expired || (a.expires_at && deps.nowMs - Date.parse(a.expires_at) < HOUR_MS)),
    'approvals',
  );

  // Bodies are loaded when an item is opened (review SEC-14); the board carries a preview.
  const inbox: SnapshotInboxItem[] = cap(state.q.openDeliveriesFor(pid, 'human'), 'inbox').map((d) => {
    const { body, ...item } = state.inboxItem(pid, d, null);
    return { ...item, preview: Array.from(body).slice(0, PREVIEW_CHARS).join('') };
  });

  const brainJobs: BrainJobView[] = state
    .brainJobs(pid)
    .map((j) => ({ job_id: j.job_id, kind: j.kind, status: j.status, goal_id: j.goal_id ?? null }));

  // The same read as `GET memory/review`, so the rail's count and the drawer's list agree.
  const memoriesToReview = state.memory
    .search(pid, HUMAN_MEMORY, { limit: MEMORY_REVIEW_SCAN })
    .filter((m) => m.needs_review).length;

  const info = deps.info ?? {
    has_commit: true,
    worktrees_mode: project.config.worktrees.mode,
    config: { loaded_hash: 'unknown', current_hash: null },
    auto_verification: false,
  };

  return {
    ui_api: UI_API_VERSION,
    head,
    generated_at: new Date(deps.nowMs).toISOString(),
    project: {
      project_id: pid,
      name: project.name,
      root: project.root,
      port: deps.port,
      daemon_version: deps.daemonVersion,
      has_commit: info.has_commit,
      worktrees_mode: info.worktrees_mode,
    },
    config: info.config,
    control: state.q.control(pid),
    landing: { mode: info.auto_landing ?? 'ask', requested: project.config.landing.mode },
    verification: {
      checks: project.config.verification.checks.map((c) => ({ name: c.name, kind: c.kind, required: c.required })),
      auto_on_completion: info.auto_verification,
      auto_requested: project.config.verification.auto_on_completion === true,
    },
    counts: state.q.statusCounts(pid),
    goals,
    goal_progress: goalProgress,
    goal_landing: goalLanding,
    answers: answersOf(state, pid, goals),
    host_blocks: hostBlocks,
    plans,
    tasks,
    runs,
    verifications,
    integrations,
    usage: lastUsage(state, pid, new Set(Object.values(runs).map((r) => r.run_id))),
    agents: cap(allAgents, 'agents'),
    harnesses,
    approvals,
    escalations: cap(
      state.q.escalations(pid, 'pending').map((e) => escalationView(e) as unknown as EscalationView),
      'escalations',
    ),
    inbox,
    reservations: cap(state.q.fileReservations(pid, ['active']), 'reservations'),
    brain: deps.brain ? (deps.brain.status() as BrainStatusView) : null,
    brain_jobs: brainJobs,
    memories_to_review: memoriesToReview,
    policy_untrusted: info.policy_trusted === false,
    truncated,
  };
}

/** The reason of a task's latest transition event of this type (≤ 1000 characters). */
function latestReason(state: FridayState, pid: string, taskId: string, type: string): string | null {
  const e = state.store.readByRef(pid, 'task', taskId, { types: [type], limit: 1, desc: true })[0];
  const reason = (e?.payload as { transition?: { reason?: unknown } } | undefined)?.transition?.reason;
  return typeof reason === 'string' && reason ? reason.slice(0, 1000) : null;
}

/**
 * What a running task's agent last did, when that agent is one its person runs and it is not at
 * work (`SnapshotTask.attention`): the newest of its turn ending, a tool call Friday judged and a
 * tool call that finished. A turn that ended last: it stopped. A call Friday answered "ask" last:
 * its host is asking the person in its own window. Anything else: it works.
 */
function attentionOf(state: FridayState, pid: string, t: TaskView): TaskAttention | null {
  if (t.status !== 'RUNNING' || !t.current_run_id) return null;
  const run = state.q.findRun(t.current_run_id);
  const h = run ? state.q.findHarness(run.harness_id) : undefined;
  // An agent Friday starts is watched by its adapter: its turns and its questions are Friday's own.
  if (!h || h.attach_mode === 'spawn') return null;
  const e = state.store.readByRef(pid, 'task', t.task_id, {
    types: ['agent.turn_ended', 'policy.evaluated', 'agent.event', 'run.paths_observed'],
    limit: 1,
    desc: true,
  })[0];
  if (!e || (run?.accepted_at && e.occurred_at < run.accepted_at)) return null;
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const text = (v: unknown, max: number) => (typeof v === 'string' && v ? v.slice(0, max) : null);
  if (e.type === 'agent.turn_ended') {
    return { kind: 'stopped', at: e.occurred_at, reason: text(p.reason, 80), error: text(p.error, 400) };
  }
  if (e.type === 'policy.evaluated' && p.decision === 'ask') {
    const targets = Array.isArray(p.targets) ? p.targets.filter((x): x is string => typeof x === 'string') : [];
    return {
      kind: 'asking',
      at: e.occurred_at,
      tool: text(p.tool, 80),
      target: text(targets[0], 400),
      rule: text(p.reason, 300),
    };
  }
  return null;
}

/** The last usage a host reported for each listed run, from the most recent agent events. */
function lastUsage(state: FridayState, pid: string, runIds: Set<string>): Record<string, UsageView> {
  const out: Record<string, UsageView> = {};
  if (!runIds.size) return out;
  for (const e of state.store.readSince(pid, 0, { types: ['agent.event'], limit: USAGE_SCAN, desc: true })) {
    const p = e.payload as { run_id?: string; event_type?: string; data?: Record<string, unknown> };
    if (p.event_type !== 'host.usage' || !p.run_id || !runIds.has(p.run_id) || out[p.run_id]) continue;
    const d = p.data ?? {};
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const run = state.q.findRun(p.run_id);
    const codex = run ? state.q.findHarness(run.harness_id)?.vendor === 'codex' : false;
    out[p.run_id] = {
      cost_usd: num(d.cost_usd),
      // The whole prompt, the cache included, for every host alike (2026-11-18).
      input_tokens: promptTokens({
        input_tokens: num(d.input_tokens),
        output_tokens: num(d.output_tokens),
        cache_read_input_tokens: num(d.cache_read_input_tokens),
        cache_creation_input_tokens: num(d.cache_creation_input_tokens),
        input_includes_cache: d.input_includes_cache === true || codex,
      }),
      output_tokens: num(d.output_tokens),
      at: e.occurred_at,
    };
  }
  return out;
}
