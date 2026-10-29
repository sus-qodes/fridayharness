/**
 * Wire types of the interface's own routes (plan M9, `docs/frontend/PLAN.md` §5). Types only: the
 * daemon builds these from its views, and the browser bundle imports them with `import type`.
 */
import type {
  AgentView,
  FileReservationView,
  GoalView,
  HarnessView,
  IntegrationView,
  PlanTaskView,
  PlanVersionView,
  RunView,
  TaskView,
  VerificationView,
} from './api.js';
import type { InboxItem } from './methods.js';

/** `POST …/ui/login-codes`: a one-time link that signs a browser in (plan §5.2). */
export interface UiLoginCode {
  url: string;
  /** The user-only redirect file the browser opens instead of the link (never on a command line). */
  redirect_file: string | null;
  expires_at: string;
}

/** `POST /ui/session`: the UI session a login code is exchanged for. */
export interface UiSession {
  token: string;
  expires_at: string;
  project_id: string;
}

/** Pause, resume and halt (plan §5.5). */
export interface ControlState {
  paused: boolean;
  reason: string | null;
  changed_at: string | null;
  changed_by: string | null;
  halted_at: string | null;
}

/**
 * One attempt a pause or a halt stopped. `stop: 'sent'` is not "stopped": a spawned host stops
 * when its adapter takes the cancel; an attached session cannot be stopped (`not_possible`) and is
 * held by the pause instead.
 */
export interface ControlTaskStop {
  task_id: string;
  preserved_ref: string | null;
  host: 'spawned' | 'attached' | 'none';
  stop: 'sent' | 'not_possible' | 'none';
}

/** The answer of `control/pause`, `control/resume` and `control/halt`. */
export interface ControlResult {
  control: ControlState;
  tasks: ControlTaskStop[];
  operations_stopped: number;
}

export type HaltResult = ControlResult;

/** `POST …/tasks/:tid/continue` (plan §5.6). */
export interface ContinueResult {
  continued: boolean;
  reason: string | null;
  task: TaskView;
}

/** An approval row as stored, plus whether its expiry has passed. */
export interface ApprovalRow {
  approval_id: string;
  project_id: string;
  task_id: string | null;
  run_id: string | null;
  requested_by_kind: string;
  requested_by_id: string;
  capability: string;
  target: string | null;
  purpose: string | null;
  risk: 'low' | 'medium' | 'high' | null;
  status: 'pending' | 'granted' | 'denied' | 'used' | 'revoked';
  decided_by_kind: string | null;
  decided_by_id: string | null;
  decided_at: string | null;
  expires_at: string | null;
  created_at: string;
  reuse: 'once' | 'run' | 'task';
  policy_version: string | null;
  uses: number;
  last_used_at: string | null;
  note: string | null;
  decided_via: string | null;
  expired: boolean;
}

/**
 * The kinds of question Friday raises itself (plan FD-21). `null` is an agent's own question
 * (`friday_ask_human`). Answering most system kinds only records text: the interface acts on them
 * through the routes that do the work.
 */
export type EscalationKind =
  | 'recovery_needed'
  | 'routing_blocked'
  | 'routing_violated'
  | 'integration_conflict'
  | 'integration_failed'
  | 'unanswered_request'
  | 'ambiguous_intent'
  | 'repeated_failures'
  | 'replan_limit'
  | 'planner_unavailable'
  | 'invalid_plan'
  | 'budget_exceeded'
  | 'plan_rejected'
  | 'action_failed'
  | (string & {});

/** An escalation ("a question for a human") with its JSON columns decoded. */
export interface EscalationView {
  escalation_id: string;
  project_id: string;
  task_id: string | null;
  run_id: string | null;
  goal_id: string | null;
  kind: EscalationKind | null;
  question: string;
  status: 'pending' | 'answered';
  answer: string | null;
  requested_by_id: string;
  requested_by_kind: string;
  created_at: string;
  answered_at: string | null;
  options: string[] | null;
  /** Usually `{blocked, why, proposed_action, evidence}`; free-form for system kinds. */
  details: Record<string, unknown> | null;
}

