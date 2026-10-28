import { globsOverlap, matchesAny } from '@friday/policy';

/**
 * Delegation policy (spec Part 03 §10): a deterministic score, not a model call.
 *   score = 3·capability_fit + 2·context_fit + 1.5·reliability + 1·locality − 0.5·cost
 * Only available agents are eligible; ties go to the lower agent key, so the same state always
 * gives the same assignment.
 */

export interface DelegationTask {
  task_id: string;
  goal_id: string | null;
  role: string;
  write: string[];
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
  /** Relative model cost, 0 (cheapest) to 1; 0 until model routing (M7). */
  cost: number;
}

export interface ScoreParts {
  capability_fit: number;
  context_fit: number;
  availability: number;
  reliability: number;
  locality: number;
  conflict_risk: number;
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
  cost: 0.5,
} as const;

const round = (n: number) => Math.round(n * 1000) / 1000;

export function scoreCandidate(task: DelegationTask, c: DelegationCandidate): CandidateScore {
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
          : '';
  const parts: ScoreParts = {
    capability_fit,
    context_fit: round(context_fit),
    availability: why ? 0 : 1,
    reliability: round(reliability),
    locality,
    conflict_risk: 0,
    cost: c.cost,
  };
  const w = DELEGATION_WEIGHTS;
  const total = round(
    w.capability_fit * capability_fit +
      w.context_fit * parts.context_fit +
      w.reliability * parts.reliability +
      w.locality * locality -
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

/**
 * Picks an agent for one READY task. A task whose write scope overlaps a task that is running
 * now waits instead (single live writer until worktrees exist, plan B26).
 */
export function delegate(
  task: DelegationTask,
  candidates: DelegationCandidate[],
  runningWrites: string[][],
): DelegationDecision {
  // A read-only task (no write scope) never conflicts; a running task without a scope may write anywhere.
  if (task.write.length > 0 && runningWrites.some((w) => globsOverlap(w, task.write))) {
    return {
      task_id: task.task_id,
      agent_key: null,
      reason: 'waits: its write scope overlaps a task that is running',
      scores: [],
    };
  }
  const scores = candidates
    .map((c) => scoreCandidate(task, c))
    .sort(
      (a, b) => Number(b.eligible) - Number(a.eligible) || b.total - a.total || a.agent_key.localeCompare(b.agent_key),
    );
  const best = scores.find((s) => s.eligible);
  return best
    ? {
        task_id: task.task_id,
        agent_key: best.agent_key,
        reason: `highest score ${best.total} (${best.agent_key})`,
        scores,
      }
    : { task_id: task.task_id, agent_key: null, reason: 'no available agent; the task stays claimable', scores };
}
