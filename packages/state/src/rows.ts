import { fromJson } from '@friday/db';
import type {
  ActorKind,
  AgentView,
  HarnessView,
  RunView,
  TaskScope,
  TaskView,
  VerificationView,
} from '@friday/protocol';

export interface TaskRow {
  task_id: string;
  project_id: string;
  goal_id: string | null;
  plan_id: string | null;
  kind: string;
  summary: string;
  description: string | null;
  acceptance_criteria_json: string;
  status: string;
  waiting_reason: string | null;
  priority: string;
  risk_level: string;
  scope_json: string | null;
  reserved_for_agent_key: string | null;
  assigned_agent_id: string | null;
  assigned_harness_id: string | null;
  current_run_id: string | null;
  created_by_kind: string;
  created_by_id: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  last_event_sequence: number;
  revision: number;
}

export interface RunRow {
  run_id: string;
  project_id: string;
  task_id: string;
  harness_id: string;
  agent_id: string;
  attempt: number;
  status: string;
  outcome: string | null;
  session_ref: string | null;
  claim_json: string | null;
  observed_paths_json: string;
  created_at: string;
  accepted_at: string | null;
  suspended_at: string | null;
  ended_at: string | null;
}

export interface HarnessRow {
  harness_id: string;
  project_id: string;
  harness_key: string;
  vendor: string;
  name: string;
  version: string | null;
  attach_mode: string;
  protocol_version: string;
  capabilities_json: string;
  status: string;
  enforcement_level: string | null;
  shadow: number;
  requested_agent_key: string | null;
  host_pid: number | null;
  host_session_id: string | null;
  host_cwd: string | null;
  registered_at: string;
  disconnected_at: string | null;
  terminated_at: string | null;
  updated_at: string;
  lease_expires_at?: string | null;
  last_heartbeat_at?: string | null;
}

export interface AgentRow {
  agent_id: string;
  project_id: string;
  agent_key: string;
  harness_id: string | null;
  role: string;
  display_name: string | null;
  status: string;
  current_task_id: string | null;
  current_run_id: string | null;
  registered_at: string;
  updated_at: string;
  harness_shadow?: number | null;
}

export function toTaskView(row: TaskRow, dependencies: string[]): TaskView {
  return {
    task_id: row.task_id,
    project_id: row.project_id,
    goal_id: row.goal_id,
    plan_id: row.plan_id,
    kind: row.kind as TaskView['kind'],
    summary: row.summary,
    description: row.description,
    acceptance_criteria: fromJson<string[]>(row.acceptance_criteria_json, []),
    status: row.status as TaskView['status'],
    waiting_reason: row.waiting_reason as TaskView['waiting_reason'],
    priority: row.priority as TaskView['priority'],
    risk_level: row.risk_level as TaskView['risk_level'],
    scope: fromJson<TaskScope | null>(row.scope_json, null),
    dependencies,
    reserved_for_agent_key: row.reserved_for_agent_key,
    assigned_agent_id: row.assigned_agent_id,
    assigned_harness_id: row.assigned_harness_id,
    current_run_id: row.current_run_id,
    created_by: { kind: row.created_by_kind as ActorKind, id: row.created_by_id },
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    cancelled_at: row.cancelled_at,
    revision: row.revision,
  };
}

export function toRunView(row: RunRow): RunView {
  return {
    run_id: row.run_id,
    task_id: row.task_id,
    harness_id: row.harness_id,
    agent_id: row.agent_id,
    attempt: row.attempt,
    status: row.status as RunView['status'],
    outcome: row.outcome as RunView['outcome'],
    session_ref: row.session_ref,
    observed_paths: fromJson<string[]>(row.observed_paths_json, []),
    claim: fromJson<unknown>(row.claim_json, null),
    created_at: row.created_at,
    accepted_at: row.accepted_at,
    ended_at: row.ended_at,
  };
}

export function toHarnessView(row: HarnessRow): HarnessView {
  return {
    harness_id: row.harness_id,
    harness_key: row.harness_key,
    vendor: row.vendor as HarnessView['vendor'],
    name: row.name,
    version: row.version,
    attach_mode: row.attach_mode as HarnessView['attach_mode'],
    protocol_version: row.protocol_version,
    status: row.status as HarnessView['status'],
    enforcement_level: row.enforcement_level as HarnessView['enforcement_level'],
    host_pid: row.host_pid,
    host_session_id: row.host_session_id,
    capabilities: fromJson<Record<string, unknown>>(row.capabilities_json, {}),
    registered_at: row.registered_at,
    updated_at: row.updated_at,
    lease_expires_at: row.lease_expires_at ?? null,
    last_heartbeat_at: row.last_heartbeat_at ?? null,
  };
}

export function toAgentView(row: AgentRow): AgentView {
  return {
    agent_id: row.agent_id,
    agent_key: row.agent_key,
    role: row.role,
    status: row.status as AgentView['status'],
    shadow: Boolean(row.harness_shadow),
    harness_id: row.harness_id,
    current_task_id: row.current_task_id,
    current_run_id: row.current_run_id,
    updated_at: row.updated_at,
  };
}

export interface VerificationRow {
  verification_id: string;
  task_id: string;
  run_id: string | null;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  summary: string | null;
}

export interface CheckRow {
  name: string;
  kind: string;
  status: string;
  exit_code: number | null;
  artifact_ref: string | null;
  summary: string | null;
}

export function toVerificationView(row: VerificationRow, checks: CheckRow[]): VerificationView {
  return {
    verification_id: row.verification_id,
    task_id: row.task_id,
    run_id: row.run_id,
    status: row.status as VerificationView['status'],
    started_at: row.started_at,
    ended_at: row.ended_at,
    summary: row.summary,
    checks: checks.map((c) => ({ ...c, status: c.status as VerificationView['status'] })),
  };
}