/** A plan task as the live version shows it: its current status and agent. */
export type LivePlanTask = PlanTaskView & {
  status: string | null;
  waiting_reason: string | null;
  agent_key: string | null;
  reserved_for_agent_key: string | null;
};

export type LivePlanVersion = Omit<PlanVersionView, 'tasks'> & { tasks: LivePlanTask[] };

/** The Master Brain's state as the interface needs it. */
export interface BrainStatusView {
  provider: string;
  model: string;
  remote: boolean;
  allow_remote: boolean;
  approved_here: boolean;
  endpoint: string | null;
  ignored_base_url: string | null;
  key: 'stored' | 'environment' | 'missing' | 'not needed';
  planner_available: boolean;
  reason: string | null;
  auto_approve: boolean;
  escalate_after_failures: number;
  max_replans: number;
  daily_budget_usd: number;
  spent_today_usd: number;
  cursor: number;
  head: number;
}

/** An open Master Brain job; `calling` while a model request is in flight (the mascot thinks). */
export interface BrainJobView {
  job_id: string;
  kind: string;
  status: 'pending' | 'waiting' | 'calling' | string;
  goal_id: string | null;
}

/** A harness with the fields only its own record carries. */
export type HarnessEntry = HarnessView & {
  shadow: boolean;
  requested_agent_key: string | null;
  observed_model: string | null;
  host_cwd: string | null;
};

/** The last usage a host reported for a run (Claude Code in spawn mode reports it). */
export interface UsageView {
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  at: string;
}

/** A task as the board shows it. */
export type SnapshotTask = TaskView & {
  agent_key: string | null;
  /** WAITING: the reason of its latest `task.waiting` (what the agent needs). */
  waiting_note: string | null;
  /** READY: why delegation left it waiting ("no agent is available …"). */
  delegation_note: string | null;
};

/** An inbox item without its body (loaded when opened), with a short preview. */
export type SnapshotInboxItem = Omit<InboxItem, 'body'> & { preview: string };

export type SnapshotList =
  | 'goals'
  | 'tasks'
  | 'agents'
  | 'harnesses'
  | 'approvals'
  | 'escalations'
  | 'inbox'
  | 'reservations';

/** `GET …/ui/snapshot`: everything the board needs, consistent with `head` (plan §5.3). */
export interface UiSnapshot {
  /** The interface API version the daemon speaks; a mismatched page asks to be reloaded. */
  ui_api: number;
  head: number;
  generated_at: string;
  project: {
    project_id: string;
    name: string;
    root: string;
    port: number;
    daemon_version: string;
    /** False in a repository without a commit: every agent then works in the main checkout. */
    has_commit: boolean;
    worktrees_mode: string;
  };
  /** Differ → "config.yaml changed; restart Friday to apply". */
  config: { loaded_hash: string; current_hash: string | null };
  control: ControlState;
  verification: { checks: { name: string; kind: string; required: boolean }[]; auto_on_completion: boolean };
  counts: Record<string, number>;
  goals: GoalView[];
  plans: Record<string, { active: LivePlanVersion | null; proposed: LivePlanVersion | null }>;
  tasks: SnapshotTask[];
  runs: Record<string, RunView>;
  verifications: Record<string, VerificationView>;
  integrations: Record<string, IntegrationView>;
  /** Per run id. */
  usage: Record<string, UsageView>;
  agents: AgentView[];
  harnesses: HarnessEntry[];
  approvals: ApprovalRow[];
  escalations: EscalationView[];
  inbox: SnapshotInboxItem[];
  reservations: FileReservationView[];
  brain: BrainStatusView | null;
  brain_jobs: BrainJobView[];
  truncated: Partial<Record<SnapshotList, boolean>>;
}

