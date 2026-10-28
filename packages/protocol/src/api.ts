import { z } from 'zod';
import {
  AgentStatus,
  AttachMode,
  EnforcementLevel,
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
  /** Only this agent may claim the task while it is READY (set by `--assign` before a session exists). */
  reserved_for_agent_key: z.string().nullable(),
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
});
export type RunView = z.infer<typeof RunView>;

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

export const VerificationView = z.object({
  verification_id: z.string(),
  task_id: z.string(),
  run_id: z.string().nullable(),
  status: VerificationStatus,
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  summary: z.string().nullable(),
  checks: z.array(
    z.object({
      name: z.string(),
      kind: z.string(),
      status: VerificationStatus,
      exit_code: z.number().int().nullable(),
      artifact_ref: z.string().nullable(),
      summary: z.string().nullable(),
    }),
  ),
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
