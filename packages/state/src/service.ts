import { createHash, randomBytes } from 'node:crypto';
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
  FridayError,
  type HarnessRegisterParams,
  type HarnessStatus,
  type HarnessView,
  negotiateProtocolVersion,
  type OutboundMessage,
  type RunStatus,
  type RunView,
  TaskCreateRequest,
  type TaskScope,
  type TaskStartParams,
  type TaskView,
  type TokenClass,
  type VerificationStatus,
  type WaitingReason,
} from '@friday/protocol';
import type { z } from 'zod';
import { CommandBus, type CommandContext, type CommandMeta } from './bus.js';
import { ALL_MIGRATIONS } from './migrations.js';
import { StateProjector } from './projector.js';
import { type HarnessRecord, Queries } from './queries.js';

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
};

/** Identity of a protocol caller, derived from its harness token (never from request fields). */
export interface Caller {
  harness_id: string;
  agent_id: string;
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
  readonly config: StateConfig;

  constructor(deps: {
    db: SqlDatabase;
    ids?: IdGenerator;
    clock?: Clock;
    transport?: EventTransport;
    redactor?: Redactor;
    artifactsDir?: string;
    config?: Partial<StateConfig>;
    migrate?: boolean;
  }) {
    this.db = deps.db;
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

  private createRun(ctx: CommandContext, task: TaskView, harnessId: string, agentId: string): RunView {
    const run_id = this.ids.next('run');
    const attempt = this.q.maxAttempt(task.task_id) + 1;
    ctx.emit({
      type: 'run.created',
      payload: { run: { run_id, task_id: task.task_id, harness_id: harnessId, agent_id: agentId, attempt } },
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
    return this.exec({ name: 'task.assign', project_id: projectId, actor, params: { taskId, agentKey } }, (ctx) => {
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
        this.q.isHarnessLive(harness.harness_id, ctx.now);
      if (!canPush || !agent || !harness) {
        return {
          mode: 'reserved' as const,
          task: this.updateTaskFields(ctx, taskId, { reserved_for_agent_key: agentKey }),
        };
      }
      const run = this.createRun(ctx, task, harness.harness_id, agent.agent_id);
      task = this.moveTask(ctx, task, 'task.assign', {
        changes: {
          assigned_agent_id: agent.agent_id,
          assigned_harness_id: harness.harness_id,
          current_run_id: run.run_id,
          reserved_for_agent_key: null,
        },
      });
      this.moveAgent(ctx, agent, 'ASSIGNED', { current_task_id: task.task_id, current_run_id: run.run_id });
      this.enqueue(
        ctx,
        harness.harness_id,
        'task.start',
        this.startParams(projectId, task, run, agent.role),
        run.run_id,
      );
      return { mode: 'assigned' as const, task };
    });
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
        const task = p.task_id ? this.q.task(projectId, p.task_id) : this.pickNext(projectId, agent);
        if (!task) throw new FridayError('task_not_found', 'no task is ready for this agent');
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
          const run = this.createRun(ctx, task, harness.harness_id, agent.agent_id);
          let t = this.moveTask(ctx, task, 'task.claim', {
            changes: {
              assigned_agent_id: agent.agent_id,
              assigned_harness_id: harness.harness_id,
              current_run_id: run.run_id,
              reserved_for_agent_key: null,
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
          const run = this.createRun(ctx, task, harness.harness_id, agent.agent_id);
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

  private pickNext(projectId: string, agent: AgentView): TaskView | undefined {
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
    return this.exec({ name: 'task.cancel', project_id: projectId, actor, params: { taskId, reason } }, (ctx) => {
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
    });
  }

  /** FAILED → REWORK → READY, reserved for the agent that did the work. */
  reworkTask(projectId: string, actor: Actor, taskId: string, reason: string): TaskView {
    return this.exec({ name: 'task.rework', project_id: projectId, actor, params: { taskId, reason } }, (ctx) => {
      let task = this.q.task(projectId, taskId);
      const prevAgent = task.assigned_agent_id ? this.q.findAgent(task.assigned_agent_id) : undefined;
      task = this.moveTask(ctx, task, 'task.rework', { reason });
      return this.moveTask(ctx, task, 'task.ready', {
        changes: {
          assigned_agent_id: null,
          assigned_harness_id: null,
          reserved_for_agent_key: prevAgent?.agent_key ?? task.reserved_for_agent_key,
        },
      });
    });
  }

  // ================================================================ verification

  startVerification(projectId: string, actor: Actor, taskId: string): { verification_id: string; task: TaskView } {
    return this.exec({ name: 'verification.start', project_id: projectId, actor, params: { taskId } }, (ctx) => {
      let task = this.q.task(projectId, taskId);
      task = this.moveTask(ctx, task, 'verification.start');
      const verification_id = this.ids.next('ver');
      ctx.emit({
        type: 'verification.started',
        payload: { verification_id, task_id: taskId, run_id: task.current_run_id },
        refs: [
          { kind: 'task', id: taskId },
          { kind: 'verification', id: verification_id },
        ],
      });
      return { verification_id, task };
    });
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
      const hostChanges = {
        host_pid: host.pid ?? null,
        host_session_id: host.session_id ?? null,
        host_cwd: host.cwd ?? null,
        version: params.version ?? null,
        protocol_version,
        capabilities: params.capabilities,
        enforcement_level: params.enforcement_level ?? null,
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
              attach_mode: params.attach_mode,
              protocol_version,
              capabilities: params.capabilities,
              enforcement_level: params.enforcement_level ?? null,
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
   * Lease manager tick (plan B13). Marks late harnesses DEGRADED, expired ones lost, ends the
   * reconnect window, and declines assignments whose `task.start` was never acknowledged.
   */
  tick(projectId: string): { degraded: string[]; lost: string[]; terminated: string[]; declined: string[] } {
    const now = this.clock.now();
    const nowMs = Date.parse(now);
    const out = {
      degraded: [] as string[],
      lost: [] as string[],
      terminated: [] as string[],
      declined: [] as string[],
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

  private startParams(projectId: string, task: TaskView, run: RunView, role: string): TaskStartParams {
    return {
      task_id: task.task_id,
      run_id: run.run_id,
      attempt: run.attempt,
      role,
      instruction: task.description ? `${task.summary}\n\n${task.description}` : task.summary,
      context_packet_ref: null,
      working_directory: this.q.project(projectId)?.root_path ?? '.',
      git_ref: null,
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
    this.exec({ name: 'escalation.answer', project_id: projectId, actor, params: { escalationId, answer } }, (ctx) => {
      ctx.emit({
        type: 'escalation.answered',
        payload: { escalation_id: escalationId, answer },
        refs: [{ kind: 'escalation', id: escalationId }],
      });
    });
  }

  recordCommunication(
    projectId: string,
    caller: Caller,
    p: {
      to: string;
      mode: string;
      content: string;
      response_to?: string | undefined;
      task_id?: string | undefined;
      idempotency_key?: string | undefined;
    },
  ): { message_id: string; status: 'recorded' } {
    const actor: Actor = { kind: 'agent', id: caller.agent_id };
    return this.exec(
      { name: 'communication.request', project_id: projectId, actor, idempotency_key: p.idempotency_key, params: p },
      (ctx) => {
        const message_id = this.ids.next('msg');
        ctx.emit({
          type: 'communication.recorded',
          payload: {
            message_id,
            from: caller.agent_id,
            to: p.to,
            mode: p.mode,
            content: p.content,
            response_to: p.response_to ?? null,
            task_id: p.task_id ?? null,
          },
          refs: p.task_id ? [{ kind: 'task', id: p.task_id }] : [],
        });
        return { message_id, status: 'recorded' as const };
      },
    );
  }

  recordContextPacket(projectId: string, actor: Actor, packet: ContextPacket): void {
    this.exec({ name: 'context.compiled', project_id: projectId, actor }, (ctx) => {
      ctx.emit({
        type: 'context.compiled',
        payload: { packet },
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

  // ================================================================ tokens (ADR-0008)

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
