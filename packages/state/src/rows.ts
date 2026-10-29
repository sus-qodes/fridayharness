import { fromJson } from '@friday/db';
import type {
  ActorKind,
  AgentView,
  AssignmentView,
  DeliveryView,
  GoalView,
  HarnessView,
  MessageView,
  ModelCallView,
  PlanTaskView,
  PlanVersionView,
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
  plan_version: number | null;
  plan_key: string | null;
  role: string | null;
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
  reserved_by?: string | null;
  reserved_until?: string | null;
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
  execution_root: string | null;
  base_commit: string | null;
  branch_ref: string | null;
  workspace: string | null;
  model_requested?: string | null;
  model_binding?: number | null;
  routing_decision_id?: string | null;
  model_observed?: string | null;
  model_basis?: string | null;
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
  enforcement_status?: string | null;
  enforcement_basis?: string | null;
  adapter_version?: string | null;
  hooks_seen_at?: string | null;
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
    plan_version: row.plan_version ?? null,
    plan_key: row.plan_key ?? null,
    role: row.role ?? null,
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
    reserved_by: (row.reserved_by ?? null) as TaskView['reserved_by'],
    reserved_until: row.reserved_until ?? null,
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
    execution_root: row.execution_root ?? null,
    base_commit: row.base_commit ?? null,
    branch_ref: row.branch_ref ?? null,
    workspace: row.workspace === 'pending' ? 'pending' : 'ready',
    model_requested: row.model_requested ?? null,
    model_binding: Number(row.model_binding ?? 0) === 1,
    routing_decision_id: row.routing_decision_id ?? null,
    model_observed: row.model_observed ?? null,
    model_basis: row.model_basis ?? null,
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
    enforcement_status: (row.enforcement_status ?? null) as HarnessView['enforcement_status'],
    enforcement_basis: row.enforcement_basis ?? null,
    adapter_version: row.adapter_version ?? null,
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
  execution_root?: string | null;
  commit_sha?: string | null;
  source_version?: string | null;
  base_commit?: string | null;
  task_kind?: string | null;
  tree?: string | null;
  policy_version?: string | null;
}

export interface CheckRow {
  name: string;
  kind: string;
  status: string;
  exit_code: number | null;
  artifact_ref: string | null;
  summary: string | null;
  required?: number | null;
  origin?: string | null;
  duration_ms?: number | null;
  details_json?: string | null;
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
    execution_root: row.execution_root ?? null,
    commit_sha: row.commit_sha ?? null,
    source_version: row.source_version ?? null,
    base_commit: row.base_commit ?? null,
    task_kind: row.task_kind ?? null,
    tree: row.tree ?? null,
    policy_version: row.policy_version ?? null,
    checks: checks.map((c) => ({
      name: c.name,
      kind: c.kind,
      status: c.status as VerificationView['status'],
      exit_code: c.exit_code,
      artifact_ref: c.artifact_ref,
      summary: c.summary,
      required: c.required !== 0,
      origin: (c.origin ?? 'configured') as VerificationView['checks'][number]['origin'],
      duration_ms: c.duration_ms ?? null,
      details: c.details_json ? (JSON.parse(c.details_json) as VerificationView['checks'][number]['details']) : null,
    })),
  };
}

// ---- Master Brain (M2) ----------------------------------------------------------------------

