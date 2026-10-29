import { z } from 'zod';
import {
  AgentStatus,
  AttachMode,
  EnforcementLevel,
  EnforcementStatus,
  HarnessStatus,
  Priority,
  RiskLevel,
  RunOutcome,
  RunStatus,
  TaskKind,
  TaskStatus,
  Vendor,
  VerificationStatus,
  WaitingReason,
} from './enums.js';
import { Actor } from './envelope.js';

/** Paths are project-relative POSIX globs (plan B19). */
export const TaskScope = z.object({
  write: z.array(z.string().min(1)).default([]),
  read: z.array(z.string().min(1)).default([]),
});
export type TaskScope = z.infer<typeof TaskScope>;

export const TaskCreateRequest = z.object({
  summary: z.string().min(1).max(500),
  kind: TaskKind.default('implementation'),
  description: z.string().max(20_000).optional(),
  acceptance_criteria: z.array(z.string().min(1).max(1000)).max(50).default([]),
  priority: Priority.default('normal'),
  risk_level: RiskLevel.default('low'),
  depends_on: z.array(z.string()).default([]),
  scope: TaskScope.optional(),
  /** Move PROPOSED → READY immediately. */
  ready: z.boolean().default(false),
  /** Assign to this agent key right away (implies ready). */
  assign_agent_key: z.string().min(1).max(64).optional(),
});
export type TaskCreateRequest = z.input<typeof TaskCreateRequest>;

export const TaskView = z.object({
  task_id: z.string(),
  project_id: z.string(),
  goal_id: z.string().nullable(),
  plan_id: z.string().nullable(),
  /** The plan version that created the task, and its key in that plan (M2; absent from M1 daemons). */
  plan_version: z.number().int().nullable().default(null),
  plan_key: z.string().nullable().default(null),
  /** The kind of agent the plan asked for ("backend", "qa", …). */
  role: z.string().nullable().default(null),
  kind: TaskKind,
  summary: z.string(),
  description: z.string().nullable(),
  acceptance_criteria: z.array(z.string()),
  status: TaskStatus,
  waiting_reason: WaitingReason.nullable(),
  priority: Priority,
  risk_level: RiskLevel,
  scope: TaskScope.nullable(),
  dependencies: z.array(z.string()),
  /** Only this agent may claim the task while it is READY. */
  reserved_for_agent_key: z.string().nullable(),
  /**
   * Who reserved it (review F08): a human (`task assign`; kept until a human changes it), the
   * Master Brain's delegation, or a rework for the agent that did the work. The last two expire
   * at `reserved_until`, or earlier when that agent's session ends.
   */
  reserved_by: z.enum(['human', 'master_brain', 'rework']).nullable().default(null),
  reserved_until: z.string().nullable().default(null),
  assigned_agent_id: z.string().nullable(),
  assigned_harness_id: z.string().nullable(),
  current_run_id: z.string().nullable(),
  created_by: Actor,
  created_at: z.string(),
  updated_at: z.string(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  cancelled_at: z.string().nullable(),
  revision: z.number().int(),
});
export type TaskView = z.infer<typeof TaskView>;

export const RunView = z.object({
  run_id: z.string(),
  task_id: z.string(),
  harness_id: z.string(),
  agent_id: z.string(),
  attempt: z.number().int(),
  status: RunStatus,
  outcome: RunOutcome.nullable(),
  session_ref: z.string().nullable(),
  observed_paths: z.array(z.string()),
  claim: z.unknown().nullable(),
  created_at: z.string(),
  accepted_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  /** The checkout the run works in (ADR-0014, ADR-0023); null while its worktree is being prepared. */
  execution_root: z.string().nullable(),
  base_commit: z.string().nullable(),
  branch_ref: z.string().nullable(),
  /** `pending` while Friday prepares the worktree, then `ready`. */
  workspace: z.enum(['pending', 'ready']),
});
export type RunView = z.infer<typeof RunView>;

/** A task worktree (ADR-0023). */
export const WorktreeView = z.object({
  worktree_id: z.string(),
  task_id: z.string(),
  path: z.string(),
  branch: z.string(),
  base_commit: z.string().nullable(),
  status: z.enum(['active', 'released', 'preserved', 'removed']),
  note: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type WorktreeView = z.infer<typeof WorktreeView>;

/**
 * An exclusive reservation of conflict-prone files for one task (ADR-0025 §1): a lockfile, a
 * migration folder, a shared contract. Not to be confused with a READY task reserved for an agent.
 */
export const FileReservationView = z.object({
  reservation_id: z.string(),
  task_id: z.string(),
  /** A project-relative path or glob, as configured in `reservations.required` or given by a human. */
  pattern: z.string(),
  status: z.enum(['active', 'released', 'expired']),
  /** Taken by a write through Friday's hooks, at verification, or by a human. */
  via: z.enum(['write', 'verification', 'human']),
  acquired_at: z.string(),
  ended_at: z.string().nullable(),
  note: z.string().nullable(),
});
export type FileReservationView = z.infer<typeof FileReservationView>;

/**
 * One attempt to bring a verified task branch into its goal branch (ADR-0025 §2–§5). The goal
 * branch only ever moves to a merge whose checks passed.
 */
export const IntegrationView = z.object({
  integration_id: z.string(),
  goal_id: z.string(),
  task_id: z.string(),
  status: z.enum(['integrated', 'conflicted', 'failed', 'not_needed']),
  /** The goal branch, `friday/goal-<goal_id>`. */
  branch: z.string().nullable(),
  /** The task branch commit that was integrated (the verified work). */
  task_commit: z.string().nullable(),
  /** The goal branch before, and after when integrated. */
  base_commit: z.string().nullable(),
  merged_commit: z.string().nullable(),
  conflicts: z.array(z.string()),
  checks: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      exit_code: z.number().int().nullable(),
      artifact_ref: z.string().nullable(),
      summary: z.string().nullable(),
    }),
  ),
  summary: z.string().nullable(),
  created_at: z.string(),
});
export type IntegrationView = z.infer<typeof IntegrationView>;

