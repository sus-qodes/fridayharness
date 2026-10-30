import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  addMs,
  type Clock,
  canAgentTransition,
  canHarnessTransition,
  canRunTransition,
  type IdGenerator,
  randomIds,
  systemClock,
  type TaskTrigger,
  transitionTask,
} from '@friday/core';
import { migrate, type SqlDatabase, toJson } from '@friday/db';
import {
  ArtifactStore,
  EventStore,
  type EventTransport,
  InProcessTransport,
  Redactor,
  type StoredEvent,
} from '@friday/events';
import {
  type Actor,
  type ActorKind,
  type AgentResultParams,
  type AgentStatus,
  type AgentView,
  COST_ORDER,
  type ContextPacket,
  type ControlState,
  type CostClass,
  type EnforcementLevel,
  type EnforcementStatus,
  type FileReservationView,
  FridayError,
  GoalCreateRequest,
  type GoalView,
  type HarnessRegisterParams,
  type HarnessStatus,
  type HarnessView,
  type InboxItem,
  type IntegrationView,
  isFridayError,
  negotiateProtocolVersion,
  type OperationRunView,
  type OutboundMessage,
  type PlanStatus,
  type PlanTaskView,
  type PlanVersionView,
  type RoutingPinView,
  type RunStatus,
  type RunView,
  TaskCreateRequest,
  type TaskRoleDecisionView,
  type TaskScope,
  type TaskSplitResult,
  type TaskStartParams,
  type TaskStatus,
  type TaskView,
  type TokenClass,
  type VerificationFinding,
  type VerificationStatus,
  type WaitingReason,
  type WorktreeView,
} from '@friday/protocol';
import {
  ROLE_REGISTRY_SOURCE,
  type RoleDecision,
  resolveTaskRoleContract,
  type TaskRoleOrigin,
  taskRoleIntentVersion,
} from '@friday/routing';
import type { z } from 'zod';
import { CommandBus, type CommandContext, type CommandMeta } from './bus.js';
import { IntentService } from './intent.js';
import { LearningService } from './learnings.js';
import { MemoryService } from './memory.js';
import { ALL_MIGRATIONS } from './migrations.js';
import { StateProjector } from './projector.js';
import { type HarnessRecord, Queries } from './queries.js';
import { type HostFailure, ReadinessService } from './readiness.js';
import type { DeliveryRow, MessageRow } from './rows.js';

/**
 * The routing decision for a new run (ADR-0031 §6), made by the daemon's router in the run's
 * transaction. `decision` is stored as given (the RoutingDecision of @friday/routing).
 */
export interface RunRouting {
  decision: {
    mode: string;
    task_class: string;
    model: string | null;
    binding: boolean;
    /** The work must not start on this harness (review F01): no run is created. */
    blocked?: boolean;
    source: string;
    reason: string;
    reason_codes: string[];
    [key: string]: unknown;
  };
}
export type RunRouter = (args: { task: TaskView; harness: HarnessRecord; agent: AgentView }) => RunRouting | null;

/** What installing a fresh worktree's dependencies did (plan Phase 7), carried by `run.workspace_ready`. */
export interface WorkspaceSetupRecord {
  status: 'passed' | 'failed' | 'skipped' | 'refused';
  source: string | null;
  command: string | null;
  args: string[];
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number | null;
  reason: string;
  output_tail: string | null;
}

/** What a `routing_blocked` error carries (review F01). */
interface RoutingBlock {
  task_id: string;
  harness_id: string | null;
  decision: RunRouting['decision'];
}

export interface StateConfig {
  heartbeatIntervalMs: number;
  leaseTtlMs: number;
  reconnectWindowMs: number;
  cleanExitGraceMs: number;
  ackTimeoutMs: number;
  maxDeliveryAttempts: number;
  idempotencyTtlMs: number;
  /** Agent key used when a harness registers without one. */
  defaultAgentKey: string;
  /** How long an automatic reservation (delegation, rework) waits for its agent (review F08). */
  reservationTtlMs: number;
  /** `security.enforcement_required`: the level a session must reach before it may take work (review F09). */
  enforcementRequired: EnforcementLevel;
  /**
   * `security.require_enforcing_hooks`: sessions of a host that runs Friday's hooks (Claude Code,
   * Cursor, Antigravity, Gemini CLI) must run where a failing hook blocks the call.
   */
  requireEnforcingHooks: boolean;
  /** Agent messaging (ADR-0017, `communication.*`). */
  allowBroadcast: boolean;
  /** How long an inbox read reserves a delivery for the reading session. */
  messageReservationMs: number;
  /** Deliveries of one message to one recipient before it is dead-lettered. */
  messageMaxAttempts: number;
  /** How long a message stays deliverable. */
  messageTtlMs: number;
  /** The reply deadline of a blocking request that names none. */
  blockingReplyMs: number;
  /** Unacknowledged deliveries an agent may hold before low and normal notifications are refused. */
  maxOpenPerRecipient: number;
  /**
   * `worktrees.mode` (ADR-0023): `per_task` gives each spawn-mode run its task's worktree, prepared
   * by the daemon before `task.start` is delivered. The library default is `off`; the daemon
   * turns it on for git projects with a commit.
   */
  worktreeMode: 'per_task' | 'off';
  /**
   * This clone's folder of task worktrees (`<worktrees dir>/<root key>`, ADR-0023 §4). A recorded
   * worktree anywhere else belongs to another clone of the project (a restored database, review
   * F08): it is never reused, and the daemon decides with git what the run gets instead.
   */
  worktreeRoot: string | null;
  /** How long a run may wait for its worktree before it is declined. */
  workspaceTimeoutMs: number;
  /**
   * File reservations (ADR-0025): how long a reservation outlives its task standing still (READY
   * again, or its harness lost) before it expires and others may take the files.
   */
  fileReservationTtlMs: number;
  /**
   * `routing.task_budget_usd` (plan M11.5): the spending cap per task attempt, in dollars, carried
   * in `task.start` for adapters whose host enforces one. Null means no cap. The daemon judges each
   * cost report against the project's setting itself; this copy is what the host is told.
   */
  taskBudgetUsd: number | null;
}

export const DEFAULT_STATE_CONFIG: StateConfig = {
  heartbeatIntervalMs: 10_000,
  leaseTtlMs: 30_000,
  reconnectWindowMs: 120_000,
  cleanExitGraceMs: 60_000,
  ackTimeoutMs: 30_000,
  maxDeliveryAttempts: 5,
  idempotencyTtlMs: 24 * 60 * 60 * 1000,
  defaultAgentKey: 'dev-1',
  reservationTtlMs: 15 * 60 * 1000,
  // The library default asks for nothing; the daemon passes the project's `security` settings.
  enforcementRequired: 'L0',
  requireEnforcingHooks: false,
  allowBroadcast: false,
  messageReservationMs: 120_000,
  messageMaxAttempts: 5,
  messageTtlMs: 24 * 60 * 60 * 1000,
  blockingReplyMs: 30 * 60 * 1000,
  maxOpenPerRecipient: 50,
  worktreeMode: 'off',
  worktreeRoot: null,
  workspaceTimeoutMs: 10 * 60 * 1000,
  fileReservationTtlMs: 30 * 60 * 1000,
  taskBudgetUsd: null,
};

/** Who sends a message (ADR-0017 §4). Agents are identified by their harness token, never by the request. */
export type MessageSender =
  | { kind: 'agent'; caller: Caller }
  | { kind: 'human'; actor: Actor }
  | { kind: 'master_brain'; actor: Actor }
  /** Friday itself, for notices such as "this question was answered" (M3.1). */
  | { kind: 'system'; actor: Actor };

export interface SendMessageInput {
  to: string;
  mode: 'request' | 'response' | 'notification';
  subject?: string | undefined;
  content: string;
  facts?: { fact: string; area?: string | undefined; impact?: string | undefined }[];
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  blocking?: boolean;
  reply_within_s?: number | undefined;
  response_to?: string | undefined;
  task_id?: string | undefined;
  correlation_id?: string | undefined;
}

interface Recipient {
  kind: 'agent' | 'role' | 'task' | 'master_brain' | 'human';
  id: string;
  agent_id: string | null;
}

/** Bodies longer than this are stored as an artifact (plan B23). */
const MAX_BODY = 8000;
const HELD_STATUSES: TaskStatus[] = [
  'ASSIGNED',
  'RUNNING',
  'WAITING',
  'HARNESS_LOST',
  'READY_FOR_VERIFICATION',
  'VERIFYING',
  'FAILED',
  'REWORK',
];

const LEVEL_RANK: Record<EnforcementLevel, number> = { L0: 0, L1: 1, L2: 2 };
/** Claude Code versions that block an action when a hook fails (`onFailure: block`), and that run hooks at all. */
const CLAUDE_ENFORCING = [2, 1, 295] as const;
const CLAUDE_HOOKS = [2, 1, 232] as const;
/**
 * The first Cursor whose documentation describes `failClosed` on a permission hook (its hooks page,
 * read for 3.24). When Cursor added the key is not documented: an older Cursor may ignore it and
 * let a call through when the hook fails, so its level stays unverified (plan B21).
 */
const CURSOR_FAIL_CLOSED = [3, 24] as const;
/** The same for the Cursor CLI (`agent`), whose versions are dates: the release its documentation was read for. */
const CURSOR_CLI_FAIL_CLOSED = [2026, 10, 16] as const;
/** The hosts other than Claude Code whose Friday hooks reach the daemon in attach mode (plan M8b). */
const HOOKED_HOSTS: Record<string, string> = { cursor: 'Cursor', antigravity: 'Antigravity', gemini: 'Gemini CLI' };
/** What reaches an enforcing level on each host whose sessions run Friday's hooks (`security.require_enforcing_hooks`). */
const ENFORCING_FIX: Record<string, string> = {
  'claude-code': 'Update Claude Code to 2.1.295 or later.',
  cursor: `Use Cursor ${CURSOR_FAIL_CLOSED.join('.')} or later with the hooks "friday harness config cursor" writes (each permission hook fails closed).`,
  antigravity:
    'What Antigravity does when a hook fails is not documented, so no Antigravity session counts as enforcing yet.',
  gemini: 'Gemini CLI lets a call through when a hook fails, so no Gemini CLI session counts as enforcing.',
};

/**
 * Whether `v` is at least `min`. A three-part minimum needs a three-part version (`2.1` is not
 * read as 2.1.0); a two-part minimum takes `3.24` and `3.24.1` alike. Null when `v` does not say.
 */
function versionAtLeast(v: string | null | undefined, min: readonly number[]): boolean | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(v ?? '');
  if (!m || (min.length > 2 && m[3] === undefined)) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  for (let i = 0; i < min.length; i += 1) {
    if ((parts[i] ?? 0) !== (min[i] ?? 0)) return (parts[i] ?? 0) > (min[i] ?? 0);
  }
  return true;
}

/**
 * What the hooks route learned about an attached session's hooks (`capabilities.hook_evidence`):
 * the host version its hooks report (Cursor's `cursor_version`), and whether the project's hook
 * file makes a failing permission hook block (`fail-closed`), let the call through (`fail-open`),
 * or could not be read (null). Unknown values are null.
 */
export interface HookEvidence {
  host_version: string | null;
  hook_failure: 'fail-closed' | 'fail-open' | null;
}

/**
 * Whether a registering MCP server takes over the session its hooks registered first (plan M8b):
 * the same host, both attached, a harness the hooks route made (it has no tools), and a server
 * with tools. Claude Code's hooks and MCP server share one harness key, so they never register apart.
 */
function takesOverHooksSession(
  holder: { vendor: string; attach_mode: string; capabilities?: Record<string, unknown> | null },
  params: { vendor: string; attach_mode: string; capabilities: Record<string, unknown> },
): boolean {
  return (
    holder.vendor === params.vendor &&
    params.vendor !== 'claude-code' &&
    holder.attach_mode === 'attach' &&
    params.attach_mode === 'attach' &&
    holder.capabilities?.hooks_route === true &&
    params.capabilities.mcp_tools === true
  );
}

export function hookEvidenceOf(capabilities: Record<string, unknown> | null | undefined): HookEvidence {
  const e = (capabilities?.hook_evidence ?? {}) as Record<string, unknown>;
  const failure = e.hook_failure === 'fail-closed' || e.hook_failure === 'fail-open' ? e.hook_failure : null;
  return {
    host_version: typeof e.host_version === 'string' && e.host_version ? e.host_version : null,
    hook_failure: failure,
  };
}

/**
 * The host cohort an outcome is counted in (review F15): the vendor and the version's major and
 * minor parts (`claude-code 2.1`), so a patch release does not start the evidence over while a new
 * minor version does.
 */
export function hostCohort(vendor: string, version: string | null | undefined): string {
  const m = /^(\d+)\.(\d+)/.exec(version ?? '');
  return `${vendor} ${m ? `${m[1]}.${m[2]}` : (version ?? 'unknown')}`;
}

/**
 * The enforcement a session actually reached (ADR-0010, review F09, plan B21), from evidence
 * rather than from what the client says. A session attached to a host with Friday hooks (Claude
 * Code, Cursor, Antigravity, Gemini CLI) reaches L1 once Friday hooks reached the daemon from it,
 * and what the host does with a failing hook decides its status: enforcing where it blocks the
 * call, degraded where it lets the call through, unverified where that is not known. Adapters that
 * run the host themselves (spawn mode, FakeHarness) report their level; one whose capabilities say
 * its hooks fail open (`hook_failure: "fail-open"`) is degraded, not reported.
 */
export function achievedEnforcement(h: {
  vendor: string;
  attach_mode: string;
  claimed: EnforcementLevel | null;
  hooks_seen: boolean;
  host_version: string | null;
  capabilities?: Record<string, unknown> | null;
}): { level: EnforcementLevel; status: EnforcementStatus; basis: string } {
  if (h.vendor === 'opencode')
    return {
      level: h.claimed === 'L1' ? 'L1' : 'L0',
      status: h.claimed === 'L1' ? 'unverified' : 'observed',
      basis: 'OpenCode is experimental; its live refusals are recorded (checkpoint C), its lifecycle is not',
    };
  const hooked = HOOKED_HOSTS[h.vendor];
  if (hooked && h.attach_mode === 'attach') {
    if (!h.hooks_seen) {
      return { level: 'L0', status: 'observed', basis: 'no Friday hook has reached the daemon from this session' };
    }
    if (h.vendor === 'gemini') {
      return {
        level: 'L1',
        status: 'degraded',
        basis:
          'Friday hooks from this session; Gemini CLI lets a call through when a hook fails, and no setting changes that',
      };
    }
    if (h.vendor === 'antigravity') {
      return {
        level: 'L1',
        status: 'unverified',
        basis: 'Friday hooks from this session; what Antigravity does when a hook fails is not documented',
      };
    }
    const evidence = hookEvidenceOf(h.capabilities);
    const version = evidence.host_version ?? h.host_version;
    const host = version ? `Cursor ${version}` : 'Cursor (version unknown)';
    if (evidence.hook_failure === 'fail-open') {
      return {
        level: 'L1',
        status: 'degraded',
        basis: `Friday hooks from this session; a permission hook in .cursor/hooks.json has no failClosed, so ${host} lets that call through when the hook fails`,
      };
    }
    if (evidence.hook_failure !== 'fail-closed') {
      return {
        level: 'L1',
        status: 'unverified',
        basis: `Friday hooks from this session; ${host}, and Friday could not read whether .cursor/hooks.json runs each permission hook with failClosed`,
      };
    }
    const cli = /^\d{4}\./.test(version ?? '');
    if (versionAtLeast(version, cli ? CURSOR_CLI_FAIL_CLOSED : CURSOR_FAIL_CLOSED)) {
      return {
        level: 'L1',
        status: 'enforcing',
        basis: `Friday hooks from this session; ${host} blocks a call when its failClosed permission hook fails`,
      };
    }
    return {
      level: 'L1',
      status: 'unverified',
      basis: `Friday hooks from this session; ${host}: failClosed is documented from Cursor ${CURSOR_FAIL_CLOSED.join('.')} (CLI ${CURSOR_CLI_FAIL_CLOSED.join('.')}), and whether this version honours it is not known`,
    };
  }
  if (h.vendor === 'claude-code' && h.attach_mode === 'attach') {
    if (!h.hooks_seen) {
      return { level: 'L0', status: 'observed', basis: 'no Friday hook has reached the daemon from this session' };
    }
    const host = h.host_version ? `Claude Code ${h.host_version}` : 'Claude Code (version unknown)';
    const enforcing = versionAtLeast(h.host_version, CLAUDE_ENFORCING);
    if (enforcing === null)
      return { level: 'L1', status: 'unverified', basis: `Friday hooks from this session; ${host}` };
    if (enforcing) {
      return {
        level: 'L1',
        status: 'enforcing',
        basis: `Friday hooks from this session; ${host} blocks when a hook fails`,
      };
    }
    if (versionAtLeast(h.host_version, CLAUDE_HOOKS)) {
      return {
        level: 'L1',
        status: 'degraded',
        basis: `Friday hooks from this session; ${host} lets an action through when a hook fails (2.1.295 blocks)`,
      };
    }
    return { level: 'L0', status: 'observed', basis: `${host} is too old for Friday hooks` };
  }
  if (h.claimed && h.claimed !== 'L0') {
    // An adapter whose host lets a call through when a hook fails says so (Gemini CLI's spawn adapter).
    if (h.capabilities?.hook_failure === 'fail-open') {
      return {
        level: h.claimed,
        status: 'degraded',
        basis: `reported by the ${h.vendor} adapter; its host lets a call through when a hook fails`,
      };
    }
    return { level: h.claimed, status: 'reported', basis: `reported by the ${h.vendor} adapter` };
  }
  return { level: 'L0', status: 'observed', basis: `the ${h.vendor} client has no Friday policy hooks` };
}

/** Where a run works (ADR-0023): its execution root, the commit and branch it started from. */
export interface Workspace {
  execution_root: string | null;
  base_commit: string | null;
  branch_ref: string | null;
  workspace: 'pending' | 'ready';
}

/** What a verification judged (ADR-0024 §1). */
export interface VerificationRevision {
  execution_root?: string | null;
  commit_sha?: string | null;
  source_version?: string | null;
  base_commit?: string | null;
  task_kind?: string | null;
  /** The exact content judged, as a git tree; integration lands only this (review F04). */
  tree?: string | null;
  /** The version of the effective policy the work was judged by (review F03). */
  policy_version?: string | null;
}

/** Identity of a protocol caller, derived from its harness token (never from request fields). */
export interface Caller {
  harness_id: string;
  agent_id: string;
}

/** One task of a plan version as the planner hands it over (ADR-0013). */
export type PlanTaskInput = Omit<PlanTaskView, 'position'>;

export interface PlanProposal {
  summary: string;
  rationale: string;
  needs_human: { question: string; why: string; options: string[] } | null;
  /** Why this version exists: "first plan", "verification failed: …", "human answer", … */
  trigger: string;
  tasks: PlanTaskInput[];
  model_call_id?: string | null;
  prompt_version?: string | null;
  /**
   * The normalized intent from a first plan (spec Part 03 §5). Only the objective and what the
   * planner inferred: the human's own constraints and outcomes are never replaced (review F07).
   */
  intent?: {
    objective: string;
    inferred_constraints: string[];
    inferred_outcomes: string[];
    /** ADR-0034 §3: the planner's non-goals and definition of done, kept apart from the human's. */
    inferred_non_goals?: string[];
    inferred_definition_of_done?: string[];
  } | null;
  /**
   * The ACTIVE version this proposal was made against (null: there was none). Checked when it is
   * proposed and again when it is approved, so a stale proposal cannot apply (review F06).
   */
  base_version?: number | null;
}

export interface PlanApproval {
  plan: PlanVersionView;
  created: TaskView[];
  reworked: TaskView[];
  dropped: TaskView[];
  readied: TaskView[];
}

/**
 * The ceiling on a plan's tasks (plan M12.2): per agent role, the write scopes the project's
 * policy declares for it (ADR-0028 team scopes, one layer per source). A plan task of that role
 * holds no more than lies inside every layer.
 */
export interface PlanBounds {
  teams: Readonly<Record<string, readonly { source: string; write: readonly string[] }[]>>;
}

/** One plan task after the ceiling was applied (`FridayState.boundPlanTask`). */
export interface BoundedPlanTask {
  /** The write scope the task holds: as written, or cut to the ceiling. */
  write: string[];
  /** Why it was cut, for the human who reviews the plan; null when nothing changed. */
  note: string | null;
  /** Why it cannot be held at all; null when it can. */
  refused: string | null;
}

