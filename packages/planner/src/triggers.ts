import type { EscalationReason } from './escalate.js';

/**
 * When the Master Brain acts (spec Part 03 §4, §12): it is invoked by events, never runs
 * continuously, and most reactions need no model call. This table is the whole policy.
 *
 * Coordination actions (`ready_dependents`, `check_goal`, `delegate`, `release_lost`) only say
 * that coordination is due: the Master Brain derives them from the current state on every pass,
 * so none can be lost (review F05). The others become durable jobs.
 */

export type BrainAction =
  | { kind: 'plan'; goal_id: string }
  | { kind: 'auto_approve'; plan_id: string; version: number }
  | { kind: 'ready_dependents'; task_id: string }
  | { kind: 'check_goal'; goal_id: string }
  | { kind: 'delegate' }
  | {
      kind: 'replan';
      goal_id: string;
      reason: string;
      task_id: string | null;
      /** Replace a proposal that is still waiting (a human answered the question it asked). */
      force?: boolean;
      /** The escalation whose answer this revision takes into account. */
      escalation_id?: string;
    }
  | { kind: 'after_rejection'; goal_id: string; plan_id: string; version: number; note: string | null }
  | { kind: 'classify_role'; goal_id: string | null; task_id: string; decision_id: string }
  | { kind: 'escalate'; goal_id: string | null; task_id: string | null; reason: EscalationReason; detail: string }
  | { kind: 'release_lost'; harness_id: string };

export interface TriggerEvent {
  type: string;
  actor: { kind: string; id: string };
  payload: Record<string, unknown>;
}

export interface TriggerFacts {
  /** The goal of a plan task, or null for tasks outside any plan. */
  goalOf(taskId: string): string | null;
  /** Verification failures recorded for the task, including this one. */
  failuresOf(taskId: string): number;
  /** Revisions proposed after the first plan of the goal. */
  replansOf(goalId: string): number;
  /**
   * For an escalation the Master Brain raised: its goal, and whether the answer calls for a new
   * proposal (a planning problem, or a question whose proposal is still undecided). Otherwise the
   * answer is a decision agents see in their context, and nothing is replanned.
   */
  brainEscalation(escalationId: string): { goal_id: string; replan: boolean; force: boolean } | null;
  /** The goal a plan belongs to. */
  goalOfPlan(planId: string): string | null;
  /** Whether this task already had a role-classifier job (so a clarification is not asked again). */
  roleClassificationAttempted(taskId: string): boolean;
  planner: { available: boolean; reason: string };
  limits: { escalateAfterFailures: number; maxReplans: number; autoApprove: boolean };
}

const transitionTo = (e: TriggerEvent) => (e.payload.transition as { to?: string } | undefined)?.to;

/**
 * What a verification failure leads to, checked when the event arrives and again when the job
 * runs (the facts may have changed while it waited): an escalation after repeated failures or
 * at the revision limit, or without a planner; otherwise a revision.
 */
export function failureAction(task_id: string, goal_id: string, f: TriggerFacts): BrainAction {
  const failures = f.failuresOf(task_id);
  if (failures >= f.limits.escalateAfterFailures) {
    return {
      kind: 'escalate',
      goal_id,
      task_id,
      reason: 'repeated_verification_failures',
      detail: `${task_id} failed verification ${failures} times`,
    };
  }
  if (f.replansOf(goal_id) >= f.limits.maxReplans) {
    return {
      kind: 'escalate',
      goal_id,
      task_id,
      reason: 'replan_limit',
      detail: `the plan was already revised ${f.limits.maxReplans} times`,
    };
  }
  if (!f.planner.available) {
    return { kind: 'escalate', goal_id, task_id, reason: 'planner_unavailable', detail: f.planner.reason };
  }
  return { kind: 'replan', goal_id, task_id, reason: 'verification failed' };
}

