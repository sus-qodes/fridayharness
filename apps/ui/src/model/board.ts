/**
 * The board graph (plan §7.3): what the Studio canvas shows, derived from the daemon's snapshot.
 * Pure: no DOM, no store. Goal groups with their tasks, a "Loose tasks" group, dependency edges,
 * agent pods with the task each works on, proposed-plan ghosts and per-goal progress. Node sizes
 * live here too, because the layout reserves exactly the space each card is drawn in.
 */
import type {
  AgentView,
  EscalationView,
  FileReservationView,
  GoalView,
  HarnessEntry,
  IntegrationView,
  LivePlanTask,
  LivePlanVersion,
  RunView,
  SnapshotTask,
  UiSnapshot,
  UsageView,
  VerificationView,
} from '@friday/protocol';
import type { LayoutGroup, LayoutInput, LayoutItem, LayoutPod } from './layout.js';

/** Task statuses that end a task. */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['COMPLETED', 'CANCELLED', 'ABANDONED']);
/** Goal statuses hidden when "show finished goals" is off. */
export const FINISHED_GOALS: ReadonlySet<string> = new Set(['COMPLETED', 'CANCELLED']);
/** Statuses in which a task is held by an agent (its pod sits beside it). */
const HELD: ReadonlySet<string> = new Set(['ASSIGNED', 'RUNNING', 'WAITING']);

export const LOOSE_GROUP = 'loose';

export function podId(agentKey: string): string {
  return `pod:${agentKey}`;
}

export function ghostId(planId: string, version: number, key: string): string {
  return `ghost:${planId}:${version}:${key}`;
}

export function planBarId(goalId: string): string {
  return `planbar:${goalId}`;
}

export interface BoardOptions {
  /** `prefs.showFinished`: finished goals (and finished loose tasks) stay on the board. */
  showFinished: boolean;
}

export interface Progress {
  completed: number;
  /** Every task of the goal except cancelled and abandoned ones. */
  total: number;
}

export interface IntegrationSummary {
  integrated: number;
  conflicted: number;
  failed: number;
  not_needed: number;
}

/** A new or reworked task of a proposed plan version, drawn as a dashed card (plan §7.3). */
export interface PlanGhost {
  id: string;
  goalId: string;
  planId: string;
  version: number;
  key: string;
  change: 'new' | 'rework';
  /** The existing task a rework applies to. */
  taskId: string | null;
  planTask: LivePlanTask;
  /** Node ids (tasks or other ghosts) this ghost depends on. */
  deps: string[];
}

export interface GoalGroup {
  id: string;
  goal: GoalView;
  /** Visible task ids in plan order, then by creation. */
  taskIds: string[];
  ghostIds: string[];
  active: LivePlanVersion | null;
  proposed: LivePlanVersion | null;
  progress: Progress;
  integration: IntegrationSummary;
  /** Tasks the proposed version drops. */
  dropped: string[];
}

export interface PodModel {
  id: string;
  agentKey: string;
  agent: AgentView;
  harness: HarnessEntry | null;
  /** The visible task the agent works on. */
  taskId: string | null;
  task: SnapshotTask | null;
  run: RunView | null;
  usage: UsageView | null;
  /** Its task is RUNNING: a live conduit with pulses. */
  working: boolean;
}

export type EdgeKind = 'dependency' | 'goal' | 'ghost' | 'conduit' | 'assignment';

export interface BoardEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  /** Dependency edges: the prerequisite task is COMPLETED. */
  satisfied: boolean;
}

export interface Board {
  snapshot: UiSnapshot | null;
  groups: GoalGroup[];
  /** Visible task ids without a (shown) goal. */
  loose: string[];
  tasks: Map<string, SnapshotTask>;
  ghosts: Map<string, PlanGhost>;
  pods: PodModel[];
  edges: BoardEdge[];
  /** Which group each task and ghost is in. */
  groupOf: Map<string, string>;
  reservations: Map<string, FileReservationView[]>;
  /** Tasks with a pending `recovery_needed` question. */
  recoveryTasks: Set<string>;
  /** Pending escalations per task (any kind). */
  escalations: Map<string, EscalationView[]>;
  harnessById: Map<string, HarnessEntry>;
  /** Nothing to draw. */
  empty: boolean;
}

export function emptyBoard(snapshot: UiSnapshot | null = null): Board {
  return {
    snapshot,
    groups: [],
    loose: [],
    tasks: new Map(),
    ghosts: new Map(),
    pods: [],
    edges: [],
    groupOf: new Map(),
    reservations: new Map(),
    recoveryTasks: new Set(),
    escalations: new Map(),
    harnessById: new Map(),
    empty: true,
  };
}

