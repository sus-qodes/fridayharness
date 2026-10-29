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

/** M2: goals, versioned plans, delegation decisions and model calls (ADR-0013). */
export const MASTER_BRAIN_MIGRATIONS: Migration[] = [
  {
    version: 4,
    name: 'goals_plans',
    up: `
CREATE TABLE goals (
  goal_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  request TEXT NOT NULL,
  objective TEXT,
  constraints_json TEXT NOT NULL DEFAULT '[]',
  outcomes_json TEXT NOT NULL DEFAULT '[]',
  priority TEXT NOT NULL,
  status TEXT NOT NULL,
  plan_id TEXT,
  created_by_kind TEXT NOT NULL,
  created_by_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX ix_goals_project ON goals(project_id, status);
CREATE TABLE plans (
  plan_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  status TEXT NOT NULL,
  supersedes INTEGER,
  summary TEXT NOT NULL,
  rationale TEXT,
  needs_human_json TEXT,
  trigger TEXT NOT NULL,
  proposed_by_kind TEXT NOT NULL,
  proposed_by_id TEXT NOT NULL,
  model_call_id TEXT,
  prompt_version TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by_id TEXT,
  decision_note TEXT,
  PRIMARY KEY (plan_id, version)
);
CREATE INDEX ix_plans_goal ON plans(goal_id, version);
CREATE TABLE plan_tasks (
  plan_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  key TEXT NOT NULL,
  project_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  change TEXT NOT NULL,
  task_id TEXT,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  description TEXT,
  acceptance_criteria_json TEXT NOT NULL,
  depends_on_json TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  role TEXT NOT NULL,
  priority TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  note TEXT,
  PRIMARY KEY (plan_id, version, key)
);
CREATE TABLE agent_assignments (
  assignment_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  agent_key TEXT,
  mode TEXT NOT NULL,
  reason TEXT NOT NULL,
  scores_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_assignments_task ON agent_assignments(task_id, created_at);
CREATE TABLE model_calls (
  call_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  goal_id TEXT,
  plan_id TEXT,
  purpose TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  remote INTEGER NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  error TEXT,
  attempt INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_creation_input_tokens INTEGER NOT NULL,
  cache_read_input_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  latency_ms INTEGER NOT NULL,
  request_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_model_calls_time ON model_calls(project_id, provider, created_at);
ALTER TABLE tasks ADD COLUMN plan_version INTEGER;
ALTER TABLE tasks ADD COLUMN plan_key TEXT;
ALTER TABLE tasks ADD COLUMN role TEXT;
ALTER TABLE escalations ADD COLUMN goal_id TEXT;
ALTER TABLE escalations ADD COLUMN kind TEXT;
ALTER TABLE escalations ADD COLUMN requested_by_kind TEXT;
ALTER TABLE escalations ADD COLUMN details_json TEXT;
-- Operational: how far the Master Brain has read the event log (excluded from replay).
CREATE TABLE brain_cursor (
  project_id TEXT PRIMARY KEY,
  last_sequence INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
];

/**
 * M1/M2 stabilization (review 2026-10-14, plan H.6): authoritative human requirements, expiring
 * reservations, evidence-based enforcement, unknown model costs, and durable Master Brain jobs.
 */
export const STABILIZATION_MIGRATIONS: Migration[] = [
  {
    version: 5,
    name: 'review_fixes',
    up: `
ALTER TABLE goals ADD COLUMN inferred_constraints_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE goals ADD COLUMN inferred_outcomes_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN reserved_by TEXT;
ALTER TABLE tasks ADD COLUMN reserved_until TEXT;
ALTER TABLE harnesses ADD COLUMN adapter_version TEXT;
ALTER TABLE harnesses ADD COLUMN enforcement_status TEXT;
ALTER TABLE harnesses ADD COLUMN enforcement_basis TEXT;
ALTER TABLE harnesses ADD COLUMN hooks_seen_at TEXT;
ALTER TABLE model_calls ADD COLUMN cache_write_1h_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE model_calls ADD COLUMN cost_known INTEGER NOT NULL DEFAULT 1;
ALTER TABLE model_calls ADD COLUMN cost_estimate_usd REAL;
-- Operational: what the Master Brain still has to do (excluded from replay). A trigger becomes a
-- job in the same transaction that moves the cursor past its event, so nothing is lost on a crash.
CREATE TABLE brain_jobs (
  job_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  goal_id TEXT,
  task_id TEXT,
  reason TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'waiting', 'calling', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  source_sequence INTEGER,
  not_before TEXT,
  call_estimate_usd REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_brain_jobs_open ON brain_jobs(project_id, dedupe_key) WHERE status IN ('pending', 'waiting');
CREATE INDEX ix_brain_jobs_status ON brain_jobs(project_id, status, created_at);
`,
  },
];

/** M3: agent messaging (ADR-0017) and durable event consumers. */
export const MESSAGING_MIGRATIONS: Migration[] = [
  {
    version: 6,
    name: 'messages',
    up: `
CREATE TABLE messages (
  message_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  sender_kind TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_key TEXT,
  target TEXT NOT NULL,
  mode TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  body_artifact_ref TEXT,
  facts_json TEXT NOT NULL DEFAULT '[]',
  priority TEXT NOT NULL,
  blocking INTEGER NOT NULL DEFAULT 0,
  task_id TEXT,
  goal_id TEXT,
  correlation_id TEXT NOT NULL,
  response_to TEXT,
  reply_by TEXT,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL,
  settled_reason TEXT,
  created_at TEXT NOT NULL,
  settled_at TEXT
);
CREATE INDEX ix_messages_project ON messages(project_id, created_at);
CREATE INDEX ix_messages_corr ON messages(project_id, correlation_id);
CREATE TABLE message_deliveries (
  delivery_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES messages(message_id),
  recipient_kind TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  agent_id TEXT,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  reserved_by_harness TEXT,
  reserved_until TEXT,
  delivered_at TEXT,
  received_at TEXT,
  acknowledged_at TEXT,
  ended_at TEXT,
  end_reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (message_id, recipient_kind, recipient_id)
);
CREATE INDEX ix_deliveries_recipient ON message_deliveries(project_id, recipient_kind, recipient_id, state);
CREATE INDEX ix_deliveries_agent ON message_deliveries(project_id, agent_id, state);
-- Operational: durable consumers of the event log and how far each has read (M3b; excluded from replay).
CREATE TABLE event_consumers (
  consumer_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  last_sequence INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (consumer_id, project_id)
);
`,
  },
];

/** M3b: unanswered blocking requests, and the Master Brain's cursor as a durable event consumer. */
export const CONSUMER_MIGRATIONS: Migration[] = [
  {
    version: 7,
    name: 'consumers_and_timeouts',
    up: `
ALTER TABLE messages ADD COLUMN escalated_at TEXT;
ALTER TABLE messages ADD COLUMN escalation_id TEXT;
INSERT OR IGNORE INTO event_consumers (consumer_id, project_id, last_sequence, updated_at)
  SELECT 'master-brain', project_id, last_sequence, updated_at FROM brain_cursor;
`,
  },
];

/**
 * M4c: scoped memory (ADR-0021). `memories` and `memory_links` are domain tables written by the
 * projector; the FTS5 index follows `memories` through triggers on every write path, replay and
 * snapshot restore included; `memory_usage` is operational (reuse counts).
 */
export const MEMORY_MIGRATIONS: Migration[] = [
  {
    version: 8,
    name: 'memory',
    up: `
CREATE TABLE memories (
  memory_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('project', 'team', 'agent', 'task', 'session')),
  scope_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  source_events_json TEXT NOT NULL DEFAULT '[]',
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  authority TEXT NOT NULL CHECK (authority IN ('human-approved', 'verified', 'system', 'agent')),
  verification_status TEXT NOT NULL CHECK (verification_status IN ('verified', 'unverified')),
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'retracted')),
  supersedes TEXT,
  superseded_by TEXT,
  needs_review INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_memories_subject ON memories(project_id, kind, subject_key, status);
CREATE INDEX ix_memories_scope ON memories(project_id, scope_type, scope_id, status);
CREATE TABLE memory_links (
  project_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('supersedes', 'contradicts')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, kind)
);
CREATE VIRTUAL TABLE memories_fts USING fts5(subject, content, tags, content='memories', content_rowid='rowid');
CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, subject, content, tags) VALUES (new.rowid, new.subject, new.content, new.tags_json);
END;
CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, subject, content, tags) VALUES ('delete', old.rowid, old.subject, old.content, old.tags_json);
END;
CREATE TRIGGER memories_fts_update AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, subject, content, tags) VALUES ('delete', old.rowid, old.subject, old.content, old.tags_json);
  INSERT INTO memories_fts(rowid, subject, content, tags) VALUES (new.rowid, new.subject, new.content, new.tags_json);
