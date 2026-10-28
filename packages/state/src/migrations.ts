import type { Migration } from '@friday/db';
import { EVENT_MIGRATIONS } from '@friday/events';

/**
 * Domain tables (written only by the Projector, rebuilt by replay) and operational tables
 * (written directly, excluded from replay). Plan Appendix 1.
 */
export const STATE_MIGRATIONS: Migration[] = [
  {
    version: 2,
    name: 'core_entities',
    up: `
CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE harnesses (
  harness_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  harness_key TEXT NOT NULL,
  vendor TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT,
  attach_mode TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  enforcement_level TEXT,
  shadow INTEGER NOT NULL DEFAULT 0,
  requested_agent_key TEXT,
  host_pid INTEGER,
  host_session_id TEXT,
  host_cwd TEXT,
  registered_at TEXT NOT NULL,
  disconnected_at TEXT,
  terminated_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_harnesses_key ON harnesses(project_id, harness_key);
CREATE TABLE harness_sessions (
  project_id TEXT NOT NULL,
  vendor TEXT NOT NULL,
  host_session_id TEXT NOT NULL,
  harness_id TEXT NOT NULL,
  transcript_path TEXT,
  bound_at TEXT NOT NULL,
  PRIMARY KEY (project_id, vendor, host_session_id)
);
CREATE TABLE agents (
  agent_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  harness_id TEXT,
  role TEXT NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL,
  current_task_id TEXT,
  current_run_id TEXT,
  registered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, agent_key)
);
CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  goal_id TEXT,
  plan_id TEXT,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  description TEXT,
  acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  waiting_reason TEXT,
  priority TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  scope_json TEXT,
  reserved_for_agent_key TEXT,
  assigned_agent_id TEXT,
  assigned_harness_id TEXT,
  current_run_id TEXT,
  created_by_kind TEXT NOT NULL,
  created_by_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  last_event_sequence INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_tasks_project_status ON tasks(project_id, status);
CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id)
);
CREATE TABLE task_runs (
  run_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  harness_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  outcome TEXT,
  session_ref TEXT,
  claim_json TEXT,
  observed_paths_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  suspended_at TEXT,
  ended_at TEXT
);
CREATE INDEX ix_runs_task ON task_runs(task_id, attempt);
CREATE TABLE verification_runs (
  verification_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT,
  status TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  summary TEXT
);
CREATE TABLE verification_checks (
  check_id TEXT PRIMARY KEY,
  verification_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  artifact_ref TEXT,
  summary TEXT
);
CREATE TABLE approvals (
  approval_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT,
  run_id TEXT,
  requested_by_kind TEXT NOT NULL,
  requested_by_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  target TEXT,
  purpose TEXT,
  risk TEXT,
  status TEXT NOT NULL,
  decided_by_kind TEXT,
  decided_by_id TEXT,
  decided_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE escalations (
  escalation_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT,
  run_id TEXT,
  requested_by_id TEXT NOT NULL,
  question TEXT NOT NULL,
  options_json TEXT,
  status TEXT NOT NULL,
  answer TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT
);
CREATE TABLE context_packets (
  context_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT,
  recipient_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  state_version INTEGER NOT NULL,
  packet_json TEXT NOT NULL
);
CREATE VIEW v_task_board AS
  SELECT t.project_id, t.task_id, t.status, t.kind, t.priority, t.summary, t.waiting_reason, t.reserved_for_agent_key,
         a.agent_id, a.agent_key, a.status AS agent_status, h.harness_id, h.vendor, h.status AS harness_status,
         r.run_id, r.attempt, t.updated_at
  FROM tasks t
  LEFT JOIN agents a ON a.agent_id = t.assigned_agent_id
  LEFT JOIN harnesses h ON h.harness_id = t.assigned_harness_id
  LEFT JOIN task_runs r ON r.run_id = t.current_run_id;
`,
  },
  {
    version: 3,
    name: 'operational',
    up: `
CREATE TABLE idempotency_keys (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);
CREATE TABLE outbox_messages (
  message_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  harness_id TEXT NOT NULL,
  method TEXT NOT NULL,
  params_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','delivered','acked','expired')),
  attempts INTEGER NOT NULL DEFAULT 0,
  run_id TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  acked_at TEXT,
  expires_at TEXT NOT NULL,
  ack_result_json TEXT
);
CREATE INDEX ix_outbox_pending ON outbox_messages(harness_id, status, created_at);
CREATE TABLE harness_leases (
  harness_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  heartbeat_interval_ms INTEGER NOT NULL,
  lease_ttl_ms INTEGER NOT NULL,
  last_heartbeat_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL
);
CREATE TABLE credentials (
  credential_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  token_class TEXT NOT NULL CHECK (token_class IN ('operator','bootstrap','harness')),
  harness_id TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  issued_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_reason TEXT
);
CREATE TABLE daemon_instances (
  instance_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  port INTEGER NOT NULL,
  version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  stopped_at TEXT,
  stop_reason TEXT
);
CREATE TABLE audit_records (
  audit_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  decision TEXT NOT NULL,
  error_code TEXT,
  details_json TEXT
);
`,
  },
];

/** Every migration for a Friday project database, in order. */
export const ALL_MIGRATIONS: Migration[] = [...EVENT_MIGRATIONS, ...STATE_MIGRATIONS];

/** Domain tables cleared by a replay, children first. */
export const DOMAIN_TABLES = [
  'context_packets',
  'escalations',
  'approvals',
  'verification_checks',
  'verification_runs',
  'task_runs',
  'task_dependencies',
  'tasks',
  'agents',
  'harness_sessions',
  'harnesses',
  'projects',
] as const;