export function goalProgress(tasks: readonly Pick<SnapshotTask, 'status'>[]): Progress {
  let completed = 0;
  let total = 0;
  for (const t of tasks) {
    if (t.status === 'CANCELLED' || t.status === 'ABANDONED') continue;
    total += 1;
    if (t.status === 'COMPLETED') completed += 1;
  }
  return { completed, total };
}

export function integrationSummary(list: readonly (IntegrationView | undefined)[]): IntegrationSummary {
  const out: IntegrationSummary = { integrated: 0, conflicted: 0, failed: 0, not_needed: 0 };
  for (const i of list) if (i) out[i.status] += 1;
  return out;
}

/** Derives the board from a snapshot. A null snapshot gives an empty board. */
export function deriveBoard(snapshot: UiSnapshot | null, opts: BoardOptions = { showFinished: true }): Board {
  const board = emptyBoard(snapshot);
  if (!snapshot) return board;

  const allTasks = new Map(snapshot.tasks.map((t) => [t.task_id, t]));
  const goalsShown = snapshot.goals.filter((g) => opts.showFinished || !FINISHED_GOALS.has(g.status));
  const hiddenGoals = new Set(snapshot.goals.filter((g) => !goalsShown.includes(g)).map((g) => g.goal_id));

  for (const h of snapshot.harnesses) board.harnessById.set(h.harness_id, h);
  for (const r of snapshot.reservations) {
    const list = board.reservations.get(r.task_id) ?? [];
    list.push(r);
    board.reservations.set(r.task_id, list);
  }
  for (const e of snapshot.escalations) {
    if (e.status !== 'pending' || !e.task_id) continue;
    const list = board.escalations.get(e.task_id) ?? [];
    list.push(e);
    board.escalations.set(e.task_id, list);
    if (e.kind === 'recovery_needed') board.recoveryTasks.add(e.task_id);
  }

  // ---- goal groups: tasks by plan order, then the goal's other tasks by creation
  const claimed = new Set<string>();
  for (const goal of goalsShown) {
    const plans = snapshot.plans[goal.goal_id] ?? { active: null, proposed: null };
    const ids: string[] = [];
    const take = (id: string | null | undefined) => {
      if (!id || claimed.has(id) || !allTasks.has(id)) return;
      claimed.add(id);
      ids.push(id);
    };
    for (const pt of byPosition(plans.active?.tasks ?? [])) take(pt.task_id);
    for (const t of byCreation(snapshot.tasks.filter((t) => t.goal_id === goal.goal_id))) take(t.task_id);
    for (const pt of byPosition(plans.proposed?.tasks ?? [])) take(pt.task_id);

    const group: GoalGroup = {
      id: goal.goal_id,
      goal,
      taskIds: ids,
      ghostIds: [],
      active: plans.active,
      proposed: plans.proposed,
      progress: goalProgress(ids.map((id) => allTasks.get(id) as SnapshotTask)),
      integration: integrationSummary(ids.map((id) => snapshot.integrations[id])),
      dropped: [],
    };
    if (plans.proposed) addGhosts(board, group, plans.proposed, allTasks);
    board.groups.push(group);
    for (const id of ids) {
      board.tasks.set(id, allTasks.get(id) as SnapshotTask);
      board.groupOf.set(id, group.id);
    }
  }

  // ---- loose tasks: no goal, or a goal the snapshot does not list (tasks of hidden goals stay hidden)
  for (const t of byCreation(snapshot.tasks)) {
    if (claimed.has(t.task_id)) continue;
    if (t.goal_id && hiddenGoals.has(t.goal_id)) continue;
    if (!opts.showFinished && TERMINAL_STATUSES.has(t.status)) continue;
    board.loose.push(t.task_id);
    board.tasks.set(t.task_id, t);
    board.groupOf.set(t.task_id, LOOSE_GROUP);
  }

  // ---- dependency edges, and goal edges to the tasks that start a goal's graph
  for (const group of board.groups) {
    const inGroup = new Set(group.taskIds);
    for (const id of group.taskIds) {
      const t = board.tasks.get(id) as SnapshotTask;
      if (!t.dependencies.some((d) => inGroup.has(d))) {
        board.edges.push({ id: `goal:${group.id}>${id}`, from: group.id, to: id, kind: 'goal', satisfied: true });
      }
    }
    for (const gid of group.ghostIds) {
      const g = board.ghosts.get(gid) as PlanGhost;
      if (!g.deps.length)
        board.edges.push({ id: `goal:${group.id}>${gid}`, from: group.id, to: gid, kind: 'ghost', satisfied: false });
      for (const d of g.deps)
        board.edges.push({ id: `ghost:${d}>${gid}`, from: d, to: gid, kind: 'ghost', satisfied: false });
    }
  }
  for (const t of board.tasks.values()) {
    for (const d of t.dependencies) {
      const dep = board.tasks.get(d);
      if (!dep || d === t.task_id) continue;
      board.edges.push({
        id: `dep:${d}>${t.task_id}`,
        from: d,
        to: t.task_id,
        kind: 'dependency',
        satisfied: dep.status === 'COMPLETED',
      });
    }
  }

  // ---- agent pods
  for (const agent of snapshot.agents) {
    if (agent.status === 'TERMINATED') continue;
    const taskId = podTask(agent, board.tasks);
    if (agent.status === 'DISCONNECTED' && !taskId) continue;
    const task = taskId ? (board.tasks.get(taskId) ?? null) : null;
    const run = taskId ? (snapshot.runs[taskId] ?? null) : null;
    const pod: PodModel = {
      id: podId(agent.agent_key),
      agentKey: agent.agent_key,
      agent,
      harness: agent.harness_id ? (board.harnessById.get(agent.harness_id) ?? null) : null,
      taskId,
      task,
      run,
      usage: run ? (snapshot.usage[run.run_id] ?? null) : null,
      working: task?.status === 'RUNNING',
    };
    board.pods.push(pod);
    if (taskId) {
      board.edges.push({
        id: `pod:${agent.agent_key}>${taskId}`,
        from: pod.id,
        to: taskId,
        kind: pod.working ? 'conduit' : 'assignment',
        satisfied: false,
      });
    }
  }

  board.empty = !board.groups.length && !board.loose.length && !board.pods.length;
  return board;
}

