import { globsOverlap, matchesAny } from '@friday/policy';
import { COST_ORDER, type CostClass } from '@friday/protocol';

/**
 * Delegation policy (spec Part 03 §10): a deterministic score, not a model call.
 *   score = 3·capability_fit + 2·context_fit + 1.5·reliability + 1·locality + 1·model_fit − 0.5·cost
 * `model_fit` is how well the best model the agent's harness can run fits the task (ADR-0031 §9).
 * Only available agents are eligible. A task that names a role goes to a free agent of that role
 * when there is one, the score deciding among them; ties go to the lower agent key, so the same
 * state always gives the same assignment. A small, low-risk task goes to the cheapest capable agent
 * first (plan M13.3): of its role, the lowest cost class whose model fits, then the score.
 */

export interface DelegationTask {
  task_id: string;
  goal_id: string | null;
  role: string;
  write: string[];
  /** The task's kind and risk: with its write scope, they say whether it is small (plan M13.3). */
  kind?: string;
  risk_level?: string;
}

export interface DelegationCandidate {
  agent_id: string;
  agent_key: string;
  role: string;
  status: string;
  shadow: boolean;
  harness_live: boolean;
  /** Task the agent is holding, if any. */
  current_task_id: string | null;
  completed: number;
  failed: number;
  /** Paths the agent changed in earlier runs (newest first). */
  recent_paths: string[];
  /** Goals in which the agent completed a task. */
  goals_done: string[];
  /** Relative cost of the model routing would run for the task, 0 (cheapest or unknown) to 1 (ADR-0031 §9). */
  cost: number;
  /** How well that model fits the task, 0 to 1; 0 when routing chose none for this harness. */
  model_fit?: number;
  /** What the agent's work costs (plan M13.3); `standard` when unknown. */
  cost_class?: CostClass;
  /**
   * The agent's session is one its person runs (Antigravity, Claude Code in an editor): a task
   * given to it is only kept for it until that person prompts it there (2026-11-17).
   */
  waits_for_person?: boolean;
  /**
   * Friday gives each task of this agent a folder of its own (a task worktree), so it may work
   * beside a task that changes the same files (2026-11-18). Without it the agent works in a
   * folder it shares, the project folder.
   */
  own_folder?: boolean;
}

/** A task that is at work now, as delegation sees it. */
export interface RunningWork {
  write: string[];
  /** It works in a folder of its own, not in one it shares with other tasks. */
  own_folder?: boolean;
  task_id?: string;
  agent_key?: string | null;
}

/** The kinds of task a cheaper agent may take when small and low-risk. */
const SMALL_KINDS = new Set(['implementation', 'docs', 'chore', 'verification']);

/** At least this model fit makes a cheaper agent capable of a task; a fit routing does not know (0) does not rule it out. */
export const CAPABLE_FIT = 0.6;

/**
 * A small, low-risk task (plan M13.3): risk `low`, a kind a smaller model does well, and at most
 * three write globs. Such a task goes to the cheapest capable agent.
 */
/** A write-scope entry that names one file: no glob characters, so its size is known. */
const namesOneFile = (pattern: string) => !/[*?[\]{}]/.test(pattern);

/**
 * A small task: low risk, of a kind that is usually quick, and allowed to change at most three
 * named files. A glob (`backend/**`, `src/*.ts`, `**`) may cover anything, so a scope with one is
 * of unknown size, never small: the cheapest agent is not sent to the whole repository.
 */
export function isSmallTask(t: DelegationTask): boolean {
  return (
    t.risk_level === 'low' &&
    SMALL_KINDS.has(t.kind ?? 'implementation') &&
    t.write.length > 0 &&
    t.write.length <= 3 &&
    t.write.every(namesOneFile)
  );
}

export interface ScoreParts {
  capability_fit: number;
  context_fit: number;
  availability: number;
  reliability: number;
  locality: number;
  conflict_risk: number;
  model_fit: number;
  cost: number;
}

export interface CandidateScore {
  agent_id: string;
  agent_key: string;
  eligible: boolean;
  reason: string;
  total: number;
  parts: ScoreParts;
}

