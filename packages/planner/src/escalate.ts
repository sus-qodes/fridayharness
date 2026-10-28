/**
 * Human escalation (spec Part 03 §11): the UI must explain what is blocked, why, who requested
 * it, what capability is needed, the proposed action, and the evidence that exists.
 */

export type EscalationReason =
  | 'ambiguous_intent'
  | 'repeated_verification_failures'
  | 'replan_limit'
  | 'planner_unavailable'
  | 'invalid_plan'
  | 'budget_exceeded'
  /** A human rejected a revision while failed tasks still wait for a decision (review F05). */
  | 'plan_rejected'
  /** A Master Brain action kept failing after its retries (review F05). */
  | 'action_failed';

export interface EscalationDetails {
  blocked: string;
  why: string;
  requested_by: string;
  capability: string;
  proposed_action: string;
  evidence: string[];
}

export interface Escalation {
  reason: EscalationReason;
  goal_id: string | null;
  task_id: string | null;
  question: string;
  options: string[];
  details: EscalationDetails;
}

const CAPABILITY: Record<EscalationReason, string> = {
  ambiguous_intent: 'human.decision',
  repeated_verification_failures: 'human.decision',
  replan_limit: 'human.decision',
  planner_unavailable: 'model.remote_call',
  invalid_plan: 'human.decision',
  budget_exceeded: 'model.budget',
  plan_rejected: 'human.decision',
  action_failed: 'human.decision',
};

export function buildEscalation(input: {
  reason: EscalationReason;
  goal_id: string | null;
  task_id?: string | null;
  blocked: string;
  why: string;
  question: string;
  options?: string[];
  proposed_action: string;
  evidence?: string[];
}): Escalation {
  return {
    reason: input.reason,
    goal_id: input.goal_id,
    task_id: input.task_id ?? null,
    question: input.question,
    options: (input.options ?? []).slice(0, 4),
    details: {
      blocked: input.blocked,
      why: input.why,
      requested_by: 'master_brain',
      capability: CAPABILITY[input.reason],
      proposed_action: input.proposed_action,
      evidence: (input.evidence ?? []).slice(0, 10).map((e) => e.slice(0, 500)),
    },
  };
}