END;
CREATE TABLE memory_usage (
  memory_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT
);
`,
  },
];

/** M4d: the explanation of each context packet (ADR-0022 §8). */
export const CONTEXT_MIGRATIONS: Migration[] = [
  {
    version: 9,
    name: 'context_explanations',
    up: `ALTER TABLE context_packets ADD COLUMN explanation_json TEXT;`,
  },
];

/**
 * M5a: execution roots and task worktrees (ADR-0014, ADR-0023). Worktree paths are machine-local
 * hints: a missing one is allocated again from its branch.
 */
export const WORKTREE_MIGRATIONS: Migration[] = [
  {
    version: 10,
    name: 'worktrees',
    up: `
ALTER TABLE task_runs ADD COLUMN execution_root TEXT;
ALTER TABLE task_runs ADD COLUMN base_commit TEXT;
ALTER TABLE task_runs ADD COLUMN branch_ref TEXT;
ALTER TABLE task_runs ADD COLUMN workspace TEXT;
CREATE TABLE worktrees (
  worktree_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  path TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_commit TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'released', 'preserved', 'removed')),
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_worktrees_task ON worktrees(project_id, task_id, status);
`,
  },
];

/** M5b: what a verification judged, and how each check counted (ADR-0024). */
export const VERIFICATION_MIGRATIONS: Migration[] = [
  {
    version: 11,
    name: 'verification_revision',
    up: `