/** The visible task an agent works on: its current task, else a held task assigned to its key. */
function podTask(agent: AgentView, tasks: Map<string, SnapshotTask>): string | null {
  if (agent.current_task_id && tasks.has(agent.current_task_id)) return agent.current_task_id;
  for (const t of tasks.values()) {
    if (t.agent_key === agent.agent_key && HELD.has(t.status)) return t.task_id;
  }
  return null;
}

function addGhosts(
  board: Board,
  group: GoalGroup,
  proposed: LivePlanVersion,
  allTasks: Map<string, SnapshotTask>,
): void {
  const byKey = new Map(proposed.tasks.map((pt) => [pt.key, pt]));
  const nodeOfKey = (key: string): string | null => {
    if (allTasks.has(key)) return key; // a revision may name an existing task id
    const pt = byKey.get(key);
    if (!pt) return null;
    if (pt.change === 'new') return ghostId(proposed.plan_id, proposed.version, pt.key);
    if (pt.task_id && allTasks.has(pt.task_id)) return pt.task_id;
    if (pt.change === 'rework') return ghostId(proposed.plan_id, proposed.version, pt.key);
    return null;
  };
  for (const pt of byPosition(proposed.tasks)) {
    if (pt.change === 'drop') {
      if (pt.task_id) group.dropped.push(pt.task_id);
      continue;
    }
    if (pt.change !== 'new' && pt.change !== 'rework') continue;
    const id = ghostId(proposed.plan_id, proposed.version, pt.key);
    const deps = unique(
      pt.depends_on.map(nodeOfKey).filter((d): d is string => d !== null && d !== id && d !== pt.task_id),
    );
    const ghost: PlanGhost = {
      id,
      goalId: group.id,
      planId: proposed.plan_id,
      version: proposed.version,
      key: pt.key,
      change: pt.change,
      taskId: pt.task_id,
      planTask: pt,
      deps,
    };
    board.ghosts.set(id, ghost);
    board.groupOf.set(id, group.id);
    group.ghostIds.push(id);
  }
  // Ghost deps that point at tasks hidden from the board are dropped from the drawing.
  for (const gid of group.ghostIds) {
    const g = board.ghosts.get(gid) as PlanGhost;
    g.deps = g.deps.filter((d) => board.ghosts.has(d) || allTasks.has(d));
  }
}

function byPosition<T extends { position: number }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => a.position - b.position);
}

function byCreation<T extends { created_at: string; task_id: string }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) =>
    a.created_at === b.created_at ? (a.task_id < b.task_id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1,
  );
}

function unique(list: string[]): string[] {
  return [...new Set(list)];
}

// ---- what the cards need -------------------------------------------------------------------

/** Card sizes in world pixels (handoff Part 04: goal 340×150, task 300×165, pod 280×145). */
export const NODE_SIZE = {
  goal: { w: 340, h: 150 },
  task: { w: 300, h: 144 },
  ghost: { w: 300, h: 126 },
  planbar: { w: 340, h: 104 },
  pod: { w: 280, h: 150 },
} as const;

