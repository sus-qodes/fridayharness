import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
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
  type ContextPacket,
  type EnforcementLevel,
  type EnforcementStatus,
  FridayError,
  GoalCreateRequest,
  type GoalView,
  type HarnessRegisterParams,
  type HarnessStatus,
  type HarnessView,
  type InboxItem,
  negotiateProtocolVersion,
  type OutboundMessage,
  type PlanStatus,
  type PlanTaskView,
  type PlanVersionView,
  type RunStatus,
  type RunView,
  TaskCreateRequest,
  type TaskScope,
  type TaskStartParams,
  type TaskStatus,
  type TaskView,
  type TokenClass,
  type VerificationFinding,
  type VerificationStatus,
  type WaitingReason,
  type WorktreeView,
} from '@friday/protocol';
import type { z } from 'zod';
import { CommandBus, type CommandContext, type CommandMeta } from './bus.js';
import { MemoryService } from './memory.js';
import { ALL_MIGRATIONS } from './migrations.js';
import { StateProjector } from './projector.js';
import { type HarnessRecord, Queries } from './queries.js';
import type { DeliveryRow, MessageRow } from './rows.js';

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
  /** `security.require_enforcing_hooks`: Claude Code sessions must run on a host that blocks when a hook fails. */
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
  /** How long a run may wait for its worktree before it is declined. */
  workspaceTimeoutMs: number;
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
  workspaceTimeoutMs: 10 * 60 * 1000,
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

function versionAtLeast(v: string | null | undefined, min: readonly number[]): boolean | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v ?? '');
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i += 1) {
    if ((parts[i] ?? 0) !== (min[i] ?? 0)) return (parts[i] ?? 0) > (min[i] ?? 0);
  }
  return true;
}

/**
 * The enforcement a session actually reached (ADR-0010, review F09), from evidence rather than
 * from what the client says: for a Claude Code session in attach mode, Friday hooks must have
 * reached the daemon from that session, and the host version decides whether a failing hook
 * blocks. Adapters that run the host themselves (spawn mode, FakeHarness) report their level.
 */
export function achievedEnforcement(h: {
  vendor: string;
  attach_mode: string;
  claimed: EnforcementLevel | null;
  hooks_seen: boolean;
  host_version: string | null;
}): { level: EnforcementLevel; status: EnforcementStatus; basis: string } {
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
  intent?: { objective: string; inferred_constraints: string[]; inferred_outcomes: string[] } | null;
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
]);