ALTER TABLE verification_runs ADD COLUMN execution_root TEXT;
ALTER TABLE verification_runs ADD COLUMN commit_sha TEXT;
ALTER TABLE verification_runs ADD COLUMN source_version TEXT;
ALTER TABLE verification_runs ADD COLUMN base_commit TEXT;
ALTER TABLE verification_runs ADD COLUMN task_kind TEXT;
ALTER TABLE verification_checks ADD COLUMN required INTEGER NOT NULL DEFAULT 1;
ALTER TABLE verification_checks ADD COLUMN origin TEXT NOT NULL DEFAULT 'configured';
ALTER TABLE verification_checks ADD COLUMN duration_ms INTEGER;
ALTER TABLE verification_checks ADD COLUMN details_json TEXT;
`,
  },
];

/** M5c: exclusive reservations of conflict-prone files (ADR-0025). */
export const RESERVATION_MIGRATIONS: Migration[] = [
  {
    version: 12,
    name: 'file_reservations',
    up: `
CREATE TABLE file_reservations (
  reservation_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  pattern TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'released', 'expired')),
  via TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  ended_at TEXT,
  note TEXT
);
CREATE INDEX ix_file_reservations ON file_reservations(project_id, status, task_id);
`,
  },
];

/** M5c: verified task branches brought into their goal branch (ADR-0025). */
export const INTEGRATION_MIGRATIONS: Migration[] = [
  {
    version: 13,
    name: 'integrations',
    up: `
CREATE TABLE integrations (
  integration_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('integrated', 'conflicted', 'failed', 'not_needed')),
  branch TEXT,
  task_commit TEXT,
  base_commit TEXT,
  merged_commit TEXT,
  conflicts_json TEXT NOT NULL DEFAULT '[]',
  checks_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_integrations ON integrations(project_id, goal_id, task_id);