/** The most criteria a task card lists before "+N more". */
export const CRITERIA_SHOWN = 3;

/** The latest verification's checks: how many of those that ran passed. */
export function checksSummary(v: VerificationView | null | undefined): { passed: number; run: number } | null {
  if (!v?.checks.length) return null;
  let passed = 0;
  let run = 0;
  for (const c of v.checks) {
    if (c.status === 'NOT_REQUESTED' || c.status === 'QUEUED' || c.status === 'CANCELLED') continue;
    run += 1;
    if (c.status === 'PASSED') passed += 1;
  }
  return { passed, run };
}

/** A conflict on the task: an integration that conflicted or failed. */
export function conflictOf(integration: IntegrationView | null | undefined): 'conflicted' | 'failed' | null {
  if (!integration) return null;
  return integration.status === 'conflicted' || integration.status === 'failed' ? integration.status : null;
}

/** The parts a task card shows, so its height can be reserved exactly. */
export interface TaskCardParts {
  scope: boolean;
  criteria: number;
  note: 'blocked' | 'delegation' | null;
  badges: boolean;
}

export function taskCardParts(board: Board, task: SnapshotTask, dropped: boolean): TaskCardParts {
  const snapshot = board.snapshot;
  const note =
    task.status === 'WAITING' && task.waiting_note
      ? 'blocked'
      : task.status === 'READY' && task.delegation_note
        ? 'delegation'
        : null;
  const badges =
    dropped ||
    !!checksSummary(snapshot?.verifications[task.task_id]) ||
    !!board.reservations.get(task.task_id)?.length ||
    !!conflictOf(snapshot?.integrations[task.task_id]);
  return { scope: !!task.scope?.write.length, criteria: task.acceptance_criteria.length, note, badges };
}

export function taskCardHeight(parts: TaskCardParts): number {
  let h = NODE_SIZE.task.h;
  if (parts.scope) h += 24;
  if (parts.criteria > 0)
    h += 6 + Math.min(parts.criteria, CRITERIA_SHOWN) * 17 + (parts.criteria > CRITERIA_SHOWN ? 17 : 0);
  if (parts.note === 'blocked') h += 56;
  else if (parts.note === 'delegation') h += 22;
  if (parts.badges) h += 26;
  return h;
}

export function goalCardHeight(goal: GoalView): number {
  return NODE_SIZE.goal.h + (goal.constraints.length || goal.inferred_constraints.length ? 26 : 0);
}

/** The layout input: groups in board order, then the loose tasks, then the pods. */
export function layoutInputOf(board: Board): LayoutInput {
  const groups: LayoutGroup[] = [];
  for (const g of board.groups) {
    const dropped = new Set(g.dropped);
    const items: LayoutItem[] = [];
    if (g.proposed) items.push({ id: planBarId(g.id), ...NODE_SIZE.planbar, deps: [], pinned: true });
    for (const id of g.taskIds) {
      const t = board.tasks.get(id) as SnapshotTask;
      items.push({
        id,
        w: NODE_SIZE.task.w,
        h: taskCardHeight(taskCardParts(board, t, dropped.has(id))),
        deps: t.dependencies,
      });
    }
    for (const id of g.ghostIds) {
      const ghost = board.ghosts.get(id) as PlanGhost;
      items.push({ id, ...NODE_SIZE.ghost, deps: ghost.deps });
    }
    groups.push({ id: g.id, root: { id: g.id, w: NODE_SIZE.goal.w, h: goalCardHeight(g.goal), deps: [] }, items });
  }
  if (board.loose.length) {
    groups.push({
      id: LOOSE_GROUP,
      label: 'Loose tasks',
      items: board.loose.map((id) => {
        const t = board.tasks.get(id) as SnapshotTask;
        return { id, w: NODE_SIZE.task.w, h: taskCardHeight(taskCardParts(board, t, false)), deps: t.dependencies };
      }),
    });
  }
  const pods: LayoutPod[] = board.pods.map((p) => ({ id: p.id, ...NODE_SIZE.pod, taskId: p.taskId }));
  return { groups, pods };
}

/** Agents a task can be given to (Reassign): connected, not shadows, not the current holder. */
export function assignableAgents(snapshot: UiSnapshot | null, task: SnapshotTask): AgentView[] {
  if (!snapshot) return [];
  return snapshot.agents.filter(
    (a) =>
      !a.shadow &&
      a.status !== 'TERMINATED' &&
      a.status !== 'DISCONNECTED' &&
      a.status !== 'UNHEALTHY' &&
      a.agent_key !== task.agent_key,
  );
}