const GLOB_CHARS = /[*?[{]/;

/**
 * A project-relative glob as a list of segments, a trailing slash read as "everything under"
 * (as the hooks read it). Backslashes and a leading `./` are tolerated, never produced by a plan.
 */
function globSegments(glob: string): string[] {
  const g = glob.replaceAll('\\', '/').replace(/^\.\//, '');
  return (g.endsWith('/') ? `${g}**` : g).split('/').filter((s) => s.length > 0);
}

/** One glob segment as a regular expression over one path segment, case folded. */
function segmentPattern(segment: string): RegExp {
  const source = segment
    .split(/(\*|\?)/)
    .map((part) => (part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${source}$`, 'i');
}

/**
 * Whether every path `inner` can name is also named by `outer`, judged segment by segment: `**`
 * in the outer glob stands for any run of segments, `*` and `?` for parts of one segment, and a
 * literal segment for itself (case folded, since the hooks fold case on Windows). An inner `**`
 * is inside only an outer `**`; an inner wildcard segment only an outer `*`, `**` or the same
 * text. Conservative: when it cannot tell, the answer is no, and the hooks still judge the write.
 */
function globInside(inner: string, outer: string): boolean {
  const a = globSegments(inner);
  const b = globSegments(outer);
  const fits = (i: number, j: number): boolean => {
    if (j === b.length) return i === a.length;
    const o = b[j] as string;
    if (o === '**') {
      // Zero or more inner segments, then the rest of the outer glob.
      for (let k = i; k <= a.length; k += 1) if (fits(k, j + 1)) return true;
      return false;
    }
    if (i === a.length) return false;
    const s = a[i] as string;
    if (s === '**') return false;
    if (s.toLowerCase() === o.toLowerCase()) return fits(i + 1, j + 1);
    if (o === '*') return fits(i + 1, j + 1);
    if (GLOB_CHARS.test(s)) return false;
    return GLOB_CHARS.test(o) && segmentPattern(o).test(s) ? fits(i + 1, j + 1) : false;
  };
  return fits(0, 0);
}

/**
 * The part of a write scope that lies inside a ceiling: each glob kept when a ceiling glob
 * contains it, replaced by the ceiling globs it contains when it is wider, dropped otherwise.
 */
function boundWriteScope(write: readonly string[], ceiling: readonly string[]): { write: string[]; changed: boolean } {
  const out: string[] = [];
  let changed = false;
  for (const g of write) {
    if (ceiling.some((c) => globInside(g, c))) {
      out.push(g);
      continue;
    }
    changed = true;
    for (const c of ceiling) if (globInside(c, g)) out.push(c);
  }
  return { write: [...new Set(out)], changed };
}

/** A model request as recorded in `model.called` (plan B28): never the prompt or the answer. */
export interface ModelCallInput {
  goal_id: string | null;
  plan_id: string | null;
  purpose: string;
  prompt_version: string;
  provider: string;
  model: string;
  remote: boolean;
  status: 'ok' | 'invalid' | 'error' | 'refused' | 'interrupted';
  error_code: string | null;
  error: string | null;
  attempt: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    cache_write_1h_input_tokens?: number;
  };
  /** Null when unknown (review F04); never 0 for "unknown". */
  cost_usd: number | null;
  /** Worst-case estimate the budget counts while the cost is unknown. */
  cost_estimate_usd?: number | null;
  latency_ms: number;
  request_id: string | null;
}

/** One unit of Master Brain work (operational, ADR-0013 amendment, review F05). */
export interface BrainJob {
  job_id: string;
  kind: string;
  goal_id: string | null;
  task_id: string | null;
  reason: string;
  payload: Record<string, unknown>;
  dedupe_key: string;
  status: 'pending' | 'waiting' | 'calling' | 'done' | 'failed';
  attempts: number;
  result: string | null;
  source_sequence: number | null;
  not_before: string | null;
  call_estimate_usd: number | null;
  created_at: string;
  updated_at: string;
}

export interface BrainJobInput {
  kind: string;
  goal_id: string | null;
  task_id: string | null;
  reason: string;
  payload?: Record<string, unknown>;
  dedupe_key: string;
}

export interface TokenInfo {
  credential_id: string;
  project_id: string;
  token_class: TokenClass;
  harness_id: string | null;
}

/** Observation events that callers may record directly; they never change domain rows. */
const OBSERVATION_TYPES = new Set([
  'policy.evaluated',
  'agent.event',
  'agent.turn_ended',
  'context.requested',
  'harness.session_started',
  'harness.session_ended',
  'daemon.started',
  'daemon.stopped',
  'scope.violation',
  'ownership.conflict',
  'recovery.performed',
  // M7c: Laya did not answer (ADR-0031 §10).
  'laya.unavailable',
  // The daemon noticed it had been paused (a sleeping machine); it was refused before it was listed.
  'daemon.paused',
  // M11.2: config.yaml read again; the keys applied and the keys that wait for a restart.
  'config.reloaded',
  // M9: browser sign-in and agents started from the interface (docs/frontend/PLAN.md §5).
  'ui.session_started',
  'ui.session_ended',
  'agent.process_started',
  'agent.process_exited',
  'control.task_stopped',
  // The Master Brain began a model call, so a client can show it thinking (plan M9 §5.11).
  'brain.call_started',
]);

const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const TERMINAL_TASK = new Set(['COMPLETED', 'CANCELLED', 'ABANDONED']);
/** The Master Brain's questions about what to do with a failed task (not `ambiguous_intent`). */
/**
 * Friday's own questions about one task's way forward (plan M9 §5.7): answering them only records
 * text, so Friday answers them itself, as moot, once their cause is resolved.
 */
const RECOVERY_QUESTIONS = new Set(['recovery_needed']);
const ROUTING_QUESTIONS = new Set(['routing_blocked', 'routing_violated']);
const INTEGRATION_QUESTIONS = new Set(['integration_conflict', 'integration_failed']);
const SYSTEM_QUESTIONS = new Set([...RECOVERY_QUESTIONS, ...ROUTING_QUESTIONS, ...INTEGRATION_QUESTIONS]);
const FAILURE_QUESTIONS = new Set([
  'planner_unavailable',
  'budget_exceeded',
  'invalid_plan',
  'repeated_verification_failures',
  'replan_limit',
  'plan_rejected',
  'action_failed',
]);
const SYSTEM: Actor = { kind: 'system', id: 'friday' };
const LEASE_MANAGER: Actor = { kind: 'system', id: 'lease-manager' };

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** Dollars in a message: `$0.0123`, `$2`; the binary noise of a sum does not show. */
const usd = (n: number): string => `$${Number(n.toFixed(6))}`;

/**
 * How long an attempt stays open after its reported cost reached the task's spending cap (plan
 * M11.5). A spawn adapter sends what the attempt reported about itself (`host.usage` among it) and
 * then, in the same delivery, how the attempt ended; a report of the end that arrives within this
 * grace is recorded as what it is, so finished, paid-for work is not run again (plan rule B31). A few
 * seconds are enough: the two calls follow each other at once, and only a Friday out of reach between
 * them makes the second one late. The grace is counted from the `budget.exceeded` record and judged
 * by `tick`, so it is as coarse as the tick.
 */
export const BUDGET_STOP_GRACE_MS = 5_000;

/** A cap stop on record for an attempt that is still open (`budget.exceeded`, plan M11.5). */
interface CapStop {
  /** When the cap was reached: the grace counts from here. */
  at: string;
  attempt: number;
  cost_usd: number;
  cap_usd: number;
}

/** The fatal error an attempt ends with at the task's spending cap; the recovery assessment names it. */
const capReason = (s: CapStop): string =>
  `budget_exceeded: attempt ${s.attempt} reported ${usd(s.cost_usd)}, at or above the task's spending cap of ${usd(s.cap_usd)} (routing.task_budget_usd)`;
const RUN_EVENT: Partial<Record<RunStatus, string>> = {
  ACTIVE: 'run.accepted',
  DECLINED: 'run.declined',
  SUSPENDED: 'run.suspended',
  ENDED: 'run.ended',
};

/**
 * Friday's project state: every M1 operation as an atomic command over the event log.
 * The daemon, tests and (later) the planner all go through this class.
 */
export class FridayState {
  readonly db: SqlDatabase;
  readonly store: EventStore;
  readonly projector: StateProjector;
  readonly transport: EventTransport;
  readonly bus: CommandBus;
  readonly q: Queries;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly redactor: Redactor;
  /** The daemon's router (ADR-0031 §6). */
  private router: RunRouter | undefined;
  readonly artifacts: ArtifactStore | undefined;
  /** The project's artifacts folder (`.friday/artifacts`); snapshots live in its `snapshots/`. */
  readonly artifactsDir: string | undefined;
  readonly config: StateConfig;
  /** Scoped memory (M4c, ADR-0021). */
  readonly memory: MemoryService;
  /** Project and goal intent (ADR-0034 §1–§3). */
  readonly intent: IntentService;
  /** Learnings agents propose for the project (ADR-0034 §7). */
  readonly learnings: LearningService;
  /** Runtime readiness: what Friday has seen of each host and model here (ADR-0035). */
  readonly readiness: ReadinessService;
  /**
   * Per project: sessions that last reported at or before `since` are not judged until `until`
   * (daemon start, after a pause), because they could not report in between.
   */
  private readonly leaseGrace = new Map<string, { since: string; until: string }>();

  constructor(deps: {
    db: SqlDatabase;
    ids?: IdGenerator;
    clock?: Clock;
    transport?: EventTransport;
    redactor?: Redactor;
    artifactsDir?: string;
    config?: Partial<StateConfig>;
    migrate?: boolean;
    /** Open an inspection copy made by replay (for analysis only; M3.1, R08). */
    inspection?: boolean;
  }) {
    this.db = deps.db;
    if (!deps.inspection && isInspectionCopy(this.db)) {
      throw new FridayError(
        'invalid_request',
        `${this.db.path} is an inspection copy made by "friday events replay", not a backup; Friday does not run on it. Restore from "friday backup" instead`,
      );
    }
    this.ids = deps.ids ?? randomIds;
    this.clock = deps.clock ?? systemClock;
    this.redactor = deps.redactor ?? new Redactor();
    this.config = { ...DEFAULT_STATE_CONFIG, ...deps.config };
    if (deps.migrate !== false) migrate(this.db, ALL_MIGRATIONS);
    this.store = new EventStore(this.db, { ids: this.ids, clock: this.clock, redactor: this.redactor });
    this.projector = new StateProjector(this.db);
    this.transport = deps.transport ?? new InProcessTransport();
    this.q = new Queries(this.db);
    this.bus = new CommandBus({
      db: this.db,
      store: this.store,
      projector: this.projector,
      transport: this.transport,
      ids: this.ids,
      clock: this.clock,
      idempotencyTtlMs: this.config.idempotencyTtlMs,
    });
    this.artifactsDir = deps.artifactsDir;
    this.memory = new MemoryService(this);
    this.intent = new IntentService(this);
    this.learnings = new LearningService(this);
    this.readiness = new ReadinessService(this);
    this.artifacts = deps.artifactsDir
      ? new ArtifactStore(this.db, deps.artifactsDir, { ids: this.ids, clock: this.clock, redactor: this.redactor })
      : undefined;
  }

  private exec<T>(meta: CommandMeta, fn: (ctx: CommandContext) => T): T {
    return this.bus.execute(meta, fn).result;
  }

  // ================================================================ transition helpers

  private moveTask(
    ctx: CommandContext,
    task: TaskView,
    trigger: TaskTrigger,
    opts: {
      actorKind?: ActorKind;
      actor?: Actor;
      waiting_reason?: WaitingReason;
      reason?: string;
      changes?: Record<string, unknown>;
    } = {},
  ): TaskView {
    const actor = opts.actor ?? (opts.actorKind ? { kind: opts.actorKind, id: ctx.actor.id } : ctx.actor);
    const req: Parameters<typeof transitionTask>[1] = { trigger, actor: actor.kind };
    if (opts.waiting_reason) req.waiting_reason = opts.waiting_reason;
    if (opts.reason) req.reason = opts.reason;
    const res = transitionTask(task.status, req);
    if (!res.ok) throw res.error;
    const tr = res.value;
    const transition: Record<string, string> = { from: tr.from, to: tr.to, trigger: tr.trigger };
    if (tr.reason) transition.reason = tr.reason;
    const changes: Record<string, unknown> = { waiting_reason: tr.waiting_reason, ...(opts.changes ?? {}) };
    if (tr.to === 'COMPLETED') changes.completed_at = ctx.now;
    if (tr.to === 'CANCELLED') changes.cancelled_at = ctx.now;
    const refs: { kind: 'task' | 'run'; id: string }[] = [{ kind: 'task', id: task.task_id }];
    const runRef = (changes.current_run_id as string | undefined) ?? task.current_run_id;
    if (runRef) refs.push({ kind: 'run', id: runRef });
    ctx.emit({ type: tr.event, actor, payload: { task_id: task.task_id, transition, changes }, refs });
    if (tr.to === 'REWORK' || tr.to === 'COMPLETED' || tr.to === 'CANCELLED') {
      this.settleFailureQuestions(ctx, task.task_id, tr.to);
    }
    // A cancelled task needs none of Friday's questions about it; a task that got a run needs no
    // answer about why routing could not start one (plan M9 §5.7).
    if (tr.to === 'CANCELLED') this.settleQuestions(ctx, task.task_id, SYSTEM_QUESTIONS, 'the task was cancelled');
    if (tr.to === 'ASSIGNED' || tr.to === 'RUNNING') {
      this.settleQuestions(ctx, task.task_id, ROUTING_QUESTIONS, 'the task got a run');
    }
    const awaitsIntegration = tr.to === 'COMPLETED' && this.awaitsIntegration(task);
    if ((tr.to === 'COMPLETED' && !awaitsIntegration) || tr.to === 'CANCELLED' || tr.to === 'ABANDONED') {
      this.endFileReservations(ctx, task.task_id, 'released', `the task was ${tr.to.toLowerCase()}`);
    }
    return this.q.task(ctx.project_id, task.task_id);
  }

  /**
   * The Master Brain's open questions about what to do with a failed task no longer need an answer
   * once the task was sent back for rework, completed or cancelled: they are answered as moot, in
   * the same transaction, and an answer marked moot starts no revision (LESSONS D-50).
   */
  private settleFailureQuestions(ctx: CommandContext, taskId: string, to: 'REWORK' | 'COMPLETED' | 'CANCELLED'): void {
    const why = { REWORK: 'was sent back for rework', COMPLETED: 'was completed', CANCELLED: 'was cancelled' }[to];
    for (const e of this.q.escalations(ctx.project_id, 'pending')) {
      if (e.task_id !== taskId || e.requested_by_kind !== 'master_brain') continue;
      if (!FAILURE_QUESTIONS.has(String(e.kind))) continue;
      ctx.emit({
        type: 'escalation.answered',
        actor: SYSTEM,
        payload: { escalation_id: e.escalation_id, answer: `no longer needed: the task ${why}`, moot: true },
        refs: [{ kind: 'escalation', id: String(e.escalation_id) }],
      });
    }
  }

  /** Answers a task's pending questions of these kinds as moot, in the caller's transaction. */
  private settleQuestions(ctx: CommandContext, taskId: string, kinds: Set<string>, why: string): void {
    for (const e of this.q.escalations(ctx.project_id, 'pending')) {
      if (e.task_id !== taskId || !kinds.has(String(e.kind))) continue;
      ctx.emit({
        type: 'escalation.answered',
        actor: SYSTEM,
        payload: { escalation_id: e.escalation_id, answer: `no longer needed: ${why}`, moot: true },
        refs: [{ kind: 'escalation', id: String(e.escalation_id) }],
      });
    }
  }

  /**
   * A human performed a recovery action on a task: its recovery question is answered (plan M9 §5.7),
   * so the Master Brain no longer skips the task and the card goes away.
   */
  settleRecoveryQuestions(projectId: string, actor: Actor, taskId: string, action: string): void {
    this.exec({ name: 'escalation.settle', project_id: projectId, actor, params: { taskId, action } }, (ctx) =>
      this.settleQuestions(ctx, taskId, RECOVERY_QUESTIONS, `recovery action ${action} was performed`),
    );
  }

  /**
   * A goal's task that worked on its own task branch is not done when it completes: its verified
   * work still has to reach the goal branch (ADR-0025 §2).
   */
  awaitsIntegration(task: TaskView): boolean {
    return Boolean(task.goal_id && this.q.worktreeForTask(task.task_id));
  }

  /** Ends every active file reservation a task holds, inside the caller's transaction. */
  private endFileReservations(
    ctx: CommandContext,
    taskId: string,
    status: 'released' | 'expired',
    note: string,
  ): string[] {
    const ended: string[] = [];
    for (const r of this.q.fileReservations(ctx.project_id, ['active'])) {
      if (r.task_id !== taskId) continue;
      ctx.emit({
        type: 'file.reservation_ended',
        payload: { reservation_id: r.reservation_id, task_id: taskId, pattern: r.pattern, status, note },
        refs: [
          { kind: 'reservation', id: r.reservation_id },
          { kind: 'task', id: taskId },
        ],
      });
      ended.push(r.reservation_id);
    }
    return ended;
  }

  private updateTaskFields(ctx: CommandContext, taskId: string, changes: Record<string, unknown>): TaskView {
    ctx.emit({ type: 'task.updated', payload: { task_id: taskId, changes }, refs: [{ kind: 'task', id: taskId }] });
    return this.q.task(ctx.project_id, taskId);
  }

  /**
   * Where a new run works (ADR-0023 §2–§3): an attach session in its own checkout; a spawn run in
   * its task's worktree (reused when it exists, else prepared by the daemon: `pending`); without
   * worktrees, in the main checkout.
   */
  private workspaceFor(
    ctx: CommandContext,
    projectId: string,
    task: TaskView,
    harness: HarnessRecord,
    head: string | null = null,
  ): Workspace {
    const root = this.q.project(projectId)?.root_path ?? '.';
    if (harness.attach_mode !== 'spawn') {
      // A session in a task worktree works from that worktree's base (verification diffs against it);
      // elsewhere, from the commit its checkout was at when it claimed, which the daemon read just
      // before: what it commits during the task is then judged too (LESSONS D-41).
      const tree = harness.host_cwd ? this.q.worktreeAt(projectId, harness.host_cwd) : undefined;
      return {
        execution_root: harness.host_cwd ?? root,
        base_commit: tree?.base_commit ?? head ?? null,
        branch_ref: tree?.branch ?? null,
        workspace: 'ready',
      };
    }
    if (this.config.worktreeMode !== 'per_task') {
      return { execution_root: root, base_commit: null, branch_ref: null, workspace: 'ready' };
    }
    const wt = this.q.worktreeForTask(task.task_id);
    // An operation of an earlier attempt still owns the worktree: the daemon stops it, and only
    // then prepares the worktree for this run (review F07). A worktree of another clone is never
    // reused (review F08): the daemon decides what the run gets.
    const owned = this.q.operationRuns(projectId, { task_id: task.task_id, status: 'running', limit: 1 }).length > 0;
    if (wt && existsSync(wt.path) && !owned && this.inThisClone(wt.path)) {
      if (wt.status !== 'active') {
        ctx.emit({
          type: 'worktree.released',
          payload: { worktree_id: wt.worktree_id, status: 'active', reason: 'reused by a new attempt' },
          refs: [
            { kind: 'task', id: task.task_id },
            { kind: 'worktree', id: wt.worktree_id },
          ],
        });
      }
      return { execution_root: wt.path, base_commit: wt.base_commit, branch_ref: wt.branch, workspace: 'ready' };
    }
    return { execution_root: null, base_commit: null, branch_ref: null, workspace: 'pending' };
  }

  /** Whether a task worktree's path is in this clone's worktree folder (review F08). */
  inThisClone(dir: string): boolean {
    const root = this.config.worktreeRoot;
    if (!root) return true;
    const norm = (p: string) => {
      const r = path.resolve(p);
      return process.platform === 'win32' ? r.toLowerCase() : r;
    };
    const rel = path.relative(norm(root), norm(dir));
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  private createRun(
    ctx: CommandContext,
    task: TaskView,
    harnessId: string,
    agentId: string,
    ws: Workspace = { execution_root: null, base_commit: null, branch_ref: null, workspace: 'ready' },
  ): RunView {
    // Nobody else works where an operation of an earlier attempt still runs (review F07).
    const owner = this.q.operationRuns(ctx.project_id, { task_id: task.task_id, status: 'running', limit: 1 })[0];
    if (owner && ws.workspace === 'ready') {
      throw new FridayError(
        'invalid_state_transition',
        `${owner.operation} (${owner.operation_run_id}) of an earlier attempt of ${task.task_id} is still being stopped; try again in a moment`,
      );
    }
    const run_id = this.ids.next('run');
    const attempt = this.q.maxAttempt(task.task_id) + 1;
    const snapshot = this.intent.snapshot(
      ctx.project_id,
      task.goal_id ? this.q.findGoal(ctx.project_id, task.goal_id) : null,
    );
    ctx.emit({
      type: 'run.created',
      payload: {
        run: {
          run_id,
          task_id: task.task_id,
          harness_id: harnessId,
          agent_id: agentId,
          attempt,
          ...ws,
          // What the run starts under (ADR-0034 §8), so a later change can be named to it.
          intent: { version: snapshot.version, snapshot },
        },
      },
      refs: [
        { kind: 'task', id: task.task_id },
        { kind: 'run', id: run_id },
        { kind: 'harness', id: harnessId },
      ],
    });
    const harness = this.q.harness(harnessId);
    if (harness.observed_model) {
      // The session already said which model it runs (ADR-0031 §7).
      ctx.emit({
        type: 'run.model_observed',
        payload: { run_id, task_id: task.task_id, model: harness.observed_model, basis: 'session' },
        refs: [
          { kind: 'run', id: run_id },
          { kind: 'task', id: task.task_id },
        ],
      });
    }
    this.routeWithin(ctx, task, harness, agentId, run_id);
    return this.q.run(run_id);
  }

  /**
   * The model a new run should use (ADR-0031 §6), decided by the daemon's router in the run's own
   * transaction. A decision that blocks the work stops the run before it exists (review F01): the
   * transaction is abandoned with `routing_blocked`, and the caller records the block. A router
   * that fails cannot show that the work may run here, so it blocks too.
   */
  private routeWithin(ctx: CommandContext, task: TaskView, harness: HarnessRecord, agentId: string, runId: string) {
    if (!this.router) return;
    let decision: RunRouting['decision'];
    try {
      const r = this.router({ task, harness, agent: this.q.agent(agentId) });
      if (!r) return;
      decision = r.decision;
    } catch (e) {
      decision = {
        mode: 'unknown',
        task_class: task.kind,
        model: null,
        binding: false,
        blocked: true,
        source: 'none',
        reason:
          `routing failed: ${(e as Error).message}; a human decides ("friday routing explain ${task.task_id}")`.slice(
            0,
            500,
          ),
        reason_codes: ['router.error'],
      };
    }
    // The host failure the attempt before ended with, when one did (ADR-0035 §4): the receipt names
    // the failed attempt, its host, model and failure, beside what was chosen next.
    const failover_from = this.readiness.failoverFrom(ctx.project_id, task.task_id, runId);
    if (failover_from) decision = { ...decision, failover_from };
    if (decision.blocked) {
      throw new FridayError('routing_blocked', `routing does not let ${task.task_id} start here: ${decision.reason}`, {
        task_id: task.task_id,
        harness_id: harness.harness_id,
        decision,
      });
    }
    // A route that allows the work now answers an earlier question about its block.
    for (const e of this.q.escalations(ctx.project_id, 'pending')) {
      if (e.task_id === task.task_id && e.kind === 'routing_blocked') {
        ctx.emit({
          type: 'escalation.answered',
          payload: {
            escalation_id: e.escalation_id,
            answer: `routing allows it now: ${decision.reason}`.slice(0, 500),
          },
          refs: [{ kind: 'escalation', id: String(e.escalation_id) }],
        });
      }
    }
    ctx.emit({
      type: 'routing.decided',
      payload: {
        decision_id: this.ids.next('route'),
        task_id: task.task_id,
        run_id: runId,
        harness_id: harness.harness_id,
        decision,
      },
      refs: [
        { kind: 'task', id: task.task_id },
        { kind: 'run', id: runId },
      ],
    });
  }

  /** Sets the daemon's router (ADR-0031 §6); without one, runs carry no model. */
  setRouter(router: RunRouter | undefined): void {
    this.router = router;
  }

  /** A human pins a model for a scope (spec Part 12 §11, ADR-0031 §4). */
  pinRouting(
    projectId: string,
    actor: Actor,
    p: Omit<RoutingPinView, 'pin_id' | 'source' | 'created_at' | 'revoked_at'>,
  ): RoutingPinView {
    if (actor.kind !== 'human') throw new FridayError('permission_denied', 'only a human pins routing');
    if (!p.model && !p.sensitive && !p.needs_vision) {
      throw new FridayError('invalid_request', 'a pin names a model, or marks the work sensitive or visual');
    }
    if ((p.scope === 'project') !== (p.target === null)) {
      throw new FridayError('invalid_request', 'a project pin has no target; a kind, role or task pin names one');
    }
    return this.exec({ name: 'routing.pin', project_id: projectId, actor, params: p }, (ctx) => {
      if (p.until && p.until <= ctx.now) throw new FridayError('invalid_request', 'the pin would already have expired');
      const pin_id = this.ids.next('pin');
      // Named fields only: nothing else a caller passes reaches the record.
      const pin = {
        pin_id,
        scope: p.scope,
        target: p.target,
        model: p.model,
        sensitive: p.sensitive,
        needs_vision: p.needs_vision,
        until: p.until,
        note: p.note,
        source: `${actor.kind}:${actor.id}`,
      };
      ctx.emit({
        type: 'routing.pinned',
        payload: { pin },
        refs: [
          { kind: 'routing', id: pin_id },
          ...(p.scope === 'task' && p.target ? [{ kind: 'task' as const, id: p.target }] : []),
        ],
      });
      return this.q.routingPin(pin_id) as RoutingPinView;
    });
  }

  unpinRouting(projectId: string, actor: Actor, pinId: string): RoutingPinView {
    if (actor.kind !== 'human') throw new FridayError('permission_denied', 'only a human changes routing pins');
    return this.exec({ name: 'routing.unpin', project_id: projectId, actor, params: { pinId } }, (ctx) => {
      const pin = this.q.routingPin(pinId);
      if (!pin) throw new FridayError('invalid_request', `routing pin ${pinId} not found`);
      if (pin.revoked_at) return pin;
      ctx.emit({ type: 'routing.unpinned', payload: { pin_id: pinId }, refs: [{ kind: 'routing', id: pinId }] });
      return this.q.routingPin(pinId) as RoutingPinView;
    });
  }

  /**
   * The model a host reports running (ADR-0031 §7): for one run (an adapter), or for a session
   * (Claude Code's SessionStart), which its later runs inherit.
   */
  observeModel(
    projectId: string,
    actor: Actor,
    target: { run_id: string } | { harness_id: string },
    model: string,
    basis: string,
  ): void {
    const m = model.trim().slice(0, 200);
    if (!m) return;
    this.exec({ name: 'model.observe', project_id: projectId, actor, params: { target, model: m, basis } }, (ctx) => {
      if ('run_id' in target) {
        const run = this.q.run(target.run_id);
        if (run.model_observed === m && run.model_basis === basis) return;
        ctx.emit({
          type: 'run.model_observed',
          payload: { run_id: run.run_id, task_id: run.task_id, model: m, basis },
          refs: [
            { kind: 'run', id: run.run_id },
            { kind: 'task', id: run.task_id },
          ],
        });
        this.holdToConstraints(ctx, projectId, run, m);
        return;
      }
      const harness = this.q.harness(target.harness_id);
      if (harness.observed_model === m) return;
      ctx.emit({
        type: 'harness.model_observed',
        payload: { harness_id: harness.harness_id, model: m, basis },
        refs: [{ kind: 'harness', id: harness.harness_id }],
      });
      // A run already under way in this session ran on it too.
      const agent = this.q.agents(projectId).find((a) => a.harness_id === harness.harness_id);
      const run = agent?.current_run_id ? this.q.findRun(agent.current_run_id) : undefined;
      if (run && run.status !== 'ENDED') {
        ctx.emit({
          type: 'run.model_observed',
          payload: { run_id: run.run_id, task_id: run.task_id, model: m, basis },
          refs: [
            { kind: 'run', id: run.run_id },
            { kind: 'task', id: run.task_id },
          ],
        });
        this.holdToConstraints(ctx, projectId, run, m);
      }
    });
  }

  /**
   * A run routed under hard constraints (local only, vision, sensitive work) whose host reports a
   * model other than the one routed: the declaration that it applies models is not trusted over
   * what it reports (review F01). The attempt ends, and a human is asked before the task runs again.
   */
  private holdToConstraints(ctx: CommandContext, projectId: string, run: RunView, observed: string): void {
    const d = run.routing_decision_id ? this.q.routingDecision(run.routing_decision_id) : undefined;
    if (!d?.constraints?.length || d.model === null || d.model === observed) return;
    const task = this.q.task(projectId, run.task_id);
    if (task.current_run_id !== run.run_id || !['RUNNING', 'WAITING', 'ASSIGNED'].includes(task.status)) return;
    const reason = `the host reports running ${observed}, but ${d.constraints.join(', ')} allowed only ${d.model}`;
    ctx.emit({
      type: 'routing.violated',
      payload: { task_id: run.task_id, run_id: run.run_id, requested: d.model, observed, constraints: d.constraints },
      refs: [
        { kind: 'task', id: run.task_id },
        { kind: 'run', id: run.run_id },
      ],
    });
    // Released first: releasing expires the run's outbox, and the host must still be told to stop.
    this.releaseWithin(ctx, projectId, SYSTEM, run.task_id, reason);
    const h = this.q.findHarness(run.harness_id);
    if (run.status === 'ACTIVE' && h?.attach_mode === 'spawn') {
      this.enqueue(
        ctx,
        run.harness_id,
        'task.cancel',
        { task_id: run.task_id, run_id: run.run_id, reason },
        run.run_id,
      );
    }
    this.escalationWithin(ctx, {
      kind: 'routing_violated',
      goal_id: task.goal_id ?? null,
      task_id: run.task_id,
      question: `${run.task_id} was stopped: ${reason}`,
      options: [
        `friday routing explain ${run.task_id}`,
        'friday routing pin --task <task> --model <model>',
        `friday task cancel ${run.task_id}`,
      ],
      details: { run_id: run.run_id, requested: d.model, observed, constraints: d.constraints },
    });
  }

  /** Laya's answer to a task's routing question, stored for the decision that comes later (ADR-0031 §10). */
  recordLayaAnswer(
    projectId: string,
    answer: {
      task_id: string;
      question_id: string;
      checkpoint: string;
      choice: string;
      confidence: number;
      basis: string;
      options: number;
      probabilities: Record<string, number> | null;
      latency_ms: number;
    },
  ): void {
    const actor: Actor = { kind: 'system', id: 'laya' };
    this.exec({ name: 'laya.answer', project_id: projectId, actor, params: { task_id: answer.task_id } }, (ctx) => {
      ctx.emit({
        type: 'laya.answered',
        payload: { answer: { answer_id: this.ids.next('route'), ...answer } },
        refs: [{ kind: 'task', id: answer.task_id }],
      });
    });
  }

  /** A human records thresholds fitted on labelled answers (`friday laya calibrate`). */
  recordLayaCalibrations(
    projectId: string,
    actor: Actor,
    calibrations: {
      checkpoint: string;
      shape: string;
      threshold: number | null;
      accuracy: number | null;
      coverage: number;
      support: number;
      target: number;
    }[],
    source: string,
  ): void {
    if (actor.kind !== 'human') throw new FridayError('permission_denied', 'only a human calibrates Laya');
    this.exec(
      { name: 'laya.calibrate', project_id: projectId, actor, params: { count: calibrations.length } },
      (ctx) => {
        ctx.emit({
          type: 'laya.calibrated',
          payload: {
            source: source.slice(0, 200),
            calibrations: calibrations.map((c) => ({ calibration_id: this.ids.next('route'), ...c })),
          },
        });
      },
    );
  }

  /**
   * The outcome of a verified run for its model (ADR-0031 §8): the model observed running, else
   * the one requested, recorded with that basis (review F15: only observed outcomes are measured
   * evidence), the host's version and the checks that judged it, so only comparable outcomes are
   * counted together.
   */
  private recordOutcome(
    ctx: CommandContext,
    task: TaskView,
    runId: string | null,
    passed: boolean,
    checksVersion: string | null,
  ): void {
    const run = runId ? this.q.findRun(runId) : undefined;
    const model = run?.model_observed ?? run?.model_requested;
    if (!run || !model) return;
    const decision = run.routing_decision_id ? this.q.routingDecision(run.routing_decision_id) : undefined;
    const ended = run.ended_at ?? ctx.now;
    const started = run.accepted_at ?? run.created_at;
    const harness = this.q.findHarness(run.harness_id);
    ctx.emit({
      type: 'routing.outcome_recorded',
      payload: {
        outcome: {
          outcome_id: this.ids.next('oc'),
          task_id: task.task_id,
          run_id: run.run_id,
          model,
          basis: run.model_observed ? 'observed' : 'requested',
          task_class: decision?.task_class ?? task.kind,
          task_kind: task.kind,
          harness_version: harness ? hostCohort(harness.vendor, harness.version) : null,
          checks_version: checksVersion,
          outcome: passed ? 'passed' : 'failed',
          attempt: run.attempt,
          duration_ms: Math.max(0, Date.parse(ended) - Date.parse(started)) || null,
        },
      },
      refs: [
        { kind: 'task', id: task.task_id },
        { kind: 'run', id: run.run_id },
      ],
    });
  }

  private moveRun(
    ctx: CommandContext,
    run: RunView,
    to: RunStatus,
    trigger: string,
    changes: Record<string, unknown> = {},
    actor?: Actor,
  ): RunView {
    if (!canRunTransition(run.status, to)) {
      throw new FridayError('invalid_state_transition', `run ${run.run_id} cannot move from ${run.status} to ${to}`);
    }
    const type = run.status === 'SUSPENDED' && to === 'ACTIVE' ? 'run.resumed' : (RUN_EVENT[to] ?? 'run.updated');
    const payload = { run_id: run.run_id, transition: { from: run.status, to, trigger }, changes };
    ctx.emit({
      type,
      ...(actor ? { actor } : {}),
      payload,
      refs: [
        { kind: 'run', id: run.run_id },
        { kind: 'task', id: run.task_id },
      ],
    });
    return this.q.run(run.run_id);
  }

  private endRun(
    ctx: CommandContext,
    run: RunView | undefined,
    outcome: string,
    extra: Record<string, unknown> = {},
    actor?: Actor,
  ) {
    if (!run || run.status === 'ENDED' || run.status === 'DECLINED') return;
    this.moveRun(ctx, run, 'ENDED', outcome, { outcome, ended_at: ctx.now, ...extra }, actor);
  }

  private moveAgent(
    ctx: CommandContext,
    agent: AgentView,
    to: AgentStatus,
    changes: Record<string, unknown> = {},
    actor?: Actor,
  ): AgentView {
    if (agent.status === to) {
      if (Object.keys(changes).length > 0) {
        ctx.emit({
          type: 'agent.updated',
          ...(actor ? { actor } : {}),
          payload: { agent_id: agent.agent_id, changes },
          refs: [{ kind: 'agent', id: agent.agent_id }],
        });
      }
      return this.q.agent(agent.agent_id);
    }
    if (!canAgentTransition(agent.status, to)) {
      throw new FridayError(
        'invalid_state_transition',
        `agent ${agent.agent_key} cannot move from ${agent.status} to ${to}`,
      );
    }
    ctx.emit({
      type: 'agent.status_changed',
      ...(actor ? { actor } : {}),
      payload: { agent_id: agent.agent_id, transition: { from: agent.status, to, trigger: 'state' }, changes },
      refs: [{ kind: 'agent', id: agent.agent_id }],
    });
    return this.q.agent(agent.agent_id);
  }

  /** Walks the agent to BUSY through the allowed intermediate states. */
  private agentToBusy(ctx: CommandContext, agent: AgentView, changes: Record<string, unknown>): void {
    let a = agent;
    if (a.status === 'REGISTERED') a = this.moveAgent(ctx, a, 'AVAILABLE');
    if (a.status === 'AVAILABLE') a = this.moveAgent(ctx, a, 'ASSIGNED', changes);
    if (a.status === 'WAITING' || a.status === 'ASSIGNED' || a.status === 'DISCONNECTED') {
      this.moveAgent(ctx, a, 'BUSY', changes);
    } else if (a.status === 'BUSY') this.moveAgent(ctx, a, 'BUSY', changes);
  }

  /** Frees the agent if it is still working on `taskId`. */
  private releaseAgent(ctx: CommandContext, agentId: string | null, taskId: string, actor?: Actor): void {
    if (!agentId) return;
    const agent = this.q.findAgent(agentId);
    if (!agent || agent.current_task_id !== taskId) return;
    const changes = { current_task_id: null, current_run_id: null };
    if (agent.status === 'DISCONNECTED' || agent.status === 'TERMINATED' || agent.status === 'UNHEALTHY') {
      this.moveAgent(ctx, agent, agent.status, changes, actor);
    } else {
      this.moveAgent(ctx, agent, 'AVAILABLE', changes, actor);
    }
  }

  private moveHarness(
    ctx: CommandContext,
    harness: HarnessView,
    to: HarnessStatus,
    trigger: string,
    changes: Record<string, unknown> = {},
    actor?: Actor,
  ): void {
    if (harness.status === to) {
      if (Object.keys(changes).length > 0) {
        ctx.emit({
          type: 'harness.updated',
          ...(actor ? { actor } : {}),
          payload: { harness_id: harness.harness_id, changes },
          refs: [{ kind: 'harness', id: harness.harness_id }],
        });
      }
      return;
    }
    if (!canHarnessTransition(harness.status, to)) {
      throw new FridayError('invalid_state_transition', `harness cannot move from ${harness.status} to ${to}`);
    }
    ctx.emit({
      type: 'harness.status_changed',
      ...(actor ? { actor } : {}),
      payload: { harness_id: harness.harness_id, transition: { from: harness.status, to, trigger }, changes },
      refs: [{ kind: 'harness', id: harness.harness_id }],
    });
  }

  /** READY ⇄ BUSY follows whether the harness has an active run. */
  private syncHarnessBusy(ctx: CommandContext, harnessId: string): void {
    const h = this.q.findHarness(harnessId);
    if (!h || !['READY', 'BUSY'].includes(h.status)) return;
    const busy = this.q.activeRunsForHarness(harnessId).length > 0;
    this.moveHarness(ctx, h, busy ? 'BUSY' : 'READY', busy ? 'run_active' : 'runs_idle');
  }

  // ================================================================ project and tasks

  ensureProject(input: { project_id: string; name: string; root_path: string }): void {
    const known = this.q.project(input.project_id);
    if (!known) {
      this.exec({ name: 'project.ensure', project_id: input.project_id, actor: SYSTEM }, (ctx) => {
        ctx.emit({ type: 'project.created', payload: { name: input.name, root_path: input.root_path } });
      });
      return;
    }
    // A database restored into another clone, or a checkout that moved: the project now lives here,
    // and new runs work here, never in the checkout the database came from (review F08).
    const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
    if (norm(known.root_path) === norm(input.root_path)) return;
    this.exec({ name: 'project.relocate', project_id: input.project_id, actor: SYSTEM }, (ctx) => {
      ctx.emit({ type: 'project.relocated', payload: { from: known.root_path, to: input.root_path } });
    });
  }

  /**
   * Persists a task's role contract (R2) and emits `task.role_resolved`. Resolution happens once
   * when the task is created or a human/classifier changes its role, so routing cannot drift with
   * a later agent or registry lookup.
   */
  private resolveTaskRoleWithin(
    ctx: CommandContext,
    taskId: string,
    origin: TaskRoleOrigin,
    explicitRole: string | null,
    opts: {
      decision?: RoleDecision | null;
      preferDecision?: boolean;
      intentVersion?: string | null;
      /** Reopened because the intent changed (ADR-0034 §4): the classifier may be asked again. */
      reclassify?: boolean;
    } = {},
  ): TaskRoleDecisionView {
    const task = this.q.task(ctx.project_id, taskId);
    // The contract is keyed by the effective intent and the task's own facts (ADR-0034 §4).
    const effective = this.intent.effectiveVersion(
      ctx.project_id,
      task.goal_id ? this.q.findGoal(ctx.project_id, task.goal_id) : null,
    );
    const resolution = resolveTaskRoleContract({
      task,
      origin,
      explicit_role: explicitRole,
      registry: ROLE_REGISTRY_SOURCE,
      decision: opts.decision ?? null,
      prefer_decision: opts.preferDecision ?? false,
      intent_version: opts.intentVersion ?? `${effective}:${taskRoleIntentVersion(task)}`,
    });
    const decision_id = this.ids.next('rdec');
    const decision = {
      ...resolution,
      decision_id,
      project_id: ctx.project_id,
      task_id: taskId,
      created_at: ctx.now,
    };
    ctx.emit({
      type: 'task.role_resolved',
      payload: { task_id: taskId, decision, ...(opts.reclassify ? { reclassify: true } : {}) },
      refs: [
        { kind: 'task', id: taskId },
        ...(task.goal_id ? [{ kind: 'goal' as const, id: task.goal_id }] : []),
        ...(task.plan_id ? [{ kind: 'plan' as const, id: task.plan_id }] : []),
      ],
    });
    const stored = this.q.latestTaskRoleDecision(ctx.project_id, taskId);
    if (!stored) throw new Error(`task ${taskId}: role resolution was not projected`);
    return stored;
  }

  /**
   * The intent changed (ADR-0034 §4, §8): the project's, or one goal's. Work not started whose role
   * a model chose is reopened so the classifier decides again under the new intent; every agent
   * holding affected work gets a notice naming what changed, and its next packet says so too.
   * Running work is never re-routed.
   */
  intentChangedWithin(ctx: CommandContext, goalId: string | null): void {
    const pid = ctx.project_id;
    const tasks = goalId ? this.q.goalTasks(pid, goalId) : this.q.tasks(pid, { limit: 5000 });
    for (const t of tasks) {
      if (TERMINAL_TASK.has(t.status)) continue;
      if (
        t.role_source === 'decision_model' &&
        (t.status === 'PROPOSED' || t.status === 'READY') &&
        !t.assigned_agent_id
      ) {
        this.resolveTaskRoleWithin(ctx, t.task_id, 'none', null, { reclassify: true });
        continue;
      }
      if (!t.assigned_agent_id || !t.current_run_id) continue;
      const run = this.q.findRun(t.current_run_id);
      if (!run || run.status === 'ENDED' || run.status === 'DECLINED') continue;
      const goal = t.goal_id ? this.q.findGoal(pid, t.goal_id) : null;
      if (run.intent_version === this.intent.effectiveVersion(pid, goal)) continue;
      const agent = this.q.findAgent(t.assigned_agent_id);
      if (!agent) continue;
      const changes = this.intent.changesSince(pid, this.q.runIntentSnapshot(run.run_id), goal);
      if (!changes.length) continue;
      this.sendWithin(
        ctx,
        pid,
        { kind: 'system', actor: SYSTEM },
        {
          to: agent.agent_key,
          mode: 'notification',
          priority: 'high',
          subject: `Intent changed for ${t.task_id}`,
          content: [
            'What this work is for changed while you work on it. Keep going, but make your work fit the new intent:',
            ...changes.map((c) => `- ${c}`),
            'Your verification is reviewed against the new intent.',
          ].join('\n'),
          task_id: t.task_id,
        },
      );
    }
  }

  /**
   * A human approves a stored multi-role proposal by splitting the task (ADR-0035 §5): one task per
   * proposed role, in dependency order, each with the proposal's summary for that role and the
   * original's kind, scope, acceptance criteria, priority, risk and goal; the roles' `depends_on`
   * become task dependencies. The original is cancelled as split, and whatever depended on it now
   * depends on the split's last tasks. A task of a goal is split through a plan revision this same
   * approval approves, so the planner stays the one authority for a goal's tasks (ADR-0013), and its
   * parts carry the plan's role; a standalone task's parts carry the human's. Neither asks the
   * classifier again.
   */
  splitTask(projectId: string, actor: Actor, taskId: string, note: string | null = null): TaskSplitResult {
    if (actor.kind !== 'human') throw new FridayError('permission_denied', 'only a human splits a task');
    const task = this.q.task(projectId, taskId);
    const decision = this.q.latestTaskRoleDecision(projectId, taskId);
    if (!decision || decision.status !== 'proposed' || decision.roles.length < 2) {
      throw new FridayError(
        'invalid_request',
        `no multi-role proposal waits for approval on ${taskId}${decision ? ` (its latest role decision is ${decision.status})` : ''}`,
      );
    }
    if (!['PROPOSED', 'READY', 'ASSIGNED', 'WAITING'].includes(task.status)) {
      throw new FridayError(
        'invalid_state_transition',
        `task ${taskId} is ${task.status}; only a task whose work has not started is split`,
      );
    }
    const parts = this.splitParts(task, decision);
    if (task.goal_id) {
      const goal = this.q.goal(projectId, task.goal_id);
      const active = goal.plan_id ? this.q.latestPlanVersion(goal.plan_id, ['ACTIVE']) : undefined;
      const scope = task.scope ?? { write: [], read: [] };
      const common = {
        kind: task.kind,
        acceptance_criteria: task.acceptance_criteria,
        scope,
        priority: task.priority,
        risk_level: task.risk_level,
      };
      const plan = this.proposePlan(projectId, actor, task.goal_id, {
        summary: `Split ${taskId} by role: ${parts.map((p) => p.role).join(', ')}`,
        rationale: `${actor.id} approved the multi-role proposal ${decision.decision_id}${note ? `: ${note}` : ''}`,
        needs_human: null,
        trigger: `task split: ${taskId}`,
        base_version: active?.version ?? null,
        tasks: [
          {
            ...common,
            key: task.plan_key ?? taskId,
            change: 'drop',
            task_id: taskId,
            summary: task.summary,
            description: task.description,
            depends_on: [],
            role: task.role ?? (parts[0]?.role as string),
            note: `split into ${parts.map((p) => p.key).join(', ')}`,
          },
          ...parts.map((p) => ({
            ...common,
            key: p.key,
            change: 'new' as const,
            task_id: null,
            summary: p.summary,
            description: p.description,
            depends_on: [...p.depends_on_keys, ...task.dependencies],
            role: p.role,
            note: `from the split of ${taskId}`,
          })),
        ],
      });
      const approval = this.approvePlan(projectId, actor, plan.plan_id, plan.version, note ?? undefined);
      this.exec({ name: 'task.split', project_id: projectId, actor, params: { taskId, note } }, (ctx) =>
        this.finishSplit(ctx, projectId, task, decision, approval.created, {
          plan_id: plan.plan_id,
          version: plan.version,
        }),
      );
      return {
        original: this.q.task(projectId, taskId),
        subtasks: approval.created.map((t) => this.q.task(projectId, t.task_id)),
        plan: approval.plan,
      };
    }
    return this.exec({ name: 'task.split', project_id: projectId, actor, params: { taskId, note } }, (ctx) => {
      const idOfKey = new Map<string, string>();
      const created: TaskView[] = [];
      for (const p of parts) {
        const task_id = this.ids.next('task');
        idOfKey.set(p.key, task_id);
        const dependencies = [...p.depends_on_keys.map((k) => idOfKey.get(k) as string), ...task.dependencies];
        ctx.emit({
          type: 'task.created',
          payload: {
            task: {
              task_id,
              role: p.role,
              kind: task.kind,
              summary: p.summary,
              description: p.description,
              acceptance_criteria: task.acceptance_criteria,
              priority: task.priority,
              risk_level: task.risk_level,
              scope: task.scope,
              dependencies,
              reserved_for_agent_key: null,
              reserved_by: null,
              reserved_until: null,
              created_by: actor,
            },
          },
          refs: [{ kind: 'task', id: task_id }],
        });
        this.resolveTaskRoleWithin(ctx, task_id, 'human', p.role);
        let part = this.q.task(projectId, task_id);
        // The original was already offered to agents: so is each part whose prerequisites are done.
        if (task.status !== 'PROPOSED' && this.q.openDependencies(task_id).length === 0) {
          part = this.moveTask(ctx, part, 'task.ready');
        }
        created.push(part);
      }
      this.finishSplit(ctx, projectId, task, decision, created, null);
      return {
        original: this.q.task(projectId, taskId),
        subtasks: created.map((t) => this.q.task(projectId, t.task_id)),
        plan: null,
      };
    });
  }

  /** The proposal's roles as the parts of a split, keyed uniquely and in dependency order. */
  private splitParts(
    task: TaskView,
    decision: TaskRoleDecisionView,
  ): { key: string; role: string; summary: string; description: string; depends_on_keys: string[] }[] {
    const counts = new Map<string, number>();
    const keyed = decision.roles.map((r) => {
      const n = (counts.get(r.role) ?? 0) + 1;
      counts.set(r.role, n);
      return { ...r, key: n === 1 ? r.role : `${r.role}-${n}` };
    });
    const keys = new Set(keyed.map((k) => k.key));
    for (const k of keyed) {
      for (const d of k.depends_on) {
        if (!keys.has(d)) {
          throw new FridayError(
            'invalid_request',
            `the proposal's ${k.role} depends on "${d}", which names no role of the proposal`,
          );
        }
      }
    }
    const order: typeof keyed = [];
    const done = new Set<string>();
    while (order.length < keyed.length) {
      const next = keyed.find((k) => !done.has(k.key) && k.depends_on.every((d) => done.has(d)));
      if (!next) throw new FridayError('invalid_request', "the proposal's dependencies form a cycle");
      done.add(next.key);
      order.push(next);
    }
    const description = `Split from ${task.task_id} (${task.summary}).${task.description ? `\n\n${task.description}` : ''}`;
    return order.map((k) => ({
      key: k.key,
      role: k.role,
      summary: k.task_summary,
      description,
      depends_on_keys: k.depends_on,
    }));
  }

  /**
   * The end of a split: whatever depended on the original now depends on the split's last parts
   * (those nothing else in the split depends on), a standalone original is cancelled as split (a
   * plan revision dropped a goal task already), and the split is on record.
   */
  private finishSplit(
    ctx: CommandContext,
    projectId: string,
    task: TaskView,
    decision: TaskRoleDecisionView,
    subtasks: readonly TaskView[],
    plan: { plan_id: string; version: number } | null,
  ): void {
    const ids = subtasks.map((t) => t.task_id);
    const inner = new Set(subtasks.flatMap((t) => this.q.dependencies(t.task_id)));
    const leaves = ids.filter((id) => !inner.has(id));
    for (const dependent of this.q.dependents(task.task_id)) {
      const next = [...new Set([...this.q.dependencies(dependent).filter((d) => d !== task.task_id), ...leaves])];
      ctx.emit({
        type: 'task.dependencies_changed',
        payload: {
          task_id: dependent,
          dependencies: next,
          reason: `${task.task_id} was split into ${ids.join(', ')}`,
        },
        refs: [{ kind: 'task', id: dependent }],
      });
    }
    if (!plan) this.cancelWithin(ctx, projectId, task.task_id, `split into ${ids.join(', ')}`);
    ctx.emit({
      type: 'task.split',
      payload: { task_id: task.task_id, decision_id: decision.decision_id, subtasks: ids, plan },
      refs: [{ kind: 'task', id: task.task_id }, ...ids.map((id) => ({ kind: 'task' as const, id }))],
    });
  }

  /** A human deliberately replaces an existing task's stored role contract (R2). */
  assignTaskRole(projectId: string, actor: Actor, taskId: string, role: string): TaskView {
    if (actor.kind !== 'human') throw new FridayError('permission_denied', 'only a human can assign a task role');
    const named = role.trim();
    if (!named) throw new FridayError('invalid_request', 'name the role');
    return this.exec({ name: 'task.role', project_id: projectId, actor, params: { taskId, role: named } }, (ctx) => {
      const task = this.q.task(projectId, taskId);
      if (task.status === 'COMPLETED' || task.status === 'CANCELLED') {
        throw new FridayError('invalid_state_transition', `task ${taskId} is ${task.status}`);
      }
      this.resolveTaskRoleWithin(ctx, taskId, 'human', named);
      return this.q.task(projectId, taskId);
    });
  }

  /**
   * Records an already-validated decision-model result (R2). Multi-role output is stored as a
   * proposed DAG with no single `role`, so nothing can dispatch it by guessing.
   */
  recordTaskRoleDecision(
    projectId: string,
    actor: Actor,
    taskId: string,
    decision: RoleDecision,
    opts: { intent_version?: string | null; idempotency_key?: string } = {},
  ): TaskView {
    return this.exec(
      {
        name: 'task.role_decision',
        project_id: projectId,
        actor,
        idempotency_key: opts.idempotency_key,
        params: { taskId, decision, intent_version: opts.intent_version ?? null },
      },
      (ctx) => {
        const task = this.q.task(projectId, taskId);
        if (task.role && !['decision_model', 'none'].includes(task.role_source ?? 'none')) {
          throw new FridayError(
            'invalid_state_transition',
            `task ${taskId} already has a ${task.role_source ?? 'task'} role (${task.role}); a classifier may not override it`,
          );
        }
        this.resolveTaskRoleWithin(ctx, taskId, 'none', null, {
          decision,
          preferDecision: true,
          intentVersion: opts.intent_version ?? null,
        });
        return this.q.task(projectId, taskId);
      },
    );
  }

  createTask(
    projectId: string,
    actor: Actor,
    input: z.input<typeof TaskCreateRequest>,
    opts: { idempotency_key?: string } = {},
  ): TaskView {
    const req = TaskCreateRequest.parse(input);
    return this.exec(
      { name: 'task.create', project_id: projectId, actor, idempotency_key: opts.idempotency_key, params: req },
      (ctx) => {
        for (const dep of req.depends_on) this.q.task(projectId, dep);
        const task_id = this.ids.next('task');
        const scope: TaskScope | null = req.scope ? { write: req.scope.write ?? [], read: req.scope.read ?? [] } : null;
        ctx.emit({
          type: 'task.created',
          payload: {
            task: {
              task_id,
              role: req.role ?? null,
              kind: req.kind,
              summary: req.summary,
              description: req.description ?? null,
              acceptance_criteria: req.acceptance_criteria,
              priority: req.priority,
              risk_level: req.risk_level,
              scope,
              dependencies: req.depends_on,
              reserved_for_agent_key: req.assign_agent_key ?? null,
              reserved_by: req.assign_agent_key ? 'human' : null,
              reserved_until: null,
              created_by: actor,
            },
          },
          refs: [{ kind: 'task', id: task_id }],
        });
        this.resolveTaskRoleWithin(ctx, task_id, req.role ? 'task' : 'none', req.role ?? null);
        let task = this.q.task(projectId, task_id);
        if (req.ready || req.assign_agent_key) task = this.moveTask(ctx, task, 'task.ready');
        return task;
      },
    );
  }

  readyTask(projectId: string, actor: Actor, taskId: string): TaskView {
    return this.exec({ name: 'task.ready', project_id: projectId, actor, params: { taskId } }, (ctx) =>
      this.moveTask(ctx, this.q.task(projectId, taskId), 'task.ready'),
    );
  }

  /**
   * Operator assignment. A live spawn-mode harness receives `task.start` through the outbox.
   * Otherwise (attach mode, or no session yet) the task is reserved for the agent, which claims it.
   */
  assignTask(
    projectId: string,
    actor: Actor,
    taskId: string,
    agentKey: string,
  ): { mode: 'assigned' | 'reserved'; task: TaskView } {
    return this.routed(projectId, () =>
      this.exec({ name: 'task.assign', project_id: projectId, actor, params: { taskId, agentKey } }, (ctx) =>
        this.assignWithin(ctx, projectId, taskId, agentKey),
      ),
    );
  }

  // ================================================================ pause, resume, halt (M9)

  /** Refuses new work while a human has paused Friday (docs/frontend/PLAN.md §5.4). */
  private assertNotPaused(projectId: string): void {
    if (this.q.control(projectId).paused) {
      throw new FridayError('permission_denied', 'Friday is paused; a human resumes it before new work starts');
    }
  }

  /** Pauses the project: no delegation, claims, starts or operations; mutating tool calls are denied. */
  pauseProject(projectId: string, actor: Actor, reason: string | null): ControlState {
    if (actor.kind !== 'human') throw new FridayError('permission_denied', 'only a human can pause Friday');
    this.exec({ name: 'control.pause', project_id: projectId, actor, params: { reason } }, (ctx) => {
      if (this.q.control(projectId).paused) return;
      ctx.emit({ type: 'control.paused', payload: { reason }, refs: [] });
    });
    return this.q.control(projectId);
  }

  /**
   * Resumes the project. Spawned tasks that ended their turn blocked while Friday was paused (their
   * tool calls were refused) continue in their sessions (plan M9 §5.6); withheld starts go out.
   */
  resumeProject(projectId: string, actor: Actor): ControlState {
    if (actor.kind !== 'human') throw new FridayError('permission_denied', 'only a human can resume Friday');
    this.exec({ name: 'control.resume', project_id: projectId, actor, params: {} }, (ctx) => {
      const control = this.q.control(projectId);
      if (!control.paused) return;
      const pausedAt = control.changed_at;
      ctx.emit({ type: 'control.resumed', payload: {}, refs: [] });
      // Starts and resumes held during the pause go out now: they get a fresh expiry, as if queued
      // at this moment, so a pause longer than their expiry does not drop them (review M9i).
      this.db
        .prepare(
          "UPDATE outbox_messages SET expires_at = ? WHERE project_id = ? AND method IN ('task.start', 'task.resume') AND status = 'queued'",
        )
        .run(addMs(ctx.now, this.config.ackTimeoutMs * this.config.maxDeliveryAttempts * 2), projectId);
      if (!pausedAt) return;
      for (const t of this.q.tasks(projectId, { statuses: ['WAITING'] })) {
        if (t.waiting_reason !== 'blocked') continue;
        const waited = this.store.readByRef(projectId, 'task', t.task_id, {
          types: ['task.waiting'],
          limit: 1,
          desc: true,
        })[0];
        if (!waited || waited.occurred_at < pausedAt) continue;
        this.queueContinue(ctx, projectId, t, 'Friday was paused and runs again: continue the task.');
      }
    });
    return this.q.control(projectId);
  }

  /**
   * Stops one running attempt for a halt: its task goes back to READY and a live spawn host is told
   * to stop, as recovery's reassign does (ADR-0026). The caller preserved the worktree's work first.
   */
  haltTask(projectId: string, actor: Actor, taskId: string, reason: string, preservedRef: string | null): TaskView {
    if (actor.kind !== 'human') throw new FridayError('permission_denied', 'only a human can halt Friday');
    const task = this.exec(
      { name: 'control.halt_task', project_id: projectId, actor, params: { taskId, reason } },
      (ctx) => {
        const before = this.q.task(projectId, taskId);
        const run = before.current_run_id ? this.q.findRun(before.current_run_id) : undefined;
        const released = this.releaseWithin(ctx, projectId, actor, taskId, `halted: ${reason}`);
        const h = run ? this.q.findHarness(run.harness_id) : undefined;
        if (
          run?.status === 'ACTIVE' &&
          h?.attach_mode === 'spawn' &&
          !['DISCONNECTED', 'TERMINATED'].includes(h.status)
        ) {
          this.enqueue(
            ctx,
            run.harness_id,
            'task.cancel',
            { task_id: taskId, run_id: run.run_id, reason: `halted: ${reason}` },
            run.run_id,
          );
        }
        return released;
      },
    );
    this.recordObservation(
      projectId,
      actor,
      'control.task_stopped',
      { task_id: taskId, reason, preserved_ref: preservedRef },
      [{ kind: 'task', id: taskId }],
    );
    return task;
  }

  /** Records a halt once its attempts are stopped (Friday stays paused). */
  recordHalt(
    projectId: string,
    actor: Actor,
    reason: string | null,
    stopped: { task_id: string; preserved_ref: string | null }[],
  ): ControlState {
    if (actor.kind !== 'human') throw new FridayError('permission_denied', 'only a human can halt Friday');
    this.exec({ name: 'control.halt', project_id: projectId, actor, params: { reason } }, (ctx) => {
      ctx.emit({ type: 'control.halted', payload: { reason, stopped }, refs: [] });
    });
    return this.q.control(projectId);
  }

  /**
   * Runs a command that may create a run. When routing blocks it, nothing of the command commits;
   * the block is recorded in its own transaction (review F01), and the error goes to the caller.
   */
  private routed<T>(projectId: string, command: () => T): T {
    try {
      return command();
    } catch (e) {
      if (isFridayError(e, 'routing_blocked')) {
        try {
          this.recordRoutingBlock(projectId, e.details as RoutingBlock);
        } catch {
          // Recording is best effort: the block itself already held.
        }
      }
      throw e;
    }
  }

  /**
   * A route that blocks a task's work (review F01): one `routing.blocked` event per new reason,
   * and one question to a human while the task waits for an answer. A later route that allows the
   * work answers it.
   */
  /** The Master Brain found no agent whose route lets the task start (review F01). */
  noteRoutingBlocked(projectId: string, taskId: string, reason: string): void {
    this.recordRoutingBlock(projectId, {
      task_id: taskId,
      harness_id: null,
      decision: {
        mode: 'unknown',
        task_class: this.q.task(projectId, taskId).kind,
        model: null,
        binding: false,
        blocked: true,
        source: 'none',
        reason: `no available agent may run it: ${reason}`,
        reason_codes: ['delegation.all_blocked'],
      },
    });
  }

  private recordRoutingBlock(projectId: string, b: RoutingBlock): void {
    const reason = String(b.decision.reason);
    this.exec(
      { name: 'routing.block', project_id: projectId, actor: SYSTEM, params: { task_id: b.task_id } },
      (ctx) => {
        const last = this.store.readByRef(projectId, 'task', b.task_id, { types: ['routing.blocked'] }).at(-1);
        const lastReason = (last?.payload as { decision?: { reason?: string } } | undefined)?.decision?.reason;
        if (lastReason !== reason) {
          ctx.emit({
            type: 'routing.blocked',
            payload: { task_id: b.task_id, harness_id: b.harness_id, decision: b.decision },
            refs: [
              { kind: 'task', id: b.task_id },
              ...(b.harness_id ? [{ kind: 'harness' as const, id: b.harness_id }] : []),
            ],
          });
        }
        const asked = this.q
          .escalations(projectId, 'pending')
          .some((e) => e.task_id === b.task_id && e.kind === 'routing_blocked');
        if (!asked) {
          const task = this.q.task(projectId, b.task_id);
          this.escalationWithin(ctx, {
            kind: 'routing_blocked',
            goal_id: task.goal_id ?? null,
            task_id: b.task_id,
            question: `${b.task_id} cannot start: ${reason}`,
            options: [
              `friday routing explain ${b.task_id}`,
              'friday routing pin --task <task> --model <model>',
              `friday task cancel ${b.task_id}`,
            ],
            details: { harness_id: b.harness_id, reason_codes: b.decision.reason_codes ?? [] },
          });
        }
      },
    );
  }

  private assignWithin(
    ctx: CommandContext,
    projectId: string,
    taskId: string,
    agentKey: string,
  ): { mode: 'assigned' | 'reserved'; task: TaskView } {
    // Every assignment passes here: an operator's and the Master Brain's delegation (plan M9 §5.5).
    this.assertNotPaused(projectId);
    {
      let task = this.q.task(projectId, taskId);
      if (task.status === 'PROPOSED') task = this.moveTask(ctx, task, 'task.ready');
      if (task.status !== 'READY') {
        throw new FridayError('invalid_state_transition', `only READY tasks can be assigned (task is ${task.status})`);
      }
      const agent = this.q.agentByKey(projectId, agentKey);
      const harness = agent?.harness_id ? this.q.findHarness(agent.harness_id) : undefined;
      const canPush =
        agent &&
        harness &&
        harness.attach_mode === 'spawn' &&
        !harness.shadow &&
        agent.status === 'AVAILABLE' &&
        this.q.isHarnessLive(harness.harness_id, ctx.now) &&
        this.enforcementGap(harness) === null;
      if (!canPush || !agent || !harness) {
        // A human's choice stays until a human changes it; the Master Brain's expires (review F08).
        const byHuman = ctx.actor.kind === 'human';
        return {
          mode: 'reserved' as const,
          task: this.updateTaskFields(ctx, taskId, {
            reserved_for_agent_key: agentKey,
            reserved_by: byHuman ? 'human' : 'master_brain',
            reserved_until: byHuman ? null : addMs(ctx.now, this.config.reservationTtlMs),
          }),
        };
      }
      const ws = this.workspaceFor(ctx, projectId, task, harness);
      const run = this.createRun(ctx, task, harness.harness_id, agent.agent_id, ws);
      task = this.moveTask(ctx, task, 'task.assign', {
        changes: {
          assigned_agent_id: agent.agent_id,
          assigned_harness_id: harness.harness_id,
          current_run_id: run.run_id,
          reserved_for_agent_key: null,
          reserved_by: null,
          reserved_until: null,
        },
      });
      this.moveAgent(ctx, agent, 'ASSIGNED', { current_task_id: task.task_id, current_run_id: run.run_id });
      // A run waiting for its worktree gets task.start once the daemon prepared it (ADR-0023 §2).
      if (ws.workspace === 'ready') {
        this.enqueue(
          ctx,
          harness.harness_id,
          'task.start',
          this.taskStartParams(projectId, task, run, agent.role),
          run.run_id,
        );
      }
      return { mode: 'assigned' as const, task };
    }
  }

  /** Attach-mode pull path (Friday extension, ADR-0007): the agent takes a task and starts it. */
  /**
   * An attached session takes a task. `head` is the commit the session's checkout is at, read by the
   * daemon just before: a run outside a task worktree starts from it (LESSONS D-41).
   */
  claimTask(
    projectId: string,
    caller: Caller,
    p: { task_id?: string | undefined; next?: boolean | undefined },
    opts: { idempotency_key?: string | undefined; head?: string | null } = {},
  ): { task: TaskView; run_id: string; attempt: number; resumed: boolean } {
    const actor: Actor = { kind: 'agent', id: caller.agent_id };
    return this.routed(projectId, () => this.claimWithin(projectId, caller, actor, p, opts));
  }

  private claimWithin(
    projectId: string,
    caller: Caller,
    actor: Actor,
    p: { task_id?: string | undefined; next?: boolean | undefined },
    opts: { idempotency_key?: string | undefined; head?: string | null },
  ): { task: TaskView; run_id: string; attempt: number; resumed: boolean } {
    this.assertNotPaused(projectId);
    return this.exec(
      { name: 'task.claim', project_id: projectId, actor, idempotency_key: opts.idempotency_key, params: p },
      (ctx) => {
        const harness = this.q.harness(caller.harness_id);
        if (['DISCONNECTED', 'TERMINATED'].includes(harness.status)) {
          throw new FridayError('harness_disconnected', 'this session is disconnected; restart it to claim work');
        }
        const agent = this.q.agent(caller.agent_id);
        if (harness.shadow || agent.harness_id !== caller.harness_id) {
          throw new FridayError(
            'harness_shadowed',
            `agent ${agent.agent_key} is already attached to another live session; use a different agent key`,
          );
        }
        const gap = this.enforcementGap(harness);
        if (gap) throw new FridayError('enforcement_insufficient', gap);
        // A session in a task's worktree works on that task; a task's worktree holds its work (ADR-0023 §3).
        const sessionTree = harness.host_cwd ? this.q.worktreeAt(projectId, harness.host_cwd) : undefined;
        const task = p.task_id
          ? this.q.task(projectId, p.task_id)
          : this.pickNext(projectId, agent, sessionTree?.task_id);
        if (!task) throw new FridayError('task_not_found', 'no task is ready for this agent');
        if (sessionTree && sessionTree.task_id !== task.task_id) {
          throw new FridayError(
            'permission_denied',
            `this session works in the worktree of ${sessionTree.task_id} (${sessionTree.path}); claim that task, or start a session in the checkout of ${task.task_id}`,
            { rule: 'claim.worktree_mismatch' },
          );
        }
        const taskTree = this.q.worktreeForTask(task.task_id);
        if (!sessionTree && taskTree) {
          throw new FridayError(
            'permission_denied',
            `the work of ${task.task_id} is in its worktree ${taskTree.path}; start a session there to continue it`,
            { rule: 'claim.worktree_elsewhere' },
          );
        }
        const active = this.q.activeRunForAgent(agent.agent_id);
        if (active && active.task_id !== task.task_id) {
          throw new FridayError(
            'agent_unavailable',
            `agent ${agent.agent_key} is already working on ${active.task_id}`,
          );
        }
        const busy = { current_task_id: task.task_id };

        if (task.status === 'READY') {
          if (task.reserved_for_agent_key && task.reserved_for_agent_key !== agent.agent_key) {
            throw new FridayError(
              'permission_denied',
              `task ${task.task_id} is reserved for ${task.reserved_for_agent_key}`,
            );
          }
          const open = this.q.openDependencies(task.task_id);
          if (open.length > 0) {
            throw new FridayError('invalid_state_transition', `task ${task.task_id} waits on ${open.join(', ')}`, {
              open,
            });
          }
          const run = this.createRun(
            ctx,
            task,
            harness.harness_id,
            agent.agent_id,
            this.workspaceFor(ctx, projectId, task, harness, opts.head ?? null),
          );
          let t = this.moveTask(ctx, task, 'task.claim', {
            changes: {
              assigned_agent_id: agent.agent_id,
              assigned_harness_id: harness.harness_id,
              current_run_id: run.run_id,
              reserved_for_agent_key: null,
              reserved_by: null,
              reserved_until: null,
            },
          });
          this.moveRun(ctx, run, 'ACTIVE', 'claimed', { accepted_at: ctx.now, session_ref: harness.host_session_id });
          t = this.moveTask(ctx, t, 'run.accepted', { changes: { started_at: t.started_at ?? ctx.now } });
          this.agentToBusy(ctx, agent, { ...busy, current_run_id: run.run_id });
          this.syncHarnessBusy(ctx, harness.harness_id);
          return { task: t, run_id: run.run_id, attempt: run.attempt, resumed: false };
        }

        if (task.assigned_agent_id !== agent.agent_id) {
          throw new FridayError(
            'permission_denied',
            `task ${task.task_id} is ${task.status} and assigned to another agent`,
          );
        }
        const current = task.current_run_id ? this.q.findRun(task.current_run_id) : undefined;

        if (task.status === 'ASSIGNED' && current?.status === 'STARTING' && current.harness_id === harness.harness_id) {
          this.moveRun(ctx, current, 'ACTIVE', 'claimed', {
            accepted_at: ctx.now,
            session_ref: harness.host_session_id,
          });
          const t = this.moveTask(ctx, task, 'run.accepted', { changes: { started_at: task.started_at ?? ctx.now } });
          this.ackPendingStart(ctx, current.run_id);
          this.agentToBusy(ctx, agent, { ...busy, current_run_id: current.run_id });
          this.syncHarnessBusy(ctx, harness.harness_id);
          return { task: t, run_id: current.run_id, attempt: current.attempt, resumed: false };
        }

        if (['RUNNING', 'WAITING', 'HARNESS_LOST'].includes(task.status)) {
          if (current && current.harness_id === harness.harness_id && current.status === 'ACTIVE') {
            return { task, run_id: current.run_id, attempt: current.attempt, resumed: false };
          }
          if (current && current.harness_id === harness.harness_id && current.status === 'SUSPENDED') {
            // Same session came back within the reconnect window: continue the same run (conformance case 10).
            this.moveRun(ctx, current, 'ACTIVE', 'resumed');
            const t = task.status === 'HARNESS_LOST' ? this.moveTask(ctx, task, 'run.resumed') : task;
            this.agentToBusy(ctx, this.q.agent(agent.agent_id), { ...busy, current_run_id: current.run_id });
            this.syncHarnessBusy(ctx, harness.harness_id);
            return { task: t, run_id: current.run_id, attempt: current.attempt, resumed: true };
          }
          this.endRun(ctx, current, 'released');
          const run = this.createRun(
            ctx,
            task,
            harness.harness_id,
            agent.agent_id,
            this.workspaceFor(ctx, projectId, task, harness, opts.head ?? null),
          );
          this.moveRun(ctx, run, 'ACTIVE', 'resumed', { accepted_at: ctx.now, session_ref: harness.host_session_id });
          const moved =
            task.status === 'HARNESS_LOST'
              ? this.moveTask(ctx, task, 'run.resumed', {
                  changes: { assigned_harness_id: harness.harness_id, current_run_id: run.run_id },
                })
              : this.updateTaskFields(ctx, task.task_id, {
                  assigned_harness_id: harness.harness_id,
                  current_run_id: run.run_id,
                });
          this.agentToBusy(ctx, this.q.agent(agent.agent_id), { ...busy, current_run_id: run.run_id });
          this.syncHarnessBusy(ctx, harness.harness_id);
          return { task: moved, run_id: run.run_id, attempt: run.attempt, resumed: true };
        }
        throw new FridayError(
          'invalid_state_transition',
          `task ${task.task_id} is ${task.status} and cannot be claimed`,
        );
      },
    );
  }

  private pickNext(projectId: string, agent: AgentView, onlyTask?: string): TaskView | undefined {
    if (onlyTask) return this.q.findTask(projectId, onlyTask);
    const mine = this.q
      .tasks(projectId, { statuses: ['HARNESS_LOST', 'RUNNING', 'WAITING', 'ASSIGNED'] })
      .filter((t) => t.assigned_agent_id === agent.agent_id);
    if (mine[0]) return mine[0];
    const ready = this.q
      .tasks(projectId, { statuses: ['READY'] })
      .filter((t) => !t.reserved_for_agent_key || t.reserved_for_agent_key === agent.agent_key)
      .filter((t) => this.q.openDependencies(t.task_id).length === 0);
    ready.sort((a, b) => {
      const reserved = Number(Boolean(b.reserved_for_agent_key)) - Number(Boolean(a.reserved_for_agent_key));
      if (reserved !== 0) return reserved;
      const pr = (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9);
      return pr !== 0 ? pr : a.created_at.localeCompare(b.created_at);
    });
    return ready[0];
  }

  /** Tasks this agent could claim right now, assigned ones first. */
  claimableTasks(projectId: string, agentKey: string, limit = 10): TaskView[] {
    const agent = this.q.agentByKey(projectId, agentKey);
    const mine = agent
      ? this.q
          .tasks(projectId, { statuses: ['HARNESS_LOST', 'RUNNING', 'WAITING', 'ASSIGNED'] })
          .filter((t) => t.assigned_agent_id === agent.agent_id)
      : [];
    const ready = this.q
      .tasks(projectId, { statuses: ['READY'] })
      .filter((t) => !t.reserved_for_agent_key || t.reserved_for_agent_key === agentKey)
      .filter((t) => this.q.openDependencies(t.task_id).length === 0);
    return [...mine, ...ready].slice(0, limit);
  }

  private requireOwnedRun(caller: Caller, taskId: string, runId: string): RunView {
    const run = this.q.findRun(runId);
    if (!run || run.task_id !== taskId)
      throw new FridayError('run_not_found', `run ${runId} does not belong to task ${taskId}`);
    if (run.harness_id !== caller.harness_id || run.agent_id !== caller.agent_id) {
      throw new FridayError('permission_denied', `run ${runId} belongs to another session`);
    }
    return run;
  }

  /** Progress and RUNNING ⇄ WAITING from the agent. */
  updateTask(
    projectId: string,
    caller: Caller,
    p: {
      task_id: string;
      run_id: string;
      status?: 'running' | 'waiting' | undefined;
      waiting_reason?: WaitingReason | undefined;
      note?: string | undefined;
      percent?: number | undefined;
      changed_paths?: string[] | undefined;
      idempotency_key?: string | undefined;
    },
  ): { task_status: TaskView['status']; event_id: string } {
    const actor: Actor = { kind: 'agent', id: caller.agent_id };
    return this.exec(
      { name: 'task.update', project_id: projectId, actor, idempotency_key: p.idempotency_key, params: p },
      (ctx) => {
        const run = this.requireOwnedRun(caller, p.task_id, p.run_id);
        let task = this.q.task(projectId, p.task_id);
        if (run.status !== 'ACTIVE')
          throw new FridayError('invalid_state_transition', `run ${run.run_id} is ${run.status}`);
        if (p.status === 'waiting' && task.status === 'RUNNING') {
          task = this.moveTask(ctx, task, 'task.wait', {
            waiting_reason: p.waiting_reason ?? 'blocked',
            reason: p.note,
          });
          const agent = this.q.agent(caller.agent_id);
          if (agent.status === 'BUSY') this.moveAgent(ctx, agent, 'WAITING');
        } else if (p.status === 'running' && task.status === 'WAITING') {
          task = this.moveTask(ctx, task, 'task.resume');
          const agent = this.q.agent(caller.agent_id);
          if (agent.status === 'WAITING') this.moveAgent(ctx, agent, 'BUSY');
        }
        if (p.changed_paths?.length) this.emitPaths(ctx, run, p.changed_paths);
        const event = ctx.emit({
          type: 'agent.event',
          payload: {
            task_id: task.task_id,
            run_id: run.run_id,
            event_type: 'progress',
            note: p.note ?? null,
            percent: p.percent ?? null,
            status: task.status,
          },
          refs: [
            { kind: 'task', id: task.task_id },
            { kind: 'run', id: run.run_id },
          ],
        });
        return { task_status: task.status, event_id: event.event_id };
      },
    );
  }

  /** `agent.result`: a completion claim (never a completion) or a block. */
  submitResult(
    projectId: string,
    caller: Caller,
    p: z.output<typeof AgentResultParams>,
  ): {
    task_status: TaskView['status'];
    verification_status: VerificationStatus;
    observed_changed_paths: string[];
    discrepancies: { path: string; note: string }[];
  } {
    const actor: Actor = { kind: 'agent', id: caller.agent_id };
    return this.exec(
      { name: 'agent.result', project_id: projectId, actor, idempotency_key: p.idempotency_key, params: p },
      (ctx) => {
        const run = this.requireOwnedRun(caller, p.task_id, p.run_id);
        let task = this.q.task(projectId, p.task_id);
        if (run.status !== 'ACTIVE')
          throw new FridayError('invalid_state_transition', `run ${run.run_id} is ${run.status}`);
        if (p.status === 'blocked') {
          if (task.status === 'RUNNING') {
            task = this.moveTask(ctx, task, 'task.wait', {
              waiting_reason: 'blocked',
              reason: p.blocked_reason ?? p.summary,
            });
          }
          const agent = this.q.agent(caller.agent_id);
          if (agent.status === 'BUSY') this.moveAgent(ctx, agent, 'WAITING');
          return {
            task_status: task.status,
            verification_status: 'NOT_REQUESTED',
            observed_changed_paths: run.observed_paths,
            discrepancies: [],
          };
        }
        if (task.status === 'WAITING') task = this.moveTask(ctx, task, 'task.resume');
        const observed = run.observed_paths;
        const claimed = [...new Set(p.changed_paths.map(normalizePath))].sort();
        const discrepancies = [
          ...claimed
            .filter((c) => !observed.includes(c))
            .map((path) => ({ path, note: 'claimed but not observed by Friday' })),
          ...observed
            .filter((o) => !claimed.includes(o))
            .map((path) => ({ path, note: 'changed but not listed in the claim' })),
        ];
        this.endRun(ctx, run, 'completed_claim', {
          claim: {
            summary: p.summary,
            changed_paths: claimed,
            checks: p.checks,
            notes: p.notes,
            risks: p.risks,
            discrepancies,
            // The intent current when the work was claimed (ADR-0034 §8), beside the one it started under.
            intent_version: this.intent.effectiveVersion(
              projectId,
              task.goal_id ? this.q.findGoal(projectId, task.goal_id) : null,
            ),
          },
        });
        task = this.moveTask(ctx, task, 'agent.completion_claim', { reason: p.summary.slice(0, 200) });
        // The host and model took the work to a claim: signed in, for seven days (ADR-0035 §1).
        this.readiness.observeCompletion(ctx, projectId, this.q.run(run.run_id), this.q.harness(caller.harness_id));
        this.releaseAgent(ctx, caller.agent_id, task.task_id);
        this.syncHarnessBusy(ctx, caller.harness_id);
        return {
          task_status: task.status,
          verification_status: 'NOT_REQUESTED',
          observed_changed_paths: observed,
          discrepancies,
        };
      },
    );
  }

  /** A host failure benches the host and model the attempt ran on (ADR-0035 §3). */
  private benchRun(ctx: CommandContext, projectId: string, run: RunView, failure: HostFailure, detail: string): void {
    const harness = this.q.harness(run.harness_id);
    this.readiness.benchWithin(ctx, projectId, {
      host: harness.vendor,
      model: run.model_observed ?? run.model_requested ?? null,
      failure,
      source: `run:${run.run_id}`,
      detail,
    });
  }

  reportAgentError(
    projectId: string,
    caller: Caller,
    p: {
      task_id: string;
      run_id: string;
      message: string;
      fatal: boolean;
      /** Why the host failed, when the adapter could tell (ADR-0035 §3); absent for a work failure. */
      failure?: HostFailure | undefined;
      idempotency_key?: string | undefined;
    },
  ): { task_status: TaskView['status'] } {
    const actor: Actor = { kind: 'agent', id: caller.agent_id };
    return this.exec(
      { name: 'agent.error', project_id: projectId, actor, idempotency_key: p.idempotency_key, params: p },
      (ctx) => {
        const run = this.requireOwnedRun(caller, p.task_id, p.run_id);
        let task = this.q.task(projectId, p.task_id);
        ctx.emit({
          type: 'agent.event',
          payload: {
            task_id: task.task_id,
            run_id: run.run_id,
            event_type: 'error',
            message: p.message,
            fatal: p.fatal,
            ...(p.failure ? { failure: p.failure } : {}),
          },
          refs: [{ kind: 'task', id: task.task_id }],
        });
        if (!p.fatal) return { task_status: task.status };
        if (run.status === 'ENDED' || run.status === 'DECLINED' || task.current_run_id !== run.run_id) {
          // The attempt is already over (Friday ended it at the task's spending cap once the grace
          // had passed, or a human released it): the error is on record, and the task's state is no
          // longer this attempt's to change.
          return { task_status: task.status };
        }
        if (run.status === 'STARTING') {
          // The work never started (Friday had not heard that the run was accepted): the harness
          // could not take it, which is a decline, and the task is free again. The host is benched
          // for the failure the adapter saw, else as one that could not start (ADR-0035 §3).
          this.benchRun(ctx, projectId, run, p.failure ?? { kind: 'start' }, p.message);
          this.declineWithin(ctx, projectId, run, `the harness could not start: ${p.message}`.slice(0, 500), {
            kind: 'harness',
            id: caller.harness_id,
          });
          this.syncHarnessBusy(ctx, caller.harness_id);
          return { task_status: this.q.task(projectId, p.task_id).status };
        }
        const stop = this.capStopOf(projectId, run.run_id);
        if (stop && (task.status === 'RUNNING' || task.status === 'WAITING')) {
          // The attempt had reached the task's spending cap, and this is how it ended (a host stopped
          // by its own cap reports its error after its usage, plan M11.5): the host's error is on
          // record, and the attempt ends at the cap now, for a human to decide, never for the
          // recovery sweep to retry.
          return { task_status: this.endAtCap(ctx, run, task, stop).status };
        }
        if (task.status === 'RUNNING') {
          task = this.moveTask(ctx, task, 'task.wait', {
            waiting_reason: 'agent_error',
            reason: p.message.slice(0, 200),
          });
        } else if (task.status === 'WAITING') {
          task = this.updateTaskFields(ctx, task.task_id, { waiting_reason: 'agent_error' });
        }
        this.endRun(ctx, run, 'failed');
        // The host's failure, not the work's, benches the host and model (ADR-0035 §3); an error
        // without a kind is the work's and benches nothing.
        if (p.failure) this.benchRun(ctx, projectId, run, p.failure, p.message);
        this.releaseAgent(ctx, caller.agent_id, task.task_id);
        this.syncHarnessBusy(ctx, caller.harness_id);
        return { task_status: task.status };
      },
    );
  }

  /**
   * The spending cap per task (plan M11.5), judged on every `host.usage` report: when the attempt's
   * reported cost reaches `routing.task_budget_usd`, Friday records `budget.exceeded` with the
   * figures, once per attempt, drops whatever was still queued for the attempt and tells a spawned
   * host to stop. The attempt itself stays open for `BUDGET_STOP_GRACE_MS`: a spawn adapter sends
   * the attempt's cost and then, at once, how the attempt ended, and that report is still recorded as
   * what it is (a completion claim moves the task to READY_FOR_VERIFICATION as any claim does, a
   * blocked result or an error is recorded as such), so finished work is not paid for twice (plan
   * rule B31). When the grace passes without one, `tick` ends the attempt as a fatal agent error
   * `budget_exceeded` and the task waits for a human (`endAtCap`). A report without a cost, a cap
   * that is not set, a run already over, or a run that is no longer the task's current one changes
   * nothing: a report that arrives after the stop is read, not acted on.
   */
  enforceTaskBudget(
    projectId: string,
    p: { run_id: string; cost_usd: unknown; cap_usd: unknown },
  ): { stopped: boolean; task_status: TaskView['status'] | null } {
    const cap = typeof p.cap_usd === 'number' && Number.isFinite(p.cap_usd) && p.cap_usd > 0 ? p.cap_usd : null;
    const cost = typeof p.cost_usd === 'number' && Number.isFinite(p.cost_usd) ? p.cost_usd : null;
    if (cap === null || cost === null || cost < cap) return { stopped: false, task_status: null };
    const known = this.q.findRun(p.run_id);
    if (!known || (known.status !== 'ACTIVE' && known.status !== 'SUSPENDED')) {
      return { stopped: false, task_status: null };
    }
    // Once per attempt: a second report past the cap during the grace (the host's final figures)
    // is read, and the grace already running decides the attempt.
    if (this.capStopOf(projectId, p.run_id)) return { stopped: false, task_status: null };
    return this.exec(
      {
        name: 'budget.enforce',
        project_id: projectId,
        actor: SYSTEM,
        params: { run_id: p.run_id, cost_usd: cost, cap_usd: cap },
      },
      (ctx) => {
        const run = this.q.run(p.run_id);
        const task = this.q.task(projectId, run.task_id);
        if (
          (run.status !== 'ACTIVE' && run.status !== 'SUSPENDED') ||
          task.current_run_id !== run.run_id ||
          (task.status !== 'RUNNING' && task.status !== 'WAITING')
        ) {
          return { stopped: false, task_status: null };
        }
        const stop: CapStop = { at: ctx.now, attempt: run.attempt, cost_usd: cost, cap_usd: cap };
        ctx.emit({
          type: 'budget.exceeded',
          payload: { task_id: task.task_id, run_id: run.run_id, attempt: run.attempt, cost_usd: cost, cap_usd: cap },
          refs: [
            { kind: 'task', id: task.task_id },
            { kind: 'run', id: run.run_id },
          ],
        });
        // Whatever was queued for the attempt no longer goes out; the host is told to stop after
        // that, so the cancel is not what gets expired.
        this.expireOutboxForRun(ctx, run.run_id);
        const h = this.q.findHarness(run.harness_id);
        if (
          run.status === 'ACTIVE' &&
          h?.attach_mode === 'spawn' &&
          !['DISCONNECTED', 'TERMINATED'].includes(h.status)
        ) {
          this.enqueue(
            ctx,
            run.harness_id,
            'task.cancel',
            { task_id: task.task_id, run_id: run.run_id, reason: capReason(stop) },
            run.run_id,
          );
        }
        return { stopped: true, task_status: task.status };
      },
    );
  }

  /**
   * The cap stop on record for an attempt (`budget.exceeded`, plan M11.5), read from the attempt's
   * own events: the event store is the one place a stop lives, so a grace in progress survives a
   * restart and needs no second record. An attempt that is over keeps its record, which the usage
   * row reads; callers check the run's status themselves.
   */
  private capStopOf(projectId: string, runId: string): CapStop | undefined {
    const [e] = this.store.readByRef(projectId, 'run', runId, { types: ['budget.exceeded'], limit: 1 });
    if (!e) return undefined;
    const p = e.payload as { attempt?: unknown; cost_usd?: unknown; cap_usd?: unknown };
    return { at: e.occurred_at, attempt: Number(p.attempt), cost_usd: Number(p.cost_usd), cap_usd: Number(p.cap_usd) };
  }

  /**
   * Ends an attempt at the task's spending cap (plan M11.5), once its grace passed with no report of
   * the end or once the host's own fatal error arrived: a fatal agent error `budget_exceeded` the
   * recovery assessment names, the run ended `failed`, and a human asked with the figures. The task
   * waits as `blocked`, not `agent_error`: the automatic recovery sweep retries agent errors within
   * its limits, and another attempt would spend up to the cap again, so only a human runs the task
   * again (after raising the cap) or cancels it.
   */
  private endAtCap(ctx: CommandContext, run: RunView, task: TaskView, stop: CapStop): TaskView {
    const reason = capReason(stop);
    ctx.emit({
      type: 'agent.event',
      payload: { task_id: task.task_id, run_id: run.run_id, event_type: 'error', message: reason, fatal: true },
      refs: [
        { kind: 'task', id: task.task_id },
        { kind: 'run', id: run.run_id },
      ],
    });
    const waiting =
      task.status === 'RUNNING'
        ? this.moveTask(ctx, task, 'task.wait', { waiting_reason: 'blocked', reason: reason.slice(0, 200) })
        : this.updateTaskFields(ctx, task.task_id, { waiting_reason: 'blocked' });
    this.endRun(ctx, run, 'failed');
    // Anything queued for the attempt during the grace (a message, a packet) no longer goes out.
    this.expireOutboxForRun(ctx, run.run_id);
    this.releaseAgent(ctx, run.agent_id, task.task_id);
    this.syncHarnessBusy(ctx, run.harness_id);
    this.escalationWithin(ctx, {
      kind: 'recovery_needed',
      goal_id: task.goal_id ?? null,
      task_id: task.task_id,
      question: `${task.task_id} was stopped at its spending cap: attempt ${stop.attempt} reported ${usd(stop.cost_usd)} against routing.task_budget_usd ${usd(stop.cap_usd)}. Raise the cap in .friday/config.yaml before it runs again, or cancel it`,
      options: [
        `friday recover ${task.task_id} --action reassign`,
        `friday recover ${task.task_id} --action restart`,
        `friday task cancel ${task.task_id}`,
      ],
      details: {
        reason: 'budget_exceeded',
        run_id: run.run_id,
        attempt: stop.attempt,
        cost_usd: stop.cost_usd,
        cap_usd: stop.cap_usd,
      },
    });
    return waiting;
  }

  /**
   * The grace of a cap stop passed with no report of the end (`tick`, plan M11.5): the attempt ends
   * as `budget_exceeded`, if it is still open and still the task's current one. True when it did.
   */
  private endRunAtCap(projectId: string, runId: string, stop: CapStop): boolean {
    return this.exec(
      { name: 'budget.stop', project_id: projectId, actor: SYSTEM, params: { run_id: runId } },
      (ctx) => {
        const run = this.q.run(runId);
        const task = this.q.task(projectId, run.task_id);
        if (
          (run.status !== 'ACTIVE' && run.status !== 'SUSPENDED') ||
          task.current_run_id !== run.run_id ||
          (task.status !== 'RUNNING' && task.status !== 'WAITING')
        ) {
          return false;
        }
        this.endAtCap(ctx, run, task, stop);
        return true;
      },
    );
  }

  /** Back to READY. Operators release ASSIGNED/WAITING/HARNESS_LOST/RUNNING; agents release their own RUNNING task. */
  releaseTask(projectId: string, actor: Actor, taskId: string, reason: string, caller?: Caller): TaskView {
    return this.exec({ name: 'task.release', project_id: projectId, actor, params: { taskId, reason } }, (ctx) =>
      this.releaseWithin(ctx, projectId, actor, taskId, reason, caller),
    );
  }

  private releaseWithin(
    ctx: CommandContext,
    projectId: string,
    actor: Actor,
    taskId: string,
    reason: string,
    caller?: Caller,
  ): TaskView {
    {
      let task = this.q.task(projectId, taskId);
      const run = task.current_run_id ? this.q.findRun(task.current_run_id) : undefined;
      if (caller) {
        if (!run || run.harness_id !== caller.harness_id || run.agent_id !== caller.agent_id) {
          throw new FridayError('permission_denied', `task ${taskId} is not held by this session`);
        }
      }
      const releaser: Actor = caller ? SYSTEM : actor;
      if (task.status === 'RUNNING') {
        task = this.moveTask(ctx, task, 'task.wait', {
          actor: caller ? actor : SYSTEM,
          waiting_reason: 'blocked',
          reason: `release requested: ${reason}`,
        });
      }
      const agentId = task.assigned_agent_id;
      const runToEnd =
        run && (run.status === 'STARTING' || run.status === 'ACTIVE' || run.status === 'SUSPENDED') ? run : undefined;
      task = this.moveTask(ctx, task, 'task.release', {
        actor: task.status === 'ASSIGNED' ? actor : releaser,
        reason,
        changes: { assigned_agent_id: null, assigned_harness_id: null, current_run_id: null },
      });
      if (runToEnd) {
        if (runToEnd.status === 'STARTING')
          this.moveRun(ctx, runToEnd, 'DECLINED', 'released', { outcome: 'released', ended_at: ctx.now });
        else this.endRun(ctx, runToEnd, 'released');
        this.expireOutboxForRun(ctx, runToEnd.run_id);
        this.syncHarnessBusy(ctx, runToEnd.harness_id);
      }
      this.releaseAgent(ctx, agentId, taskId);
      return task;
    }
  }

  /**
   * Recovers a task's lost or failed attempt (ADR-0026 §4). `reassign` and `restart` fence the
   * attempt (its run ended, its outbox expired, a spawn session still alive told to stop) and give
   * the task back to READY: the next attempt reuses the task's worktree and branch. The daemon has
   * preserved the worktree's state first, and reset it for `restart`. `needs_human` asks a human
   * with the assessment; `cancel` cancels.
   */
  recoverTask(
    projectId: string,
    actor: Actor,
    taskId: string,
    action: 'reassign' | 'restart' | 'needs_human' | 'cancel',
    opts: { reason: string; preserved_ref?: string | null; details?: Record<string, unknown> },
  ): TaskView {
    let task: TaskView;
    if (action === 'cancel') {
      task = this.cancelTask(projectId, actor, taskId, opts.reason);
    } else if (action === 'needs_human') {
      const t = this.q.task(projectId, taskId);
      this.raiseEscalation(projectId, actor, {
        kind: 'recovery_needed',
        goal_id: t.goal_id ?? null,
        task_id: taskId,
        question: `${taskId} needs a decision before it continues: ${opts.reason}`,
        options: [
          `friday recover ${taskId} --action reassign`,
          `friday recover ${taskId} --action restart`,
          `friday recover ${taskId} --action cancel`,
        ],
        details: { ...(opts.details ?? {}), ...(opts.preserved_ref ? { preserved_ref: opts.preserved_ref } : {}) },
      });
      task = this.q.task(projectId, taskId);
    } else {
      task = this.exec(
        { name: 'task.recover', project_id: projectId, actor, params: { taskId, action, reason: opts.reason } },
        (ctx) => {
          const before = this.q.task(projectId, taskId);
          const run = before.current_run_id ? this.q.findRun(before.current_run_id) : undefined;
          const released = this.releaseWithin(ctx, projectId, actor, taskId, `${action}: ${opts.reason}`);
          const h = run ? this.q.findHarness(run.harness_id) : undefined;
          if (
            run?.status === 'ACTIVE' &&
            h?.attach_mode === 'spawn' &&
            !['DISCONNECTED', 'TERMINATED'].includes(h.status)
          ) {
            this.enqueue(
              ctx,
              run.harness_id,
              'task.cancel',
              { task_id: taskId, run_id: run.run_id, reason: `${action}: ${opts.reason}` },
              run.run_id,
            );
          }
          // A reservation for an agent whose host cannot take the work now would hold the task for
          // the one agent that cannot take it (ADR-0035 §4). A claim already clears reservations,
          // so this guards only a reservation placed on the freed task by another path.
          const freed = this.q.task(projectId, taskId);
          if (freed.status === 'READY' && freed.reserved_for_agent_key && freed.reserved_by !== 'human') {
            const holder = this.q.agentByKey(projectId, freed.reserved_for_agent_key);
            const hh = holder?.harness_id ? this.q.findHarness(holder.harness_id) : undefined;
            const a = hh ? this.readiness.assess(projectId, hh.vendor, hh.observed_model ?? null, ctx.now) : null;
            if (a && !a.dispatchable) {
              return this.unreserveWithin(
                ctx,
                projectId,
                taskId,
                `${freed.reserved_for_agent_key} cannot take it now: ${a.reason}`,
              );
            }
          }
          return released;
        },
      );
    }
    this.recordObservation(
      projectId,
      actor,
      'recovery.performed',
      { task_id: taskId, action, reason: opts.reason, preserved_ref: opts.preserved_ref ?? null },
      [{ kind: 'task', id: taskId }],
    );
    return task;
  }

  /** Fatal agent errors reported for a task, oldest first (ADR-0026 §5). */
  agentErrors(projectId: string, taskId: string): string[] {
    return this.store
      .readByRef(projectId, 'task', taskId, { types: ['agent.event'] })
      .map((e) => e.payload as { event_type?: string; fatal?: boolean; message?: string })
      .filter((p) => p.event_type === 'error' && p.fatal)
      .map((p) => String(p.message ?? ''));
  }

  cancelTask(projectId: string, actor: Actor, taskId: string, reason: string): TaskView {
    return this.exec({ name: 'task.cancel', project_id: projectId, actor, params: { taskId, reason } }, (ctx) =>
      this.cancelWithin(ctx, projectId, taskId, reason),
    );
  }

  private cancelWithin(ctx: CommandContext, projectId: string, taskId: string, reason: string): TaskView {
    {
      let task = this.q.task(projectId, taskId);
      const run = task.current_run_id ? this.q.findRun(task.current_run_id) : undefined;
      const agentId = task.assigned_agent_id;
      task = this.moveTask(ctx, task, 'task.cancel', { reason, changes: { current_run_id: null } });
      if (run && run.status !== 'ENDED' && run.status !== 'DECLINED') {
        const harness = this.q.findHarness(run.harness_id);
        if (run.status === 'STARTING')
          this.moveRun(ctx, run, 'DECLINED', 'cancelled', { outcome: 'cancelled', ended_at: ctx.now });
        else this.endRun(ctx, run, 'cancelled');
        this.expireOutboxForRun(ctx, run.run_id);
        if (harness?.attach_mode === 'spawn' && run.status === 'ACTIVE') {
          this.enqueue(ctx, run.harness_id, 'task.cancel', { task_id: taskId, run_id: run.run_id, reason }, run.run_id);
        }
        this.syncHarnessBusy(ctx, run.harness_id);
      }
      this.releaseAgent(ctx, agentId, taskId);
      return task;
    }
  }

  /** FAILED → REWORK → READY, reserved for the agent that did the work. */
  reworkTask(projectId: string, actor: Actor, taskId: string, reason: string): TaskView {
    return this.exec({ name: 'task.rework', project_id: projectId, actor, params: { taskId, reason } }, (ctx) =>
      this.reworkWithin(ctx, projectId, taskId, reason),
    );
  }

  private reworkWithin(ctx: CommandContext, projectId: string, taskId: string, reason: string): TaskView {
    let task = this.q.task(projectId, taskId);
    const prevAgent = task.assigned_agent_id ? this.q.findAgent(task.assigned_agent_id) : undefined;
    task = this.moveTask(ctx, task, 'task.rework', { reason });
    // A stronger agent of the role reworks what a cheaper one could not finish (plan M13.3);
    // otherwise the agent that did the work gets the first chance, for a while (review F08), and
    // continues its own session where its host can (plan M13.2).
    const changes: Record<string, unknown> = { assigned_agent_id: null, assigned_harness_id: null };
    const next = prevAgent ? (this.strongerAgent(projectId, task, prevAgent) ?? prevAgent) : undefined;
    if (next) {
      changes.reserved_for_agent_key = next.agent_key;
      changes.reserved_by = 'rework';
      changes.reserved_until = addMs(ctx.now, this.config.reservationTtlMs);
    }
    return this.moveTask(ctx, task, 'task.ready', {
      changes,
      ...(next && prevAgent && next.agent_id !== prevAgent.agent_id
        ? { reason: `reworked by ${next.agent_key}, an agent of a higher cost class than ${prevAgent.agent_key}` }
        : {}),
    });
  }

  /**
   * The agent a rework escalates to (plan M13.3): of the role of the agent that did the work, in the
   * next cost class above that agent's, the lowest agent key among equals, and only one Friday can
   * hand the work to now: a spawned agent with a live session, free and holding no reservation,
   * whose route does not block the task. None otherwise, and the agent that did the work keeps it.
   */
  private strongerAgent(projectId: string, task: TaskView, prev: AgentView): AgentView | undefined {
    const classOf = this.costClassOf;
    if (!classOf) return undefined;
    // A routing failure never stops a rework: nobody is stronger, and the previous agent keeps it.
    const costOf = (a: AgentView): CostClass | null => {
      try {
        return classOf(task, a.agent_id);
      } catch {
        return null;
      }
    };
    const from = COST_ORDER.indexOf(costOf(prev) ?? 'standard');
    const reserved = new Set(
      this.q
        .tasks(projectId, { statuses: ['READY'] })
        .map((t) => t.reserved_for_agent_key)
        .filter((k): k is string => Boolean(k)),
    );
    const free = (a: AgentView) => {
      const h = a.harness_id ? this.q.findHarness(a.harness_id) : undefined;
      return Boolean(
        h &&
          h.attach_mode === 'spawn' &&
          !h.shadow &&
          !['DISCONNECTED', 'TERMINATED'].includes(h.status) &&
          a.status === 'AVAILABLE' &&
          !a.current_task_id &&
          !reserved.has(a.agent_key),
      );
    };
    const stronger = this.q
      .agents(projectId)
      .filter((a) => a.agent_id !== prev.agent_id && a.role === prev.role && free(a))
      .map((a) => ({ a, rank: COST_ORDER.indexOf(costOf(a) ?? ('none' as CostClass)) }))
      .filter((x) => x.rank > from)
      .sort((x, y) => x.rank - y.rank || x.a.agent_key.localeCompare(y.a.agent_key));
    return stronger[0]?.a;
  }

  /**
   * Clears the reservation of a READY task so any agent may take it (`friday task unreserve`,
   * review F08). Also how the lease manager ends automatic reservations that ran out.
   */
  unreserveTask(projectId: string, actor: Actor, taskId: string, reason: string): TaskView {
    return this.exec({ name: 'task.unreserve', project_id: projectId, actor, params: { taskId, reason } }, (ctx) =>
      this.unreserveWithin(ctx, projectId, taskId, reason),
    );
  }

  private unreserveWithin(ctx: CommandContext, projectId: string, taskId: string, reason: string): TaskView {
    const task = this.q.task(projectId, taskId);
    if (task.status !== 'READY' || !task.reserved_for_agent_key) {
      throw new FridayError(
        'invalid_state_transition',
        `task ${taskId} is ${task.status}${task.reserved_for_agent_key ? '' : ' and not reserved'}; only a reserved READY task can be released to everyone`,
      );
    }
    ctx.emit({
      type: 'task.reservation_released',
      payload: {
        task_id: taskId,
        agent_key: task.reserved_for_agent_key,
        reserved_by: task.reserved_by,
        reason,
        changes: { reserved_for_agent_key: null, reserved_by: null, reserved_until: null },
      },
      refs: [{ kind: 'task', id: taskId }],
    });
    return this.q.task(projectId, taskId);
  }

  /**
   * Automatic reservations end when they run out or when their agent's session is gone for good
   * (review F08). A human's reservation is never released here.
   */
  private expireReservations(projectId: string, nowIso: string): string[] {
    const out: string[] = [];
    for (const t of this.q.tasks(projectId, { statuses: ['READY'] })) {
      if (!t.reserved_for_agent_key || t.reserved_by === 'human' || t.reserved_by === null) continue;
      const agent = this.q.agentByKey(projectId, t.reserved_for_agent_key);
      const harness = agent?.harness_id ? this.q.findHarness(agent.harness_id) : undefined;
      let reason: string | null = null;
      if (t.reserved_until && Date.parse(t.reserved_until) <= Date.parse(nowIso)) {
        reason = `${t.reserved_for_agent_key} did not take it before ${t.reserved_until}`;
      } else if (!agent || !harness || harness.status === 'TERMINATED' || agent.status === 'TERMINATED') {
        reason = `${t.reserved_for_agent_key} has no session any more`;
      }
      if (!reason) continue;
      this.exec({ name: 'task.unreserve', project_id: projectId, actor: LEASE_MANAGER }, (ctx) =>
        this.unreserveWithin(ctx, projectId, t.task_id, reason as string),
      );
      out.push(t.task_id);
    }
    return out;
  }

  // ================================================================ goals and plans (M2, ADR-0013)

  createGoal(
    projectId: string,
    actor: Actor,
    input: z.input<typeof GoalCreateRequest>,
    opts: { idempotency_key?: string } = {},
  ): GoalView {
    const req = GoalCreateRequest.parse(input);
    return this.exec(
      { name: 'goal.create', project_id: projectId, actor, idempotency_key: opts.idempotency_key, params: req },
      (ctx) => {
        const goal_id = this.ids.next('goal');
        ctx.emit({
          type: 'goal.created',
          payload: {
            goal: {
              goal_id,
              request: req.request,
              objective: null,
              constraints: req.constraints,
              outcomes: req.outcomes,
              non_goals: req.non_goals,
              definition_of_done: req.definition_of_done,
              priority: req.priority,
              created_by: actor,
            },
            plan_requested: req.plan,
          },
          refs: [{ kind: 'goal', id: goal_id }],
        });
        return this.q.goal(projectId, goal_id);
      },
    );
  }

  /** Cancels a goal, its unfinished tasks and any proposal waiting for a decision. */
  cancelGoal(projectId: string, actor: Actor, goalId: string, reason: string): GoalView {
    return this.exec({ name: 'goal.cancel', project_id: projectId, actor, params: { goalId, reason } }, (ctx) => {
      const goal = this.q.goal(projectId, goalId);
      if (goal.status === 'COMPLETED' || goal.status === 'CANCELLED') {
        throw new FridayError('invalid_state_transition', `goal ${goalId} is ${goal.status}`);
      }
      ctx.emit({
        type: 'goal.status_changed',
        payload: {
          goal_id: goalId,
          transition: { from: goal.status, to: 'CANCELLED', trigger: 'cancelled', reason },
          changes: {},
        },
        refs: [{ kind: 'goal', id: goalId }],
      });
      for (const t of this.q.goalTasks(projectId, goalId)) {
        if (!TERMINAL_TASK.has(t.status)) this.cancelWithin(ctx, projectId, t.task_id, `goal cancelled: ${reason}`);
      }
      for (const v of goal.plan_id ? this.q.planVersions(goal.plan_id) : []) {
        if (v.status === 'PROPOSED') this.movePlan(ctx, v, 'REJECTED', 'goal cancelled');
      }
      return this.q.goal(projectId, goalId);
    });
  }

  private movePlan(
    ctx: CommandContext,
    v: PlanVersionView,
    to: Exclude<PlanStatus, 'PROPOSED'>,
    trigger: string,
    note?: string,
  ): void {
    const allowed: Partial<Record<PlanStatus, PlanStatus[]>> = {
      PROPOSED: ['ACTIVE', 'REJECTED', 'SUPERSEDED'],
      ACTIVE: ['SUPERSEDED', 'COMPLETED'],
    };
    if (!(allowed[v.status] ?? []).includes(to)) {
      throw new FridayError(
        'invalid_state_transition',
        `plan ${v.plan_id} v${v.version} cannot move from ${v.status} to ${to}`,
      );
    }
    const type = {
      ACTIVE: 'plan.approved',
      REJECTED: 'plan.rejected',
      SUPERSEDED: 'plan.superseded',
      COMPLETED: 'plan.completed',
    }[to];
    ctx.emit({
      type,
      payload: {
        plan_id: v.plan_id,
        goal_id: v.goal_id,
        version: v.version,
        transition: { from: v.status, to, trigger },
        note: note ?? null,
      },
      refs: [
        { kind: 'goal', id: v.goal_id },
        { kind: 'plan', id: v.plan_id },
      ],
    });
  }

  /**
   * The ceiling on delegated work (plan M12.2): what the project's policy declares for each agent
   * role (`teams.<role>.write`, every source). The daemon sets it from the effective policy; it is
   * read again at every proposal and approval, so a tightened policy applies to the next plan.
   * Without it, plan tasks are recorded as the planner wrote them.
   */
  planBounds: (() => PlanBounds) | null = null;

  /**
   * What an agent's work on a task costs (plan M13.3): the cost class its harness declared, else
   * the class of the model routing runs for it. The daemon sets it from routing; without it, every
   * agent is `standard` and a rework stays with the agent that did the work.
   */
  costClassOf: ((task: TaskView, agentId: string) => CostClass | null) | null = null;

  /**
   * The version of the project's effective policy now (review F02): a rework continues an earlier
   * session only under the policy that session's packet was compiled under (plan M13.2). The daemon
   * sets it; without it, a project has no policy version.
   */
  policyVersion: (() => string | null) | null = null;

  /**
   * Bounds one plan task by the ceiling of its role (plan M12.2): a task never holds more
   * authority than what delegated it. Its write scope is cut to what lies inside the role's
   * declared scopes, with a note a human reads in the plan; a task with nothing left inside is
   * refused. Read scopes are not authority to change anything and stay as written. The hooks
   * remain the final judge of every write, so a glob this cut keeps is still judged at use.
   */
  boundPlanTask(task: { key: string; kind: string; role: string; write: readonly string[] }): BoundedPlanTask {
    const layers = this.planBounds?.().teams[task.role] ?? [];
    let write = [...task.write];
    const notes: string[] = [];
    for (const layer of layers) {
      if (!layer.write.length) continue;
      const bounded = boundWriteScope(write, layer.write);
      if (bounded.changed && write.length > 0 && bounded.write.length === 0) {
        return {
          write,
          note: null,
          refused: `task "${task.key}" (role ${task.role}) would write ${write.join(', ')}, outside the project's scope for that role (${layer.write.join(', ')}, from ${layer.source}), and nothing of it lies inside: narrow the task's scope.write or give it another role`,
        };
      }
      if (bounded.changed) {
        notes.push(
          `scope.write cut to the project's scope for role ${task.role}: ${bounded.write.join(', ')} (the plan asked for ${write.join(', ')}; ${layer.source})`,
        );
        write = bounded.write;
      }
    }
    return { write, note: notes.length ? notes.join('; ') : null, refused: null };
  }

  /**
   * Records a plan version as PROPOSED. The planner validated it (or a human wrote it and the
   * CLI validated it); this checks that kept, reworked and dropped tasks belong to the goal, and
   * bounds every new task by the ceiling of its role (plan M12.2), so the version a human reviews
   * already shows the scope the task will hold, with a note where it was cut.
   */
  proposePlan(projectId: string, actor: Actor, goalId: string, proposal: PlanProposal): PlanVersionView {
    return this.exec(
      { name: 'plan.propose', project_id: projectId, actor, params: { goalId, trigger: proposal.trigger } },
      (ctx) => {
        const goal = this.q.goal(projectId, goalId);
        if (goal.status === 'COMPLETED' || goal.status === 'CANCELLED') {
          throw new FridayError('invalid_state_transition', `goal ${goalId} is ${goal.status}`);
        }
        const plan_id = goal.plan_id ?? this.q.planIdOfGoal(goalId) ?? this.ids.next('plan');
        const versions = this.q.planVersions(plan_id);
        const version = (versions.at(-1)?.version ?? 0) + 1;
        const active = versions.find((v) => v.status === 'ACTIVE');
        if (proposal.base_version !== undefined && proposal.base_version !== (active?.version ?? null)) {
          throw new FridayError(
            'plan_outdated',
            `this proposal was made against ${proposal.base_version === null ? 'no plan' : `version ${proposal.base_version}`}, but the active plan is now ${active ? `version ${active.version}` : 'none'}`,
          );
        }
        const goalTasks = new Set(this.q.goalTasks(projectId, goalId).map((t) => t.task_id));
        const keys = new Set<string>();
        for (const t of proposal.tasks) {
          if (keys.has(t.key)) throw new FridayError('invalid_request', `plan task key ${t.key} is used twice`);
          keys.add(t.key);
          if (t.change !== 'new' && (!t.task_id || !goalTasks.has(t.task_id))) {
            throw new FridayError(
              'invalid_request',
              `plan task ${t.key} (${t.change}) must name a task of goal ${goalId}`,
            );
          }
        }
        // The ceiling (plan M12.2): a new task is recorded with the scope it will hold. A task with
        // nothing inside its role's scope refuses the whole proposal, with the task and the ceiling named.
        const tasks = proposal.tasks.map((t) => {
          if (t.change !== 'new') return t;
          const b = this.boundPlanTask({ key: t.key, kind: t.kind, role: t.role, write: t.scope.write });
          if (b.refused) throw new FridayError('invalid_request', `the plan exceeds its ceiling: ${b.refused}`);
          if (!b.note) return t;
          return {
            ...t,
            scope: { write: b.write, read: t.scope.read },
            note: t.note ? `${t.note}; ${b.note}` : b.note,
          };
        });
        // One proposal waits for a decision at a time.
        for (const v of versions.filter((x) => x.status === 'PROPOSED')) {
          this.movePlan(ctx, v, 'SUPERSEDED', `replaced by version ${version}`);
        }
        ctx.emit({
          type: 'plan.proposed',
          payload: {
            plan: {
              plan_id,
              version,
              goal_id: goalId,
              supersedes: active?.version ?? null,
              summary: proposal.summary,
              rationale: proposal.rationale || null,
              needs_human: proposal.needs_human,
              trigger: proposal.trigger,
              model_call_id: proposal.model_call_id ?? null,
              prompt_version: proposal.prompt_version ?? null,
              tasks,
            },
          },
          refs: [
            { kind: 'goal', id: goalId },
            { kind: 'plan', id: plan_id },
          ],
        });
        const changes: Record<string, unknown> = {};
        if (!goal.plan_id) changes.plan_id = plan_id;
        if (proposal.intent && !goal.objective) {
          // The human's constraints and outcomes stay as they are; additions are kept apart (review F07).
          const fold = (xs: string[]) => new Set(xs.map((x) => x.trim().toLowerCase()));
          const ownC = fold(goal.constraints);
          const ownO = fold(goal.outcomes);
          const ownN = fold(goal.non_goals);
          const ownD = fold(goal.definition_of_done);
          changes.objective = proposal.intent.objective;
          changes.inferred_constraints = proposal.intent.inferred_constraints.filter(
            (c) => !ownC.has(c.trim().toLowerCase()),
          );
          changes.inferred_outcomes = proposal.intent.inferred_outcomes.filter(
            (o) => !ownO.has(o.trim().toLowerCase()),
          );
          changes.inferred_non_goals = (proposal.intent.inferred_non_goals ?? []).filter(
            (n) => !ownN.has(n.trim().toLowerCase()),
          );
          changes.inferred_definition_of_done = (proposal.intent.inferred_definition_of_done ?? []).filter(
            (d) => !ownD.has(d.trim().toLowerCase()),
          );
        }
        if (Object.keys(changes).length > 0) {
          ctx.emit({
            type: 'goal.updated',
            payload: { goal_id: goalId, changes },
            refs: [{ kind: 'goal', id: goalId }],
          });
        }
        return this.q.planVersion(plan_id, version) as PlanVersionView;
      },
    );
  }

  /**
   * Approves a PROPOSED version and applies it in one transaction (ADR-0013): new tasks are
   * created in dependency order, FAILED tasks go back for rework, dropped tasks are cancelled,
   * and every task whose dependencies are complete becomes READY.
   */
  approvePlan(projectId: string, actor: Actor, planId: string, version: number, note?: string): PlanApproval {
    return this.exec({ name: 'plan.approve', project_id: projectId, actor, params: { planId, version } }, (ctx) => {
      const v = this.q.planVersion(planId, version);
      if (!v) throw new FridayError('plan_not_found', `plan ${planId} version ${version} not found`);
      if (v.status !== 'PROPOSED') {
        throw new FridayError(
          'invalid_state_transition',
          `plan ${planId} v${version} is ${v.status}; only a PROPOSED version can be approved`,
        );
      }
      const goal = this.q.goal(projectId, v.goal_id);
      if (goal.status === 'COMPLETED' || goal.status === 'CANCELLED') {
        throw new FridayError('invalid_state_transition', `goal ${goal.goal_id} is ${goal.status}`);
      }
      const active = this.q.latestPlanVersion(planId, ['ACTIVE']);
      this.assertPlanFresh(projectId, v, active?.version ?? null);
      // The ceiling again (plan M12.2): the policy may have tightened since the version was proposed,
      // and a task is materialized with the scope it may hold now, or the approval is refused.
      const bounded = new Map<string, BoundedPlanTask>();
      for (const t of v.tasks) {
        if (t.change !== 'new') continue;
        const b = this.boundPlanTask({ key: t.key, kind: t.kind, role: t.role, write: t.scope.write });
        if (b.refused) {
          throw new FridayError(
            'plan_outdated',
            `plan ${planId} v${version} exceeds its ceiling under the project's policy as it is now: ${b.refused}. Reject it ("friday plan reject") and ask for a new one ("friday goal replan").`,
          );
        }
        bounded.set(t.key, b);
      }
      if (active) this.movePlan(ctx, active, 'SUPERSEDED', `superseded by version ${version}`);
      this.movePlan(ctx, v, 'ACTIVE', 'approved', note);

      const created: TaskView[] = [];
      const idOfKey = new Map<string, string>();
      for (const t of v.tasks) if (t.task_id) idOfKey.set(t.key, t.task_id);
      for (const t of this.newTasksInOrder(v.tasks)) {
        const task_id = this.ids.next('task');
        idOfKey.set(t.key, task_id);
        const dependencies = t.depends_on.map((d) => idOfKey.get(d) ?? d);
        for (const dep of dependencies) this.q.task(projectId, dep);
        const bound = bounded.get(t.key);
        const scope = bound?.note ? { write: bound.write, read: t.scope.read } : t.scope;
        ctx.emit({
          type: 'task.created',
          payload: {
            task: {
              task_id,
              goal_id: v.goal_id,
              plan_id: planId,
              plan_version: version,
              plan_key: t.key,
              role: t.role,
              kind: t.kind,
              summary: t.summary,
              description: t.description,
              acceptance_criteria: t.acceptance_criteria,
              priority: t.priority,
              risk_level: t.risk_level,
              scope,
              dependencies,
              reserved_for_agent_key: null,
              created_by: ctx.actor,
            },
          },
          refs: [
            { kind: 'task', id: task_id },
            { kind: 'goal', id: v.goal_id },
            { kind: 'plan', id: planId },
          ],
        });
        this.resolveTaskRoleWithin(ctx, task_id, 'plan', t.role);
        ctx.emit({
          type: 'plan.task_materialized',
          payload: {
            plan_id: planId,
            version,
            key: t.key,
            task_id,
            // Cut at approval, after the version was proposed: what the task holds and why.
            ...(bound?.note ? { bounded: { write: bound.write, note: bound.note } } : {}),
          },
          refs: [
            { kind: 'plan', id: planId },
            { kind: 'task', id: task_id },
          ],
        });
        created.push(this.q.task(projectId, task_id));
      }
      const reworked: TaskView[] = [];
      const dropped: TaskView[] = [];
      for (const t of v.tasks) {
        if (t.change === 'rework' && t.task_id) {
          reworked.push(this.reworkWithin(ctx, projectId, t.task_id, t.note ?? 'rework requested by the plan'));
        }
        if (t.change === 'drop' && t.task_id) {
          dropped.push(this.cancelWithin(ctx, projectId, t.task_id, t.note ?? 'dropped by the plan'));
        }
      }
      const readied = this.readyWithin(ctx, projectId, v.goal_id);
      if (goal.status === 'OPEN') {
        ctx.emit({
          type: 'goal.status_changed',
          payload: {
            goal_id: goal.goal_id,
            transition: { from: 'OPEN', to: 'ACTIVE', trigger: 'plan approved' },
            changes: { plan_id: planId },
          },
          refs: [{ kind: 'goal', id: goal.goal_id }],
        });
      }
      return {
        plan: this.q.planVersion(planId, version) as PlanVersionView,
        created: created.map((t) => this.q.task(projectId, t.task_id)),
        reworked,
        dropped,
        readied,
      };
    });
  }

  /**
   * A proposal is checked against the live state when it is approved (review F06): it must have
   * been made against the plan that is active now, reworked tasks must still be FAILED, dropped
   * tasks must not have started, and new tasks may not wait on a task that can never complete.
   * Nothing changes when it fails, so the active plan stays as it was.
   */
  private assertPlanFresh(projectId: string, v: PlanVersionView, activeVersion: number | null): void {
    const stale: string[] = [];
    if ((v.supersedes ?? null) !== activeVersion) {
      stale.push(
        `it revises ${v.supersedes === null ? 'no plan' : `version ${v.supersedes}`}, but the active plan is ${activeVersion === null ? 'none' : `version ${activeVersion}`}`,
      );
    }
    for (const t of v.tasks) {
      if (!t.task_id) {
        for (const dep of t.depends_on) {
          const d = this.q.findTask(projectId, dep);
          if (d && (d.status === 'CANCELLED' || d.status === 'ABANDONED')) {
            stale.push(`new task ${t.key} would wait on ${dep}, which is ${d.status}`);
          }
        }
        continue;
      }
      const live = this.q.findTask(projectId, t.task_id);
      if (!live) {
        stale.push(`${t.task_id} no longer exists`);
        continue;
      }
      if (t.change === 'rework' && live.status !== 'FAILED') {
        stale.push(`${t.task_id} was to be reworked, but it is ${live.status} now`);
      }
      if (t.change === 'drop' && live.status !== 'PROPOSED' && live.status !== 'READY') {
        stale.push(`${t.task_id} was to be dropped, but it is ${live.status} now (work has started)`);
      }
    }
    if (stale.length) {
      throw new FridayError(
        'plan_outdated',
        `plan ${v.plan_id} v${v.version} is out of date: ${stale.join('; ')}. Reject it ("friday plan reject") and ask for a new one ("friday goal replan").`,
        { stale },
      );
    }
  }

  /** New tasks of a version, dependencies first (the planner already rejected cycles). */
  private newTasksInOrder(tasks: PlanTaskView[]): PlanTaskView[] {
    const fresh = tasks.filter((t) => t.change === 'new');
    const keys = new Set(fresh.map((t) => t.key));
    const done = new Set<string>();
    const out: PlanTaskView[] = [];
    while (out.length < fresh.length) {
      const next = fresh.find((t) => !done.has(t.key) && t.depends_on.every((d) => !keys.has(d) || done.has(d)));
      if (!next) throw new FridayError('invalid_request', 'the plan has a dependency cycle');
      done.add(next.key);
      out.push(next);
    }
    return out;
  }

  /** PROPOSED tasks of a goal whose dependencies are all COMPLETED become READY. */
  private readyWithin(ctx: CommandContext, projectId: string, goalId: string): TaskView[] {
    const out: TaskView[] = [];
    for (const t of this.q.goalTasks(projectId, goalId)) {
      // A dependency counts once its work is where the dependent will start from: integrated into the
      // goal branch when it worked on a task branch (ADR-0025 §4).
      const ready =
        t.status === 'PROPOSED' &&
        this.q.openDependencies(t.task_id).length === 0 &&
        this.q.dependencies(t.task_id).every((d) => this.integratedWork(projectId, d));
      if (ready) out.push(this.moveTask(ctx, t, 'task.ready'));
    }
    return out;
  }

  /** After a plan task completes: dependents whose prerequisites are all done may start. */
  readyDependents(projectId: string, actor: Actor, goalId: string): TaskView[] {
    return this.exec({ name: 'plan.ready_dependents', project_id: projectId, actor, params: { goalId } }, (ctx) =>
      this.readyWithin(ctx, projectId, goalId),
    );
  }

  rejectPlan(projectId: string, actor: Actor, planId: string, version: number, note?: string): PlanVersionView {
    return this.exec({ name: 'plan.reject', project_id: projectId, actor, params: { planId, version } }, (ctx) => {
      const v = this.q.planVersion(planId, version);
      if (!v) throw new FridayError('plan_not_found', `plan ${planId} version ${version} not found`);
      this.movePlan(ctx, v, 'REJECTED', 'rejected', note);
      return this.q.planVersion(planId, version) as PlanVersionView;
    });
  }

  /**
   * A task's work is where its goal needs it: integrated into the goal branch, or it needed no
   * integration because it did not work on a task branch (ADR-0025 §4).
   */
  integratedWork(projectId: string, taskId: string): boolean {
    return (
      !this.q.worktrees(projectId).some((w) => w.task_id === taskId) ||
      ['integrated', 'not_needed'].includes(this.q.latestIntegration(projectId, taskId)?.status ?? '')
    );
  }

  /** Completes the goal and its active plan once every task is COMPLETED and integrated (cancelled ones aside). */
  completeGoalIfDone(projectId: string, actor: Actor, goalId: string): GoalView | null {
    const goal = this.q.goal(projectId, goalId);
    if (goal.status !== 'ACTIVE' || !goal.plan_id) return null;
    const active = this.q.latestPlanVersion(goal.plan_id, ['ACTIVE']);
    const tasks = this.q.goalTasks(projectId, goalId);
    const done =
      tasks.every(
        (t) => (t.status === 'COMPLETED' && this.integratedWork(projectId, t.task_id)) || t.status === 'CANCELLED',
      ) && tasks.some((t) => t.status === 'COMPLETED');
    if (!active || !done) return null;
    return this.exec({ name: 'goal.complete', project_id: projectId, actor, params: { goalId } }, (ctx) => {
      this.movePlan(ctx, active, 'COMPLETED', 'all tasks completed');
      ctx.emit({
        type: 'goal.status_changed',
        payload: {
          goal_id: goalId,
          transition: { from: 'ACTIVE', to: 'COMPLETED', trigger: 'all tasks completed and integrated' },
          changes: { completed_at: ctx.now },
        },
        refs: [{ kind: 'goal', id: goalId }],
      });
      return this.q.goal(projectId, goalId);
    });
  }

  recordModelCall(projectId: string, actor: Actor, call: ModelCallInput): string {
    return this.exec({ name: 'model.call', project_id: projectId, actor, params: { purpose: call.purpose } }, (ctx) => {
      const call_id = this.ids.next('call');
      ctx.emit({
        type: 'model.called',
        payload: { call: { call_id, ...call } },
        refs: [{ kind: 'call', id: call_id }, ...(call.goal_id ? [{ kind: 'goal' as const, id: call.goal_id }] : [])],
      });
      return call_id;
    });
  }

  /**
   * Applies one delegation decision (ADR-0013 §9): assign (spawn mode), reserve (attach mode),
   * or record why the task waits. A repeated "nobody available" decision is not recorded again.
   */
  delegateTask(
    projectId: string,
    actor: Actor,
    taskId: string,
    decision: { agent_key: string | null; reason: string; scores: unknown[] },
  ): { mode: 'assigned' | 'reserved' | 'waiting' | 'none'; task: TaskView } {
    const idle = decision.reason.startsWith('waits') ? 'waiting' : 'none';
    if (!decision.agent_key) {
      const last = this.q.assignments(taskId).at(-1);
      if (last && last.mode === idle && last.reason === decision.reason)
        return { mode: idle, task: this.q.task(projectId, taskId) };
    }
    return this.routed(projectId, () => this.delegateWithin(projectId, actor, taskId, decision, idle));
  }

  private delegateWithin(
    projectId: string,
    actor: Actor,
    taskId: string,
    decision: { agent_key: string | null; reason: string; scores: unknown[] },
    idle: 'waiting' | 'none',
  ): { mode: 'assigned' | 'reserved' | 'waiting' | 'none'; task: TaskView } {
    return this.exec(
      { name: 'task.delegate', project_id: projectId, actor, params: { taskId, agent_key: decision.agent_key } },
      (ctx) => {
        let mode: 'assigned' | 'reserved' | 'waiting' | 'none' = idle;
        let task = this.q.task(projectId, taskId);
        if (decision.agent_key) {
          const r = this.assignWithin(ctx, projectId, taskId, decision.agent_key);
          mode = r.mode;
          task = r.task;
        }
        const assignment_id = this.ids.next('asg');
        ctx.emit({
          type: 'assignment.decided',
          payload: {
            assignment: {
              assignment_id,
              task_id: taskId,
              agent_key: decision.agent_key,
              mode,
              reason: decision.reason,
              scores: decision.scores,
            },
          },
          refs: [{ kind: 'task', id: taskId }],
        });
        return { mode, task };
      },
    );
  }

  /** An escalation raised by the Master Brain, with the six fields of spec Part 03 §11. */
  raiseEscalation(
    projectId: string,
    actor: Actor,
    esc: {
      kind: string;
      goal_id: string | null;
      task_id: string | null;
      question: string;
      options: string[];
      details: Record<string, unknown>;
    },
  ): string {
    return this.exec(
      { name: 'escalation.raise', project_id: projectId, actor, params: { kind: esc.kind, goal_id: esc.goal_id } },
      (ctx) => this.escalationWithin(ctx, esc),
    );
  }

  /** Records an escalation inside the caller's transaction, so it commits with what caused it. */
  private escalationWithin(
    ctx: CommandContext,
    esc: {
      kind: string;
      goal_id: string | null;
      task_id: string | null;
      question: string;
      options: string[];
      details: Record<string, unknown>;
    },
  ): string {
    const escalation_id = this.ids.next('esc');
    ctx.emit({
      type: 'escalation.requested',
      payload: {
        escalation: {
          escalation_id,
          task_id: esc.task_id,
          run_id: null,
          question: esc.question,
          options: esc.options.length ? esc.options : null,
          context: null,
          goal_id: esc.goal_id,
          kind: esc.kind,
          details: esc.details,
        },
      },
      refs: [
        { kind: 'escalation', id: escalation_id },
        ...(esc.goal_id ? [{ kind: 'goal' as const, id: esc.goal_id }] : []),
        ...(esc.task_id ? [{ kind: 'task' as const, id: esc.task_id }] : []),
      ],
    });
    return escalation_id;
  }

  /** HARNESS_LOST tasks of a harness that will not come back go back to READY for someone else. */
  releaseLostTasks(projectId: string, actor: Actor, harnessId: string): TaskView[] {
    return this.q
      .tasks(projectId, { statuses: ['HARNESS_LOST'] })
      .filter((t) => t.assigned_harness_id === harnessId)
      .map((t) => this.releaseTask(projectId, actor, t.task_id, `harness ${harnessId} did not come back`));
  }

  /**
   * Operational (review F05): turns triggers into durable jobs and moves the cursor past their
   * events in one transaction, so a crash can neither lose a trigger nor act on it twice. An
   * equal job that is still pending or waiting absorbs a new one (its id is then null).
   */
  enqueueBrainJobs(
    projectId: string,
    jobs: (BrainJobInput & { source_sequence: number })[],
    cursor: number,
  ): (string | null)[] {
    const now = this.clock.now();
    const ids: (string | null)[] = [];
    const insert = this.db.prepare(
      `INSERT INTO brain_jobs (job_id, project_id, kind, goal_id, task_id, reason, payload_json, dedupe_key, status,
         attempts, source_sequence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    );
    this.db.transaction(() => {
      for (const j of jobs) {
        const id = this.ids.next('job');
        const added = insert.run(
          id,
          projectId,
          j.kind,
          j.goal_id,
          j.task_id,
          j.reason,
          toJson(j.payload ?? {}),
          j.dedupe_key,
          j.source_sequence,
          now,
          now,
        ).changes;
        ids.push(added ? id : null);
      }
      this.setBrainCursor(projectId, cursor);
    });
    return ids;
  }

  /** Open jobs, oldest first. */
  brainJobs(projectId: string, statuses: BrainJob['status'][] = ['pending', 'waiting', 'calling']): BrainJob[] {
    const marks = statuses.map(() => '?').join(', ');
    return this.db
      .prepare(`SELECT * FROM brain_jobs WHERE project_id = ? AND status IN (${marks}) ORDER BY created_at, rowid`)
      .all<Omit<BrainJob, 'payload'> & { payload_json: string }>(projectId, ...statuses)
      .map(({ payload_json, ...j }) => ({ ...j, payload: JSON.parse(payload_json) as Record<string, unknown> }));
  }

  updateBrainJob(
    jobId: string,
    changes: Partial<Pick<BrainJob, 'status' | 'attempts' | 'result' | 'not_before' | 'call_estimate_usd'>>,
  ): void {
    const cols = Object.keys(changes);
    if (cols.length === 0) return;
    this.db
      .prepare(`UPDATE brain_jobs SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE job_id = ?`)
      .run(
        ...cols.map((c) => (changes as Record<string, unknown>)[c] as string | number | null),
        this.clock.now(),
        jobId,
      );
  }

  /** Operational: how far the Master Brain has read the event log. */
  setBrainCursor(projectId: string, sequence: number): void {
    this.setConsumerCursor(projectId, 'master-brain', sequence);
  }

  /**
   * Operational (M3b): how far a durable consumer of the event log has read. A consumer moves its
   * cursor only in the transaction that makes its work durable (the Master Brain writes its jobs
   * with it), so a restart neither loses nor repeats a local effect.
   */
  setConsumerCursor(projectId: string, consumerId: string, sequence: number): void {
    this.db
      .prepare(
        `INSERT INTO event_consumers (consumer_id, project_id, last_sequence, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(consumer_id, project_id) DO UPDATE SET last_sequence = excluded.last_sequence, updated_at = excluded.updated_at`,
      )
      .run(consumerId, projectId, sequence, this.clock.now());
  }

  // ================================================================ verification

  /**
   * READY_FOR_VERIFICATION to VERIFYING. `revision` records what is verified (ADR-0024 §1): the
   * checkout, its HEAD and source version, the run's base commit and the task's kind.
   */
  startVerification(
    projectId: string,
    actor: Actor,
    taskId: string,
    revision: VerificationRevision = {},
  ): { verification_id: string; task: TaskView } {
    return this.exec(
      { name: 'verification.start', project_id: projectId, actor, params: { taskId, revision } },
      (ctx) => {
        let task = this.q.task(projectId, taskId);
        task = this.moveTask(ctx, task, 'verification.start');
        const verification_id = this.ids.next('ver');
        ctx.emit({
          type: 'verification.started',
          payload: { verification_id, task_id: taskId, run_id: task.current_run_id, ...revision },
          refs: [
            { kind: 'task', id: taskId },
            { kind: 'verification', id: verification_id },
          ],
        });
        return { verification_id, task };
      },
    );
  }

  recordVerificationCheck(
    projectId: string,
    actor: Actor,
    verificationId: string,
    check: {
      name: string;
      kind: string;
      status: VerificationStatus;
      exit_code: number | null;
      artifact_ref: string | null;
      summary: string | null;
      /** An advisory check (false) does not fail the verification. Default true. */
      required?: boolean;
      origin?: 'friday' | 'configured' | 'targeted';
      duration_ms?: number | null;
      details?: { findings?: VerificationFinding[]; files?: string[] } | null;
    },
  ): void {
    this.exec(
      { name: 'verification.check', project_id: projectId, actor, params: { verificationId, check } },
      (ctx) => {
        const v = this.q.verification(verificationId);
        ctx.emit({
          type: 'verification.check_completed',
          payload: {
            verification_id: verificationId,
            task_id: v.task_id,
            check: { check_id: this.ids.next('chk'), ...check },
          },
          refs: [
            { kind: 'verification', id: verificationId },
            { kind: 'task', id: v.task_id },
          ],
          ...(check.artifact_ref ? { artifact_refs: [check.artifact_ref] } : {}),
        });
      },
    );
  }

  finishVerification(
    projectId: string,
    actor: Actor,
    verificationId: string,
    passed: boolean,
    summary: string,
    /** The checks that judged it, as a version (review F15); `manual` for a human's result. */
    checksVersion: string | null = actor.kind === 'human' ? 'manual' : null,
  ): TaskView {
    return this.exec(
      { name: 'verification.finish', project_id: projectId, actor, params: { verificationId, passed, summary } },
      (ctx) => {
        const v = this.q.verification(verificationId);
        if (v.status !== 'RUNNING')
          throw new FridayError('invalid_state_transition', `verification is already ${v.status}`);
        const verified = this.q.task(projectId, v.task_id);
        const ran = v.run_id ? this.q.findRun(v.run_id) : undefined;
        const current = this.intent.effectiveVersion(
          projectId,
          verified.goal_id ? this.q.findGoal(projectId, verified.goal_id) : null,
        );
        ctx.emit({
          type: 'verification.finished',
          payload: {
            verification_id: verificationId,
            task_id: v.task_id,
            status: passed ? 'PASSED' : 'FAILED',
            summary,
            // Deterministic checks cannot judge prose intent; they record that it moved (ADR-0034 §8).
            intent: {
              started: ran?.intent_version ?? null,
              current,
              changed_during_run: Boolean(ran?.intent_version && ran.intent_version !== current),
            },
          },
          refs: [
            { kind: 'verification', id: verificationId },
            { kind: 'task', id: v.task_id },
          ],
        });
        const task = this.q.task(projectId, v.task_id);
        this.recordOutcome(ctx, task, v.run_id ?? null, passed, checksVersion);
        // What the agents proposed for the project is learned only from work that passed (ADR-0034 §7).
        if (passed) this.learnings.promoteForVerification(ctx, projectId, v.task_id, verificationId);
        return this.moveTask(ctx, task, passed ? 'verification.pass' : 'verification.fail', {
          reason: summary.slice(0, 200),
          changes: { current_run_id: null },
        });
      },
    );
  }

  /**
   * A verification that could not finish judged nothing (ADR-0024 §2, §6): it ends CANCELLED as
   * interrupted, and its task, if still VERIFYING, returns to READY_FOR_VERIFICATION.
   */
  interruptVerification(projectId: string, actor: Actor, verificationId: string, reason: string): TaskView {
    return this.exec(
      { name: 'verification.interrupt', project_id: projectId, actor, params: { verificationId, reason } },
      (ctx) => {
        const v = this.q.verification(verificationId);
        if (v.status !== 'RUNNING')
          throw new FridayError('invalid_state_transition', `verification is already ${v.status}`);
        ctx.emit({
          type: 'verification.interrupted',
          payload: { verification_id: verificationId, task_id: v.task_id, reason },
          refs: [
            { kind: 'verification', id: verificationId },
            { kind: 'task', id: v.task_id },
          ],
        });
        const task = this.q.task(projectId, v.task_id);
        if (task.status !== 'VERIFYING') return task;
        return this.moveTask(ctx, task, 'verification.interrupt', { reason: reason.slice(0, 200) });
      },
    );
  }

  /** Ends every RUNNING verification except those this process runs: their runner is gone (ADR-0024 §6). */
  interruptOrphanedVerifications(
    projectId: string,
    reason: string,
    running: ReadonlySet<string> = new Set(),
  ): string[] {
    const ended: string[] = [];
    for (const v of this.q.verificationsWithStatus(projectId, 'RUNNING')) {
      if (running.has(v.verification_id)) continue;
      this.interruptVerification(projectId, SYSTEM, v.verification_id, reason);
      ended.push(v.verification_id);
    }
    return ended;
  }

  // ================================================================ harnesses

  registerHarness(
    projectId: string,
    params: z.output<typeof HarnessRegisterParams>,
  ): {
    protocol_version: string;
    harness_id: string;
    agent_id: string;
    agent_key: string;
    harness_token: string;
    reconnected: boolean;
    shadow: boolean;
    lease: { ttl_ms: number; heartbeat_interval_ms: number; expires_at: string };
    pending_messages: number;
  } {
    const protocol_version = negotiateProtocolVersion(params.protocol_version);
    if (params.project_id !== projectId)
      throw new FridayError('permission_denied', 'harness registered for another project');
    const actor: Actor = { kind: 'harness', id: params.harness_key };
    // No idempotency record: the response contains a fresh token, which must never be stored.
    return this.exec({ name: 'harness.register', project_id: projectId, actor }, (ctx) => {
      const host = params.host ?? {};
      const previous = this.q.harnessByKey(projectId, params.harness_key);
      // What the hooks route learned about this session's hooks stays with it when its MCP server
      // registers again (a restarted daemon, a lost lease).
      const kept = previous?.capabilities?.hook_evidence;
      const capabilities =
        kept !== undefined && params.capabilities.hook_evidence === undefined
          ? { ...params.capabilities, hook_evidence: kept }
          : params.capabilities;
      const enforcement = achievedEnforcement({
        vendor: params.vendor,
        attach_mode: params.attach_mode,
        claimed: params.enforcement_level ?? null,
        hooks_seen: Boolean(previous?.hooks_seen_at),
        // A client that cannot tell (a hook arriving first) keeps the version already known.
        host_version: params.version ?? previous?.version ?? null,
        capabilities,
      });
      const hostChanges = {
        host_pid: host.pid ?? null,
        host_session_id: host.session_id ?? null,
        host_cwd: host.cwd ?? null,
        version: params.version ?? previous?.version ?? null,
        adapter_version: params.adapter_version ?? previous?.adapter_version ?? null,
        protocol_version,
        capabilities,
        enforcement_level: enforcement.level,
        enforcement_status: enforcement.status,
        enforcement_basis: enforcement.basis,
        requested_agent_key: params.agent?.agent_key ?? this.config.defaultAgentKey,
      };
      const existing = this.q.harnessByKey(projectId, params.harness_key);
      let harness_id: string;
      let reconnected = false;
      if (existing) {
        harness_id = existing.harness_id;
        if (existing.status === 'DISCONNECTED') {
          this.moveHarness(ctx, existing, 'RECONNECTING', 're-register', { ...hostChanges, disconnected_at: null });
          this.moveHarness(ctx, this.q.harness(harness_id), 'READY', 'reconnected');
          reconnected = true;
        } else {
          this.moveHarness(ctx, existing, existing.status, 're-register', hostChanges);
        }
      } else {
        harness_id = this.ids.next('harness');
        ctx.emit({
          type: 'harness.registered',
          payload: {
            harness: {
              harness_id,
              harness_key: params.harness_key,
              vendor: params.vendor,
              name: params.name,
              version: params.version ?? null,
              adapter_version: params.adapter_version ?? null,
              attach_mode: params.attach_mode,
              protocol_version,
              capabilities: params.capabilities,
              enforcement_level: enforcement.level,
              enforcement_status: enforcement.status,
              enforcement_basis: enforcement.basis,
              requested_agent_key: params.agent?.agent_key ?? this.config.defaultAgentKey,
              host_pid: host.pid ?? null,
              host_session_id: host.session_id ?? null,
              host_cwd: host.cwd ?? null,
            },
          },
          refs: [{ kind: 'harness', id: harness_id }],
        });
        this.moveHarness(ctx, this.q.harness(harness_id), 'READY', 'registered');
      }
      // The host is installed, configured and connected to Friday while this session lives (ADR-0035 §1).
      this.readiness.observeRegistration(ctx, projectId, this.q.harness(harness_id));

      const agentKey = params.agent?.agent_key ?? this.config.defaultAgentKey;
      let agent = this.q.agentByKey(projectId, agentKey);
      let shadow = false;
      if (!agent) {
        const agent_id = this.ids.next('agent');
        ctx.emit({
          type: 'agent.registered',
          payload: {
            agent: {
              agent_id,
              agent_key: agentKey,
              harness_id,
              role: params.agent?.role ?? 'developer',
              display_name: params.agent?.display_name ?? null,
            },
          },
          refs: [
            { kind: 'agent', id: agent_id },
            { kind: 'harness', id: harness_id },
          ],
        });
        agent = this.moveAgent(ctx, this.q.agent(agent_id), 'AVAILABLE');
      } else if (agent.harness_id === harness_id || !agent.harness_id) {
        agent = this.reattachAgent(ctx, agent, harness_id);
      } else if (this.q.isHarnessLive(agent.harness_id, ctx.now) && agent.harness_id !== harness_id) {
        const holder = this.q.harness(agent.harness_id);
        if (takesOverHooksSession(holder, params)) {
          this.adoptHooksSession(ctx, holder, harness_id, params.enforcement_level ?? null);
          agent = this.reattachAgent(ctx, this.q.agent(agent.agent_id), harness_id);
        } else {
          shadow = true;
        }
      } else {
        agent = this.reattachAgent(ctx, agent, harness_id);
      }
      const h = this.q.harness(harness_id);
      if (h.shadow !== shadow) this.moveHarness(ctx, h, h.status, 'shadow', { shadow });
      if (host.session_id) {
        ctx.emit({
          type: 'harness.session_bound',
          payload: { vendor: params.vendor, host_session_id: host.session_id, harness_id, transcript_path: null },
          refs: [{ kind: 'harness', id: harness_id }],
        });
      }

      if (existing && params.attach_mode === 'spawn') {
        // A spawn adapter that registers again has lost its hosts: a new process, or one that ended
        // the work it could no longer govern (review M8-R02, R05). Friday tells it to resume its
        // runs, those it judged lost and those it still holds as running (acknowledged via harness.ack).
        for (const run of [...this.q.suspendedRunsFor(harness_id), ...this.q.activeRunsForHarness(harness_id)]) {
          const task = this.q.task(projectId, run.task_id);
          const live = run.status === 'SUSPENDED' ? 'HARNESS_LOST' : run.status === 'ACTIVE' ? 'RUNNING' : null;
          if (task.status !== live || task.current_run_id !== run.run_id) continue;
          this.enqueue(ctx, harness_id, 'task.resume', this.startParams(projectId, task, run, agent.role), run.run_id);
        }
      }
      this.revokeTokens({ harness_id }, 're-registered');
      const harness_token = this.issueToken(projectId, 'harness', harness_id);
      const interval = params.heartbeat_interval_ms ?? this.config.heartbeatIntervalMs;
      const expires_at = this.upsertLease(projectId, harness_id, interval, ctx.now);
      return {
        protocol_version,
        harness_id,
        agent_id: agent.agent_id,
        agent_key: agentKey,
        harness_token,
        reconnected,
        shadow,
        lease: { ttl_ms: this.config.leaseTtlMs, heartbeat_interval_ms: interval, expires_at },
        pending_messages: this.q.pendingOutboxCount(harness_id),
      };
    });
  }

  /**
   * The hooks of a session reached Friday before its MCP server registered (plan M8b): a host
   * that runs its hooks through a shell gives them another parent than its MCP server, so the two
   * registered apart. The server's harness takes the session over, with what its hooks showed,
   * and the hooks' own harness ends: it had no tools, so it held no work. One agent, one harness.
   */
  private adoptHooksSession(
    ctx: CommandContext,
    holder: HarnessRecord,
    harnessId: string,
    claimed: EnforcementLevel | null,
  ): void {
    const h = this.q.harness(harnessId);
    const evidence = holder.capabilities?.hook_evidence;
    const capabilities = evidence !== undefined ? { ...h.capabilities, hook_evidence: evidence } : h.capabilities;
    const version = h.version ?? holder.version ?? null;
    const e = achievedEnforcement({
      vendor: h.vendor,
      attach_mode: h.attach_mode,
      claimed,
      hooks_seen: Boolean(holder.hooks_seen_at),
      host_version: version,
      capabilities,
    });
    this.moveHarness(ctx, h, h.status, 'hooks session', {
      hooks_seen_at: holder.hooks_seen_at,
      host_session_id: holder.host_session_id,
      version,
      capabilities,
      enforcement_level: e.level,
      enforcement_status: e.status,
      enforcement_basis: e.basis,
    });
    if (holder.host_session_id) {
      ctx.emit({
        type: 'harness.session_bound',
        payload: {
          vendor: h.vendor,
          host_session_id: holder.host_session_id,
          harness_id: harnessId,
          transcript_path: null,
        },
        refs: [{ kind: 'harness', id: harnessId }],
      });
    }
    this.loseRuns(ctx, holder.harness_id, 'its session was taken over by its MCP server');
    this.moveHarness(ctx, holder, 'DISCONNECTED', 'taken over by its MCP server', { disconnected_at: ctx.now });
    this.moveHarness(ctx, this.q.harness(holder.harness_id), 'TERMINATED', 'taken over by its MCP server', {
      terminated_at: ctx.now,
    });
    this.revokeTokens({ harness_id: holder.harness_id }, 'taken over by its MCP server');
  }

  /**
   * A Friday hook reached the daemon from this harness's session: evidence that its tool calls
   * pass the policy hook (review F09). Recomputes the achieved enforcement once. `evidence` is what
   * the hooks route read about the session's hooks (Cursor: its version and its hook file).
   */
  noteHookEvidence(projectId: string, harnessId: string, evidence?: HookEvidence): HarnessRecord {
    const h = this.q.harness(harnessId);
    if (h.hooks_seen_at) return h;
    this.exec({ name: 'harness.hooks_seen', project_id: projectId, actor: SYSTEM }, (ctx) => {
      const capabilities = evidence ? { ...h.capabilities, hook_evidence: evidence } : h.capabilities;
      const e = achievedEnforcement({
        vendor: h.vendor,
        attach_mode: h.attach_mode,
        claimed: h.enforcement_level,
        hooks_seen: true,
        host_version: h.version,
        capabilities,
      });
      this.moveHarness(ctx, h, h.status, 'hooks seen', {
        hooks_seen_at: ctx.now,
        ...(evidence ? { capabilities } : {}),
        enforcement_level: e.level,
        enforcement_status: e.status,
        enforcement_basis: e.basis,
      });
    });
    return this.q.harness(harnessId);
  }

  /**
   * Why this harness may not take work under the project's `security` settings, or null when it
   * may (review F09). Its level comes from evidence, never from the client's claim alone.
   */
  enforcementGap(h: HarnessRecord): string | null {
    const level = h.enforcement_level ?? 'L0';
    const need = this.config.enforcementRequired;
    if (LEVEL_RANK[level] < LEVEL_RANK[need]) {
      const hooked = h.vendor === 'claude-code' ? 'Claude Code' : HOOKED_HOSTS[h.vendor];
      const hint =
        need === 'L2'
          ? 'No adapter in this version of Friday provides L2 (isolated execution); lower security.enforcement_required or wait for M6.'
          : hooked && h.attach_mode === 'attach'
            ? `Run "friday harness config ${h.vendor}" in the project and start a new ${hooked} session, so its tool calls pass Friday's policy hook.`
            : 'Use a harness with Friday policy hooks, or lower security.enforcement_required in .friday/config.yaml.';
      return `this project requires ${need} enforcement (security.enforcement_required), but this session has ${level}: ${h.enforcement_basis ?? 'no evidence'}. ${hint}`;
    }
    // Every host whose sessions run Friday's hooks: a Gemini CLI or Antigravity session is never
    // taken for one whose failing hook blocks the call (plan B21).
    const fix = ENFORCING_FIX[h.vendor];
    if (this.config.requireEnforcingHooks && fix && h.enforcement_status !== 'enforcing') {
      return `this project requires hooks that block when they fail (security.require_enforcing_hooks), but this session is ${h.enforcement_status ?? 'unknown'}: ${h.enforcement_basis ?? 'no evidence'}. ${fix}`;
    }
    return null;
  }

  private reattachAgent(ctx: CommandContext, agent: AgentView, harnessId: string): AgentView {
    const changes = agent.harness_id === harnessId ? {} : { harness_id: harnessId };
    if (agent.status === 'DISCONNECTED' || agent.status === 'REGISTERED' || agent.status === 'UNHEALTHY') {
      return this.moveAgent(ctx, agent, 'AVAILABLE', changes);
    }
    return this.moveAgent(ctx, agent, agent.status, changes);
  }

  private upsertLease(projectId: string, harnessId: string, intervalMs: number, nowIso: string): string {
    const expires = addMs(nowIso, this.config.leaseTtlMs);
    this.db
      .prepare(
        `INSERT INTO harness_leases (harness_id, project_id, heartbeat_interval_ms, lease_ttl_ms, last_heartbeat_at, lease_expires_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(harness_id) DO UPDATE SET heartbeat_interval_ms = excluded.heartbeat_interval_ms,
           lease_ttl_ms = excluded.lease_ttl_ms, last_heartbeat_at = excluded.last_heartbeat_at,
           lease_expires_at = excluded.lease_expires_at`,
      )
      .run(harnessId, projectId, intervalMs, this.config.leaseTtlMs, nowIso, expires);
    return expires;
  }

  /** Renews the lease. Heartbeats are not events; only resulting status changes are. */
  heartbeat(
    projectId: string,
    harnessId: string,
  ): { status: HarnessStatus; lease_expires_at: string; pending_messages: number; shadow: boolean } {
    const h = this.q.harness(harnessId);
    if (h.status === 'DISCONNECTED' || h.status === 'TERMINATED') {
      throw new FridayError('lease_expired', 'this session lost its lease; register again');
    }
    const now = this.clock.now();
    const interval = this.db
      .prepare('SELECT heartbeat_interval_ms AS i FROM harness_leases WHERE harness_id = ?')
      .get<{ i: number }>(harnessId)?.i;
    const expires = this.upsertLease(projectId, harnessId, interval ?? this.config.heartbeatIntervalMs, now);
    if (h.status === 'DEGRADED') {
      this.exec(
        { name: 'harness.recovered', project_id: projectId, actor: { kind: 'harness', id: harnessId } },
        (ctx) => {
          const busy = this.q.activeRunsForHarness(harnessId).length > 0;
          this.moveHarness(ctx, this.q.harness(harnessId), busy ? 'BUSY' : 'READY', 'heartbeat');
        },
      );
    }
    if (h.shadow) this.tryPromoteShadow(projectId, harnessId);
    const after = this.q.harness(harnessId);
    return {
      status: after.status,
      lease_expires_at: expires,
      pending_messages: this.q.pendingOutboxCount(harnessId),
      shadow: after.shadow,
    };
  }

  /** A shadow session takes over the agent once the original session is gone (ADR-0005). */
  private tryPromoteShadow(projectId: string, harnessId: string): void {
    const h = this.q.harness(harnessId);
    if (!h.shadow) return;
    const agent = this.agentForShadow(projectId, h);
    if (!agent || (agent.harness_id && this.q.isHarnessLive(agent.harness_id, this.clock.now()))) return;
    this.exec({ name: 'harness.promote', project_id: projectId, actor: LEASE_MANAGER }, (ctx) => {
      this.moveHarness(ctx, this.q.harness(harnessId), h.status, 'promoted', { shadow: false });
      this.reattachAgent(ctx, this.q.agent(agent.agent_id), harnessId);
    });
  }

  private agentForShadow(projectId: string, h: HarnessRecord): AgentView | undefined {
    return h.requested_agent_key ? this.q.agentByKey(projectId, h.requested_agent_key) : undefined;
  }

  disconnectHarness(projectId: string, harnessId: string, reason: string, final: boolean): void {
    this.exec(
      { name: 'harness.disconnect', project_id: projectId, actor: { kind: 'harness', id: harnessId } },
      (ctx) => {
        const h = this.q.harness(harnessId);
        if (h.status === 'TERMINATED') return;
        if (h.status !== 'DISCONNECTED') this.moveHarness(ctx, h, 'DISCONNECTED', reason, { disconnected_at: ctx.now });
        for (const agent of this.q.agents(projectId).filter((a) => a.harness_id === harnessId)) {
          if (agent.status !== 'DISCONNECTED' && agent.status !== 'TERMINATED')
            this.moveAgent(ctx, agent, 'DISCONNECTED');
        }
        this.revokeTokens({ harness_id: harnessId }, `disconnected: ${reason}`);
        if (final) {
          this.loseRuns(ctx, harnessId, `harness exited: ${reason}`);
          this.moveHarness(ctx, this.q.harness(harnessId), 'TERMINATED', reason, { terminated_at: ctx.now });
        } else {
          // Clean exit: give the session a grace period (e.g. /clear, /resume) before its work counts as lost.
          this.db
            .prepare('UPDATE harness_leases SET lease_expires_at = ? WHERE harness_id = ?')
            .run(addMs(ctx.now, this.config.cleanExitGraceMs), harnessId);
        }
      },
    );
  }

  /** Suspends the harness's active runs and marks their tasks HARNESS_LOST. */
  private loseRuns(ctx: CommandContext, harnessId: string, reason: string): number {
    let lost = 0;
    for (const run of this.q.activeRunsForHarness(harnessId)) {
      if (run.status === 'STARTING') {
        this.moveRun(ctx, run, 'DECLINED', 'harness_lost', { outcome: 'declined', ended_at: ctx.now }, LEASE_MANAGER);
        const task = this.q.task(ctx.project_id, run.task_id);
        if (task.status === 'ASSIGNED' && task.current_run_id === run.run_id) {
          this.moveTask(ctx, task, 'task.release', {
            actor: LEASE_MANAGER,
            reason,
            changes: { assigned_agent_id: null, assigned_harness_id: null, current_run_id: null },
          });
        }
        continue;
      }
      this.moveRun(ctx, run, 'SUSPENDED', 'harness_lost', { suspended_at: ctx.now }, LEASE_MANAGER);
      const task = this.q.task(ctx.project_id, run.task_id);
      if ((task.status === 'RUNNING' || task.status === 'WAITING') && task.current_run_id === run.run_id) {
        this.moveTask(ctx, task, 'harness.lost', { actor: LEASE_MANAGER, reason });
        lost += 1;
      }
    }
    return lost;
  }

  markHarnessLost(projectId: string, harnessId: string, reason: string): void {
    this.exec({ name: 'harness.lost', project_id: projectId, actor: LEASE_MANAGER }, (ctx) => {
      const h = this.q.harness(harnessId);
      this.loseRuns(ctx, harnessId, reason);
      if (h.status !== 'DISCONNECTED' && h.status !== 'TERMINATED') {
        this.moveHarness(ctx, h, 'DISCONNECTED', reason, { disconnected_at: ctx.now });
      }
      for (const agent of this.q.agents(projectId).filter((a) => a.harness_id === harnessId)) {
        if (agent.status !== 'DISCONNECTED' && agent.status !== 'TERMINATED')
          this.moveAgent(ctx, agent, 'DISCONNECTED');
      }
      this.revokeTokens({ harness_id: harnessId }, reason);
    });
  }

  bindSession(
    projectId: string,
    vendor: string,
    hostSessionId: string,
    harnessId: string,
    transcriptPath?: string | null,
  ): void {
    this.exec({ name: 'harness.bind', project_id: projectId, actor: SYSTEM }, (ctx) => {
      const h = this.q.harness(harnessId);
      ctx.emit({
        type: 'harness.session_bound',
        payload: {
          vendor,
          host_session_id: hostSessionId,
          harness_id: harnessId,
          transcript_path: transcriptPath ?? null,
        },
        refs: [{ kind: 'harness', id: harnessId }],
      });
      if (h.host_session_id !== hostSessionId)
        this.moveHarness(ctx, h, h.status, 'session', { host_session_id: hostSessionId });
    });
  }

  /**
   * Holds lease judgement for one lease TTL (M3.1, R09). While the daemon was not running, or was
   * paused (a long collection, a laptop asleep), sessions could not heartbeat, so a stale lease
   * is no evidence that a session died. Sessions that last reported before now get one lease
   * TTL to report again; anything that reports afterwards is judged as usual.
   */
  holdLeaseJudgement(projectId: string): { since: string; until: string } {
    const since = this.clock.now();
    const hold = { since, until: addMs(since, this.config.leaseTtlMs) };
    this.leaseGrace.set(projectId, hold);
    return hold;
  }

  /**
   * Lease manager tick (plan B13). Marks late harnesses DEGRADED, expired ones lost, ends the
   * reconnect window, and declines assignments whose `task.start` was never acknowledged.
   * Lease and acknowledgement deadlines wait while judgement is held (`holdLeaseJudgement`).
   */
  tick(projectId: string): {
    degraded: string[];
    lost: string[];
    terminated: string[];
    declined: string[];
    unreserved: string[];
    /** File reservations that expired (ADR-0025). */
    files_released: string[];
    messages_expired: string[];
    messages_escalated: string[];
    /** Replies recovered for answers recorded without one, and those that could not be sent. */
    messages_replied: string[];
    messages_reply_failed: { escalation_id: string; error: string }[];
    /** Attempts ended at the task's spending cap: their grace for a report of the end passed (plan M11.5). */
    budget_stopped: string[];
  } {
    const now = this.clock.now();
    const nowMs = Date.parse(now);
    let grace = this.leaseGrace.get(projectId);
    if (grace && grace.until <= now) {
      this.leaseGrace.delete(projectId);
      grace = undefined;
    }
    /** Sessions that could not report while Friday was stopped or paused are not judged yet. */
    const held = (lastReport: string | null) =>
      grace !== undefined && (lastReport === null || lastReport <= grace.since);
    const out = {
      degraded: [] as string[],
      lost: [] as string[],
      terminated: [] as string[],
      declined: [] as string[],
      unreserved: [] as string[],
      files_released: [] as string[],
      messages_expired: [] as string[],
      messages_escalated: [] as string[],
      messages_replied: [] as string[],
      messages_reply_failed: [] as { escalation_id: string; error: string }[],
      budget_stopped: [] as string[],
    };
    const leases = this.db
      .prepare(
        `SELECT h.harness_id, h.status, h.shadow, h.disconnected_at, l.last_heartbeat_at, l.lease_expires_at, l.heartbeat_interval_ms
         FROM harnesses h JOIN harness_leases l ON l.harness_id = h.harness_id
         WHERE h.project_id = ? AND h.status <> 'TERMINATED'`,
      )
      .all<{
        harness_id: string;
        status: HarnessStatus;
        shadow: number;
        disconnected_at: string | null;
        last_heartbeat_at: string;
        lease_expires_at: string;
        heartbeat_interval_ms: number;
      }>(projectId);
    for (const l of leases) {
      if (held(l.last_heartbeat_at)) continue;
      const expired = Date.parse(l.lease_expires_at) <= nowMs;
      const hasActive = this.q.activeRunsForHarness(l.harness_id).length > 0;
      if (expired && (l.status !== 'DISCONNECTED' || hasActive)) {
        this.markHarnessLost(projectId, l.harness_id, 'lease expired');
        out.lost.push(l.harness_id);
        continue;
      }
      if (
        !expired &&
        (l.status === 'READY' || l.status === 'BUSY') &&
        nowMs - Date.parse(l.last_heartbeat_at) > 2 * l.heartbeat_interval_ms
      ) {
        this.exec({ name: 'harness.degraded', project_id: projectId, actor: LEASE_MANAGER }, (ctx) =>
          this.moveHarness(ctx, this.q.harness(l.harness_id), 'DEGRADED', 'heartbeat late'),
        );
        out.degraded.push(l.harness_id);
      }
      if (
        l.status === 'DISCONNECTED' &&
        l.disconnected_at &&
        nowMs - Date.parse(l.disconnected_at) > this.config.reconnectWindowMs &&
        !hasActive
      ) {
        this.exec({ name: 'harness.terminate', project_id: projectId, actor: LEASE_MANAGER }, (ctx) => {
          this.moveHarness(ctx, this.q.harness(l.harness_id), 'TERMINATED', 'reconnect window expired', {
            terminated_at: ctx.now,
          });
          // Work it held when it went is a transport failure of its host (ADR-0035 §3): the next
          // attempt goes to the next host in the ranking, not back to the one that vanished.
          for (const t of this.q.tasks(projectId, { statuses: ['HARNESS_LOST'] })) {
            if (t.assigned_harness_id !== l.harness_id || !t.current_run_id) continue;
            const run = this.q.findRun(t.current_run_id);
            if (run) {
              this.benchRun(
                ctx,
                projectId,
                run,
                { kind: 'transport' },
                'the session did not come back within the reconnect window',
              );
            }
          }
        });
        out.terminated.push(l.harness_id);
      }
      if (l.shadow && !expired) this.tryPromoteShadow(projectId, l.harness_id);
    }
    // Outbox: task.start never acknowledged.
    const stale = this.db
      .prepare(
        `SELECT message_id, run_id, attempts, status, delivered_at, expires_at FROM outbox_messages
         WHERE project_id = ? AND method = 'task.start' AND status IN ('queued','delivered')`,
      )
      .all<{
        message_id: string;
        run_id: string | null;
        attempts: number;
        status: string;
        delivered_at: string | null;
        expires_at: string;
      }>(projectId);
    // While a human has paused Friday, starts are held on purpose: none times out (review M9i).
    const pausedNow = this.q.control(projectId).paused;
    for (const m of stale) {
      if (pausedNow) break;
      if (held(m.delivered_at)) continue;
      const timedOut =
        Date.parse(m.expires_at) <= nowMs ||
        (m.attempts >= this.config.maxDeliveryAttempts &&
          m.delivered_at !== null &&
          nowMs - Date.parse(m.delivered_at) > this.config.ackTimeoutMs);
      if (!timedOut || !m.run_id) continue;
      this.declineRun(projectId, m.run_id, 'ack timeout', LEASE_MANAGER, { kind: 'timeout' });
      this.db.prepare("UPDATE outbox_messages SET status = 'expired' WHERE message_id = ?").run(m.message_id);
      out.declined.push(m.run_id);
    }
    // Runs whose worktree was never prepared (ADR-0023 §2): declined, with the reason, never left waiting.
    for (const run of this.runsAwaitingWorkspace(projectId)) {
      if (held(run.created_at)) continue;
      if (nowMs - Date.parse(run.created_at) > this.config.workspaceTimeoutMs) {
        this.workspaceFailed(
          projectId,
          run.run_id,
          `it was not ready within ${Math.round(this.config.workspaceTimeoutMs / 1000)} s`,
        );
        out.declined.push(run.run_id);
      }
    }
    // Attempts stopped at the task's spending cap whose grace for a report of the end has passed
    // (plan M11.5) end now, as `budget_exceeded`. A stop recorded before Friday was away is held
    // like the leases: the report may still be on its way.
    for (const run of this.q.runsWithStatus(projectId, ['ACTIVE', 'SUSPENDED'])) {
      const stop = this.capStopOf(projectId, run.run_id);
      if (!stop || held(stop.at) || Date.parse(stop.at) + BUDGET_STOP_GRACE_MS > nowMs) continue;
      if (this.endRunAtCap(projectId, run.run_id, stop)) out.budget_stopped.push(run.run_id);
    }
    out.unreserved.push(...this.expireReservations(projectId, this.clock.now()));
    out.files_released.push(...this.expireFileReservations(projectId, this.clock.now()));
    const timeouts = this.expireMessages(projectId, this.clock.now());
    out.messages_expired.push(...timeouts.expired);
    out.messages_escalated.push(...timeouts.escalated);
    out.messages_replied.push(...timeouts.replied);
    out.messages_reply_failed.push(...timeouts.reply_failed);
    return out;
  }

  private declineRun(projectId: string, runId: string, reason: string, actor: Actor, failure?: HostFailure): void {
    this.exec({ name: 'run.decline', project_id: projectId, actor }, (ctx) => {
      const run = this.q.run(runId);
      if (run.status !== 'STARTING') return;
      // Friday's own classification of what it observed (ADR-0035 §3): a start never acknowledged.
      if (failure) this.benchRun(ctx, projectId, run, failure, reason);
      this.declineWithin(ctx, projectId, run, reason);
    });
  }

  /** A run that never started ends declined, and its task is free again (ASSIGNED → READY). */
  private declineWithin(ctx: CommandContext, projectId: string, run: RunView, reason: string, actor?: Actor): void {
    this.moveRun(ctx, run, 'DECLINED', reason, { outcome: 'declined', ended_at: ctx.now }, actor);
    const task = this.q.task(projectId, run.task_id);
    const agentId = task.assigned_agent_id;
    if (task.status === 'ASSIGNED' && task.current_run_id === run.run_id) {
      this.moveTask(ctx, task, 'task.release', {
        reason,
        ...(actor ? { actor } : {}),
        changes: { assigned_agent_id: null, assigned_harness_id: null, current_run_id: null },
      });
    }
    const agent = agentId ? this.q.findAgent(agentId) : undefined;
    if (agent && agent.status === 'ASSIGNED')
      this.moveAgent(ctx, agent, 'AVAILABLE', { current_task_id: null, current_run_id: null }, actor);
  }

  // ================================================================ outbox (daemon → harness)

  private enqueue(
    ctx: CommandContext,
    harnessId: string,
    method: OutboundMessage['method'],
    params: unknown,
    runId: string | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO outbox_messages (message_id, project_id, harness_id, method, params_json, status, attempts, run_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
      )
      .run(
        this.ids.next('out'),
        ctx.project_id,
        harnessId,
        method,
        toJson(params),
        runId,
        ctx.now,
        addMs(ctx.now, this.config.ackTimeoutMs * this.config.maxDeliveryAttempts * 2),
      );
  }

  private expireOutboxForRun(_ctx: CommandContext, runId: string): void {
    this.db
      .prepare("UPDATE outbox_messages SET status = 'expired' WHERE run_id = ? AND status IN ('queued','delivered')")
      .run(runId);
  }

  private ackPendingStart(ctx: CommandContext, runId: string): void {
    this.db
      .prepare(
        "UPDATE outbox_messages SET status = 'acked', acked_at = ? WHERE run_id = ? AND method = 'task.start' AND status IN ('queued','delivered')",
      )
      .run(ctx.now, runId);
  }

  /** Messages for the harness: new ones, plus delivered ones whose ack is overdue (at-least-once). */
  pollOutbox(projectId: string, harnessId: string, max = 10): OutboundMessage[] {
    const now = this.clock.now();
    const redeliverBefore = addMs(now, -this.config.ackTimeoutMs);
    // While a human has paused Friday, no work is handed to an agent: starts and resumes wait in
    // the outbox and go out after the resume (plan M9 §5.5). Cancels and context still go.
    const held = this.q.control(projectId).paused ? 1 : 0;
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM outbox_messages WHERE project_id = ? AND harness_id = ? AND expires_at > ?
             AND (status = 'queued' OR (status = 'delivered' AND delivered_at <= ?))
             AND NOT (? = 1 AND method IN ('task.start', 'task.resume'))
           ORDER BY created_at LIMIT ?`,
        )
        .all<{
          message_id: string;
          method: OutboundMessage['method'];
          params_json: string;
          attempts: number;
          expires_at: string;
        }>(projectId, harnessId, now, redeliverBefore, held, max);
      const mark = this.db.prepare(
        "UPDATE outbox_messages SET status = 'delivered', delivered_at = ?, attempts = attempts + 1 WHERE message_id = ?",
      );
      return rows.map((r) => {
        mark.run(now, r.message_id);
        return {
          message_id: r.message_id,
          method: r.method,
          params: JSON.parse(r.params_json) as Record<string, unknown>,
          sent_at: now,
          expires_at: r.expires_at,
          attempt: r.attempts + 1,
        };
      });
    });
  }

  ackOutbox(
    projectId: string,
    harnessId: string,
    acks: { message_id: string; accepted: boolean; session_ref?: string | undefined; reason?: string | undefined }[],
  ): { acked: string[]; unknown: string[]; current: string[] } {
    const acked: string[] = [];
    const unknown: string[] = [];
    const current: string[] = [];
    for (const a of acks) {
      const m = this.db
        .prepare('SELECT * FROM outbox_messages WHERE message_id = ? AND harness_id = ? AND project_id = ?')
        .get<{ message_id: string; method: string; status: string; run_id: string | null }>(
          a.message_id,
          harnessId,
          projectId,
        );
      if (!m) {
        unknown.push(a.message_id);
        continue;
      }
      const work = (m.method === 'task.start' || m.method === 'task.resume') && m.run_id ? m.run_id : null;
      // A start or resume delivered before a pause and accepted during it is not applied: the
      // message waits in the outbox again, is not current, so the harness starts nothing, and it
      // is delivered once Friday runs again (plan M9 §5.5).
      if (work && a.accepted && m.status !== 'acked' && m.status !== 'expired' && this.q.control(projectId).paused) {
        this.db
          .prepare("UPDATE outbox_messages SET status = 'queued', delivered_at = NULL WHERE message_id = ?")
          .run(a.message_id);
        continue;
      }
      if (m.status !== 'acked') {
        if (m.method === 'task.start' && m.run_id && m.status !== 'expired') {
          if (a.accepted) this.acceptRun(projectId, harnessId, m.run_id, a.session_ref ?? null);
          else
            this.declineRun(projectId, m.run_id, a.reason ?? 'declined by harness', { kind: 'harness', id: harnessId });
        }
        if (m.method === 'task.resume' && m.run_id && m.status !== 'expired' && a.accepted) {
          this.resumeRun(projectId, harnessId, m.run_id);
          this.continueRun(projectId, harnessId, m.run_id);
        }
        this.db
          .prepare(
            "UPDATE outbox_messages SET status = 'acked', acked_at = ?, ack_result_json = ? WHERE message_id = ?",
          )
          .run(this.clock.now(), toJson({ accepted: a.accepted, reason: a.reason ?? null }), a.message_id);
      }
      acked.push(a.message_id);
      // An acknowledgement is not authority (review M8-R03): the harness works on a run only while
      // it is active on it and its task's current run, which a cancel, an expiry or a reassignment
      // made before the acknowledgement arrived has already changed.
      if (work && a.accepted && this.isCurrentRun(projectId, harnessId, work)) current.push(a.message_id);
    }
    return { acked, unknown, current };
  }

  /** Whether a run is active on this harness and its task's current run. */
  private isCurrentRun(projectId: string, harnessId: string, runId: string): boolean {
    const run = this.q.findRun(runId);
    if (!run || run.harness_id !== harnessId || run.status !== 'ACTIVE') return false;
    const task = this.q.task(projectId, run.task_id);
    return task.current_run_id === runId && (task.status === 'RUNNING' || task.status === 'WAITING');
  }

  private acceptRun(projectId: string, harnessId: string, runId: string, sessionRef: string | null): void {
    this.exec({ name: 'run.accept', project_id: projectId, actor: { kind: 'harness', id: harnessId } }, (ctx) => {
      const run = this.q.run(runId);
      if (run.harness_id !== harnessId) throw new FridayError('permission_denied', 'run belongs to another harness');
      if (run.status !== 'STARTING') return;
      this.moveRun(ctx, run, 'ACTIVE', 'accepted', { accepted_at: ctx.now, session_ref: sessionRef });
      const task = this.q.task(projectId, run.task_id);
      this.moveTask(ctx, task, 'run.accepted', { changes: { started_at: task.started_at ?? ctx.now } });
      const agent = this.q.agent(run.agent_id);
      this.agentToBusy(ctx, agent, { current_task_id: run.task_id, current_run_id: run.run_id });
      this.syncHarnessBusy(ctx, harnessId);
    });
  }

  /** A waiting task's ACTIVE run continues in its session (plan M9 §5.6): WAITING → RUNNING. */
  private continueRun(projectId: string, harnessId: string, runId: string): void {
    this.exec({ name: 'run.continue', project_id: projectId, actor: { kind: 'harness', id: harnessId } }, (ctx) => {
      const run = this.q.run(runId);
      if (run.harness_id !== harnessId || run.status !== 'ACTIVE') return;
      const task = this.q.task(projectId, run.task_id);
      if (task.status !== 'WAITING' || task.current_run_id !== runId) return;
      this.moveTask(ctx, task, 'task.resume', { reason: 'the session continues after a human decided' });
      this.agentToBusy(ctx, this.q.agent(run.agent_id), { current_task_id: run.task_id, current_run_id: run.run_id });
      this.syncHarnessBusy(ctx, harnessId);
    });
  }

  private resumeRun(projectId: string, harnessId: string, runId: string): void {
    this.exec({ name: 'run.resume', project_id: projectId, actor: { kind: 'harness', id: harnessId } }, (ctx) => {
      const run = this.q.run(runId);
      if (run.harness_id !== harnessId || run.status !== 'SUSPENDED') return;
      this.moveRun(ctx, run, 'ACTIVE', 'resumed');
      const task = this.q.task(projectId, run.task_id);
      if (task.status === 'HARNESS_LOST' && task.current_run_id === runId) this.moveTask(ctx, task, 'run.resumed');
      this.agentToBusy(ctx, this.q.agent(run.agent_id), { current_task_id: run.task_id, current_run_id: run.run_id });
      this.syncHarnessBusy(ctx, harnessId);
    });
  }

  // ================================================================ task worktrees (M5a, ADR-0023)

  /** Spawn runs whose worktree the daemon still has to prepare. */
  runsAwaitingWorkspace(projectId: string): RunView[] {
    return this.q.runsWithStatus(projectId, ['STARTING']).filter((r) => r.workspace === 'pending');
  }

  /**
   * The run's worktree is ready: it is recorded (or reused), the run gets its execution root,
   * and `task.start` is queued with it, in one transaction.
   */
  workspaceReady(
    projectId: string,
    runId: string,
    alloc: {
      path: string;
      branch: string;
      base_commit: string;
      created: boolean;
      warnings: string[];
      /** What installing the worktree's dependencies did; null when nothing was attempted. */
      setup?: WorkspaceSetupRecord | null;
    },
  ): RunView {
    return this.exec({ name: 'run.workspace', project_id: projectId, actor: SYSTEM, params: { runId } }, (ctx) => {
      const run = this.q.run(runId);
      if (run.workspace !== 'pending' || run.status !== 'STARTING') return run;
      const task = this.q.task(projectId, run.task_id);
      const owner = this.q.operationRuns(projectId, { task_id: task.task_id, status: 'running', limit: 1 })[0];
      if (owner) {
        throw new FridayError(
          'invalid_state_transition',
          `${owner.operation} (${owner.operation_run_id}) of an earlier attempt still runs in the worktree`,
        );
      }
      let worktree = this.q.worktreeForTask(task.task_id);
      if (worktree && worktree.path === alloc.path && worktree.status !== 'active') {
        ctx.emit({
          type: 'worktree.released',
          payload: { worktree_id: worktree.worktree_id, status: 'active', reason: 'reused by a new attempt' },
          refs: [
            { kind: 'task', id: task.task_id },
            { kind: 'worktree', id: worktree.worktree_id },
          ],
        });
      }
      if (!worktree || worktree.path !== alloc.path) {
        const worktree_id = this.ids.next('wt');
        ctx.emit({
          type: 'worktree.allocated',
          payload: {
            worktree: {
              worktree_id,
              task_id: task.task_id,
              path: alloc.path,
              branch: alloc.branch,
              base_commit: alloc.base_commit,
              note: alloc.warnings.join('; ') || null,
            },
          },
          refs: [
            { kind: 'task', id: task.task_id },
            { kind: 'run', id: run.run_id },
            { kind: 'worktree', id: worktree_id },
          ],
        });
        worktree = this.q.worktreeForTask(task.task_id);
      }
      ctx.emit({
        type: 'run.workspace_ready',
        payload: {
          run_id: run.run_id,
          execution_root: alloc.path,
          base_commit: alloc.base_commit,
          branch_ref: alloc.branch,
          worktree_id: worktree?.worktree_id ?? null,
          warnings: alloc.warnings,
          setup: alloc.setup ?? null,
        },
        refs: [
          { kind: 'task', id: task.task_id },
          { kind: 'run', id: run.run_id },
        ],
      });
      const ready = this.q.run(run.run_id);
      const agent = this.q.agent(run.agent_id);
      // An agent whose dependencies could not be installed is told so, never left to find out.
      const setup = alloc.setup;
      const trouble =
        setup && (setup.status === 'failed' || setup.status === 'refused')
          ? `Friday could not install this worktree's dependencies (${setup.reason}). If the task needs them, install them yourself; that may need an approval.`
          : null;
      this.enqueue(
        ctx,
        run.harness_id,
        'task.start',
        this.taskStartParams(projectId, task, ready, agent.role, trouble),
        run.run_id,
      );
      return ready;
    });
  }

  /** The worktree could not be prepared: the run is declined and the task is free again, with the reason. */
  workspaceFailed(projectId: string, runId: string, reason: string): void {
    const run = this.q.findRun(runId);
    if (run?.workspace !== 'pending' || run.status !== 'STARTING') return;
    this.declineRun(projectId, runId, `the task worktree could not be prepared: ${reason}`, SYSTEM);
  }

  /**
   * A run's work now lives in a worktree of this clone (review M7.1 R05): a claim restored from a
   * backup is verified there. The run's base commit, claim and status stay as they were.
   */
  rebindRun(projectId: string, actor: Actor, runId: string, executionRoot: string, reason: string): RunView {
    return this.exec({ name: 'run.rebind', project_id: projectId, actor, params: { runId, executionRoot } }, (ctx) => {
      const run = this.q.run(runId);
      if (!this.inThisClone(executionRoot)) {
        throw new FridayError('invalid_request', `${executionRoot} is not a worktree of this clone`);
      }
      ctx.emit({
        type: 'run.rebound',
        payload: { run_id: runId, task_id: run.task_id, execution_root: executionRoot, reason },
        refs: [
          { kind: 'run', id: runId },
          { kind: 'task', id: run.task_id },
        ],
      });
      return this.q.run(runId);
    });
  }

  /**
   * A worktree a human asked for (`friday task worktree`), to start a session in, or one a human's
   * recovery choice rebuilt (review F16). A record at the same path with another base (a branch
   * started over) is retired in the same transaction.
   */
  recordWorktree(
    projectId: string,
    actor: Actor,
    taskId: string,
    alloc: { path: string; branch: string; base_commit: string; warnings: string[] },
  ): WorktreeView {
    return this.exec({ name: 'worktree.allocate', project_id: projectId, actor, params: { taskId } }, (ctx) => {
      const task = this.q.task(projectId, taskId);
      // A completed task whose verified work still waits for its goal branch keeps a worktree, also
      // one rebuilt in this clone from a backup (review M7.1 R05).
      const integrating =
        task.status === 'COMPLETED' &&
        this.awaitsIntegration(task) &&
        !['integrated', 'not_needed'].includes(this.q.latestIntegration(projectId, taskId)?.status ?? '');
      if (TERMINAL_TASK.has(task.status) && !integrating) {
        throw new FridayError('invalid_state_transition', `task ${taskId} is ${task.status}`);
      }
      const existing = this.q.worktreeForTask(taskId);
      if (existing && existing.path === alloc.path && existing.base_commit === alloc.base_commit) return existing;
      if (existing && existing.path === alloc.path) {
        ctx.emit({
          type: 'worktree.released',
          payload: {
            worktree_id: existing.worktree_id,
            status: 'released',
            reason: `its branch starts at ${alloc.base_commit.slice(0, 12)} now`,
          },
          refs: [
            { kind: 'task', id: taskId },
            { kind: 'worktree', id: existing.worktree_id },
          ],
        });
      }
      const worktree_id = this.ids.next('wt');
      ctx.emit({
        type: 'worktree.allocated',
        payload: {
          worktree: {
            worktree_id,
            task_id: taskId,
            path: alloc.path,
            branch: alloc.branch,
            base_commit: alloc.base_commit,
            note: alloc.warnings.join('; ') || null,
          },
        },
        refs: [
          { kind: 'task', id: taskId },
          { kind: 'worktree', id: worktree_id },
        ],
      });
      return this.q.worktreeForTask(taskId) as WorktreeView;
    });
  }

  /** A finished task's worktree: `released` when clean, `preserved` when it holds uncommitted work. */
  releaseWorktree(
    projectId: string,
    actor: Actor,
    worktreeId: string,
    status: 'released' | 'preserved',
    reason: string,
  ): void {
    this.exec({ name: 'worktree.release', project_id: projectId, actor, params: { worktreeId, status } }, (ctx) => {
      const w = this.q.worktrees(projectId).find((x) => x.worktree_id === worktreeId);
      if (!w || w.status === 'removed' || w.status === status) return;
      ctx.emit({
        type: 'worktree.released',
        payload: { worktree_id: worktreeId, status, reason },
        refs: [
          { kind: 'task', id: w.task_id },
          { kind: 'worktree', id: worktreeId },
        ],
      });
    });
  }

  worktreeRemoved(projectId: string, actor: Actor, worktreeId: string): void {
    this.exec({ name: 'worktree.remove', project_id: projectId, actor, params: { worktreeId } }, (ctx) => {
      const w = this.q.worktrees(projectId).find((x) => x.worktree_id === worktreeId);
      if (!w || w.status === 'removed') return;
      ctx.emit({
        type: 'worktree.removed',
        payload: { worktree_id: worktreeId },
        refs: [
          { kind: 'task', id: w.task_id },
          { kind: 'worktree', id: worktreeId },
        ],
      });
    });
  }

  // ================================================================ file reservations

  /**
   * Exclusive reservations of conflict-prone files for a task (ADR-0025 §1). A pattern the task
   * already holds is kept; one that `overlaps` a pattern another task holds refuses the whole
   * request with COS-8002, naming the holder. The check and the reservation are one transaction.
   */
  reserveFiles(
    projectId: string,
    actor: Actor,
    taskId: string,
    patterns: readonly string[],
    via: FileReservationView['via'],
    overlaps: (a: string, b: string) => boolean,
    note?: string,
  ): FileReservationView[] {
    return this.exec(
      { name: 'file.reserve', project_id: projectId, actor, params: { taskId, patterns, via } },
      (ctx) => {
        const task = this.q.task(projectId, taskId);
        if (['COMPLETED', 'CANCELLED', 'ABANDONED'].includes(task.status)) {
          throw new FridayError('invalid_state_transition', `${taskId} is ${task.status}; it cannot reserve files`);
        }
        const active = this.q.fileReservations(projectId, ['active']);
        const ids: string[] = [];
        for (const pattern of [...new Set(patterns.map(normalizePath))]) {
          const mine = active.find((r) => r.task_id === taskId && r.pattern === pattern);
          if (mine) {
            ids.push(mine.reservation_id);
            continue;
          }
          const other = active.find((r) => r.task_id !== taskId && overlaps(r.pattern, pattern));
          if (other) {
            throw new FridayError(
              'reservation_conflict',
              `${pattern} overlaps ${other.pattern}, which ${other.task_id} has held reserved since ${other.acquired_at}`,
              { holder_task_id: other.task_id, reservation_id: other.reservation_id, pattern: other.pattern },
            );
          }
          const reservation_id = this.ids.next('res');
          ctx.emit({
            type: 'file.reserved',
            payload: { reservation: { reservation_id, task_id: taskId, pattern, via, note: note ?? null } },
            refs: [
              { kind: 'reservation', id: reservation_id },
              { kind: 'task', id: taskId },
            ],
          });
          ids.push(reservation_id);
        }
        return ids.map((id) => this.q.fileReservation(id) as FileReservationView);
      },
    );
  }

  /**
   * The outcome of integrating a task into its goal branch (ADR-0025 §2–§5). A conflict or a failed
   * check of the merged revision asks a human (or the Master Brain's next plan) in the same
   * transaction; whatever the outcome, the task's file reservations end with it.
   */
  recordIntegration(
    projectId: string,
    actor: Actor,
    rec: Omit<IntegrationView, 'integration_id' | 'created_at'>,
  ): IntegrationView {
    return this.exec(
      { name: 'integration.record', project_id: projectId, actor, params: { task: rec.task_id, status: rec.status } },
      (ctx) => {
        const integration_id = this.ids.next('int');
        const type =
          rec.status === 'integrated'
            ? 'integration.completed'
            : rec.status === 'not_needed'
              ? 'integration.not_needed'
              : `integration.${rec.status}`;
        ctx.emit({
          type,
          payload: { integration: { integration_id, ...rec } },
          refs: [
            { kind: 'integration', id: integration_id },
            { kind: 'goal', id: rec.goal_id },
            { kind: 'task', id: rec.task_id },
          ],
        });
        if (rec.status === 'integrated' || rec.status === 'not_needed') {
          this.settleQuestions(ctx, rec.task_id, INTEGRATION_QUESTIONS, 'the work was integrated');
        }
        if (rec.status === 'conflicted' || rec.status === 'failed') {
          this.escalationWithin(ctx, {
            kind: rec.status === 'conflicted' ? 'integration_conflict' : 'integration_failed',
            goal_id: rec.goal_id,
            task_id: rec.task_id,
            question:
              rec.status === 'conflicted'
                ? `The verified work of ${rec.task_id} conflicts with ${rec.branch} in ${rec.conflicts.length} file(s): ${rec.conflicts.slice(0, 10).join(', ')}. How should it be resolved?`
                : `${rec.task_id} could not be integrated into ${rec.branch ?? 'its goal branch'}: ${rec.summary ?? 'unknown reason'}. What now?`,
            options: [
              `resolve it on ${rec.branch ?? 'the goal branch'}, then run "friday integrate ${rec.task_id}"`,
              'plan a task that resolves it',
              'cancel the goal',
            ],
            details: { integration_id, conflicts: rec.conflicts, summary: rec.summary },
          });
        }
        this.endFileReservations(ctx, rec.task_id, 'released', `integration ${rec.status.replace('_', ' ')}`);
        return this.q.integrations(projectId, { task_id: rec.task_id }).at(-1) as IntegrationView;
      },
    );
  }

  // ================================================================ operations (M6c, ADR-0029)

  /**
   * The gateway starts an operation for the agent holding the task (ADR-0029 §3): recorded with
   * the names of the credentials it receives and the approval it spends, in one transaction. All
   * of its authority is checked again here, at the moment it starts (review F06): the task still
   * runs, in the caller's attempt, from the caller's session; the approval still covers it; and
   * `still` (the daemon's view of the effective policy, the operation's definition and the agent's
   * role) still allows it. The gateway starts the process right after this commits.
   */
  startOperation(
    projectId: string,
    caller: Caller,
    op: {
      operation: string;
      task_id: string;
      run_id: string | null;
      binary: string;
      cwd: string;
      credentials: string[];
      approval_id: string | null;
      policy_version: string | null;
      risk: 'low' | 'medium' | 'high';
      reason: string;
    },
    opts: { idempotency_key?: string | undefined; still?: () => string | null } = {},
  ): OperationRunView {
    const actor: Actor = { kind: 'agent', id: caller.agent_id };
    return this.exec(
      {
        name: 'operation.start',
        project_id: projectId,
        actor,
        idempotency_key: opts.idempotency_key,
        params: { operation: op.operation, task_id: op.task_id, run_id: op.run_id, reason: op.reason },
      },
      (ctx) => {
        this.assertNotPaused(projectId);
        const task = this.q.findTask(projectId, op.task_id);
        const run = op.run_id ? this.q.findRun(op.run_id) : undefined;
        if (task?.status !== 'RUNNING' || task.assigned_agent_id !== caller.agent_id) {
          throw new FridayError(
            'permission_denied',
            `${op.task_id} is ${task?.status ?? 'gone'}${task && task.assigned_agent_id !== caller.agent_id ? ' and held by another agent' : ''}; ${op.operation} was not started`,
          );
        }
        if (
          !run ||
          task.current_run_id !== run.run_id ||
          run.status !== 'ACTIVE' ||
          run.harness_id !== caller.harness_id
        ) {
          throw new FridayError(
            'permission_denied',
            `this session no longer holds the attempt of ${op.task_id} it asked for; ${op.operation} was not started`,
          );
        }
        const refused = opts.still?.();
        if (refused) throw new FridayError('permission_denied', refused);
        const running = this.q.operationRuns(projectId, { task_id: op.task_id, status: 'running', limit: 1 })[0];
        if (running) {
          throw new FridayError(
            'invalid_state_transition',
            `${running.operation} is already running for ${op.task_id} (${running.operation_run_id}); one operation runs at a time per task`,
          );
        }
        if (op.approval_id) {
          const still = this.q.usableApproval(projectId, {
            capability: 'operation.run',
            target: op.operation,
            task_id: op.task_id,
            run_id: op.run_id,
            agent_id: caller.agent_id,
            policy_version: op.policy_version,
            now: ctx.now,
          });
          if (still !== op.approval_id) {
            throw new FridayError(
              'approval_required',
              `the approval no longer covers running ${op.operation}; ask again`,
            );
          }
        }
        const operation_run_id = this.ids.next('op');
        const { policy_version: _v, ...recorded } = op;
        ctx.emit({
          type: 'operation.started',
          payload: { operation: { operation_run_id, agent_id: caller.agent_id, ...recorded } },
          refs: [
            { kind: 'operation', id: operation_run_id },
            { kind: 'task', id: op.task_id },
            ...(op.run_id ? [{ kind: 'run' as const, id: op.run_id }] : []),
            ...(op.approval_id ? [{ kind: 'approval' as const, id: op.approval_id }] : []),
          ],
        });
        if (op.approval_id) {
          ctx.emit({
            type: 'approval.used',
            payload: { approval_id: op.approval_id, tool: 'friday_run_operation', target: op.operation },
            refs: [{ kind: 'approval', id: op.approval_id }],
          });
        }
        return this.q.operationRun(operation_run_id) as OperationRunView;
      },
    );
  }

  /**
   * The outcome of an operation; its sanitized output is an artifact (ADR-0029 §5). `interrupted`:
   * Friday stopped it (its attempt ended, or the daemon stopped) and confirmed its processes ended.
   */
  finishOperation(
    projectId: string,
    operationRunId: string,
    outcome: {
      status: 'passed' | 'failed' | 'interrupted';
      exit_code: number | null;
      timed_out: boolean;
      duration_ms: number;
      redactions: number;
      artifact_ref: string | null;
      summary: string;
    },
  ): OperationRunView {
    const actor: Actor = { kind: 'system', id: 'gateway' };
    return this.exec(
      { name: 'operation.finish', project_id: projectId, actor, params: { operationRunId, status: outcome.status } },
      (ctx) => {
        const row = this.q.operationRun(operationRunId);
        if (!row) throw new FridayError('invalid_request', `operation run ${operationRunId} not found`);
        if (row.status !== 'running') return row;
        ctx.emit({
          type: 'operation.finished',
          payload: { operation_run_id: operationRunId, operation: row.operation, task_id: row.task_id, ...outcome },
          refs: [
            { kind: 'operation', id: operationRunId },
            { kind: 'task', id: row.task_id },
          ],
        });
        return this.q.operationRun(operationRunId) as OperationRunView;
      },
    );
  }

  /** At start: operations still running had their runner stop with the daemon (ADR-0029 §7). */
  interruptOrphanedOperations(projectId: string, note: string, running: ReadonlySet<string>): string[] {
    const orphans = this.q
      .operationRuns(projectId, { status: 'running', limit: 1000 })
      .filter((r) => !running.has(r.operation_run_id));
    if (!orphans.length) return [];
    const actor: Actor = { kind: 'system', id: 'gateway' };
    this.exec(
      { name: 'operation.interrupt', project_id: projectId, actor, params: { count: orphans.length } },
      (ctx) => {
        for (const r of orphans) {
          ctx.emit({
            type: 'operation.interrupted',
            payload: { operation_run_id: r.operation_run_id, operation: r.operation, task_id: r.task_id, note },
            refs: [
              { kind: 'operation', id: r.operation_run_id },
              { kind: 'task', id: r.task_id },
            ],
          });
        }
      },
    );
    return orphans.map((r) => r.operation_run_id);
  }

  /** A human ends a reservation early (`friday reservations release`). */
  releaseFileReservation(projectId: string, actor: Actor, reservationId: string, note: string): FileReservationView {
    return this.exec({ name: 'file.release', project_id: projectId, actor, params: { reservationId } }, (ctx) => {
      const r = this.q.fileReservation(reservationId);
      if (!r) throw new FridayError('invalid_request', `reservation ${reservationId} not found`);
      if (r.status !== 'active') return r;
      ctx.emit({
        type: 'file.reservation_ended',
        payload: { reservation_id: reservationId, task_id: r.task_id, pattern: r.pattern, status: 'released', note },
        refs: [
          { kind: 'reservation', id: reservationId },
          { kind: 'task', id: r.task_id },
        ],
      });
      return this.q.fileReservation(reservationId) as FileReservationView;
    });
  }

  /**
   * Reservations whose task has stood still (READY again, failed, or its harness lost) for longer than the
   * TTL expire, so a dead session cannot hold conflict-prone files forever (ADR-0025 §1).
   */
  private expireFileReservations(projectId: string, now: string): string[] {
    const nowMs = Date.parse(now);
    const ended: string[] = [];
    const stalled = new Map<string, string>();
    for (const r of this.q.fileReservations(projectId, ['active'])) {
      if (!stalled.has(r.task_id)) {
        const t = this.q.findTask(projectId, r.task_id);
        const still = t && ['READY', 'HARNESS_LOST', 'PROPOSED', 'FAILED'].includes(t.status);
        stalled.set(
          r.task_id,
          still && nowMs - Date.parse(t.updated_at) > this.config.fileReservationTtlMs ? t.status : '',
        );
      }
      const status = stalled.get(r.task_id);
      if (!status) continue;
      this.exec({ name: 'file.expire', project_id: projectId, actor: SYSTEM, params: { task: r.task_id } }, (ctx) => {
        ended.push(
          ...this.endFileReservations(
            ctx,
            r.task_id,
            'expired',
            `the task has been ${status} for more than ${Math.round(this.config.fileReservationTtlMs / 60_000)} min`,
          ),
        );
      });
      stalled.set(r.task_id, '');
    }
    return ended;
  }

  /** A write was refused because another task holds the files (audit; the hook already denied it). */
  ownershipConflict(
    projectId: string,
    actor: Actor,
    detail: { task_id: string | null; targets: string[]; holder_task_id: string; pattern: string; tool?: string },
  ): void {
    this.recordObservation(projectId, actor, 'ownership.conflict', detail, [
      ...(detail.task_id ? [{ kind: 'task' as const, id: detail.task_id }] : []),
      { kind: 'task' as const, id: detail.holder_task_id },
    ]);
  }

  private startParams(
    projectId: string,
    task: TaskView,
    run: RunView,
    role: string,
    note: string | null = null,
  ): TaskStartParams {
    return {
      task_id: task.task_id,
      run_id: run.run_id,
      attempt: run.attempt,
      role,
      instruction: task.description ? `${task.summary}\n\n${task.description}` : task.summary,
      context_packet_ref: null,
      working_directory: run.execution_root ?? this.q.project(projectId)?.root_path ?? '.',
      git_ref: run.branch_ref,
      acceptance_criteria: task.acceptance_criteria,
      policy_profile: null,
      model: run.model_requested,
      model_binding: run.model_binding,
      // The session to resume, as the adapter reported it when it accepted the run (ADR-0032 §3).
      session_ref: run.session_ref ?? null,
      continue_session: null,
      note,
      // The task's spending cap (plan M11.5), for a host that can enforce one itself.
      budget_usd:
        typeof this.config.taskBudgetUsd === 'number' && this.config.taskBudgetUsd > 0
          ? this.config.taskBudgetUsd
          : null,
    };
  }

  /** A new attempt's `task.start`: with the session it continues, when it is a rework that can (plan M13.2). */
  private taskStartParams(
    projectId: string,
    task: TaskView,
    run: RunView,
    role: string,
    extra: string | null = null,
  ): TaskStartParams {
    const cont = this.continuation(projectId, task, run);
    const note = [cont?.note, extra].filter((n): n is string => Boolean(n)).join('\n\n');
    return {
      ...this.startParams(projectId, task, run, role, note.slice(0, 2000) || null),
      continue_session: cont?.session ?? null,
    };
  }

  /**
   * A rework continues the session that did the work (plan M13.2): when the new attempt's agent and
   * harness are those of the attempt verification refused, that attempt left a session, and the
   * harness declared `capabilities.resume_session`, its `task.start` names that session and says,
   * as the session's next message, why the claim was refused. The session already holds the task,
   * the files it read and what it did, so nothing is sent or read twice (B31). Null otherwise: the
   * attempt starts a new session with its packet and the handoff summary.
   */
  private continuation(projectId: string, task: TaskView, run: RunView): { session: string; note: string } | null {
    if (run.attempt <= 1 || run.session_ref) return null;
    // The attempt whose claim was refused; attempts declined since started no session, so they are
    // passed over, while any other session in between ends the chain.
    const earlier = this.q.runs(task.task_id).filter((r) => r.attempt < run.attempt);
    const at = earlier.findLastIndex((r) => r.claim);
    const prev = at >= 0 ? earlier[at] : undefined;
    if (!prev || earlier.slice(at + 1).some((r) => r.session_ref)) return null;
    if (!prev.session_ref || prev.agent_id !== run.agent_id || prev.harness_id !== run.harness_id) return null;
    const caps = (this.q.findHarness(run.harness_id)?.capabilities ?? {}) as { resume_session?: unknown };
    if (caps.resume_session !== true) return null;
    // Only a claim that verification refused: a lost or cancelled session is recovery's to judge.
    const verification = this.q.latestVerificationForRun(prev.run_id);
    if (!prev.claim || verification?.status !== 'FAILED') return null;
    // The session holds the packet it was given and what it read: only under the policy that packet
    // was compiled under (review M7.1e R02). A changed policy starts a new session with a new packet.
    const now = this.policyVersion?.() ?? null;
    const then = this.db
      .prepare(
        `SELECT json_extract(explanation_json, '$.policy_version') AS v FROM context_packets
          WHERE task_id = ? AND json_extract(packet_json, '$.recipient.run_id') = ? ORDER BY created_at LIMIT 1`,
      )
      .get<{ v: string | null }>(task.task_id, prev.run_id);
    if (then && (then.v ?? null) !== now) return null;
    const rework = this.store.readByRef(projectId, 'task', task.task_id, { types: ['task.rework'] }).at(-1);
    const why = (rework?.payload as { transition?: { reason?: string } } | undefined)?.transition?.reason;
    // Each failed check names its raw output, so a lesson learned from it can say where it comes from (ADR-0038 §3).
    const failed = verification.checks
      .filter((c) => c.status === 'FAILED' || c.status === 'BLOCKED')
      .map(
        (c) =>
          `${c.name}: ${(c.summary ?? c.status).slice(0, 240)}${c.artifact_ref ? ` (raw output: ${c.artifact_ref})` : ''}`,
      );
    const note = [
      "Friday's verification refused your completion claim.",
      why ? `Why: ${why}` : verification.summary ? `Why: ${verification.summary}` : '',
      failed.length ? `Checks that failed: ${failed.join('; ')}` : '',
      'Fix this in this worktree, then give your final answer again.',
    ]
      .filter(Boolean)
      .join('\n');
    return { session: prev.session_ref, note: note.slice(0, 2000) };
  }

  /**
   * A task WAITING on a still-ACTIVE run of a live spawn harness continues in the same run and
   * session (plan M9 §5.6, FD-22): `task.resume` with a note saying why. The acknowledgement moves
   * the task back to RUNNING. A spawned agent cannot wait inside its turn, so this is how a human's
   * decision reaches it. Returns false when the task's host cannot be resumed this way.
   */
  private queueContinue(ctx: CommandContext, projectId: string, task: TaskView, note: string): boolean {
    if (task.status !== 'WAITING' || !task.current_run_id) return false;
    const run = this.q.findRun(task.current_run_id);
    if (run?.status !== 'ACTIVE') return false;
    const h = this.q.findHarness(run.harness_id);
    if (h?.attach_mode !== 'spawn' || h.shadow || ['DISCONNECTED', 'TERMINATED'].includes(h.status)) return false;
    // A resume that expired unsent (held through a long pause) is no resume: it is marked so, and a
    // new one is queued, so Continue never answers "continued" while nothing goes out (review M9i).
    this.db
      .prepare(
        "UPDATE outbox_messages SET status = 'expired' WHERE run_id = ? AND method = 'task.resume' AND status IN ('queued', 'delivered') AND expires_at <= ?",
      )
      .run(run.run_id, ctx.now);
    const queued = this.db
      .prepare(
        "SELECT 1 AS one FROM outbox_messages WHERE run_id = ? AND method = 'task.resume' AND status IN ('queued', 'delivered') LIMIT 1",
      )
      .get<{ one: number }>(run.run_id);
    if (queued) return true;
    const agent = this.q.agent(run.agent_id);
    this.enqueue(
      ctx,
      run.harness_id,
      'task.resume',
      this.startParams(projectId, task, run, agent.role, note.slice(0, 2000)),
      run.run_id,
    );
    return true;
  }

  /**
   * A human asks a waiting task to go on (plan M9 §5.6): the note reaches the agent as a message,
   * and a spawned run continues in its session; an attached session in an editor must be asked there.
   */
  continueTask(
    projectId: string,
    actor: Actor,
    taskId: string,
    note: string | null,
  ): { continued: boolean; reason: string | null; task: TaskView } {
    if (actor.kind !== 'human') throw new FridayError('permission_denied', 'only a human can ask a task to continue');
    return this.exec({ name: 'task.continue', project_id: projectId, actor, params: { taskId, note } }, (ctx) => {
      const task = this.q.task(projectId, taskId);
      if (task.status !== 'WAITING') {
        throw new FridayError(
          'invalid_state_transition',
          `${taskId} is ${task.status}; only a waiting task can continue`,
        );
      }
      const run = task.current_run_id ? this.q.findRun(task.current_run_id) : undefined;
      const h = run ? this.q.findHarness(run.harness_id) : undefined;
      const live = h && !['DISCONNECTED', 'TERMINATED'].includes(h.status);
      if (run?.status !== 'ACTIVE' || !h || !live) {
        throw new FridayError(
          'invalid_state_transition',
          `no live session holds ${taskId}; release it or recover it instead`,
        );
      }
      const agent = this.q.agent(run.agent_id);
      if (note) {
        this.sendWithin(
          ctx,
          projectId,
          { kind: 'human', actor },
          {
            to: agent.agent_key,
            mode: 'notification',
            subject: 'From the human',
            content: note,
            task_id: taskId,
            priority: 'high',
          },
        );
      }
      if (h.attach_mode !== 'spawn') {
        return {
          continued: false,
          reason: 'its session runs in an editor: ask it there to continue',
          task: this.q.task(projectId, taskId),
        };
      }
      this.queueContinue(
        ctx,
        projectId,
        task,
        note ? `A human answered: ${note}` : 'A human asked you to continue the task.',
      );
      return { continued: true, reason: null, task: this.q.task(projectId, taskId) };
    });
  }

  // ================================================================ approvals, escalations, communication, context, observations

  requestPermission(
    projectId: string,
    caller: Caller,
    p: {
      task_id?: string | undefined;
      run_id?: string | undefined;
      action_class: string;
      resource?: string | undefined;
      command?: string | undefined;
      justification: string;
      ttl_s: number;
      reuse?: 'once' | 'run' | 'task' | undefined;
      idempotency_key?: string | undefined;
    },
    /** The policy's verdict on the request (ADR-0027 §3), computed by the caller. */
    verdict: {
      capability: string;
      decision: 'allow' | 'review' | 'deny';
      risk: 'low' | 'medium' | 'high';
      reason: string;
      policy_version: string | null;
    } = {
      capability: p.action_class,
      decision: 'review',
      risk: 'medium',
      reason: 'a human decides',
      policy_version: null,
    },
  ): {
    approval_id: string | null;
    status: 'pending' | 'granted' | 'denied';
    reason: string;
    expires_at: string | null;
    capability: string;
    risk: 'low' | 'medium' | 'high';
  } {
    const actor: Actor = { kind: 'agent', id: caller.agent_id };
    return this.exec(
      { name: 'permission.request', project_id: projectId, actor, idempotency_key: p.idempotency_key, params: p },
      (ctx) => {
        const target = p.resource ?? p.command ?? null;
        if (verdict.decision !== 'review') {
          // Nothing for a human to decide: recorded as a policy evaluation, no approval made.
          ctx.emit({
            type: 'policy.evaluated',
            payload: {
              tool: 'friday_request_permission',
              kind: 'capability',
              capability: verdict.capability,
              decision: verdict.decision === 'allow' ? 'allow' : 'deny',
              reason: verdict.reason,
              targets: target ? [target] : [],
              task_id: p.task_id ?? null,
              risk: verdict.risk,
            },
            refs: p.task_id ? [{ kind: 'task', id: p.task_id }] : [],
          });
          return {
            approval_id: null,
            status: verdict.decision === 'allow' ? ('granted' as const) : ('denied' as const),
            reason: verdict.decision === 'allow' ? `no approval needed: ${verdict.reason}` : verdict.reason,
            expires_at: null,
            capability: verdict.capability,
            risk: verdict.risk,
          };
        }
        const approval_id = this.ids.next('apr');
        const expires_at = addMs(ctx.now, p.ttl_s * 1000);
        ctx.emit({
          type: 'approval.requested',
          payload: {
            approval: {
              approval_id,
              task_id: p.task_id ?? null,
              run_id: p.run_id ?? null,
              capability: verdict.capability,
              target,
              purpose: p.justification,
              risk: verdict.risk,
              status: 'pending',
              expires_at,
              reuse: p.reuse ?? 'once',
              policy_version: verdict.policy_version,
            },
          },
          refs: [
            { kind: 'approval', id: approval_id },
            ...(p.task_id ? [{ kind: 'task' as const, id: p.task_id }] : []),
          ],
        });
        return {
          approval_id,
          status: 'pending' as const,
          reason: `waiting for a human: run "friday approve ${approval_id}" or "friday reject ${approval_id}"`,
          expires_at,
          capability: verdict.capability,
          risk: verdict.risk,
        };
      },
    );
  }

  /**
   * A human decides a pending approval (ADR-0027 §6). A grant may narrow or widen how far it
   * reaches (`reuse`) and how long it lasts (`ttl_s`), and records how it was decided.
   */
  decideApproval(
    projectId: string,
    actor: Actor,
    approvalId: string,
    granted: boolean,
    opts: { reuse?: 'once' | 'run' | 'task'; ttl_s?: number; note?: string; via?: 'cli' | 'ui' | 'elicitation' } = {},
  ): void {
    if (actor.kind !== 'human') throw new FridayError('permission_denied', 'only a human can decide an approval');
    this.exec(
      { name: 'approval.decide', project_id: projectId, actor, params: { approvalId, granted, opts } },
      (ctx) => {
        const row = this.db
          .prepare('SELECT status, expires_at FROM approvals WHERE approval_id = ? AND project_id = ?')
          .get<{
            status: string;
            expires_at: string | null;
          }>(approvalId, projectId);
        if (!row) throw new FridayError('invalid_request', `approval ${approvalId} not found`);
        if (row.status !== 'pending')
          throw new FridayError('invalid_state_transition', `approval is already ${row.status}`);
        if (row.expires_at && row.expires_at <= ctx.now)
          throw new FridayError('approval_expired', 'approval request expired');
        ctx.emit({
          type: 'approval.decided',
          payload: {
            approval_id: approvalId,
            status: granted ? 'granted' : 'denied',
            ...(granted && opts.reuse ? { reuse: opts.reuse } : {}),
            ...(granted && opts.ttl_s ? { expires_at: addMs(ctx.now, opts.ttl_s * 1000) } : {}),
            note: opts.note ?? null,
            via: opts.via ?? null,
          },
          refs: [{ kind: 'approval', id: approvalId }],
        });
        this.afterApprovalDecision(ctx, projectId, approvalId, granted, opts.note ?? null);
      },
    );
  }

  /**
   * What an approval decision does for the agent that asked (plan M9 §5.6): a denial's note reaches
   * it as a message from the human; an attached task waiting on the request runs again (granted as
   * before, denied now too, so the agent goes on knowing); a spawned run that ended its turn to
   * wait continues in its session with a note saying what was decided.
   */
  private afterApprovalDecision(
    ctx: CommandContext,
    projectId: string,
    approvalId: string,
    granted: boolean,
    note: string | null,
  ): void {
    const a = this.db
      .prepare(
        'SELECT task_id, run_id, capability, target, requested_by_kind, requested_by_id FROM approvals WHERE approval_id = ? AND project_id = ?',
      )
      .get<{
        task_id: string | null;
        run_id: string | null;
        capability: string;
        target: string | null;
        requested_by_kind: string;
        requested_by_id: string;
      }>(approvalId, projectId);
    if (!a) return;
    const what = `${a.capability}${a.target ? ` ${a.target.slice(0, 300)}` : ''}`;
    if (!granted && a.requested_by_kind === 'agent') {
      const agent = this.q.findAgent(a.requested_by_id);
      if (agent) {
        this.sendWithin(
          ctx,
          projectId,
          { kind: 'human', actor: ctx.actor },
          {
            to: agent.agent_key,
            mode: 'notification',
            subject: 'Request denied',
            content: `A human denied your request to ${what} (${approvalId}). ${note ? `Reason: ${note}` : 'No reason was given.'} Do not get the same effect another way.`,
            ...(a.task_id ? { task_id: a.task_id } : {}),
            priority: 'high',
          },
        );
      }
    }
    if (!a.task_id || !a.run_id) return;
    const task = this.q.findTask(projectId, a.task_id);
    if (task?.status !== 'WAITING' || task.current_run_id !== a.run_id) return;
    const others = this.db
      .prepare("SELECT COUNT(*) AS n FROM approvals WHERE run_id = ? AND status = 'pending' AND approval_id <> ?")
      .get<{ n: number }>(a.run_id, approvalId);
    if ((others?.n ?? 0) > 0) return;
    const decided = granted ? 'granted' : 'denied';
    const message = `A human ${decided} your request to ${what}.${note ? ` Note: ${note}` : ''}${granted ? '' : ' Continue without it.'}`;
    if (this.queueContinue(ctx, projectId, task, message)) return;
    if (task.waiting_reason === 'human_approval') {
      this.moveTask(ctx, task, 'task.resume', { reason: `${approvalId} was ${decided}` });
    }
  }

  /** Records that an action relied on approvals (ADR-0027 §5); a `once` grant is used up. */
  useApprovals(projectId: string, actor: Actor, uses: { approval_id: string; tool: string; target: string }[]): void {
    if (!uses.length) return;
    this.exec({ name: 'approval.use', project_id: projectId, actor, params: { uses } }, (ctx) => {
      for (const u of uses) {
        ctx.emit({ type: 'approval.used', payload: u, refs: [{ kind: 'approval', id: u.approval_id }] });
      }
    });
  }

  /** A human withdraws an approval: no later use counts (spec Part 07 §16, invariant 9). */
  revokeApproval(projectId: string, actor: Actor, approvalId: string, note: string): void {
    if (actor.kind !== 'human') throw new FridayError('permission_denied', 'only a human can revoke an approval');
    this.exec({ name: 'approval.revoke', project_id: projectId, actor, params: { approvalId } }, (ctx) => {
      const row = this.db
        .prepare('SELECT status FROM approvals WHERE approval_id = ? AND project_id = ?')
        .get<{ status: string }>(approvalId, projectId);
      if (!row) throw new FridayError('invalid_request', `approval ${approvalId} not found`);
      if (row.status === 'revoked') return;
      ctx.emit({
        type: 'approval.revoked',
        payload: { approval_id: approvalId, note },
        refs: [{ kind: 'approval', id: approvalId }],
      });
    });
  }

  requestEscalation(
    projectId: string,
    caller: Caller,
    p: {
      task_id?: string | undefined;
      run_id?: string | undefined;
      question: string;
      options?: string[] | undefined;
      context?: string | undefined;
    },
  ): { escalation_id: string; status: 'pending' } {
    const actor: Actor = { kind: 'agent', id: caller.agent_id };
    return this.exec({ name: 'human.escalation', project_id: projectId, actor, params: p }, (ctx) => {
      const escalation_id = this.ids.next('esc');
      ctx.emit({
        type: 'escalation.requested',
        payload: {
          escalation: {
            escalation_id,
            task_id: p.task_id ?? null,
            run_id: p.run_id ?? null,
            question: p.question,
            options: p.options ?? null,
            context: p.context ?? null,
          },
        },
        refs: [{ kind: 'escalation', id: escalation_id }],
      });
      return { escalation_id, status: 'pending' as const };
    });
  }

  answerEscalation(projectId: string, actor: Actor, escalationId: string, answer: string): void {
    if (actor.kind !== 'human') throw new FridayError('permission_denied', 'only a human can answer an escalation');
    // A human answering for a silent recipient: the answer reaches the waiting agent as the reply,
    // in the same transaction as the answer, so neither exists without the other (M3.1, R04).
    const request = this.requestOfEscalation(escalationId);
    this.exec(
      {
        name: 'escalation.answer',
        project_id: projectId,
        actor,
        params: { escalationId, answer },
        correlation_id: request?.correlation_id,
      },
      (ctx) => {
        // An answer for nothing, or a second answer, is refused rather than recorded (LESSONS UI-12).
        const row = this.q.escalation(escalationId);
        if (!row || row.project_id !== projectId) {
          throw new FridayError('invalid_request', `unknown escalation ${escalationId}`);
        }
        if (row.status !== 'pending') {
          throw new FridayError('invalid_state_transition', `${escalationId} was already answered`);
        }
        ctx.emit({
          type: 'escalation.answered',
          payload: { escalation_id: escalationId, answer },
          refs: [{ kind: 'escalation', id: escalationId }],
        });
        if (request) this.replyFor(ctx, projectId, actor, request, answer);
        // A spawned agent that ended its turn to wait for this answer continues in its session,
        // with the answer as its next message (plan M9 §5.6).
        const taskId = row.task_id ? String(row.task_id) : null;
        if (taskId && (row.kind === null || row.kind === 'unanswered_request')) {
          const task = this.q.findTask(projectId, taskId);
          // Only the run that asked, and only when nothing else of it waits for a human (as after
          // an approval): an older run's question does not restart the run now waiting (review M9i).
          const runId = row.run_id ? String(row.run_id) : null;
          const sameRun = runId === null || runId === task?.current_run_id;
          const others = task?.current_run_id
            ? (this.db
                .prepare("SELECT COUNT(*) AS n FROM approvals WHERE run_id = ? AND status = 'pending'")
                .get<{ n: number }>(task.current_run_id)?.n ?? 0)
            : 0;
          if (task?.status === 'WAITING' && sameRun && others === 0) {
            this.queueContinue(ctx, projectId, task, `A human answered your question: ${answer}`);
          }
        }
      },
    );
  }

  /** The still-open request behind an `unanswered_request` escalation, if any. */
  private requestOfEscalation(escalationId: string): MessageRow | undefined {
    const row = this.q.escalation(escalationId);
    if (row?.kind !== 'unanswered_request') return undefined;
    const d = JSON.parse(String(row.details_json ?? '{}')) as { message_id?: string };
    const request = d.message_id ? this.q.findMessageRow(d.message_id) : undefined;
    return request?.status === 'open' ? request : undefined;
  }

  private replyFor(ctx: CommandContext, projectId: string, actor: Actor, request: MessageRow, answer: string): void {
    this.sendWithin(
      ctx,
      projectId,
      { kind: 'human', actor },
      {
        to: request.sender_key ?? request.sender_id,
        mode: 'response',
        response_to: request.message_id,
        content: answer,
      },
    );
  }

  /**
   * Message timeouts, run by the lease manager (M3b): a message past its expiry ends for every
   * recipient that has not acknowledged it; a blocking request past its reply deadline is
   * escalated to a human once, and stays open so a late answer still settles it.
   */
  private expireMessages(
    projectId: string,
    nowIso: string,
  ): {
    expired: string[];
    escalated: string[];
    replied: string[];
    reply_failed: { escalation_id: string; error: string }[];
  } {
    const out = {
      expired: [] as string[],
      escalated: [] as string[],
      replied: [] as string[],
      reply_failed: [] as { escalation_id: string; error: string }[],
    };
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE project_id = ? AND status = 'open'
           AND (expires_at <= ? OR (blocking = 1 AND reply_by IS NOT NULL AND reply_by <= ? AND escalated_at IS NULL))`,
      )
      .all<MessageRow>(projectId, nowIso, nowIso);
    for (const m of rows) {
      if (m.expires_at <= nowIso) {
        const open = this.q.deliveriesOf(m.message_id).filter((d) => d.state === 'queued' || d.state === 'delivered');
        this.exec({ name: 'message.expire', project_id: projectId, actor: LEASE_MANAGER }, (ctx) => {
          ctx.emit({
            type: 'communication.expired',
            payload: {
              message_id: m.message_id,
              delivery_ids: open.map((d) => d.delivery_id),
              reason: 'the message expired before it was answered or acknowledged',
              message_expired: true,
            },
            refs: [{ kind: 'message', id: m.message_id }],
          });
        });
        out.expired.push(m.message_id);
        continue;
      }
      const to = this.q
        .deliveriesOf(m.message_id)
        .map(
          (d) =>
            d.agent_key ?? (d.recipient_kind === 'agent' ? d.recipient_id : `${d.recipient_kind}:${d.recipient_id}`),
        )
        .join(', ');
      const from = m.sender_key ?? m.sender_kind;
      // The escalation and the request's marker commit together, so a retry cannot ask twice (R04).
      this.exec({ name: 'message.escalate', project_id: projectId, actor: LEASE_MANAGER }, (ctx) => {
        const escalation_id = this.escalationWithin(ctx, {
          kind: 'unanswered_request',
          goal_id: m.goal_id,
          task_id: m.task_id,
          question: `${from} is waiting for an answer from ${to} to "${m.subject ?? m.body.slice(0, 120)}" (asked ${m.created_at}, deadline ${m.reply_by}). Answer it yourself, or tell ${to} to reply?`,
          options: [
            'answer here: the answer is sent to the waiting agent',
            `remind the recipient: friday say <agent> "…"`,
            `tell ${from} not to wait: friday say ${from} "…"`,
          ],
          details: {
            blocked: `${from}${m.task_id ? ` on ${m.task_id}` : ''}`,
            why: `no reply by ${m.reply_by}`,
            requested_by: from,
            capability: 'human.decision',
            proposed_action: 'answer for the recipient, or unblock the sender',
            evidence: [m.body.slice(0, 500)],
            message_id: m.message_id,
          },
        });
        ctx.emit({
          type: 'communication.escalated',
          payload: { message_id: m.message_id, escalation_id },
          refs: [
            { kind: 'message', id: m.message_id },
            { kind: 'escalation', id: escalation_id },
          ],
        });
      });
      out.escalated.push(m.message_id);
    }
    // Recovery: an answer an older daemon recorded without sending the reply (R04). A reply that
    // cannot be sent is reported, not thrown, so it never stops the rest of the tick.
    for (const e of this.q.unrepliedAnswers(projectId)) {
      const request = this.requestOfEscalation(e.escalation_id);
      if (!request) continue;
      const human: Actor = { kind: 'human', id: 'local-operator' };
      try {
        this.exec(
          { name: 'escalation.reply', project_id: projectId, actor: human, correlation_id: request.correlation_id },
          (ctx) => this.replyFor(ctx, projectId, human, request, e.answer),
        );
        out.replied.push(request.message_id);
      } catch (err) {
        out.reply_failed.push({ escalation_id: e.escalation_id, error: (err as Error).message });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- agent messaging (M3, ADR-0017)

  /** The task an agent works on: the one named (it must hold it), else its current one. */
  private heldTask(projectId: string, agent: AgentView, taskId?: string): TaskView | null {
    if (taskId) {
      const t = this.q.task(projectId, taskId);
      if (t.assigned_agent_id !== agent.agent_id && t.reserved_for_agent_key !== agent.agent_key) {
        throw new FridayError('permission_denied', `task ${taskId} is not yours`);
      }
      return t;
    }
    if (agent.current_task_id) {
      const t = this.q.findTask(projectId, agent.current_task_id);
      if (t) return t;
    }
    return (
      this.tasksOfAgent(projectId, agent).find((t) => t.status !== 'COMPLETED' && t.status !== 'CANCELLED') ?? null
    );
  }

  /** Every task an agent holds, held, or has reserved (newest first). */
  private tasksOfAgent(projectId: string, agent: AgentView): TaskView[] {
    return this.q
      .tasks(projectId, { limit: 2000 })
      .filter((t) => t.assigned_agent_id === agent.agent_id || t.reserved_for_agent_key === agent.agent_key)
      .reverse();
  }

  /** Ids of the tasks an agent holds now, for task-addressed deliveries. */
  private heldTaskIds(projectId: string, agent: AgentView): string[] {
    return this.q
      .tasks(projectId, { statuses: HELD_STATUSES })
      .filter((t) => t.assigned_agent_id === agent.agent_id)
      .map((t) => t.task_id);
  }

  /**
   * How one task relates to another agent's work, from Friday's records (ADR-0017 §4): the same
   * goal, or a dependency in either direction. Null when unrelated.
   */
  private relation(
    projectId: string,
    task: TaskView | null,
    agent: AgentView,
  ): { kind: 'same_task' | 'same_goal' | 'depends_on' | 'needed_by'; theirs: TaskView } | null {
    if (!task) return null;
    for (const t of this.tasksOfAgent(projectId, agent)) {
      if (t.task_id === task.task_id) return { kind: 'same_task', theirs: t };
      if (task.dependencies.includes(t.task_id)) return { kind: 'depends_on', theirs: t };
      if (t.dependencies.includes(task.task_id)) return { kind: 'needed_by', theirs: t };
      if (task.goal_id && t.goal_id === task.goal_id) return { kind: 'same_goal', theirs: t };
    }
    return null;
  }

  /** Other tasks related to a task: the same goal, or a dependency in either direction. */
  private relatedTasks(projectId: string, task: TaskView | null): TaskView[] {
    if (!task) return [];
    return this.q
      .tasks(projectId, { limit: 2000 })
      .filter(
        (x) =>
          x.task_id !== task.task_id &&
          ((task.goal_id !== null && x.goal_id === task.goal_id) ||
            task.dependencies.includes(x.task_id) ||
            x.dependencies.includes(task.task_id)),
      );
  }

  private recipientForTask(projectId: string, t: TaskView): Recipient {
    const agent = t.assigned_agent_id
      ? this.q.findAgent(t.assigned_agent_id)
      : t.reserved_for_agent_key
        ? this.q.agentByKey(projectId, t.reserved_for_agent_key)
        : undefined;
    return agent
      ? { kind: 'agent', id: agent.agent_id, agent_id: agent.agent_id }
      : { kind: 'task', id: t.task_id, agent_id: null };
  }

  /** Turns `to` into recipients and applies the communication authority (ADR-0017 §3–§4). */
  private resolveRecipients(
    projectId: string,
    sender: MessageSender,
    senderAgent: AgentView | undefined,
    senderTask: TaskView | null,
    to: string,
    mode: SendMessageInput['mode'],
  ): { recipients: Recipient[]; note: string | null } {
    const t = to.trim();
    const byAgent = sender.kind === 'agent';
    const needTask = (what: string) => {
      if (byAgent && !senderTask) {
        throw new FridayError(
          'permission_denied',
          `only an agent working on a task may message ${what}; claim a task first, or message "master" or "human"`,
        );
      }
    };
    const nowIso = this.clock.now();
    const live = (a: AgentView) => Boolean(a.harness_id && this.q.isHarnessLive(a.harness_id, nowIso));
    if (t === 'master') {
      const out: Recipient[] = [{ kind: 'master_brain', id: 'master-brain', agent_id: null }];
      // The Master Brain does not answer free-form requests; a human sees them too (ADR-0017 §9).
      if (mode === 'request') out.push({ kind: 'human', id: 'human', agent_id: null });
      return { recipients: out, note: mode === 'request' ? 'requests to the Master Brain also reach a human' : null };
    }
    if (t === 'human') return { recipients: [{ kind: 'human', id: 'human', agent_id: null }], note: null };
    if (t === 'broadcast') {
      if (!this.config.allowBroadcast) {
        throw new FridayError(
          'permission_denied',
          'broadcast is off for this project (communication.allow_broadcast); address a role, a task or "master"',
        );
      }
      needTask('everyone on your goal');
      const agents = this.q
        .agents(projectId)
        .filter((a) => a.agent_id !== senderAgent?.agent_id && a.status !== 'TERMINATED')
        .filter((a) => !byAgent || this.relation(projectId, senderTask, a)?.kind === 'same_goal');
      if (!agents.length) throw new FridayError('agent_not_found', 'nobody else works on this goal yet');
      return { recipients: agents.map((a) => ({ kind: 'agent', id: a.agent_id, agent_id: a.agent_id })), note: null };
    }
    if (t === 'dependencies' || t === 'dependents') {
      needTask(`your task's ${t}`);
      if (!senderTask) throw new FridayError('invalid_request', `name a task (task_id) to message its ${t}`);
      const tasks =
        t === 'dependencies'
          ? senderTask.dependencies.map((id) => this.q.task(projectId, id))
          : this.q.tasks(projectId, { limit: 2000 }).filter((x) => x.dependencies.includes(senderTask.task_id));
      const seen = new Set<string>();
      const recipients: Recipient[] = [];
      for (const x of tasks) {
        const r = this.recipientForTask(projectId, x);
        if (r.agent_id === senderAgent?.agent_id || seen.has(`${r.kind}:${r.id}`)) continue;
        seen.add(`${r.kind}:${r.id}`);
        recipients.push(r);
      }
      if (!recipients.length) throw new FridayError('agent_not_found', `your task has no ${t} with another agent`);
      return { recipients, note: null };
    }
    if (t.startsWith('role:')) {
      const role = t.slice(5).trim();
      if (!role) throw new FridayError('invalid_request', 'name the role: "role:frontend"');
      needTask(`the ${role} role`);
      const others = this.q
        .agents(projectId)
        .filter((a) => a.agent_id !== senderAgent?.agent_id && a.status !== 'TERMINATED');
      const pick = (cands: AgentView[]) =>
        [...cands].sort((a, b) => Number(live(b)) - Number(live(a)) || a.agent_key.localeCompare(b.agent_key))[0];
      if (!byAgent) {
        // Humans and Friday supervise: any agent of the role, else the first of that role to attach.
        const best = pick(others.filter((a) => a.role === role));
        return best
          ? {
              recipients: [{ kind: 'agent', id: best.agent_id, agent_id: best.agent_id }],
              note: `role:${role} reached ${best.agent_key}`,
            }
          : {
              recipients: [{ kind: 'role', id: role, agent_id: null }],
              note: `no ${role} agent has attached yet; the first one to check its inbox gets it`,
            };
      }
      // An agent reaches a role only within related work (ADR-0017 §4): authorize first, then rank.
      const related = this.relatedTasks(projectId, senderTask);
      const roleTasks = related.filter((x) => x.role === role);
      const holders = new Set(
        roleTasks.flatMap((x) => {
          const r = this.recipientForTask(projectId, x);
          return r.agent_id ? [r.agent_id] : [];
        }),
      );
      const best = pick(
        others.filter(
          (a) => holders.has(a.agent_id) || (a.role === role && this.relation(projectId, senderTask, a) !== null),
        ),
      );
      if (best) {
        return {
          recipients: [{ kind: 'agent', id: best.agent_id, agent_id: best.agent_id }],
          note: `role:${role} reached ${best.agent_key}`,
        };
      }
      const waiting = roleTasks.find(
        (x) => !TERMINAL_TASK.has(x.status) && this.recipientForTask(projectId, x).kind === 'task',
      );
      if (waiting) {
        return {
          recipients: [{ kind: 'task', id: waiting.task_id, agent_id: null }],
          note: `no ${role} agent works on related tasks yet; whoever takes ${waiting.task_id} gets it`,
        };
      }
      throw new FridayError(
        'permission_denied',
        `no agent or task with the role ${role} is related to your task, so Friday does not route this; message "master" to reach other work`,
        { rule: 'communication.unrelated_recipient' },
      );
    }
    if (t.startsWith('task:')) {
      const target = this.q.task(projectId, t.slice(5).trim());
      if (byAgent) {
        const related =
          senderTask &&
          (target.task_id === senderTask.task_id ||
            senderTask.dependencies.includes(target.task_id) ||
            target.dependencies.includes(senderTask.task_id) ||
            (senderTask.goal_id !== null && target.goal_id === senderTask.goal_id));
        if (!related) {
          throw new FridayError(
            'permission_denied',
            `task ${target.task_id} is not related to your task; message "master" to reach other work`,
          );
        }
      }
      const r = this.recipientForTask(projectId, target);
      if (r.agent_id && r.agent_id === senderAgent?.agent_id) {
        throw new FridayError('invalid_request', 'that task is yours; you cannot message yourself');
      }
      return {
        recipients: [r],
        note: r.kind === 'task' ? `nobody holds ${target.task_id} yet; whoever takes it gets the message` : null,
      };
    }
    const agent = this.q.agentByKey(projectId, t);
    if (!agent) {
      throw new FridayError(
        'agent_not_found',
        `no agent "${t}"; address an agent key, "role:<role>", "task:<task_id>", "dependencies", "dependents", "master" or "human"`,
      );
    }
    if (agent.agent_id === senderAgent?.agent_id)
      throw new FridayError('invalid_request', 'you cannot message yourself');
    if (byAgent && !this.relation(projectId, senderTask, agent)) {
      throw new FridayError(
        'permission_denied',
        `${agent.agent_key} works on nothing related to your task, so Friday does not route this; message "master" to reach other work`,
        { rule: 'communication.unrelated_recipient' },
      );
    }
    return { recipients: [{ kind: 'agent', id: agent.agent_id, agent_id: agent.agent_id }], note: null };
  }

  /**
   * Sends a message through Friday (spec Part 05, ADR-0017): authorize, classify, resolve the
   * recipients, record the message with one delivery per recipient. A response settles the
   * request it answers and acknowledges the responder's delivery of it.
   */
  sendMessage(
    projectId: string,
    sender: MessageSender,
    input: SendMessageInput,
    opts: { idempotency_key?: string | undefined } = {},
  ): {
    message_id: string;
    status: 'queued';
    correlation_id: string;
    deliveries: { delivery_id: string; recipient: { kind: Recipient['kind']; id: string; agent_key: string | null } }[];
    note: string | null;
  } {
    const actor: Actor = sender.kind === 'agent' ? { kind: 'agent', id: sender.caller.agent_id } : sender.actor;
    const request =
      input.mode === 'response' && input.response_to ? this.q.findMessageRow(input.response_to) : undefined;
    return this.exec(
      {
        name: 'communication.request',
        project_id: projectId,
        actor,
        idempotency_key: opts.idempotency_key,
        params: input,
        correlation_id: request?.correlation_id ?? input.correlation_id,
      },
      (ctx) => this.sendWithin(ctx, projectId, sender, input),
    );
  }

  /** The body of `sendMessage`, inside the caller's transaction. */
  private sendWithin(
    ctx: CommandContext,
    projectId: string,
    sender: MessageSender,
    input: SendMessageInput,
  ): {
    message_id: string;
    status: 'queued';
    correlation_id: string;
    deliveries: { delivery_id: string; recipient: { kind: Recipient['kind']; id: string; agent_key: string | null } }[];
    note: string | null;
  } {
    const actor: Actor = sender.kind === 'agent' ? { kind: 'agent', id: sender.caller.agent_id } : sender.actor;
    // Only a response may name a message it answers; nothing else may touch another message (R02).
    if (input.response_to && input.mode !== 'response') {
      throw new FridayError('invalid_request', 'response_to belongs only to a response (mode "response")');
    }
    let request: MessageRow | undefined;
    let senderAgent: AgentView | undefined;
    let senderTask: TaskView | null = null;
    if (sender.kind === 'agent') {
      const h = this.q.harness(sender.caller.harness_id);
      if (h.shadow) {
        throw new FridayError('harness_shadowed', 'a shadow session cannot send messages for its agent');
      }
      senderAgent = this.q.agent(sender.caller.agent_id);
      senderTask = this.heldTask(projectId, senderAgent, input.task_id);
    } else if (input.task_id) {
      senderTask = this.q.task(projectId, input.task_id);
    }

    let recipients: Recipient[];
    let note: string | null = null;
    let target = input.to.trim();
    let myDelivery: { delivery_id: string; state: string } | undefined;
    if (input.mode === 'response') {
      if (!input.response_to) {
        throw new FridayError('invalid_request', 'a response names the message it answers (response_to)');
      }
      request = this.q.findMessageRow(input.response_to);
      if (!request) throw new FridayError('message_not_found', `message ${input.response_to} not found`);
      myDelivery = this.q
        .deliveriesOf(request.message_id)
        .find((d) =>
          sender.kind === 'agent'
            ? d.agent_id === senderAgent?.agent_id ||
              (d.recipient_kind === 'agent' && d.recipient_id === senderAgent?.agent_id)
            : d.recipient_kind === sender.kind,
        );
      // Humans supervise: they may answer any message, for example for a recipient who stays silent.
      if (!myDelivery && sender.kind !== 'human') {
        throw new FridayError('permission_denied', `you can only answer messages you received (${request.message_id})`);
      }
      // A response goes back to the sender of the request, whatever `to` says.
      recipients = [
        request.sender_kind === 'agent'
          ? { kind: 'agent', id: request.sender_id, agent_id: request.sender_id }
          : {
              kind: request.sender_kind === 'master_brain' ? 'master_brain' : 'human',
              id: request.sender_id,
              agent_id: null,
            },
      ];
      target = request.sender_key ?? request.sender_kind;
    } else {
      ({ recipients, note } = this.resolveRecipients(projectId, sender, senderAgent, senderTask, input.to, input.mode));
    }

    // Backpressure (Part 05 §15): a full inbox takes no more low-value notifications from agents
    // or humans; Friday's own notices always get through.
    const notes: string[] = note ? [note] : [];
    const priority = input.priority ?? 'normal';
    for (const r of recipients) {
      if (r.kind !== 'agent' || !r.agent_id) continue;
      const a = this.q.agent(r.agent_id);
      const open = this.q.inboxRows(projectId, a, this.heldTaskIds(projectId, a)).length;
      if (
        sender.kind !== 'system' &&
        open >= this.config.maxOpenPerRecipient &&
        input.mode === 'notification' &&
        (priority === 'low' || priority === 'normal')
      ) {
        throw new FridayError(
          'agent_unavailable',
          `${a.agent_key} has ${open} unacknowledged messages; send this as high priority if it cannot wait, or later`,
          { open },
        );
      }
      if (!a.harness_id || !this.q.isHarnessLive(a.harness_id, ctx.now)) {
        notes.push(`${a.agent_key} is not attached right now; the message waits until it expires`);
      }
    }
    note = notes.length ? notes.join('; ') : null;
    const message_id = this.ids.next('msg');
    const correlation_id = request?.correlation_id ?? input.correlation_id ?? this.ids.next('corr');
    let body = input.content;
    let body_artifact_ref: string | null = null;
    if (body.length > MAX_BODY) {
      if (this.artifacts) body_artifact_ref = this.artifacts.storeText(projectId, 'message', body).artifact_id;
      body = `${body.slice(0, MAX_BODY)}…[${body.length - MAX_BODY} more characters${body_artifact_ref ? ` in ${body_artifact_ref}` : ' dropped'}]`;
    }
    const blocking = input.mode === 'request' && (input.blocking ?? false);
    const replyMs = input.reply_within_s ? input.reply_within_s * 1000 : blocking ? this.config.blockingReplyMs : null;
    const deliveries = recipients.map((r) => ({
      delivery_id: this.ids.next('dlv'),
      recipient_kind: r.kind,
      recipient_id: r.id,
      agent_id: r.agent_id,
    }));
    const refs: { kind: 'message' | 'task'; id: string }[] = [{ kind: 'message', id: message_id }];
    if (senderTask) refs.push({ kind: 'task', id: senderTask.task_id });
    ctx.emit({
      type: 'communication.sent',
      payload: {
        message: {
          message_id,
          sender: { kind: sender.kind, id: actor.id, agent_key: senderAgent?.agent_key ?? null },
          target,
          mode: input.mode,
          subject: input.subject ?? null,
          body,
          body_artifact_ref,
          facts: input.facts ?? [],
          priority: input.priority ?? 'normal',
          blocking,
          task_id: senderTask?.task_id ?? null,
          goal_id: senderTask?.goal_id ?? null,
          correlation_id,
          response_to: request?.message_id ?? null,
          reply_by: input.mode === 'request' && replyMs ? addMs(ctx.now, replyMs) : null,
          expires_at: addMs(ctx.now, this.config.messageTtlMs),
        },
        deliveries,
        note,
      },
      refs,
    });
    if (request) {
      if (myDelivery && (myDelivery.state === 'queued' || myDelivery.state === 'delivered')) {
        ctx.emit({
          type: 'communication.acknowledged',
          payload: { message_id: request.message_id, delivery_ids: [myDelivery.delivery_id], reason: 'replied' },
          refs: [{ kind: 'message', id: request.message_id }],
        });
      }
      if (request.mode === 'request' && request.status === 'open') {
        ctx.emit({
          type: 'communication.settled',
          payload: { message_id: request.message_id, reason: 'replied', response_id: message_id },
          refs: [{ kind: 'message', id: request.message_id }],
        });
        const by =
          sender.kind === 'human'
            ? 'a human'
            : sender.kind === 'agent'
              ? (senderAgent?.agent_key ?? 'another agent')
              : 'the Master Brain';
        this.resolveOtherDeliveries(ctx, projectId, request, message_id, by, myDelivery?.delivery_id);
      } else {
        this.settleIfDone(ctx, request.message_id);
      }
    }
    return {
      message_id,
      status: 'queued' as const,
      correlation_id,
      deliveries: deliveries.map((d) => ({
        delivery_id: d.delivery_id,
        recipient: {
          kind: d.recipient_kind,
          id: d.recipient_id,
          agent_key: d.agent_id ? (this.q.findAgent(d.agent_id)?.agent_key ?? null) : null,
        },
      })),
      note,
    };
  }

  /**
   * A request answered by one party no longer asks the others (M3.1, R05): their deliveries end as
   * `resolved`, and those who had already received the question get a short notice, so nobody
   * keeps working on it or stays held by it. Those who never saw it are not disturbed.
   */
  private resolveOtherDeliveries(
    ctx: CommandContext,
    projectId: string,
    request: MessageRow,
    responseId: string,
    by: string,
    except: string | undefined,
  ): void {
    const open = this.q
      .deliveriesOf(request.message_id)
      .filter((d) => d.delivery_id !== except && (d.state === 'queued' || d.state === 'delivered'));
    if (!open.length) return;
    ctx.emit({
      type: 'communication.resolved',
      payload: {
        message_id: request.message_id,
        delivery_ids: open.map((d) => d.delivery_id),
        by,
        by_message_id: responseId,
      },
      refs: [{ kind: 'message', id: request.message_id }],
    });
    const about = request.subject ?? request.body.slice(0, 80);
    for (const d of open) {
      if (d.state !== 'delivered' || !d.agent_id) continue;
      const agent = this.q.findAgent(d.agent_id);
      if (!agent) continue;
      this.sendWithin(
        ctx,
        projectId,
        { kind: 'system', actor: SYSTEM },
        {
          to: agent.agent_key,
          mode: 'notification',
          priority: 'low',
          subject: `Resolved: ${about}`,
          content: `The request "${about}" from ${request.sender_key ?? request.sender_kind} (${request.message_id}) was answered by ${by}; you do not need to answer it. Acknowledge this note.`,
        },
      );
    }
  }

  /** A notification or response settles once every delivery ended; a request settles on its reply. */
  private settleIfDone(ctx: CommandContext, messageId: string): void {
    const m = this.q.findMessageRow(messageId);
    if (m?.status !== 'open' || m.mode === 'request') return;
    const ds = this.q.deliveriesOf(messageId);
    if (
      !ds.every(
        (d) => d.state === 'acknowledged' || d.state === 'expired' || d.state === 'dead' || d.state === 'resolved',
      )
    )
      return;
    ctx.emit({
      type: 'communication.settled',
      payload: {
        message_id: messageId,
        reason: ds.every((d) => d.state === 'acknowledged') ? 'acknowledged' : 'ended',
      },
      refs: [{ kind: 'message', id: messageId }],
    });
  }

  /** Whether a delivery is this agent's to receive or acknowledge. */
  private deliveryIsFor(d: DeliveryRow, agent: AgentView, held: string[]): boolean {
    if (d.agent_id) return d.agent_id === agent.agent_id;
    if (d.recipient_kind === 'agent') return d.recipient_id === agent.agent_id;
    if (d.recipient_kind === 'role') return d.recipient_id === agent.role;
    if (d.recipient_kind === 'task') return held.includes(d.recipient_id);
    return false;
  }

  /**
   * The inbox of the caller's agent (ADR-0017 §6): reserves what it returns for this session and
   * counts a delivery attempt, unless `peek`. A delivery reserved by another session (an old or
   * shadow session) is skipped until its reservation ends; one delivered too often is dead-lettered.
   */
  inbox(
    projectId: string,
    caller: Caller,
    opts: { max?: number; peek?: boolean } = {},
  ): { items: InboxItem[]; more: number } {
    const harness = this.q.harness(caller.harness_id);
    if (harness.shadow && !opts.peek) {
      throw new FridayError('harness_shadowed', "a shadow session cannot take its agent's messages");
    }
    const agent = this.q.agent(caller.agent_id);
    const held = this.heldTaskIds(projectId, agent);
    const now = this.clock.now();
    const usable = this.q
      .inboxRows(projectId, agent, held)
      .filter((d) => !this.reservedElsewhere(d, caller.harness_id, now));
    const max = opts.max ?? 10;
    let pick = usable.slice(0, max);
    const more = Math.max(0, usable.length - pick.length);
    if (!opts.peek) {
      const due = pick.filter(
        (d) =>
          !(
            d.state === 'delivered' &&
            d.reserved_by_harness === caller.harness_id &&
            d.reserved_until &&
            d.reserved_until > now
          ),
      );
      if (due.length) {
        const dead = new Set<string>();
        this.exec(
          { name: 'message.inbox', project_id: projectId, actor: { kind: 'agent', id: agent.agent_id } },
          (ctx) => {
            for (const d of due) {
              const attempt = d.attempts + 1;
              if (attempt > this.config.messageMaxAttempts) {
                ctx.emit({
                  type: 'communication.dead_lettered',
                  payload: {
                    message_id: d.message_id,
                    delivery_ids: [d.delivery_id],
                    reason: `delivered ${d.attempts} times without an acknowledgement`,
                  },
                  refs: [{ kind: 'message', id: d.message_id }],
                });
                dead.add(d.delivery_id);
                this.settleIfDone(ctx, d.message_id);
                continue;
              }
              ctx.emit({
                type: 'communication.delivered',
                payload: {
                  message_id: d.message_id,
                  delivery_id: d.delivery_id,
                  agent_id: agent.agent_id,
                  harness_id: caller.harness_id,
                  attempt,
                  reserved_until: addMs(ctx.now, this.config.messageReservationMs),
                },
                refs: [
                  { kind: 'message', id: d.message_id },
                  { kind: 'agent', id: agent.agent_id },
                ],
              });
            }
          },
        );
        pick = pick.filter((d) => !dead.has(d.delivery_id)).map((d) => this.q.findDelivery(d.delivery_id) ?? d);
      }
    }
    return { items: pick.map((d) => this.inboxItem(projectId, d, agent)), more };
  }

  /** An agent's open deliveries without reserving anything (context packets, status pages). */
  peekInbox(projectId: string, agentId: string, max = 10): { items: InboxItem[]; total: number } {
    const agent = this.q.agent(agentId);
    const rows = this.q.inboxRows(projectId, agent, this.heldTaskIds(projectId, agent));
    return { items: rows.slice(0, max).map((d) => this.inboxItem(projectId, d, agent)), total: rows.length };
  }

  /** One delivery as its recipient sees it, with the minimal context of ADR-0017 §7. */
  inboxItem(projectId: string, d: DeliveryRow, recipient: AgentView | null): InboxItem {
    const m = this.q.findMessageRow(d.message_id);
    if (!m) throw new FridayError('message_not_found', `message ${d.message_id} not found`);
    const senderAgent = m.sender_kind === 'agent' ? this.q.findAgent(m.sender_id) : undefined;
    const senderTask = m.task_id ? (this.q.findTask(projectId, m.task_id) ?? null) : null;
    let relationship =
      m.sender_kind === 'agent'
        ? 'sent by another agent'
        : `sent by ${m.sender_kind === 'human' ? 'a human' : 'the Master Brain'}`;
    if (recipient && senderAgent && senderTask) {
      const mine = this.relation(projectId, senderTask, recipient);
      if (mine?.kind === 'same_goal')
        relationship = `you both work on goal ${senderTask.goal_id} (your task ${mine.theirs.task_id})`;
      if (mine?.kind === 'depends_on')
        relationship = `their task ${senderTask.task_id} depends on your task ${mine.theirs.task_id}`;
      if (mine?.kind === 'needed_by')
        relationship = `your task ${mine.theirs.task_id} depends on their task ${senderTask.task_id}`;
      if (mine?.kind === 'same_task') relationship = `about task ${senderTask.task_id}, which you also worked on`;
      if (!mine) relationship = `Friday routed this to you as the ${recipient.role} agent; no shared task`;
    }
    const facts = (JSON.parse(m.facts_json) as { fact: string; area?: string; impact?: string }[]).map((x) => ({
      ...x,
      status: 'unverified' as const,
      source: m.sender_key ?? m.sender_kind,
    }));
    const original = m.response_to ? this.q.findMessageRow(m.response_to) : undefined;
    return {
      delivery_id: d.delivery_id,
      message_id: m.message_id,
      correlation_id: m.correlation_id,
      from: {
        kind: m.sender_kind as InboxItem['from']['kind'],
        id: m.sender_id,
        agent_key: m.sender_key,
        role: senderAgent?.role ?? null,
      },
      mode: m.mode as InboxItem['mode'],
      subject: m.subject,
      body: m.body,
      body_artifact_ref: m.body_artifact_ref,
      facts,
      priority: m.priority as InboxItem['priority'],
      blocking: Boolean(m.blocking),
      reply_by: m.reply_by,
      response_to: m.response_to,
      in_reply_to: original ? (original.subject ?? original.body.slice(0, 80)) : null,
      task_id: m.task_id,
      sender_task: senderTask
        ? { task_id: senderTask.task_id, summary: senderTask.summary, write: senderTask.scope?.write ?? [] }
        : null,
      relationship,
      trust: m.sender_kind === 'agent' ? 'peer-untrusted' : m.sender_kind === 'human' ? 'human' : 'system',
      state: d.state as InboxItem['state'],
      attempt: d.attempts,
      sent_at: m.created_at,
      reserved_until: d.reserved_until,
    };
  }

  /**
   * Acknowledges deliveries for the caller's agent (ADR-0017 §6). Only the recipient may
   * acknowledge; an acknowledgement says the message was accepted for processing, not that any
   * requested work succeeded.
   */
  acknowledgeMessages(
    projectId: string,
    caller: Caller,
    ids: string[],
  ): { acknowledged: string[]; unknown: string[]; refused: string[] } {
    // Only the session that received a delivery acknowledges it (M3.1, R03). A shadow session
    // never does; a successor first receives the delivery, which records the takeover.
    const harness = this.q.harness(caller.harness_id);
    if (harness.shadow) {
      throw new FridayError('harness_shadowed', "a shadow session cannot acknowledge its agent's messages");
    }
    const agent = this.q.agent(caller.agent_id);
    const held = this.heldTaskIds(projectId, agent);
    const out = { acknowledged: [] as string[], unknown: [] as string[], refused: [] as string[] };
    const todo: DeliveryRow[] = [];
    for (const id of ids) {
      let d = this.q.findDelivery(id);
      if (!d && this.q.findMessageRow(id)) {
        const all = this.q.deliveriesOf(id);
        d = all.find((x) => this.deliveryIsFor(x, agent, held));
        if (!d && all.length) {
          out.refused.push(id);
          continue;
        }
      }
      if (!d) {
        out.unknown.push(id);
        continue;
      }
      if (!this.deliveryIsFor(d, agent, held)) {
        out.refused.push(id);
        continue;
      }
      if (d.state === 'acknowledged') out.acknowledged.push(d.delivery_id);
      else if (d.state === 'delivered' && d.reserved_by_harness === caller.harness_id) todo.push(d);
      else if (d.state === 'queued' || d.state === 'delivered')
        out.refused.push(id); // read it first
      else out.unknown.push(id);
    }
    if (todo.length) {
      this.exec({ name: 'message.ack', project_id: projectId, actor: { kind: 'agent', id: agent.agent_id } }, (ctx) => {
        for (const d of todo) {
          ctx.emit({
            type: 'communication.acknowledged',
            payload: {
              message_id: d.message_id,
              delivery_ids: [d.delivery_id],
              agent_id: agent.agent_id,
              harness_id: caller.harness_id,
              reason: 'acknowledged',
            },
            refs: [{ kind: 'message', id: d.message_id }],
          });
          out.acknowledged.push(d.delivery_id);
        }
        for (const mid of new Set(todo.map((d) => d.message_id))) this.settleIfDone(ctx, mid);
      });
    }
    return out;
  }

  /** Reserved by another session that is still live and still within its reservation. */
  private reservedElsewhere(d: DeliveryRow, harnessId: string, now: string): boolean {
    if (!d.reserved_by_harness || d.reserved_by_harness === harnessId) return false;
    if (!d.reserved_until || d.reserved_until <= now) return false;
    return this.q.isHarnessLive(d.reserved_by_harness, now);
  }

  /**
   * Acknowledges deliveries addressed to the Master Brain or to humans (the Master Brain when it
   * processes them; a human with `friday messages ack`).
   */
  acknowledgeAs(projectId: string, actor: Actor, kind: 'master_brain' | 'human', ids: string[] | 'all'): string[] {
    const open = this.q.openDeliveriesFor(projectId, kind);
    const todo = ids === 'all' ? open : open.filter((d) => ids.includes(d.delivery_id) || ids.includes(d.message_id));
    if (!todo.length) return [];
    this.exec({ name: 'message.ack', project_id: projectId, actor }, (ctx) => {
      for (const d of todo) {
        ctx.emit({
          type: 'communication.acknowledged',
          payload: {
            message_id: d.message_id,
            delivery_ids: [d.delivery_id],
            reason: kind === 'master_brain' ? 'processed by the Master Brain' : 'acknowledged by a human',
          },
          refs: [{ kind: 'message', id: d.message_id }],
        });
      }
      for (const mid of new Set(todo.map((d) => d.message_id))) this.settleIfDone(ctx, mid);
    });
    return todo.map((d) => d.delivery_id);
  }

  /**
   * Records a packet as delivered. With `still`, the authority it was compiled under is checked in
   * this transaction (a reason when it changed throws `context_stale`, and nothing is recorded); the
   * read grants it relied on are spent in the same transaction (reviews M7.1 R01, R02).
   */
  recordContextPacket(
    projectId: string,
    actor: Actor,
    packet: ContextPacket,
    explanation?: unknown,
    opts: { uses?: { approval_id: string; tool: string; target: string }[]; still?: () => string | null } = {},
  ): void {
    this.exec({ name: 'context.compiled', project_id: projectId, actor }, (ctx) => {
      const changed = opts.still?.();
      if (changed) throw new FridayError('context_stale', changed);
      for (const u of opts.uses ?? []) {
        ctx.emit({ type: 'approval.used', payload: u, refs: [{ kind: 'approval', id: u.approval_id }] });
      }
      ctx.emit({
        type: 'context.compiled',
        payload: explanation === undefined ? { packet } : { packet, explanation },
        refs: [
          { kind: 'context', id: packet.context_id },
          ...(packet.task_id ? [{ kind: 'task' as const, id: packet.task_id }] : []),
        ],
      });
    });
  }

  /** Records a run's changed paths as observed by hooks (evidence for the completion claim). */
  observePaths(projectId: string, actor: Actor, runId: string, paths: string[]): void {
    if (paths.length === 0) return;
    this.exec({ name: 'run.observe', project_id: projectId, actor }, (ctx) => {
      const run = this.q.run(runId);
      this.emitPaths(ctx, run, paths);
    });
  }

  private emitPaths(ctx: CommandContext, run: RunView, paths: string[]): void {
    const normalized = [...new Set(paths.map(normalizePath))].filter((p) => !run.observed_paths.includes(p));
    if (normalized.length === 0) return;
    ctx.emit({
      type: 'run.paths_observed',
      payload: { run_id: run.run_id, paths: normalized },
      refs: [
        { kind: 'run', id: run.run_id },
        { kind: 'task', id: run.task_id },
      ],
    });
  }

  /** Appends an observation event (whitelisted types only; they never change domain rows). */
  recordObservation(
    projectId: string,
    actor: Actor,
    type: string,
    payload: Record<string, unknown>,
    refs: { kind: 'task' | 'run' | 'harness' | 'agent'; id: string }[] = [],
  ): StoredEvent {
    if (!OBSERVATION_TYPES.has(type))
      throw new FridayError('invalid_request', `"${type}" is not an observation event type`);
    return this.bus.execute({ name: `observe.${type}`, project_id: projectId, actor }, (ctx) =>
      ctx.emit({ type, payload, refs }),
    ).events[0] as StoredEvent;
  }

  /** Replaces the capability declaration of a harness (spec Part 06 §4). */
  setCapabilities(projectId: string, harnessId: string, capabilities: Record<string, unknown>): void {
    this.exec(
      { name: 'harness.capabilities', project_id: projectId, actor: { kind: 'harness', id: harnessId } },
      (ctx) => {
        const h = this.q.harness(harnessId);
        this.moveHarness(ctx, h, h.status, 'capabilities', { capabilities });
      },
    );
  }

  // ================================================================ tokens (ADR-0008)

  /** Distinguishes a revoked token (COS-3005) from an unknown one (COS-3004). */
  tokenStatus(raw: string): { status: 'valid'; info: TokenInfo } | { status: 'revoked' | 'unknown' } {
    const info = this.resolveToken(raw);
    if (info) return { status: 'valid', info };
    if (!raw || raw.length < 16) return { status: 'unknown' };
    const revoked = this.db.prepare('SELECT 1 AS r FROM credentials WHERE token_hash = ?').get(sha256(raw));
    return { status: revoked ? 'revoked' : 'unknown' };
  }

  /** Issues a token; only its sha256 is stored. Returns the raw token. */
  issueToken(projectId: string, tokenClass: TokenClass, harnessId: string | null = null): string {
    const raw = randomBytes(32).toString('base64url');
    this.db
      .prepare(
        'INSERT INTO credentials (credential_id, project_id, token_class, harness_id, token_hash, issued_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(this.ids.next('cred'), projectId, tokenClass, harnessId, sha256(raw), this.clock.now());
    this.redactor.addSecret(raw);
    return raw;
  }

  resolveToken(raw: string): TokenInfo | undefined {
    if (!raw || raw.length < 16) return undefined;
    return this.db
      .prepare(
        'SELECT credential_id, project_id, token_class, harness_id FROM credentials WHERE token_hash = ? AND revoked_at IS NULL',
      )
      .get<TokenInfo>(sha256(raw));
  }

  revokeTokens(
    filter: { token_class?: TokenClass; harness_id?: string; project_id?: string; credential_id?: string },
    reason: string,
  ): number {
    const where: string[] = ['revoked_at IS NULL'];
    const params: (string | null)[] = [];
    if (filter.credential_id) {
      where.push('credential_id = ?');
      params.push(filter.credential_id);
    }
    if (filter.token_class) {
      where.push('token_class = ?');
      params.push(filter.token_class);
    }
    if (filter.harness_id) {
      where.push('harness_id = ?');
      params.push(filter.harness_id);
    }
    if (filter.project_id) {
      where.push('project_id = ?');
      params.push(filter.project_id);
    }
    return this.db
      .prepare(`UPDATE credentials SET revoked_at = ?, revoked_reason = ? WHERE ${where.join(' AND ')}`)
      .run(this.clock.now(), reason, ...params).changes;
  }
}

/** Project-relative POSIX form for comparing paths reported by agents and hooks. */
export function normalizePath(p: string): string {
  return p.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** A database made by replay carries this marker table (M3.1, R08). */
export const INSPECTION_MARKER = 'friday_inspection';

export function isInspectionCopy(db: SqlDatabase): boolean {
  return (
    db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(INSPECTION_MARKER) !==
    undefined
  );
}