/** One changed file of a task or goal (plan §5.4). */
export interface TaskDiffFile {
  path: string;
  change: 'added' | 'modified' | 'deleted' | 'renamed';
  orig_path: string | null;
  committed: boolean;
  uncommitted: boolean;
  binary: boolean;
  too_large: boolean;
  /** Reached through a link or junction: never read. */
  link: boolean;
  /** A protected file (Friday's state, runtime files, secrets): never shown. */
  protected: boolean;
  before: string | null;
  after: string | null;
  /** Line counts (`?stat=1`); null for binary files or without stat. */
  added: number | null;
  removed: number | null;
}

export interface TaskDiff {
  task_id: string;
  source: 'worktree' | 'verified' | 'integrated' | 'none';
  root: string | null;
  base: string | null;
  files: TaskDiffFile[];
  truncated: boolean;
  notes: string[];
}

/** `GET …/goals/:gid/diff`: the goal branch against its merge base with the main checkout's HEAD. */
export interface GoalDiff {
  goal_id: string;
  source: 'goal';
  branch: string;
  head: string | null;
  merge_base: string | null;
  root: string;
  base: string | null;
  commits_ahead: { sha: string; subject: string; author: string; date: string }[];
  files: TaskDiffFile[];
  truncated: boolean;
  notes: string[];
}

/** A coding host the agent launcher can start (plan §5.9). */
export interface AgentHost {
  host: 'claude-code' | 'codex';
  found: boolean;
  version: string | null;
  supported: boolean;
  path: string | null;
  reason: string | null;
}

/** Options per host; models come from routing, never from here. */
export interface AgentOptions {
  /** Claude Code and Codex. */
  effort?: string;
  /** Claude Code: a spending cap per attempt (default 1). */
  max_budget_usd?: number;
  /** Codex. */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  windows_sandbox?: string;
  service_tier?: string;
}

export interface AgentLaunchRequest {
  host: 'claude-code' | 'codex';
  agent_key: string;
  role: string;
  options?: AgentOptions;
  /** Start this agent whenever Friday starts (plan FD-24). */
  autostart?: boolean;
}

export interface AgentProcess {
  agent_key: string;
  host: 'claude-code' | 'codex';
  role: string;
  pid: number | null;
  status: 'starting' | 'running' | 'stopping' | 'exited';
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  options: AgentOptions;
  log_tail: string[];
  /** Its harness registered as a shadow: another live session holds the agent key. */
  shadow: boolean;
}

/** A remembered agent of this project (plan FD-24). */
export interface AgentProfile {
  agent_key: string;
  host: 'claude-code' | 'codex';
  role: string;
  options: AgentOptions;
  autostart: boolean;
  updated_at: string;
}

export interface AgentProcessesView {
  processes: AgentProcess[];
  profiles: AgentProfile[];
}

/** One file `harness config claude-code` writes (plan §5.10). */
export interface ClaudeSetupChange {
  path: string;
  action: string;
  tracked: boolean;
  note: string | null;
  diff: string | null;
}

export interface ClaudeSetupPlan {
  agent_key: string;
  applied: boolean;
  changes: ClaudeSetupChange[];
  claude_code: { version: string; source: string; hook_level: string } | null;
}

export interface ClaudeSetupResult {
  plan: ClaudeSetupPlan;
  /** `harness doctor claude-code --json`. */
  doctor: { level?: string; checks?: { id: string; status: string; detail?: string }[]; [key: string]: unknown } | null;
}

/** `GET …/files?dir=`: one level of the tracked files (plan §5.11). */
export interface FilesListing {
  dir: string;
  entries: { name: string; path: string; kind: 'file' | 'dir'; files: number | null }[];
  truncated: boolean;
}

/** `POST …/files/match`: tracked files each glob matches. */
export interface GlobCounts {
  counts: Record<string, number>;
  total: number;
  truncated: boolean;
}