const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const TERMINAL_TASK = new Set(['COMPLETED', 'CANCELLED', 'ABANDONED']);
const SYSTEM: Actor = { kind: 'system', id: 'friday' };
const LEASE_MANAGER: Actor = { kind: 'system', id: 'lease-manager' };

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
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
  readonly artifacts: ArtifactStore | undefined;
  /** The project's artifacts folder (`.friday/artifacts`); snapshots live in its `snapshots/`. */
  readonly artifactsDir: string | undefined;
  readonly config: StateConfig;
  /** Scoped memory (M4c, ADR-0021). */
  readonly memory: MemoryService;
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
    return this.q.task(ctx.project_id, task.task_id);
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
  private workspaceFor(ctx: CommandContext, projectId: string, task: TaskView, harness: HarnessRecord): Workspace {
    const root = this.q.project(projectId)?.root_path ?? '.';
    if (harness.attach_mode !== 'spawn') {
      return { execution_root: harness.host_cwd ?? root, base_commit: null, branch_ref: null, workspace: 'ready' };
    }
    if (this.config.worktreeMode !== 'per_task') {
      return { execution_root: root, base_commit: null, branch_ref: null, workspace: 'ready' };
    }
    const wt = this.q.worktreeForTask(task.task_id);
    if (wt && existsSync(wt.path)) {
      if (wt.status === 'preserved') {
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

  private createRun(
    ctx: CommandContext,
    task: TaskView,
    harnessId: string,
    agentId: string,
    ws: Workspace = { execution_root: null, base_commit: null, branch_ref: null, workspace: 'ready' },
  ): RunView {
    const run_id = this.ids.next('run');
    const attempt = this.q.maxAttempt(task.task_id) + 1;
    ctx.emit({
      type: 'run.created',
      payload: { run: { run_id, task_id: task.task_id, harness_id: harnessId, agent_id: agentId, attempt, ...ws } },
      refs: [
        { kind: 'task', id: task.task_id },
        { kind: 'run', id: run_id },
        { kind: 'harness', id: harnessId },
      ],
    });
    return this.q.run(run_id);
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
    if (this.q.project(input.project_id)) return;
    this.exec({ name: 'project.ensure', project_id: input.project_id, actor: SYSTEM }, (ctx) => {
      ctx.emit({ type: 'project.created', payload: { name: input.name, root_path: input.root_path } });
    });
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
    return this.exec({ name: 'task.assign', project_id: projectId, actor, params: { taskId, agentKey } }, (ctx) =>
      this.assignWithin(ctx, projectId, taskId, agentKey),
    );
  }

  private assignWithin(
    ctx: CommandContext,
    projectId: string,
    taskId: string,
    agentKey: string,
  ): { mode: 'assigned' | 'reserved'; task: TaskView } {
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
          this.startParams(projectId, task, run, agent.role),
          run.run_id,
        );
      }
      return { mode: 'assigned' as const, task };
    }
  }

  /** Attach-mode pull path (Friday extension, ADR-0007): the agent takes a task and starts it. */
  claimTask(
    projectId: string,
    caller: Caller,
    p: { task_id?: string | undefined; next?: boolean | undefined },
    opts: { idempotency_key?: string | undefined } = {},
  ): { task: TaskView; run_id: string; attempt: number; resumed: boolean } {
    const actor: Actor = { kind: 'agent', id: caller.agent_id };
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
            this.workspaceFor(ctx, projectId, task, harness),
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
            this.workspaceFor(ctx, projectId, task, harness),
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
          },
        });
        task = this.moveTask(ctx, task, 'agent.completion_claim', { reason: p.summary.slice(0, 200) });
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

  reportAgentError(
    projectId: string,
    caller: Caller,
    p: { task_id: string; run_id: string; message: string; fatal: boolean; idempotency_key?: string | undefined },
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
          },
          refs: [{ kind: 'task', id: task.task_id }],
        });
        if (!p.fatal) return { task_status: task.status };
        if (task.status === 'RUNNING') {
          task = this.moveTask(ctx, task, 'task.wait', {
            waiting_reason: 'agent_error',
            reason: p.message.slice(0, 200),
          });
        } else if (task.status === 'WAITING') {
          task = this.updateTaskFields(ctx, task.task_id, { waiting_reason: 'agent_error' });
        }
        this.endRun(ctx, run, 'failed');
        this.releaseAgent(ctx, caller.agent_id, task.task_id);
        this.syncHarnessBusy(ctx, caller.harness_id);
        return { task_status: task.status };
      },
    );
  }

  /** Back to READY. Operators release ASSIGNED/WAITING/HARNESS_LOST/RUNNING; agents release their own RUNNING task. */
  releaseTask(projectId: string, actor: Actor, taskId: string, reason: string, caller?: Caller): TaskView {
    return this.exec({ name: 'task.release', project_id: projectId, actor, params: { taskId, reason } }, (ctx) => {
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
    });
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
    // The agent that did the work gets the first chance, for a while (review F08).
    const changes: Record<string, unknown> = { assigned_agent_id: null, assigned_harness_id: null };
    if (prevAgent) {
      changes.reserved_for_agent_key = prevAgent.agent_key;
      changes.reserved_by = 'rework';
      changes.reserved_until = addMs(ctx.now, this.config.reservationTtlMs);
    }
    return this.moveTask(ctx, task, 'task.ready', { changes });
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
   * Records a plan version as PROPOSED. The planner validated it (or a human wrote it and the
   * CLI validated it); this only checks that kept, reworked and dropped tasks belong to the goal.
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
              tasks: proposal.tasks,
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
          changes.objective = proposal.intent.objective;
          changes.inferred_constraints = proposal.intent.inferred_constraints.filter(
            (c) => !ownC.has(c.trim().toLowerCase()),
          );
          changes.inferred_outcomes = proposal.intent.inferred_outcomes.filter(
            (o) => !ownO.has(o.trim().toLowerCase()),
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
              scope: t.scope,
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
        ctx.emit({
          type: 'plan.task_materialized',
          payload: { plan_id: planId, version, key: t.key, task_id },
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
      if (t.status === 'PROPOSED' && this.q.openDependencies(t.task_id).length === 0)
        out.push(this.moveTask(ctx, t, 'task.ready'));
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

  /** Completes the goal and its active plan once every task is COMPLETED (cancelled ones aside). */
  completeGoalIfDone(projectId: string, actor: Actor, goalId: string): GoalView | null {
    const goal = this.q.goal(projectId, goalId);
    if (goal.status !== 'ACTIVE' || !goal.plan_id) return null;
    const active = this.q.latestPlanVersion(goal.plan_id, ['ACTIVE']);
    const tasks = this.q.goalTasks(projectId, goalId);
    const done =
      tasks.every((t) => t.status === 'COMPLETED' || t.status === 'CANCELLED') &&
      tasks.some((t) => t.status === 'COMPLETED');
    if (!active || !done) return null;
    return this.exec({ name: 'goal.complete', project_id: projectId, actor, params: { goalId } }, (ctx) => {
      this.movePlan(ctx, active, 'COMPLETED', 'all tasks completed');
      ctx.emit({
        type: 'goal.status_changed',
        payload: {
          goal_id: goalId,
          transition: { from: 'ACTIVE', to: 'COMPLETED', trigger: 'all tasks completed' },
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
  ): TaskView {
    return this.exec(
      { name: 'verification.finish', project_id: projectId, actor, params: { verificationId, passed, summary } },
      (ctx) => {
        const v = this.q.verification(verificationId);
        if (v.status !== 'RUNNING')
          throw new FridayError('invalid_state_transition', `verification is already ${v.status}`);
        ctx.emit({
          type: 'verification.finished',
          payload: {
            verification_id: verificationId,
            task_id: v.task_id,
            status: passed ? 'PASSED' : 'FAILED',
            summary,
          },
          refs: [
            { kind: 'verification', id: verificationId },
            { kind: 'task', id: v.task_id },
          ],
        });
        const task = this.q.task(projectId, v.task_id);
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
      const enforcement = achievedEnforcement({
        vendor: params.vendor,
        attach_mode: params.attach_mode,
        claimed: params.enforcement_level ?? null,
        hooks_seen: Boolean(previous?.hooks_seen_at),
        // A client that cannot tell (a hook arriving first) keeps the version already known.
        host_version: params.version ?? previous?.version ?? null,
      });
      const hostChanges = {
        host_pid: host.pid ?? null,
        host_session_id: host.session_id ?? null,
        host_cwd: host.cwd ?? null,
        version: params.version ?? previous?.version ?? null,
        adapter_version: params.adapter_version ?? previous?.adapter_version ?? null,
        protocol_version,
        capabilities: params.capabilities,
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
        shadow = true;
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

      if (reconnected && params.attach_mode === 'spawn') {
        // Tell a returning spawn-mode harness to resume its suspended runs (acknowledged via harness.ack).
        for (const run of this.q.suspendedRunsFor(harness_id)) {
          const task = this.q.task(projectId, run.task_id);
          if (task.status !== 'HARNESS_LOST' || task.current_run_id !== run.run_id) continue;
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
   * A Friday hook reached the daemon from this harness's session: evidence that its tool calls
   * pass the policy hook (review F09). Recomputes the achieved enforcement once.
   */
  noteHookEvidence(projectId: string, harnessId: string): HarnessRecord {
    const h = this.q.harness(harnessId);
    if (h.hooks_seen_at) return h;
    this.exec({ name: 'harness.hooks_seen', project_id: projectId, actor: SYSTEM }, (ctx) => {
      const e = achievedEnforcement({
        vendor: h.vendor,
        attach_mode: h.attach_mode,
        claimed: h.enforcement_level,
        hooks_seen: true,
        host_version: h.version,
      });
      this.moveHarness(ctx, h, h.status, 'hooks seen', {
        hooks_seen_at: ctx.now,
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
      const hint =
        need === 'L2'
          ? 'No adapter in this version of Friday provides L2 (isolated execution); lower security.enforcement_required or wait for M6.'
          : h.vendor === 'claude-code'
            ? 'Run "friday harness config claude-code" in the project and start a new Claude Code session, so its tool calls pass Friday\'s policy hook.'
            : 'Use a harness with Friday policy hooks, or lower security.enforcement_required in .friday/config.yaml.';
      return `this project requires ${need} enforcement (security.enforcement_required), but this session has ${level}: ${h.enforcement_basis ?? 'no evidence'}. ${hint}`;
    }
    if (this.config.requireEnforcingHooks && h.vendor === 'claude-code' && h.enforcement_status !== 'enforcing') {
      return `this project requires hooks that block when they fail (security.require_enforcing_hooks), but this session is ${h.enforcement_status ?? 'unknown'}: ${h.enforcement_basis ?? 'no evidence'}. Update Claude Code to 2.1.295 or later.`;
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
    messages_expired: string[];
    messages_escalated: string[];
    /** Replies recovered for answers recorded without one, and those that could not be sent. */
    messages_replied: string[];
    messages_reply_failed: { escalation_id: string; error: string }[];
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
      messages_expired: [] as string[],
      messages_escalated: [] as string[],
      messages_replied: [] as string[],
      messages_reply_failed: [] as { escalation_id: string; error: string }[],
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
        this.exec({ name: 'harness.terminate', project_id: projectId, actor: LEASE_MANAGER }, (ctx) =>
          this.moveHarness(ctx, this.q.harness(l.harness_id), 'TERMINATED', 'reconnect window expired', {
            terminated_at: ctx.now,
          }),
        );
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
    for (const m of stale) {
      if (held(m.delivered_at)) continue;
      const timedOut =
        Date.parse(m.expires_at) <= nowMs ||
        (m.attempts >= this.config.maxDeliveryAttempts &&
          m.delivered_at !== null &&
          nowMs - Date.parse(m.delivered_at) > this.config.ackTimeoutMs);
      if (!timedOut || !m.run_id) continue;
      this.declineRun(projectId, m.run_id, 'ack timeout', LEASE_MANAGER);
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
    out.unreserved.push(...this.expireReservations(projectId, this.clock.now()));
    const timeouts = this.expireMessages(projectId, this.clock.now());
    out.messages_expired.push(...timeouts.expired);
    out.messages_escalated.push(...timeouts.escalated);
    out.messages_replied.push(...timeouts.replied);
    out.messages_reply_failed.push(...timeouts.reply_failed);
    return out;
  }

  private declineRun(projectId: string, runId: string, reason: string, actor: Actor): void {
    this.exec({ name: 'run.decline', project_id: projectId, actor }, (ctx) => {
      const run = this.q.run(runId);
      if (run.status !== 'STARTING') return;
      this.moveRun(ctx, run, 'DECLINED', reason, { outcome: 'declined', ended_at: ctx.now });
      const task = this.q.task(projectId, run.task_id);
      const agentId = task.assigned_agent_id;
      if (task.status === 'ASSIGNED' && task.current_run_id === runId) {
        this.moveTask(ctx, task, 'task.release', {
          reason,
          changes: { assigned_agent_id: null, assigned_harness_id: null, current_run_id: null },
        });
      }
      const agent = agentId ? this.q.findAgent(agentId) : undefined;
      if (agent && agent.status === 'ASSIGNED')
        this.moveAgent(ctx, agent, 'AVAILABLE', { current_task_id: null, current_run_id: null });
    });
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
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM outbox_messages WHERE project_id = ? AND harness_id = ? AND expires_at > ?
             AND (status = 'queued' OR (status = 'delivered' AND delivered_at <= ?))
           ORDER BY created_at LIMIT ?`,
        )
        .all<{
          message_id: string;
          method: OutboundMessage['method'];
          params_json: string;
          attempts: number;
          expires_at: string;
        }>(projectId, harnessId, now, redeliverBefore, max);
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
  ): { acked: string[]; unknown: string[] } {
    const acked: string[] = [];
    const unknown: string[] = [];
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
      if (m.status === 'acked') {
        acked.push(a.message_id);
        continue;
      }
      if (m.method === 'task.start' && m.run_id && m.status !== 'expired') {
        if (a.accepted) this.acceptRun(projectId, harnessId, m.run_id, a.session_ref ?? null);
        else
          this.declineRun(projectId, m.run_id, a.reason ?? 'declined by harness', { kind: 'harness', id: harnessId });
      }
      if (m.method === 'task.resume' && m.run_id && m.status !== 'expired' && a.accepted) {
        this.resumeRun(projectId, harnessId, m.run_id);
      }
      this.db
        .prepare("UPDATE outbox_messages SET status = 'acked', acked_at = ?, ack_result_json = ? WHERE message_id = ?")
        .run(this.clock.now(), toJson({ accepted: a.accepted, reason: a.reason ?? null }), a.message_id);
      acked.push(a.message_id);
    }
    return { acked, unknown };
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
    alloc: { path: string; branch: string; base_commit: string; created: boolean; warnings: string[] },
  ): RunView {
    return this.exec({ name: 'run.workspace', project_id: projectId, actor: SYSTEM, params: { runId } }, (ctx) => {
      const run = this.q.run(runId);
      if (run.workspace !== 'pending' || run.status !== 'STARTING') return run;
      const task = this.q.task(projectId, run.task_id);
      let worktree = this.q.worktreeForTask(task.task_id);
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
        },
        refs: [
          { kind: 'task', id: task.task_id },
          { kind: 'run', id: run.run_id },
        ],
      });
      const ready = this.q.run(run.run_id);
      const agent = this.q.agent(run.agent_id);
      this.enqueue(ctx, run.harness_id, 'task.start', this.startParams(projectId, task, ready, agent.role), run.run_id);
      return ready;
    });
  }

  /** The worktree could not be prepared: the run is declined and the task is free again, with the reason. */
  workspaceFailed(projectId: string, runId: string, reason: string): void {
    const run = this.q.findRun(runId);
    if (run?.workspace !== 'pending' || run.status !== 'STARTING') return;
    this.declineRun(projectId, runId, `the task worktree could not be prepared: ${reason}`, SYSTEM);
  }

  /** A worktree a human asked for (`friday task worktree`), to start a session in. */
  recordWorktree(
    projectId: string,
    actor: Actor,
    taskId: string,
    alloc: { path: string; branch: string; base_commit: string; warnings: string[] },
  ): WorktreeView {
    return this.exec({ name: 'worktree.allocate', project_id: projectId, actor, params: { taskId } }, (ctx) => {
      const task = this.q.task(projectId, taskId);
      if (TERMINAL_TASK.has(task.status)) {
        throw new FridayError('invalid_state_transition', `task ${taskId} is ${task.status}`);
      }
      const existing = this.q.worktreeForTask(taskId);
      if (existing && existing.path === alloc.path) return existing;
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

  private startParams(projectId: string, task: TaskView, run: RunView, role: string): TaskStartParams {
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
    };
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
      idempotency_key?: string | undefined;
    },
  ): { approval_id: string; status: 'pending'; reason: string; expires_at: string } {
    const actor: Actor = { kind: 'agent', id: caller.agent_id };
    return this.exec(
      { name: 'permission.request', project_id: projectId, actor, idempotency_key: p.idempotency_key, params: p },
      (ctx) => {
        const approval_id = this.ids.next('apr');
        const expires_at = addMs(ctx.now, p.ttl_s * 1000);
        ctx.emit({
          type: 'approval.requested',
          payload: {
            approval: {
              approval_id,
              task_id: p.task_id ?? null,
              run_id: p.run_id ?? null,
              capability: p.action_class,
              target: p.resource ?? p.command ?? null,
              purpose: p.justification,
              risk: null,
              status: 'pending',
              expires_at,
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
        };
      },
    );
  }

  decideApproval(projectId: string, actor: Actor, approvalId: string, granted: boolean): void {
    if (actor.kind !== 'human') throw new FridayError('permission_denied', 'only a human can decide an approval');
    this.exec({ name: 'approval.decide', project_id: projectId, actor, params: { approvalId, granted } }, (ctx) => {
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
        payload: { approval_id: approvalId, status: granted ? 'granted' : 'denied' },
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
        ctx.emit({
          type: 'escalation.answered',
          payload: { escalation_id: escalationId, answer },
          refs: [{ kind: 'escalation', id: escalationId }],
        });
        if (request) this.replyFor(ctx, projectId, actor, request, answer);
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

  recordContextPacket(projectId: string, actor: Actor, packet: ContextPacket, explanation?: unknown): void {
    this.exec({ name: 'context.compiled', project_id: projectId, actor }, (ctx) => {
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

  revokeTokens(filter: { token_class?: TokenClass; harness_id?: string; project_id?: string }, reason: string): number {
    const where: string[] = ['revoked_at IS NULL'];
    const params: (string | null)[] = [];
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