export const DELEGATION_WEIGHTS = {
  capability_fit: 3,
  context_fit: 2,
  reliability: 1.5,
  locality: 1,
  model_fit: 1,
  cost: 0.5,
} as const;

const round = (n: number) => Math.round(n * 1000) / 1000;

export function scoreCandidate(
  task: DelegationTask,
  c: DelegationCandidate,
  /** Why this agent cannot take the task although it is free; said as its reason. */
  held: string | null = null,
): CandidateScore {
  const capability_fit = c.role === task.role ? 1 : c.role === 'developer' || task.role === 'developer' ? 0.6 : 0.2;
  const context_fit =
    task.write.length === 0 || c.recent_paths.length === 0
      ? 0
      : task.write.filter((g) => c.recent_paths.some((p) => matchesAny(p, [g]))).length / task.write.length;
  const reliability = (c.completed + 1) / (c.completed + c.failed + 2);
  const locality = task.goal_id && c.goals_done.includes(task.goal_id) ? 1 : 0;
  const why = !c.harness_live
    ? 'no live session'
    : c.shadow
      ? 'shadow session'
      : c.current_task_id
        ? `busy with ${c.current_task_id}`
        : c.status !== 'AVAILABLE'
          ? `agent is ${c.status}`
          : (held ?? '');
  const parts: ScoreParts = {
    capability_fit,
    context_fit: round(context_fit),
    availability: why ? 0 : 1,
    reliability: round(reliability),
    locality,
    conflict_risk: 0,
    model_fit: round(c.model_fit ?? 0),
    cost: c.cost,
  };
  const w = DELEGATION_WEIGHTS;
  const total = round(
    w.capability_fit * capability_fit +
      w.context_fit * parts.context_fit +
      w.reliability * parts.reliability +
      w.locality * locality +
      w.model_fit * parts.model_fit -
      w.cost * c.cost,
  );
  return { agent_id: c.agent_id, agent_key: c.agent_key, eligible: !why, reason: why || 'available', total, parts };
}

export interface DelegationDecision {
  task_id: string;
  /** The chosen agent, or null when nobody is eligible or the task must wait. */
  agent_key: string | null;
  reason: string;
  scores: CandidateScore[];
}

/** Said of an agent that is free but works in the folder the running tasks' files are in. */
const SHARED_FOLDER = 'works in the project folder, and a task that is running changes the same files';

/**
 * Picks an agent for one READY task.
 *
 * Two tasks never change the same files in one folder (single live writer, plan B26). In folders
 * of their own they may (2026-11-18): Friday merges their verified work into the goal, and what
 * collides goes back to the agent. So a task whose write scope overlaps a running task's waits
 * only when one of the two would work in a folder it shares: the running task does (it is in the
 * project folder), or the only free agents do. `runningWrites` may be bare write scopes, which
 * count as work in a shared folder, as every task was before.
 */