`,
  },
];

/** M6a: approvals bound to their task, attempt, target and policy version (ADR-0027). */
export const APPROVAL_MIGRATIONS: Migration[] = [
  {
    version: 14,
    name: 'bound_approvals',
    up: `
ALTER TABLE approvals ADD COLUMN reuse TEXT NOT NULL DEFAULT 'once';
ALTER TABLE approvals ADD COLUMN policy_version TEXT;
ALTER TABLE approvals ADD COLUMN uses INTEGER NOT NULL DEFAULT 0;
ALTER TABLE approvals ADD COLUMN last_used_at TEXT;
ALTER TABLE approvals ADD COLUMN note TEXT;
ALTER TABLE approvals ADD COLUMN decided_via TEXT;
CREATE INDEX ix_approvals_use ON approvals(project_id, capability, status);
`,
  },
];

/** M6c: runs of operations by the execution gateway (ADR-0029). */
export const OPERATION_MIGRATIONS: Migration[] = [
  {
    version: 15,
    name: 'operation_runs',
    up: `
CREATE TABLE operation_runs (
  operation_run_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT,
  agent_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'passed', 'failed', 'interrupted')),
  binary TEXT NOT NULL,
  cwd TEXT NOT NULL,
  credentials_json TEXT NOT NULL DEFAULT '[]',
  approval_id TEXT,
  risk TEXT NOT NULL,
  reason TEXT NOT NULL,
  exit_code INTEGER,
  timed_out INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  redactions INTEGER NOT NULL DEFAULT 0,
  artifact_ref TEXT,
  summary TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX ix_operation_runs ON operation_runs(project_id, task_id, status);
`,
  },
];

/**
 * M6c, found while building it: the memory index of v8 named a column `tags` that `memories` does
 * not have (`tags_json`). Searches read only the index and worked; anything reading the index's
 * columns through the content table (a rebuild, `snippet()`, a plain SELECT) failed. Rebuilt with
 * the content table's column names; v8 itself never changes (its checksum is recorded).
 */
export const MEMORY_INDEX_MIGRATIONS: Migration[] = [
  {
    version: 16,
    name: 'memory_index_columns',
    up: `
DROP TRIGGER memories_fts_insert;
DROP TRIGGER memories_fts_delete;
DROP TRIGGER memories_fts_update;
DROP TABLE memories_fts;
CREATE VIRTUAL TABLE memories_fts USING fts5(subject, content, tags_json, content='memories', content_rowid='rowid');
CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, subject, content, tags_json) VALUES (new.rowid, new.subject, new.content, new.tags_json);
END;
CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, subject, content, tags_json) VALUES ('delete', old.rowid, old.subject, old.content, old.tags_json);
END;
CREATE TRIGGER memories_fts_update AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, subject, content, tags_json) VALUES ('delete', old.rowid, old.subject, old.content, old.tags_json);
  INSERT INTO memories_fts(rowid, subject, content, tags_json) VALUES (new.rowid, new.subject, new.content, new.tags_json);
END;
INSERT INTO memories_fts(memories_fts) VALUES ('rebuild');
`,
  },
];

/** M7: model routing (ADR-0031): decisions, human pins, outcomes, and the models runs used. */
export const ROUTING_MIGRATIONS: Migration[] = [
  {
    version: 17,
    name: 'routing',
    up: `