export interface GoalRow {
  goal_id: string;
  project_id: string;
  request: string;
  objective: string | null;
  constraints_json: string;
  outcomes_json: string;
  inferred_constraints_json?: string;
  inferred_outcomes_json?: string;
  priority: string;
  status: string;
  plan_id: string | null;
  created_by_kind: string;
  created_by_id: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export function toGoalView(row: GoalRow): GoalView {
  return {
    goal_id: row.goal_id,
    project_id: row.project_id,
    request: row.request,
    objective: row.objective,
    constraints: fromJson<string[]>(row.constraints_json, []),
    outcomes: fromJson<string[]>(row.outcomes_json, []),
    inferred_constraints: fromJson<string[]>(row.inferred_constraints_json ?? '[]', []),
    inferred_outcomes: fromJson<string[]>(row.inferred_outcomes_json ?? '[]', []),
    priority: row.priority as GoalView['priority'],
    status: row.status as GoalView['status'],
    plan_id: row.plan_id,
    created_by: { kind: row.created_by_kind as ActorKind, id: row.created_by_id },
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  };
}

export interface PlanRow {
  plan_id: string;
  version: number;
  goal_id: string;
  status: string;
  supersedes: number | null;
  summary: string;
  rationale: string | null;
  needs_human_json: string | null;
  trigger: string;
  proposed_by_kind: string;
  proposed_by_id: string;
  model_call_id: string | null;
  prompt_version: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by_id: string | null;
  decision_note: string | null;
}

export interface PlanTaskRow {
  key: string;
  position: number;
  change: string;
  task_id: string | null;
  kind: string;
  summary: string;
  description: string | null;
  acceptance_criteria_json: string;
  depends_on_json: string;
  scope_json: string;
  role: string;
  priority: string;
  risk_level: string;
  note: string | null;
}

export function toPlanTaskView(row: PlanTaskRow): PlanTaskView {
  return {
    key: row.key,
    position: row.position,
    change: row.change as PlanTaskView['change'],
    task_id: row.task_id,
    kind: row.kind as PlanTaskView['kind'],
    summary: row.summary,
    description: row.description,
    acceptance_criteria: fromJson<string[]>(row.acceptance_criteria_json, []),
    depends_on: fromJson<string[]>(row.depends_on_json, []),
    scope: fromJson<TaskScope>(row.scope_json, { write: [], read: [] }),
    role: row.role,
    priority: row.priority as PlanTaskView['priority'],
    risk_level: row.risk_level as PlanTaskView['risk_level'],
    note: row.note,
  };
}

export function toPlanVersionView(row: PlanRow, tasks: PlanTaskRow[]): PlanVersionView {
  return {
    plan_id: row.plan_id,
    version: row.version,
    goal_id: row.goal_id,
    status: row.status as PlanVersionView['status'],
    supersedes: row.supersedes,
    summary: row.summary,
    rationale: row.rationale,
    needs_human: fromJson<PlanVersionView['needs_human']>(row.needs_human_json, null),
    trigger: row.trigger,
    proposed_by: { kind: row.proposed_by_kind as ActorKind, id: row.proposed_by_id },
    model_call_id: row.model_call_id,
    prompt_version: row.prompt_version,
    created_at: row.created_at,
    decided_at: row.decided_at,
    decided_by_id: row.decided_by_id,
    decision_note: row.decision_note,
    tasks: tasks.map(toPlanTaskView),
  };
}

export interface ModelCallRow extends Omit<ModelCallView, 'remote' | 'cost_usd'> {
  remote: number;
  cost_usd: number;
  /** 0 when the cost is unknown; `cost_usd` then holds 0 and the view shows null. */
  cost_known: number;
  project_id?: string;
}

export function toModelCallView(row: ModelCallRow): ModelCallView {
  const { cost_known, project_id: _project, ...rest } = row;
  return {
    ...rest,
    remote: Boolean(row.remote),
    cost_usd: cost_known ? row.cost_usd : null,
    cost_estimate_usd: row.cost_estimate_usd ?? null,
    cache_write_1h_input_tokens: row.cache_write_1h_input_tokens ?? 0,
  };
}

export interface AssignmentRow {
  assignment_id: string;
  task_id: string;
  agent_key: string | null;
  mode: string;
  reason: string;
  scores_json: string;
  created_at: string;
}

export function toAssignmentView(row: AssignmentRow): AssignmentView {
  return {
    assignment_id: row.assignment_id,
    task_id: row.task_id,
    agent_key: row.agent_key,
    mode: row.mode as AssignmentView['mode'],
    reason: row.reason,
    scores: fromJson<Record<string, unknown>[]>(row.scores_json, []),
    created_at: row.created_at,
  };
}

// ---- agent messaging (M3) ----------------------------------------------------------------------

export interface MessageRow {
  message_id: string;
  project_id: string;
  sender_kind: string;
  sender_id: string;
  sender_key: string | null;
  target: string;
  mode: string;
  subject: string | null;
  body: string;
  body_artifact_ref: string | null;
  facts_json: string;
  priority: string;
  blocking: number;
  task_id: string | null;
  goal_id: string | null;
  correlation_id: string;
  response_to: string | null;
  reply_by: string | null;
  expires_at: string;
  status: string;
  settled_reason: string | null;
  created_at: string;
  settled_at: string | null;
  escalated_at?: string | null;
  escalation_id?: string | null;
}

export interface DeliveryRow {
  delivery_id: string;
  project_id: string;
  message_id: string;
  recipient_kind: string;
  recipient_id: string;
  agent_id: string | null;
  agent_key?: string | null;
  state: string;
  attempts: number;
  reserved_by_harness: string | null;
  reserved_until: string | null;
  delivered_at: string | null;
  received_at: string | null;
  acknowledged_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  created_at: string;
}

export function toDeliveryView(row: DeliveryRow): DeliveryView {
  return {
    delivery_id: row.delivery_id,
    recipient_kind: row.recipient_kind as DeliveryView['recipient_kind'],
    recipient_id: row.recipient_id,
    agent_id: row.agent_id,
    agent_key: row.agent_key ?? null,
    state: row.state as DeliveryView['state'],
    attempts: row.attempts,
    delivered_at: row.delivered_at,
    acknowledged_at: row.acknowledged_at,
    ended_at: row.ended_at,
    end_reason: row.end_reason,
  };
}

export function toMessageView(row: MessageRow, deliveries: DeliveryRow[]): MessageView {
  return {
    message_id: row.message_id,
    correlation_id: row.correlation_id,
    sender: { kind: row.sender_kind, id: row.sender_id, agent_key: row.sender_key },
    target: row.target,
    mode: row.mode as MessageView['mode'],
    subject: row.subject,
    body: row.body,
    body_artifact_ref: row.body_artifact_ref,
    facts: fromJson<MessageView['facts']>(row.facts_json, []),
    priority: row.priority as MessageView['priority'],
    blocking: Boolean(row.blocking),
    task_id: row.task_id,
    goal_id: row.goal_id,
    response_to: row.response_to,
    reply_by: row.reply_by,
    expires_at: row.expires_at,
    status: row.status as MessageView['status'],
    settled_reason: row.settled_reason,
    created_at: row.created_at,
    settled_at: row.settled_at,
    deliveries: deliveries.map(toDeliveryView),
  };
}
