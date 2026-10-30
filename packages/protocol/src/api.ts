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
  /** The task contract's role, if it has one (R2; routing still canonicalizes aliases). */
  role: z.string().trim().min(1).max(64).optional(),
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

/** Where a task's execution role came from (R2). */
export const TaskRoleSource = z.enum([
  'plan',
  'task',
  'human',
  'decision_model',
  'kind_fallback',
  'path_fallback',
  'missing',
  'none',
]);
export type TaskRoleSource = z.infer<typeof TaskRoleSource>;

/** One node of a proposed multi-role work split. It is stored, never silently dispatched. */
export const ProposedRoleView = z.object({
  role: z.string(),
  task_summary: z.string(),
  depends_on: z.array(z.string()),
  confidence: z.number(),
});
export type ProposedRoleView = z.infer<typeof ProposedRoleView>;

export const TaskRoleDecisionView = z.object({
  decision_id: z.string(),
  project_id: z.string(),
  task_id: z.string(),
  status: z.enum(['resolved', 'proposed', 'blocked']),
  source: TaskRoleSource,
  role: z.string().nullable(),
  confidence: z.number().nullable(),
  roles: z.array(ProposedRoleView),
  assumptions: z.array(z.string()),
  missing_facts: z.array(z.string()),
  questions: z.array(z.string()),
  intent_version: z.string(),
  registry_version: z.string().nullable(),
  reason: z.string(),
  created_at: z.string(),
});
export type TaskRoleDecisionView = z.infer<typeof TaskRoleDecisionView>;

export const TaskRoleAssignRequest = z.object({
  role: z.string().trim().min(1).max(64),
});
export type TaskRoleAssignRequest = z.infer<typeof TaskRoleAssignRequest>;