export const HarnessView = z.object({
  harness_id: z.string(),
  harness_key: z.string(),
  vendor: Vendor,
  name: z.string(),
  version: z.string().nullable(),
  attach_mode: AttachMode,
  protocol_version: z.string(),
  status: HarnessStatus,
  enforcement_level: EnforcementLevel.nullable(),
  enforcement_status: EnforcementStatus.nullable().default(null),
  /** What the level rests on, for humans ("Friday hooks from this session; Claude Code 2.1.296"). */
  enforcement_basis: z.string().nullable().default(null),
  /** Friday's adapter version; `version` is the host's own. */
  adapter_version: z.string().nullable().default(null),
  host_pid: z.number().int().nullable(),
  host_session_id: z.string().nullable(),
  capabilities: z.record(z.string(), z.unknown()),
  registered_at: z.string(),
  updated_at: z.string(),
  lease_expires_at: z.string().nullable(),
  last_heartbeat_at: z.string().nullable(),
});
export type HarnessView = z.infer<typeof HarnessView>;

export const AgentView = z.object({
  agent_id: z.string(),
  agent_key: z.string(),
  role: z.string(),
  status: AgentStatus,
  shadow: z.boolean(),
  harness_id: z.string().nullable(),
  current_task_id: z.string().nullable(),
  current_run_id: z.string().nullable(),
  updated_at: z.string(),
});
export type AgentView = z.infer<typeof AgentView>;

/** Something Friday's own checks found (ADR-0024 §3): the rule, how much it counts and the paths. */
export const VerificationFinding = z.object({
  rule: z.string(),
  severity: z.enum(['fail', 'warn', 'info']),
  message: z.string(),
  paths: z.array(z.string()),
});
export type VerificationFinding = z.infer<typeof VerificationFinding>;

export const VerificationCheckView = z.object({
  name: z.string(),
  kind: z.string(),
  status: VerificationStatus,
  exit_code: z.number().int().nullable(),
  artifact_ref: z.string().nullable(),
  summary: z.string().nullable(),
  /** An advisory check's failure does not fail the verification. */
  required: z.boolean(),
  /** `friday`: Friday's own check, which runs no project code; `targeted`: a configured check limited to related tests. */
  origin: z.enum(['friday', 'configured', 'targeted']),
  duration_ms: z.number().int().nullable(),
  details: z
    .object({ findings: z.array(VerificationFinding).optional(), files: z.array(z.string()).optional() })
    .nullable(),
});
export type VerificationCheckView = z.infer<typeof VerificationCheckView>;

