import type { EscalationReason } from './escalate.js';

/**
 * When the Master Brain acts (spec Part 03 §4, §12): it is invoked by events, never runs
 * continuously, and most reactions need no model call. This table is the whole policy.
 */

export type BrainAction =
  | { kind: 'plan'; goal_id: string }
  | { kind: 'auto_approve'; plan_id: string; version: number }
  | { kind: 'ready_dependents'; task_id: string }
  | { kind: 'check_goal'; goal_id: string }
  | { kind: 'delegate' }
  | { kind: 'replan'; goal_id: string; reason: string; task_id: string | null }
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
  brainEscalation(escalationId: string): { goal_id: string; replan: boolean } | null;
  planner: { available: boolean; reason: string };
  limits: { escalateAfterFailures: number; maxReplans: number; autoApprove: boolean };
}

const transitionTo = (e: TriggerEvent) => (e.payload.transition as { to?: string } | undefined)?.to;

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
    case 'plan.proposed': {
      const plan = p.plan as { plan_id: string; version: number; needs_human?: unknown };
      return f.limits.autoApprove && !plan.needs_human
        ? [{ kind: 'auto_approve', plan_id: plan.plan_id, version: plan.version }]
        : [];
    }
    case 'plan.approved':
    case 'task.released':
    case 'harness.registered':
      return [{ kind: 'delegate' }];
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
    case 'task.failed': {
      const task_id = String(p.task_id);
      const goal_id = f.goalOf(task_id);
      if (!goal_id) return [];
      const failures = f.failuresOf(task_id);
      if (failures >= f.limits.escalateAfterFailures) {
        return [
          {
            kind: 'escalate',
            goal_id,
            task_id,
            reason: 'repeated_verification_failures',
            detail: `${task_id} failed verification ${failures} times`,
          },
        ];
      }
      if (f.replansOf(goal_id) >= f.limits.maxReplans) {
        return [
          {
            kind: 'escalate',
            goal_id,
            task_id,
            reason: 'replan_limit',
            detail: `the plan was already revised ${f.limits.maxReplans} times`,
          },
        ];
      }
      if (!f.planner.available) {
        return [{ kind: 'escalate', goal_id, task_id, reason: 'planner_unavailable', detail: f.planner.reason }];
      }
      return [{ kind: 'replan', goal_id, task_id, reason: 'verification failed' }];
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
      const raised = f.brainEscalation(String(p.escalation_id));
      if (!raised?.replan || !f.planner.available) return [];
      return [{ kind: 'replan', goal_id: raised.goal_id, task_id: null, reason: 'a human answered the Master Brain' }];
    }
    default:
      return [];
  }
}