export const TaskView = z.object({
  task_id: z.string(),
  project_id: z.string(),
  goal_id: z.string().nullable(),
  plan_id: z.string().nullable(),
  /** The plan version that created the task, and its key in that plan (M2; absent from M1 daemons). */
  plan_version: z.number().int().nullable().default(null),
  plan_key: z.string().nullable().default(null),
  /** The task contract's role ("backend", "qa", …); routing canonicalizes it for execution. */
  role: z.string().nullable().default(null),
  /** R2: the persisted role-resolution contract, stable for one intent and registry version. */
  role_source: TaskRoleSource.nullable().default(null),
  role_confidence: z.number().nullable().default(null),
  role_decision_id: z.string().nullable().default(null),
  role_intent_version: z.string().nullable().default(null),
  role_registry_version: z.string().nullable().default(null),
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
  /** The effective intent version the run started under (ADR-0034 §4); null for older runs. */
  intent_version: z.string().nullable().default(null),
  /** The model Friday routed the run to (ADR-0031 §6); binding when the harness applies it. */
  model_requested: z.string().nullable().default(null),
  model_binding: z.boolean().default(false),
  routing_decision_id: z.string().nullable().default(null),
  /** The model the host reported running, and how it knew (ADR-0031 §7). */
  model_observed: z.string().nullable().default(null),
  model_basis: z.string().nullable().default(null),
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

/**
 * One run of an operation by Friday's gateway (ADR-0029): the credential names it used, never
 * their values, and the outcome. The sanitized output is an artifact.
 */
export const OperationRunView = z.object({
  operation_run_id: z.string(),
  operation: z.string(),
  task_id: z.string(),
  run_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  status: z.enum(['running', 'passed', 'failed', 'interrupted']),
  /** The resolved binary, an absolute path. */
  binary: z.string(),
  cwd: z.string(),
  /** Names of the stored secrets the run received. */
  credentials: z.array(z.string()),
  approval_id: z.string().nullable(),
  risk: z.enum(['low', 'medium', 'high']),
  reason: z.string(),
  exit_code: z.number().int().nullable(),
  timed_out: z.boolean(),
  duration_ms: z.number().int().nullable(),
  /** Occurrences of a credential removed from the output. */
  redactions: z.number().int(),
  artifact_ref: z.string().nullable(),
  summary: z.string().nullable(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
});
export type OperationRunView = z.infer<typeof OperationRunView>;

/** Why a host failed an attempt, as its adapter or Friday classified it (ADR-0035 §3); never a work failure. */
export const HostFailureKind = z.enum(['start', 'auth', 'rate_limit', 'transport', 'timeout', 'runtime_unavailable']);
export type HostFailureKind = z.infer<typeof HostFailureKind>;
export const HostFailure = z.object({
  kind: HostFailureKind,
  /** When the host said it may be tried again, in seconds (a rate limit's reset). */
  retry_after_s: z.number().int().positive().max(86_400).optional(),
});
export type HostFailure = z.infer<typeof HostFailure>;

/** The host failure an earlier attempt of the task ended with, from the bench it recorded (ADR-0035 §4). */
export const FailoverFrom = z.object({
  run_id: z.string(),
  host: z.string(),
  model: z.string().nullable(),
  kind: HostFailureKind,
  detail: z.string().nullable(),
  /** Until when that host and model are benched; null when a human must clear it. */
  bench_until: z.string().nullable(),
});
export type FailoverFrom = z.infer<typeof FailoverFrom>;

/** One readiness check routing made for a candidate, in the order made (ADR-0035 §2). */
export const ReadinessCheckView = z.object({
  host: z.string(),
  model: z.string(),
  dispatchable: z.boolean(),
  reason: z.string(),
  bench_until: z.string().nullable(),
});
export type ReadinessCheckView = z.infer<typeof ReadinessCheckView>;

/** One routing decision (ADR-0031 §4–§6): what was chosen, why, from what, and how binding it is. */
export const RoutingDecisionView = z.object({
  decision_id: z.string(),
  task_id: z.string(),
  run_id: z.string().nullable(),
  harness_id: z.string().nullable(),
  /** `registry`: dispatch is registry-only. Kept for the stored decision and its event. */
  mode: z.string(),
  task_class: z.string(),
  model: z.string().nullable(),
  binding: z.boolean(),
  source: z.string(),
  reason: z.string(),
  reason_codes: z.array(z.string()),
  candidates: z.array(
    z.object({
      model: z.string(),
      score: z.number(),
      fit: z.number(),
      pass_rate: z.number().nullable(),
      samples: z.number().int(),
      cost: z.number().nullable(),
      reasons: z.array(z.string()),
    }),
  ),
  excluded: z.array(z.object({ model: z.string(), reason: z.string() })),
  constraints: z.array(z.string()),
  fallback_chain: z.array(z.object({ model: z.string().nullable(), reason: z.string() })),
  confidence: z.number().nullable(),
  pin_id: z.string().nullable(),
  role: z.string().nullable().default(null),
  role_source: TaskRoleSource.default('none'),
  role_confidence: z.number().nullable().default(null),
  role_decision_id: z.string().nullable().default(null),
  role_intent_version: z.string().nullable().default(null),
  role_registry_version: z.string().nullable().default(null),
  role_proposed: z.boolean().default(false),
  registry_version: z.string().nullable().default(null),
  selected_rank: z.number().int().nullable().default(null),
  selected_harness: z.string().nullable().default(null),
  decision_model: z.string().nullable().default(null),
  decision_confidence: z.number().nullable().default(null),
  failover_policy: z.enum(['host_failure', 'none']).default('none'),
  /** The readiness checks made (ADR-0035 §2); empty for a decision older than them. */
  readiness: z.array(ReadinessCheckView).default([]),
  /** The host failure the attempt before ended with, when one did (ADR-0035 §4). */
  failover_from: FailoverFrom.nullable().default(null),
  created_at: z.string(),
});
export type RoutingDecisionView = z.infer<typeof RoutingDecisionView>;

// ---------------------------------------------------------------- readiness (ADR-0035)

/** The stages Friday observes; `dispatchable` is computed from them and never stored. */
export const ReadinessEvidenceStage = z.enum([
  'detected',
  'configured',
  'handshake',
  'authenticated',
  'live_verified',
  'benched',
]);
export type ReadinessEvidenceStage = z.infer<typeof ReadinessEvidenceStage>;
export const ReadinessEvidenceStatus = z.enum(['passed', 'failed']);
export type ReadinessEvidenceStatus = z.infer<typeof ReadinessEvidenceStatus>;

/**
 * One observation of a host (and, where it matters, one model) on this machine (ADR-0035 §1):
 * never a credential or token. It counts until it expires, until a later observation of the same
 * stage replaces it, or until the session it came from ends.
 */
export const ReadinessEvidenceView = z.object({
  evidence_id: z.string(),
  project_id: z.string(),
  /** The harness vendor: `claude-code`, `codex`, `gemini`, `opencode`, `cursor`, `deepseek`, … */
  host: z.string(),
  /** The model the evidence is about; null for a host-level observation. */
  model: z.string().nullable(),
  stage: ReadinessEvidenceStage,
  status: ReadinessEvidenceStatus,
  checked_at: z.string(),
  /** When it stops counting; null means it does not expire on its own. */
  expires_at: z.string().nullable(),
  /** Where it came from: `harness.register`, `harness doctor`, `run:<run_id>`, a host failure, a human. */
  source: z.string(),
  /** The host or model version the check saw; null when unknown. */
  version: z.string().nullable(),
  /** A short, credential-free explanation. */
  detail: z.string().nullable(),
  /** The session it came from, when one did; its evidence ends with the session. */
  harness_id: z.string().nullable(),
  /** Set once it stopped counting before its expiry, and why. */
  ended_at: z.string().nullable(),
  ended_reason: z.string().nullable(),
});
export type ReadinessEvidenceView = z.infer<typeof ReadinessEvidenceView>;

/** Observations a host check made outside the daemon (`friday harness doctor <host>`), recorded through it. */
export const ReadinessRecordRequest = z.object({
  host: z.string().trim().min(1).max(40),
  version: z.string().trim().max(100).nullable().default(null),
  source: z.string().trim().min(1).max(100),
  stages: z
    .array(
      z.object({
        stage: ReadinessEvidenceStage.exclude(['benched']),
        status: ReadinessEvidenceStatus,
        model: z.string().trim().min(1).max(200).nullable().default(null),
        detail: z.string().trim().max(300).nullable().default(null),
      }),
    )
    .min(1)
    .max(12),
  /** How long the observations count, in seconds; at most 7 days. */
  ttl_s: z
    .number()
    .int()
    .positive()
    .max(7 * 86_400)
    .default(86_400),
});
export type ReadinessRecordRequest = z.input<typeof ReadinessRecordRequest>;

export const ReadinessStageView = z.object({
  stage: z.string(),
  /** `passed`, `failed`, `missing` (never observed and needed), `stale` (expired) or `unknown` (never observed, allowed). */
  status: z.string(),
  checked_at: z.string().nullable(),
  expires_at: z.string().nullable(),
  source: z.string().nullable(),
  detail: z.string().nullable(),
});
export type ReadinessStageView = z.infer<typeof ReadinessStageView>;

/** The loose-rule verdict for one host and model now (ADR-0035 §1), with where the ranking names them. */
export const ReadinessAssessmentView = z.object({
  host: z.string(),
  model: z.string().nullable(),
  /** A session of this host is connected to Friday now. */
  live: z.boolean(),
  stages: z.array(ReadinessStageView),
  dispatchable: z.boolean(),
  blocking: z.object({ stage: z.string(), status: z.string() }).nullable(),
  bench_until: z.string().nullable(),
  reason: z.string(),
  /** The roles whose ranking names this host and model, with the rank. */
  roles: z.array(z.object({ role: z.string(), rank: z.number().int() })),
});
export type ReadinessAssessmentView = z.infer<typeof ReadinessAssessmentView>;

/** `GET readiness`: every host and model the ranking names, and every host seen, as of `checked_at`. */
export const ReadinessReport = z.object({
  checked_at: z.string(),
  hosts: z.array(
    z.object({
      host: z.string(),
      live: z.boolean(),
      /** Sessions of this host connected now. */
      sessions: z.number().int(),
      /** Whether the ranking names this host at all. */
      ranked: z.boolean(),
      /** The host-level verdict (no model), then one per model the ranking names for it. */
      assessments: z.array(ReadinessAssessmentView),
    }),
  ),
});
export type ReadinessReport = z.infer<typeof ReadinessReport>;

/** A human's routing policy (spec Part 12 §11): a model for a scope, with source and expiry. */
export const RoutingPinView = z.object({
  pin_id: z.string(),
  scope: z.enum(['project', 'kind', 'role', 'task']),
  target: z.string().nullable(),
  model: z.string().nullable(),
  sensitive: z.boolean(),
  needs_vision: z.boolean(),
  until: z.string().nullable(),
  source: z.string(),
  note: z.string().nullable(),
  created_at: z.string(),
  revoked_at: z.string().nullable(),
});
export type RoutingPinView = z.infer<typeof RoutingPinView>;

/** Measured outcomes of one model for one task class (ADR-0031 §8). */
export const ModelEvidenceView = z.object({
  model: z.string(),
  task_class: z.string(),
  /** Measured: verified outcomes of runs the model was observed running, in the current cohort (review F15). */
  samples: z.number().int(),
  passed: z.number().int(),
  failed: z.number().int(),
  reworked: z.number().int(),
  /** Outcomes of runs where the model was only requested, never seen running: not measured. */
  assumed: z.number().int().default(0),
  /** Measured outcomes of other checks, another host version, or older than the window. */
  other_cohorts: z.number().int().default(0),
  median_duration_ms: z.number().int().nullable(),
});
export type ModelEvidenceView = z.infer<typeof ModelEvidenceView>;

/** `rebind` (review M7.1 R05): the task's work brought into a worktree of this clone, its state kept. */
export const RecoveryAction = z.enum(['reconnect', 'reassign', 'restart', 'rebind', 'needs_human', 'cancel']);
export type RecoveryAction = z.infer<typeof RecoveryAction>;

/** What Friday knows about a task's last attempt before it recovers it (ADR-0026 §1). */
export const RecoveryAssessment = z.object({
  task_id: z.string(),
  task_status: TaskStatus,
  waiting_reason: z.string().nullable(),
  /** Attempts that started work (accepted runs), the last one included. */
  attempts: z.number().int(),
  run: z
    .object({ run_id: z.string(), attempt: z.number().int(), status: z.string(), outcome: z.string().nullable() })
    .nullable(),
  harness: z
    .object({
      harness_id: z.string(),
      status: z.string(),
      agent_key: z.string().nullable(),
      last_heartbeat_at: z.string().nullable(),
      /** Until when a disconnected session may still come back and resume. */
      reconnect_until: z.string().nullable(),
      host_pid: z.number().int().nullable(),
      /** Whether its host process still runs on this machine (null: unknown). */
      process_alive: z.boolean().nullable(),
    })
    .nullable(),
  last_activity: z.object({ type: z.string(), at: z.string() }).nullable(),
  worktree: z
    .object({
      path: z.string(),
      branch: z.string(),
      exists: z.boolean(),
      base_commit: z.string().nullable(),
      head: z.string().nullable(),
      commits_since_base: z.number().int().nullable(),
      uncommitted: z.array(z.string()),
      /**
       * The worktree belongs to another clone of the project (a restored database, review F08):
       * this clone never writes it. `branch_here` is the task branch's commit in this clone, if any.
       */
      elsewhere: z.boolean().default(false),
      branch_here: z.string().nullable().default(null),
      /**
       * The uncommitted work a backup recorded in that worktree, restored into this clone under
       * `refs/friday/restored/<task>` (review F16): `reassign` brings it into a worktree here.
       */
      restored_here: z.string().nullable().default(null),
    })
    .nullable(),
  /**
   * Why earlier attempts' work is not in this clone, when it is not (review F16): their branch is
   * missing here, so a new attempt would not continue from it.
   */
  missing_code: z.string().nullable().default(null),
  /** Fatal agent errors of the task, and how often the latest one repeated. */
  errors: z.object({ total: z.number().int(), same_as_last: z.number().int(), last: z.string().nullable() }),
  /** Refs holding the preserved state of earlier attempts (`refs/friday/preserved/<task>/…`). */
  preserved: z.array(z.string()),
  options: z.array(
    z.object({ action: RecoveryAction, available: z.boolean(), recommended: z.boolean(), reason: z.string() }),
  ),
});
export type RecoveryAssessment = z.infer<typeof RecoveryAssessment>;

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
  /**
   * The exact content judged, as a git tree id (review F04): integration lands only this tree. Null
   * for manual results, checkouts outside git and older records.
   */
  tree: z.string().nullable().default(null),
  /** The version of the effective policy the work was judged by (review F03). */
  policy_version: z.string().nullable().default(null),
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

/** One line of intent (ADR-0034): a constraint, outcome, non-goal or definition-of-done item. */
const IntentLine = z.string().trim().min(1).max(300);
const IntentLines = z.array(IntentLine).max(12);

export const GoalCreateRequest = z.object({
  request: z.string().min(3).max(4000),
  constraints: IntentLines.default([]),
  outcomes: IntentLines.default([]),
  /** ADR-0034 §3: what this goal deliberately does not do, and what "done" means. */
  non_goals: IntentLines.default([]),
  definition_of_done: IntentLines.default([]),
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
  /** ADR-0034 §3: the human's non-goals and definition of done, and the planner's additions apart. */
  non_goals: z.array(z.string()).default([]),
  definition_of_done: z.array(z.string()).default([]),
  inferred_non_goals: z.array(z.string()).default([]),
  inferred_definition_of_done: z.array(z.string()).default([]),
  /** Starts at 1; every change to the objective or an intent list adds one (ADR-0034 §3). */
  intent_revision: z.number().int().positive().default(1),
  priority: Priority,
  status: GoalStatus,
  plan_id: z.string().nullable(),
  created_by: Actor,
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable(),
});
export type GoalView = z.infer<typeof GoalView>;

/** A human edit of a goal's intent (ADR-0034 §3); a field left out keeps its value. */
export const GoalIntentUpdateRequest = z.object({
  objective: z.string().trim().min(1).max(600).optional(),
  constraints: IntentLines.optional(),
  outcomes: IntentLines.optional(),
  non_goals: IntentLines.optional(),
  definition_of_done: IntentLines.optional(),
});
export type GoalIntentUpdateRequest = z.input<typeof GoalIntentUpdateRequest>;

// ---- ADR-0034: project intent and learning proposals ------------------------------------------

/** The rendered project intent stays small enough to include in every packet (ADR-0034 §1). */
export const PROJECT_INTENT_MAX_CHARS = 2000;

export const IntentItemSource = z.enum(['human', 'planner']);
export type IntentItemSource = z.infer<typeof IntentItemSource>;

/** One project-intent line with its provenance: who wrote it and, for a draft, where it came from. */
export const IntentItem = z.object({
  text: IntentLine,
  source: IntentItemSource,
  from_paths: z.array(z.string().min(1).max(300)).max(10).default([]),
});
export type IntentItem = z.infer<typeof IntentItem>;

/** A line as proposed: plain text, or text with the repository paths a draft drew it from. */
const IntentItemInput = z.union([
  IntentLine,
  z.object({ text: IntentLine, from_paths: z.array(z.string().min(1).max(300)).max(10).default([]) }),
]);

export const ProjectIntentProposeRequest = z.object({
  objective: z.string().trim().min(1).max(600),
  constraints: z.array(IntentItemInput).max(12).default([]),
  outcomes: z.array(IntentItemInput).max(12).default([]),
  non_goals: z.array(IntentItemInput).max(12).default([]),
  definition_of_done: z.array(IntentItemInput).max(12).default([]),
});
export type ProjectIntentProposeRequest = z.input<typeof ProjectIntentProposeRequest>;

export const ProjectIntentStatus = z.enum(['proposed', 'approved', 'rejected', 'superseded']);
export type ProjectIntentStatus = z.infer<typeof ProjectIntentStatus>;

/** One version of what the whole project is for. Only the newest approved version counts. */
export const ProjectIntentView = z.object({
  project_id: z.string(),
  version: z.number().int().positive(),
  status: ProjectIntentStatus,
  objective: z.string(),
  constraints: z.array(IntentItem),
  outcomes: z.array(IntentItem),
  non_goals: z.array(IntentItem),
  definition_of_done: z.array(IntentItem),
  /** Of the normalized content: equal intents have equal hashes, whatever their version. */
  content_hash: z.string(),
  proposed_by: Actor,
  decided_by: Actor.nullable(),
  decision_note: z.string().nullable(),
  created_at: z.string(),
  decided_at: z.string().nullable(),
});
export type ProjectIntentView = z.infer<typeof ProjectIntentView>;

/** The memory kinds a project learning may have (ADR-0034 §6). */
export const LearningKind = z.enum([
  'decision',
  'architecture',
  'constraint',
  'convention',
  'bug-pattern',
  'dependency',
  'operational-runbook',
  'human-preference',
  'learned-risk',
]);
export type LearningKind = z.infer<typeof LearningKind>;

export const LearningProposeRequest = z.object({
  kind: LearningKind,
  subject: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(4000),
  tags: z.array(z.string().trim().min(1).max(64)).max(12).default([]),
  /** Repository paths the learning is about; they let a later packet pick it for matching work. */
  paths: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
  /** The held task it comes from; defaults to the agent's current task. */
  task_id: z.string().optional(),
});
export type LearningProposeRequest = z.input<typeof LearningProposeRequest>;

export const LearningProposalStatus = z.enum(['proposed', 'promoted', 'rejected']);
export type LearningProposalStatus = z.infer<typeof LearningProposalStatus>;

/** What an agent asked the project to learn; it reaches other agents only once promoted (ADR-0034 §7). */
export const LearningProposalView = z.object({
  proposal_id: z.string(),
  project_id: z.string(),
  task_id: z.string(),
  run_id: z.string().nullable(),
  proposed_by: z.object({ agent_id: z.string(), agent_key: z.string() }),
  kind: LearningKind,
  subject: z.string(),
  content: z.string(),
  tags: z.array(z.string()),
  paths: z.array(z.string()),
  status: LearningProposalStatus,
  /** The project memory a promotion recorded. */
  memory_id: z.string().nullable(),
  decided_by: Actor.nullable(),
  decision_note: z.string().nullable(),
  created_at: z.string(),
  decided_at: z.string().nullable(),
});
export type LearningProposalView = z.infer<typeof LearningProposalView>;

/**
 * What Friday did for a goal (plan M12.7), counted from Friday's own records: the events that name
 * the goal's tasks, the usage reports of their attempts and the Master Brain's calls for the goal.
 * `GET goals/:gid` carries it as `summary`. Nothing in it is estimated, and a figure nobody
 * reported is null, never 0: a line built from it leaves such a figure out.
 */
export const GoalSummary = z.object({
  tasks: z.object({
    /** The goal's tasks except cancelled and abandoned ones. */
    total: z.number().int(),
    /** Those a verification passed (`verification.finished` with `PASSED`, each task once). */
    verified: z.number().int(),
  }),
  /** Completion claims a verification refused (`verification.finished` with `FAILED`). */
  claims_refused: z.number().int(),
  /** Tasks sent back for rework after a refused claim (`task.rework`). */
  reworked: z.number().int(),
  /** Actions that waited for a human's decision (`approval.requested`). */
  held_for_human: z.number().int(),
  /** Actions the policy refused (`policy.evaluated` with `deny`). */
  refused_by_policy: z.number().int(),
  /** Attempts whose session was lost (`task.harness_lost`). */
  sessions_lost: z.number().int(),
  /** Lost attempts whose task went on afterwards: it left HARNESS_LOST for work, not for cancellation. */
  sessions_recovered: z.number().int(),
  hosts: z.object({
    /** The attempts of the goal's tasks (accepted runs, as the usage report counts them). */
    attempts: z.number().int(),
    /** Attempts whose host sent a usage report at all. */
    reported: z.number().int(),
    /**
     * Input and output tokens as the hosts reported them, summed over the attempts that reported
     * either; each host's counters are kept as it counts them (Codex counts cached input inside
     * its input figure, Claude Code outside it). Null when no attempt reported.
     */
    tokens: z.number().int().nullable(),
    tokens_reporters: z.number().int(),
    /** The hosts' reported cost, summed over the attempts that named one; null when none did. */
    cost_usd: z.number().nullable(),
    cost_reporters: z.number().int(),
  }),
  planning: z.object({
    /** Friday's own model calls for the goal: its plans and revisions. */
    calls: z.number().int(),
    /** The known cost of those calls; null when no call's cost is known. */
    cost_usd: z.number().nullable(),
    /** Calls whose cost is unknown (no price for the model, an outcome the daemon did not see). */
    unknown_cost_calls: z.number().int(),
  }),
});
export type GoalSummary = z.infer<typeof GoalSummary>;

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

// ---- usage, the token baseline (M10a) ----------------------------------------------------------

/**
 * The tool calls a host reported for one attempt, grouped by what the tool does, so that "how
 * often did the model read a whole file" can be answered per attempt.
 */
export const UsageToolKinds = z.object({
  /** Read, Glob, Grep, LS and the like: the host looked at files. */
  read: z.number().int(),
  /** Edit, Write, NotebookEdit, fileChange: the host changed files. */
  edit: z.number().int(),
  /** Bash, PowerShell, commandExecution: the host ran a command. */
  shell: z.number().int(),
  /** WebFetch, WebSearch. */
  web: z.number().int(),
  /** Friday's own tools (`mcp__friday__*`). */
  friday: z.number().int(),
  other: z.number().int(),
});
export type UsageToolKinds = z.infer<typeof UsageToolKinds>;

/**
 * What the host said it spent on the attempt (its last `host.usage` event). A host that reports
 * nothing (an attached session, a plain harness) has `reported: false` and every number null: an
 * unknown value is never written as 0. `cap_usd` is Friday's, not the host's: the task's spending
 * cap the attempt reached, shown beside the cost that reached it.
 */
export const UsageHostView = z.object({
  reported: z.boolean(),
  input_tokens: z.number().int().nullable(),
  output_tokens: z.number().int().nullable(),
  cache_read_input_tokens: z.number().int().nullable(),
  cache_creation_input_tokens: z.number().int().nullable(),
  cost_usd: z.number().nullable(),
  /**
   * The task's spending cap the attempt reached (`routing.task_budget_usd`, plan M11.5, from the
   * run's `budget.exceeded`), whether Friday then ended it or its claim still arrived; null when
   * no cap was reached.
   */
  cap_usd: z.number().nullable(),
  turns: z.number().int().nullable(),
  /** The model the host named in its report. */
  model: z.string().nullable(),
});
export type UsageHostView = z.infer<typeof UsageHostView>;

/** One run attempt as the token baseline sees it: what it was given, what it spent, what it did, how it ended. */
export const UsageRowView = z.object({
  task_id: z.string(),
  task_summary: z.string(),
  goal_id: z.string().nullable(),
  run_id: z.string(),
  attempt: z.number().int(),
  agent_key: z.string().nullable(),
  /** Null when the harness record is gone. */
  harness_vendor: Vendor.nullable(),
  harness_mode: AttachMode.nullable(),
  model_requested: z.string().nullable(),
  model_observed: z.string().nullable(),
  model_basis: z.string().nullable(),
  /** The context packets delivered to this attempt, and their weight. */
  packets: z.object({
    count: z.number().int(),
    /** The sum of the packets' `budget.tokens`. */
    tokens: z.number().int(),
    /** The sum of the packets' `budget.chars`; null when no packet named its size in characters. */
    chars: z.number().int().nullable(),
    /** The sum of every source's `estimated_tokens` over every section. */
    source_tokens: z.number().int(),
  }),
  /**
   * The attempt's `context.request`s, counted by kind (`task`, `file`, `symbol`, …) as they were
   * asked, so a request the compiler refused counts too. For a log older than that record, the
   * packets that answered requests count instead.
   */
  context_requests: z.object({ count: z.number().int(), kinds: z.record(z.string(), z.number().int()) }),
  host: UsageHostView,
  tool_calls: z.object({
    total: z.number().int(),
    failed: z.number().int(),
    by_kind: UsageToolKinds,
    /**
     * Read calls of a whole file against those of a line range (`offset` or `limit` asked), as
     * the hooks recorded them; a host whose reads Friday does not see (Codex) shows 0 and 0.
     */
    reads: z.object({ whole_file: z.number().int(), ranged: z.number().int() }),
  }),
  /** The attempt's latest verification; null when nothing was verified yet. */
  verification: z
    .object({ status: VerificationStatus, checks_passed: z.number().int(), checks_total: z.number().int() })
    .nullable(),
  /** When the host accepted the attempt (or Friday created it, for a claim). */
  started_at: z.string(),
  ended_at: z.string().nullable(),
  /** Null while the attempt still runs. */
  duration_ms: z.number().int().nullable(),
});
export type UsageRowView = z.infer<typeof UsageRowView>;

/**
 * `GET /usage`: the rows and their totals. Each total sums only the attempts that reported that
 * field, and `reporters` says how many did, because a host may report some fields and not others
 * (an older report without the cache fields; an error result with a cost and no counts).
 */
export const UsageReport = z.object({
  rows: z.array(UsageRowView),
  totals: z.object({
    attempts: z.number().int(),
    /** Attempts whose host sent a usage report at all, whatever it carried. */
    host_reported: z.number().int(),
    /** Per total, the number of attempts whose reported value it sums; a share computed from two totals is sound only when their reporters match. */
    reporters: z.object({
      input_tokens: z.number().int(),
      output_tokens: z.number().int(),
      cache_read_input_tokens: z.number().int(),
      cache_creation_input_tokens: z.number().int(),
      cost_usd: z.number().int(),
    }),
    /** Null when no attempt reported the value. */
    input_tokens: z.number().int().nullable(),
    output_tokens: z.number().int().nullable(),
    cache_read_input_tokens: z.number().int().nullable(),
    cache_creation_input_tokens: z.number().int().nullable(),
    cost_usd: z.number().nullable(),
    /** Tool calls are counted from events, so this total is always known. */
    tool_calls: z.number().int(),
  }),
  /** True when the report holds only the newest `limit` attempts; a goal or task filter shows the rest. */
  truncated: z.boolean(),
  limit: z.number().int().nullable(),
});
export type UsageReport = z.infer<typeof UsageReport>;
