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
  UiSnapshot,
  UsageView,
  VerificationView,
} from '@friday/protocol';
import type { ProjectRef } from '@friday/sdk';
import type { FridayState } from '@friday/state';
import type { BrainHandle } from './brain.js';
import { escalationView, liveVersion } from './brain-routes.js';

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

/** What the daemon knows about itself that the snapshot shows. */
export interface UiSnapshotInfo {
  has_commit: boolean;
  worktrees_mode: string;
  /** The hash of config.yaml as loaded, and as it is now. */
  config: { loaded_hash: string; current_hash: string | null };
  /** Claims are verified automatically (trusted, and project checks exist). */
  auto_verification: boolean;
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

  const tasks: SnapshotTask[] = cap(
    state.q.tasks(pid, { limit: 5000 }).filter((t) => !TERMINAL.has(t.status) || recent(t.updated_at, DAY_MS)),
    'tasks',
    'last',
  ).map((t) => ({
    ...t,
    agent_key: agentKey(t.assigned_agent_id),
    waiting_note: t.status === 'WAITING' ? latestReason(state, pid, t.task_id, 'task.waiting') : null,
    delegation_note: t.status === 'READY' ? delegationNote(state, t.task_id) : null,
  }));

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

  const goals = cap(
    state.q
      .goals(pid, { limit: 1000 })
      .filter((g) => g.status === 'OPEN' || g.status === 'ACTIVE' || recent(g.updated_at, 7 * DAY_MS)),
    'goals',
    'last',
  );
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
    verification: {
      checks: project.config.verification.checks.map((c) => ({ name: c.name, kind: c.kind, required: c.required })),
      auto_on_completion: info.auto_verification,
    },
    counts: state.q.statusCounts(pid),
    goals,
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
    truncated,
  };
}

/** The reason of a task's latest transition event of this type (≤ 1000 characters). */
function latestReason(state: FridayState, pid: string, taskId: string, type: string): string | null {
  const e = state.store.readByRef(pid, 'task', taskId, { types: [type], limit: 1, desc: true })[0];
  const reason = (e?.payload as { transition?: { reason?: unknown } } | undefined)?.transition?.reason;
  return typeof reason === 'string' && reason ? reason.slice(0, 1000) : null;
}

/** Why delegation left a READY task waiting: its latest decision when nobody took it. */
function delegationNote(state: FridayState, taskId: string): string | null {
  const last = state.q.assignments(taskId).at(-1);
  if (!last || last.agent_key) return null;
  return last.reason ? String(last.reason).slice(0, 500) : null;
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
    out[p.run_id] = {
      cost_usd: num(d.cost_usd),
      input_tokens: num(d.input_tokens),
      output_tokens: num(d.output_tokens),
      at: e.occurred_at,
    };
  }
  return out;
}