export const VerificationView = z.object({
  verification_id: z.string(),
  task_id: z.string(),
  run_id: z.string().nullable(),
  status: VerificationStatus,
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  summary: z.string().nullable(),
  /**
   * What was verified (ADR-0024 §1): the checkout, its HEAD, its source version (HEAD plus a hash of
   * uncommitted content) and the run's base commit. Null for manual results and older records.
   */
  execution_root: z.string().nullable(),
  commit_sha: z.string().nullable(),
  source_version: z.string().nullable(),
  base_commit: z.string().nullable(),
  task_kind: z.string().nullable(),
  checks: z.array(VerificationCheckView),
});
export type VerificationView = z.infer<typeof VerificationView>;

export const VerifyRequest = z.object({
  /** Manual override: record this result instead of running the configured check. */
  result: z.enum(['passed', 'failed']).optional(),
  note: z.string().max(2000).optional(),
});
export type VerifyRequest = z.input<typeof VerifyRequest>;

export const TaskActionRequest = z.object({
  reason: z.string().max(2000).optional(),
  agent_key: z.string().max(64).optional(),
});
export type TaskActionRequest = z.input<typeof TaskActionRequest>;

// ---- Master Brain (M2, ADR-0013) ------------------------------------------------------------

export const GoalStatus = z.enum(['OPEN', 'ACTIVE', 'COMPLETED', 'CANCELLED']);
export type GoalStatus = z.infer<typeof GoalStatus>;
export const PlanStatus = z.enum(['PROPOSED', 'ACTIVE', 'SUPERSEDED', 'REJECTED', 'COMPLETED']);
export type PlanStatus = z.infer<typeof PlanStatus>;
export const PlanChange = z.enum(['new', 'keep', 'rework', 'drop']);
export type PlanChange = z.infer<typeof PlanChange>;

export const GoalCreateRequest = z.object({
  request: z.string().min(3).max(4000),
  constraints: z.array(z.string().min(1).max(300)).max(12).default([]),
  outcomes: z.array(z.string().min(1).max(300)).max(12).default([]),
  priority: Priority.default('normal'),
  /** Ask the Master Brain for a plan right away (default). False: a human will propose one. */
  plan: z.boolean().default(true),
});
export type GoalCreateRequest = z.input<typeof GoalCreateRequest>;

export const GoalView = z.object({
  goal_id: z.string(),
  project_id: z.string(),
  request: z.string(),
  objective: z.string().nullable(),
  /** The human's own constraints and outcomes: authoritative, never replaced by a model (review F07). */
  constraints: z.array(z.string()),
  outcomes: z.array(z.string()),
  /** What the planner added while normalizing the request; kept apart from the human's own. */
  inferred_constraints: z.array(z.string()).default([]),
  inferred_outcomes: z.array(z.string()).default([]),
  priority: Priority,
  status: GoalStatus,
  plan_id: z.string().nullable(),
  created_by: Actor,
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable(),
});
export type GoalView = z.infer<typeof GoalView>;

export const PlanTaskView = z.object({
  key: z.string(),
  position: z.number().int(),
  change: PlanChange,
  task_id: z.string().nullable(),
  kind: TaskKind,
  summary: z.string(),
  description: z.string().nullable(),
  acceptance_criteria: z.array(z.string()),
  depends_on: z.array(z.string()),
  scope: TaskScope,
  role: z.string(),
  priority: Priority,
  risk_level: RiskLevel,
  note: z.string().nullable(),
});
export type PlanTaskView = z.infer<typeof PlanTaskView>;

export const NeedsHumanView = z.object({ question: z.string(), why: z.string(), options: z.array(z.string()) });

export const PlanVersionView = z.object({
  plan_id: z.string(),
  version: z.number().int(),
  goal_id: z.string(),
  status: PlanStatus,
  supersedes: z.number().int().nullable(),
  summary: z.string(),
  rationale: z.string().nullable(),
  needs_human: NeedsHumanView.nullable(),
  trigger: z.string(),
  proposed_by: Actor,
  model_call_id: z.string().nullable(),
  prompt_version: z.string().nullable(),
  created_at: z.string(),
  decided_at: z.string().nullable(),
  decided_by_id: z.string().nullable(),
  decision_note: z.string().nullable(),
  tasks: z.array(PlanTaskView),
});
export type PlanVersionView = z.infer<typeof PlanVersionView>;