export function delegate(
  task: DelegationTask,
  candidates: DelegationCandidate[],
  runningWrites: readonly (string[] | RunningWork)[],
): DelegationDecision {
  // A read-only task (no write scope) never conflicts; a running task without a scope may write anything.
  const running = runningWrites.map((r): RunningWork => (Array.isArray(r) ? { write: r } : r));
  const clashing = task.write.length > 0 ? running.filter((r) => globsOverlap(r.write, task.write)) : [];
  const inSharedFolder = clashing.find((r) => !r.own_folder);
  if (inSharedFolder) {
    const who = inSharedFolder.agent_key ? `${inSharedFolder.agent_key} is` : 'a task that is running is';
    return {
      task_id: task.task_id,
      agent_key: null,
      // The first words are read by people ("Not started yet: …") and by tests of long standing.
      reason: `waits: its write scope overlaps a task that is running${
        inSharedFolder.own_folder === undefined && !inSharedFolder.task_id
          ? ''
          : ` in the project folder (${who} changing the same files${inSharedFolder.task_id ? ` for ${inSharedFolder.task_id}` : ''})`
      }`,
      scores: [],
    };
  }
  // The running tasks that share its files each have a folder of their own: so must this one.
  const needsOwnFolder = clashing.length > 0;
  // A task that names a role goes to a free agent of that role when there is one: the score decides
  // among them, and among everyone when there is none. A generalist's history in the same files
  // must not outweigh the role the plan chose (LESSONS D-48).
  const named = task.role !== 'developer';
  const ofRole = (s: CandidateScore) => (named && s.parts.capability_fit === 1 ? 1 : 0);
  // A small, low-risk task: the cheapest capable agent first (plan M13.3). An agent whose model
  // routing knows to fit poorly is not capable of it, and ranks as the dearest.
  const small = isSmallTask(task);
  const classOf = new Map(candidates.map((c) => [c.agent_id, c.cost_class ?? 'standard']));
  const cheapness = (s: CandidateScore) => {
    if (!small) return 0;
    const fit = s.parts.model_fit;
    return fit > 0 && fit < CAPABLE_FIT ? COST_ORDER.length : COST_ORDER.indexOf(classOf.get(s.agent_id) ?? 'standard');
  };
  // An agent that starts by itself goes before one that waits for its person (2026-11-17): the
  // second is given a task only when no free agent of the first kind can take it. In the live run
  // of that day an open task was kept fifteen minutes for an Antigravity nobody was looking at,
  // its higher score in hand, while Codex was idle.
  const waits = new Map(candidates.map((c) => [c.agent_id, c.waits_for_person === true]));
  const selfStarting = (s: CandidateScore) => (waits.get(s.agent_id) ? 0 : 1);
  /** Its role is the task's, or one of the two is the generalist: not another speciality. */
  const fits = (s: CandidateScore) => (s.parts.capability_fit > 0.2 ? 1 : 0);
  const scores = candidates
    .map((c) => scoreCandidate(task, c, needsOwnFolder && !c.own_folder ? SHARED_FOLDER : null))
    .sort(
      (a, b) =>
        Number(b.eligible) - Number(a.eligible) ||
        // The role the plan names comes first (2026-11-18): starting by itself decided before it,
        // so a frontend task went to a backend agent while a frontend agent was connected.
        ofRole(b) - ofRole(a) ||
        // Nor does it outweigh fitting at all: an agent of another speciality (a backend agent for
        // a frontend task) comes after any agent that fits, also one that waits for its person.
        fits(b) - fits(a) ||
        selfStarting(b) - selfStarting(a) ||
        cheapness(a) - cheapness(b) ||
        b.total - a.total ||
        a.agent_key.localeCompare(b.agent_key),
    );
  const best = scores.find((s) => s.eligible);
  if (!best) {
    // Only agents that work in the project folder are free: it waits for one with a folder of its own.
    const held = scores.some((s) => s.reason === SHARED_FOLDER);
    return {
      task_id: task.task_id,
      agent_key: null,
      reason: held
        ? 'waits: it shares files with a task that is running, so it goes to an agent Friday starts in a folder of its own, and none is free'
        : 'no available agent; the task stays claimable',
      scores,
    };
  }
  const top = Math.max(...scores.filter((s) => s.eligible).map((s) => s.total));
  const cls = classOf.get(best.agent_id) ?? 'standard';
  if (waits.get(best.agent_id)) {
    return {
      task_id: task.task_id,
      agent_key: best.agent_key,
      reason: `no agent that starts by itself is free: kept for ${best.agent_key}, which takes it when its person prompts it (score ${best.total})`,
      scores,
    };
  }
  const passedOver = scores.some((s) => s.eligible && waits.get(s.agent_id) && s.total > best.total);
  const cheaper =
    small && scores.some((s) => s.eligible && ofRole(s) === ofRole(best) && cheapness(s) > cheapness(best));
  return {
    task_id: task.task_id,
    agent_key: best.agent_key,
    reason: cheaper
      ? `a small, low-risk task: the cheapest capable agent (${cls}), ${best.agent_key}, score ${best.total}`
      : passedOver
        ? `${best.agent_key} starts by itself (score ${best.total}); an agent that waits for its person is asked only when none does`
        : best.total < top
          ? `the role it names (${task.role}): the highest score among its agents ${best.total} (${best.agent_key})`
          : `highest score ${best.total} (${best.agent_key})`,
    scores,
  };
}