CREATE TABLE routing_decisions (
  decision_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT,
  harness_id TEXT,
  model TEXT,
  binding INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  mode TEXT NOT NULL,
  task_class TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_routing_decisions ON routing_decisions(project_id, task_id, created_at);
CREATE TABLE routing_pins (
  pin_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('project', 'kind', 'role', 'task')),
  target TEXT,
  model TEXT,
  mode TEXT,
  sensitive INTEGER NOT NULL DEFAULT 0,
  needs_vision INTEGER NOT NULL DEFAULT 0,
  until TEXT,
  source TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE model_outcomes (
  outcome_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT,
  model TEXT NOT NULL,
  basis TEXT NOT NULL,
  task_class TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('passed', 'failed')),
  attempt INTEGER NOT NULL,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_model_outcomes ON model_outcomes(project_id, model, task_class);
ALTER TABLE task_runs ADD COLUMN model_requested TEXT;
ALTER TABLE task_runs ADD COLUMN model_binding INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_runs ADD COLUMN routing_decision_id TEXT;
ALTER TABLE task_runs ADD COLUMN model_observed TEXT;
ALTER TABLE task_runs ADD COLUMN model_basis TEXT;
ALTER TABLE harnesses ADD COLUMN observed_model TEXT;
`,
  },
];

/** M7c: Laya's stored answers and the thresholds fitted for it (ADR-0031 §10). */
export const LAYA_MIGRATIONS: Migration[] = [
  {
    version: 18,
    name: 'laya',
    up: `
CREATE TABLE laya_answers (
  answer_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  checkpoint TEXT NOT NULL,
  choice TEXT NOT NULL,
  confidence REAL NOT NULL,
  basis TEXT NOT NULL,
  options INTEGER NOT NULL,
  probabilities_json TEXT,
  latency_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_laya_answers ON laya_answers(project_id, task_id, created_at);
CREATE TABLE laya_calibrations (
  calibration_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  checkpoint TEXT NOT NULL,
  shape TEXT NOT NULL,
  threshold REAL,
  accuracy REAL,
  coverage REAL NOT NULL,
  support INTEGER NOT NULL,
  target REAL NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_laya_calibrations ON laya_calibrations(project_id, checkpoint, shape, created_at);
`,
  },
];

/**
 * M7.1: the M7 review's stabilization (docs/reviews/2026-10-14-m7-review-disposition.md). v19
 * (M7.1a, released): the exact tree a verification judged (F04). v20 (M7.1b): the policy version
 * it judged by (F03). An applied migration never changes; later columns take the next version.
 */
export const REVIEW_M7_MIGRATIONS: Migration[] = [
  {
    version: 19,
    name: 'review_m7',
    up: `
ALTER TABLE verification_runs ADD COLUMN tree TEXT;
`,
  },
  {
    version: 20,
    name: 'review_m7_policy',
    up: `
ALTER TABLE verification_runs ADD COLUMN policy_version TEXT;
`,
  },
  {
    // M7.1c: an outcome's cohort (F15): the host version and the checks that judged it, and the
    // task's kind, so only comparable outcomes are counted together.
    version: 21,
    name: 'review_m7_outcome_cohorts',
    up: `
ALTER TABLE model_outcomes ADD COLUMN task_kind TEXT;
ALTER TABLE model_outcomes ADD COLUMN harness_version TEXT;
ALTER TABLE model_outcomes ADD COLUMN checks_version TEXT;
`,
  },
];

/** Every migration for a Friday project database, in order. */
export const ALL_MIGRATIONS: Migration[] = [
  ...EVENT_MIGRATIONS,
  ...STATE_MIGRATIONS,
  ...MASTER_BRAIN_MIGRATIONS,
  ...STABILIZATION_MIGRATIONS,
  ...MESSAGING_MIGRATIONS,
  ...CONSUMER_MIGRATIONS,
  ...MEMORY_MIGRATIONS,
  ...CONTEXT_MIGRATIONS,
  ...WORKTREE_MIGRATIONS,
  ...VERIFICATION_MIGRATIONS,
  ...RESERVATION_MIGRATIONS,
  ...INTEGRATION_MIGRATIONS,
  ...APPROVAL_MIGRATIONS,
  ...OPERATION_MIGRATIONS,
  ...MEMORY_INDEX_MIGRATIONS,
  ...ROUTING_MIGRATIONS,
  ...LAYA_MIGRATIONS,
  ...REVIEW_M7_MIGRATIONS,
];

/** Domain tables cleared by a replay, children first. */
export const DOMAIN_TABLES = [
  'laya_calibrations',
  'laya_answers',
  'model_outcomes',
  'routing_decisions',
  'routing_pins',
  'operation_runs',
  'integrations',
  'file_reservations',
  'worktrees',
  'memory_links',
  'memories',
  'message_deliveries',
  'messages',
  'model_calls',
  'agent_assignments',
  'plan_tasks',
  'plans',
  'goals',
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