export const PlanDecisionRequest = z.object({ note: z.string().max(2000).optional() });
export type PlanDecisionRequest = z.input<typeof PlanDecisionRequest>;

export const ModelCallView = z.object({
  call_id: z.string(),
  goal_id: z.string().nullable(),
  plan_id: z.string().nullable(),
  purpose: z.string(),
  prompt_version: z.string(),
  provider: z.string(),
  model: z.string(),
  remote: z.boolean(),
  /** `interrupted`: the daemon stopped while the request was in flight, so its outcome is unknown. */
  status: z.enum(['ok', 'invalid', 'error', 'refused', 'interrupted']),
  error_code: z.string().nullable(),
  error: z.string().nullable(),
  attempt: z.number().int(),
  input_tokens: z.number().int(),
  output_tokens: z.number().int(),
  cache_creation_input_tokens: z.number().int(),
  cache_read_input_tokens: z.number().int(),
  cache_write_1h_input_tokens: z.number().int().default(0),
  /** Null when the cost is unknown (no price for the model, or a request whose outcome is uncertain). */
  cost_usd: z.number().nullable(),
  /** Worst-case estimate counted against the budget while the real cost is unknown (review F04). */
  cost_estimate_usd: z.number().nullable().default(null),
  latency_ms: z.number().int(),
  request_id: z.string().nullable(),
  created_at: z.string(),
});
export type ModelCallView = z.infer<typeof ModelCallView>;

export const AssignmentView = z.object({
  assignment_id: z.string(),
  task_id: z.string(),
  agent_key: z.string().nullable(),
  mode: z.enum(['assigned', 'reserved', 'waiting', 'none']),
  reason: z.string(),
  scores: z.array(z.record(z.string(), z.unknown())),
  created_at: z.string(),
});
export type AssignmentView = z.infer<typeof AssignmentView>;

// ---- agent messaging (M3, ADR-0017) ------------------------------------------------------------

export const MessageStatus = z.enum(['open', 'settled', 'expired']);
export type MessageStatus = z.infer<typeof MessageStatus>;

export const DeliveryView = z.object({
  delivery_id: z.string(),
  recipient_kind: z.enum(['agent', 'role', 'task', 'master_brain', 'human']),
  recipient_id: z.string(),
  agent_id: z.string().nullable(),
  agent_key: z.string().nullable(),
  state: z.enum(['queued', 'delivered', 'acknowledged', 'expired', 'dead', 'resolved']),
  attempts: z.number().int(),
  delivered_at: z.string().nullable(),
  acknowledged_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  end_reason: z.string().nullable(),
});
export type DeliveryView = z.infer<typeof DeliveryView>;

export const MessageView = z.object({
  message_id: z.string(),
  correlation_id: z.string(),
  sender: z.object({ kind: z.string(), id: z.string(), agent_key: z.string().nullable() }),
  target: z.string(),
  mode: z.enum(['request', 'response', 'notification']),
  subject: z.string().nullable(),
  body: z.string(),
  body_artifact_ref: z.string().nullable(),
  facts: z.array(z.object({ fact: z.string(), area: z.string().optional(), impact: z.string().optional() })),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  blocking: z.boolean(),
  task_id: z.string().nullable(),
  goal_id: z.string().nullable(),
  response_to: z.string().nullable(),
  reply_by: z.string().nullable(),
  expires_at: z.string(),
  status: MessageStatus,
  settled_reason: z.string().nullable(),
  created_at: z.string(),
  settled_at: z.string().nullable(),
  deliveries: z.array(DeliveryView),
});
export type MessageView = z.infer<typeof MessageView>;

/** A human sends a message (`friday say`). */
export const HumanMessageRequest = z.object({
  to: z.string().min(1).max(100),
  content: z.string().min(1).max(60_000),
  subject: z.string().min(1).max(200).optional(),
  reply_to: z.string().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
});
export type HumanMessageRequest = z.input<typeof HumanMessageRequest>;