export function triggersFor(e: TriggerEvent, f: TriggerFacts): BrainAction[] {
  const p = e.payload;
  switch (e.type) {
    case 'goal.created': {
      const goal_id = String((p.goal as { goal_id: string }).goal_id);
      if (p.plan_requested === false) return [];
      return f.planner.available
        ? [{ kind: 'plan', goal_id }]
        : [{ kind: 'escalate', goal_id, task_id: null, reason: 'planner_unavailable', detail: f.planner.reason }];
    }
    case 'task.role_resolved': {
      // Only a genuinely blocked contract needs the decision model (R3). Plan/task/human roles and
      // deterministic fallbacks are already resolved, and a proposal is waiting for a human.
      const decision = p.decision as { status?: string; decision_id?: string } | undefined;
      if (decision?.status !== 'blocked' || !decision.decision_id || !f.planner.available) return [];
      const task_id = String(p.task_id);
      if (f.roleClassificationAttempted(task_id)) return [];
      return [{ kind: 'classify_role', goal_id: f.goalOf(task_id), task_id, decision_id: decision.decision_id }];
    }
    case 'plan.proposed': {
      const plan = p.plan as { plan_id: string; version: number; needs_human?: unknown };
      return f.limits.autoApprove && !plan.needs_human
        ? [{ kind: 'auto_approve', plan_id: plan.plan_id, version: plan.version }]
        : [];
    }
    case 'plan.approved':
    case 'task.released':
    case 'task.reservation_released':
    case 'harness.registered':
    // Laya answered, or did not in time: the task that waited for it can be routed (review F11).
    case 'laya.answered':
    case 'laya.unavailable':
    // A human resumed Friday: delegation, and the planning lane, start again (plan M9 §5.5).
    case 'control.resumed':
      return [{ kind: 'delegate' }];
    case 'plan.rejected': {
      const plan_id = String(p.plan_id);
      const goal_id = typeof p.goal_id === 'string' ? p.goal_id : f.goalOfPlan(plan_id);
      if (!goal_id) return [];
      return [
        {
          kind: 'after_rejection',
          goal_id,
          plan_id,
          version: Number(p.version),
          note: typeof p.note === 'string' ? p.note : null,
        },
      ];
    }
    case 'agent.status_changed':
      return transitionTo(e) === 'AVAILABLE' ? [{ kind: 'delegate' }] : [];
    case 'harness.status_changed':
      return transitionTo(e) === 'TERMINATED'
        ? [{ kind: 'release_lost', harness_id: String(p.harness_id) }, { kind: 'delegate' }]
        : [];
    case 'task.completed': {
      const task_id = String(p.task_id);
      const goal_id = f.goalOf(task_id);
      if (!goal_id) return [];
      return [{ kind: 'ready_dependents', task_id }, { kind: 'check_goal', goal_id }, { kind: 'delegate' }];
    }
    // A task's verified work reached its goal branch (ADR-0025): its dependents may start from it,
    // and the goal may be done.
    case 'integration.completed':
    case 'integration.not_needed': {
      const i = p.integration as { task_id?: string; goal_id?: string } | undefined;
      if (!i?.task_id || !i.goal_id) return [];
      return [
        { kind: 'ready_dependents', task_id: i.task_id },
        { kind: 'check_goal', goal_id: i.goal_id },
        { kind: 'delegate' },
      ];
    }
    case 'task.failed': {
      const task_id = String(p.task_id);
      const goal_id = f.goalOf(task_id);
      if (!goal_id) return [];
      return [failureAction(task_id, goal_id, f)];
    }
    case 'task.cancelled': {
      const task_id = String(p.task_id);
      const goal_id = f.goalOf(task_id);
      // The Master Brain's own drops are part of a revision, not a reason for another one.
      if (!goal_id || e.actor.kind === 'master_brain') return [];
      if (!f.planner.available || f.replansOf(goal_id) >= f.limits.maxReplans) return [{ kind: 'check_goal', goal_id }];
      return [
        { kind: 'replan', goal_id, task_id, reason: 'a task was cancelled by a human' },
        { kind: 'check_goal', goal_id },
      ];
    }
    case 'escalation.answered': {
      // Friday closed the question because its task moved on; nothing to plan again (LESSONS D-50).
      if (p.moot === true) return [];
      const escalation_id = String(p.escalation_id);
      const raised = f.brainEscalation(escalation_id);
      if (!raised?.replan || !f.planner.available) return [];
      return [
        {
          kind: 'replan',
          goal_id: raised.goal_id,
          task_id: null,
          reason: 'a human answered the Master Brain',
          escalation_id,
          ...(raised.force ? { force: true } : {}),
        },
      ];
    }
    default:
      return [];
  }
}
