import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import type { Clock, IdGenerator } from '@friday/core';
import { closeDatabase, openDatabase } from '@friday/db';
import { type ExecutionProfile, ProcessGroups } from '@friday/execution';
import { GitRoot, rootKey, worktreesDir } from '@friday/git';
import type { PlannerModel } from '@friday/planner';
import { type Actor, API_VERSION, type ContextPacket, FridayError, PROTOCOL_VERSIONS } from '@friday/protocol';
import {
  type DaemonDiscovery,
  ensurePrivateDir,
  FRIDAY_DIR,
  FRIDAY_VERSION,
  loadProject,
  type ProjectRef,
  privateDirFor,
  writePrivateFile,
} from '@friday/sdk';
import { FridayState, type StateConfig } from '@friday/state';
import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import { buildApp } from './app.js';
import { type BrainHandle, createMasterBrain } from './brain.js';
import { type CompileInput, createContextService } from './context.js';
import { profileCache } from './execution.js';
import { GraphService } from './graph-service.js';
import { IntegrationManager } from './integration.js';
import { LayaService } from './laya.js';
import { createLogger, type Level, type Logger, silentLogger } from './log.js';
import { OperationManager } from './operations.js';
import { type EffectivePolicy, loadEffectivePolicy, writePolicyTrust } from './policy.js';
import { RecoveryManager } from './recovery.js';
import { RoutingService } from './routing.js';
import { createToolJudge, type ToolJudge } from './tool-policy.js';
import { runVerification } from './verify.js';
import { WorkspaceManager } from './workspaces.js';

export interface DaemonOptions {
  /** Any directory inside the project; resolved to the main worktree root. */
  projectRoot: string;
  /** Overrides the private state directory (default: FRIDAY_STATE_DIR or the per-user location). */
  stateDir?: string;
  port?: number;
  clock?: Clock;
  ids?: IdGenerator;
  /** Lease manager interval; 0 disables the timer (tests drive `tick()` themselves). */
  tickMs?: number;
  /** Poll interval for long-polls and streams. */
  pollIntervalMs?: number;
  logLevel?: Level;
  /** Write logs to `.friday/logs/daemon.jsonl` (default true). */
  logToFile?: boolean;
  logToConsole?: boolean;
  /** Extra routes (e.g. Claude Code hook endpoints) mounted on the app before it starts serving. */
  extensions?: ((app: Hono, ctx: DaemonContext) => void)[];
  /** Runs verification checks for `POST /tasks/:id/verify` without a manual result. */
  verify?: (ctx: DaemonContext, taskId: string, actor: Actor) => Promise<unknown>;
  state?: Partial<StateConfig>;
  /**
   * The Master Brain (M2): false leaves it out; `model` replaces the configured provider (tests);
   * `autoStart: false` leaves it idle until `brain.runOnce()`.
   */
  brain?: false | { model?: PlannerModel | null; autoStart?: boolean };
}

export interface DaemonContext {
  state: FridayState;
  project: ProjectRef;
  privateDir: string;
  logger: Logger;
  port: () => number;
  /** Raw bootstrap token, for in-process components that call back into the daemon. */
  bootstrapToken: () => string;
  /** The context compiler (M4d, ADR-0022). */
  compile: (input: CompileInput, actor: Actor) => Promise<ContextPacket>;
  /** Code graphs of the project's checkouts (ADR-0020, ADR-0023). */
  graph: GraphService;
  /** Verifications this daemon is running; any other RUNNING one has lost its runner (ADR-0024 §6). */
  verifying: Set<string>;
  /** The project's effective policy (ADR-0028). */
  policy: () => EffectivePolicy;
  /** Reads the policy files and this clone's trust again. */
  reloadPolicy: () => EffectivePolicy;
  /** The execution profile checks and operations run in (ADR-0029 §4). */
  profile: () => ExecutionProfile;
  /** Process groups: a check's or an operation's whole process tree ends with it (review F07). */
  groups: ProcessGroups;
  /** Stops a task's gateway operations, confirmed, before its checkout is judged or reused. */
  quiesce: (taskId: string, reason: string) => Promise<void>;
  /** Judges a host's tool call, for every host the same way (ADR-0032 §4). */
  judgeTool: ToolJudge;
}

export interface Daemon extends DaemonContext {
  url: string;
  instanceId: string;
  tokens: { operator: string; bootstrap: string };
  app: Hono;
  tick(): ReturnType<FridayState['tick']>;
  /** The Master Brain, unless it was disabled. */
  brain: BrainHandle | undefined;
  /** Recovery of lost and failed attempts (M5d, ADR-0026). */
  recovery: RecoveryManager;
  /** Integration of verified task branches into goal branches (M5c, ADR-0025). */
  integration: IntegrationManager;
  /** The execution gateway (M6c, ADR-0029). */
  operations: OperationManager;
  close(reason?: string): Promise<void>;
  /** Resolves when the daemon has fully stopped (after close or an admin shutdown). */
  closed: Promise<void>;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** One daemon per project (ADR-0012): an exclusive lock file in the private directory. */
function acquireLock(dir: string, instanceId: string): string {
  const lock = path.join(dir, 'daemon.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, instance_id: instanceId, at: new Date().toISOString() }));
      closeSync(fd);
      return lock;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let holder: { pid?: number } = {};
      try {
        holder = JSON.parse(readFileSync(lock, 'utf8')) as { pid?: number };
      } catch {
        // unreadable lock: treat as stale
      }
      // close() always removes the lock, so a lock held by a live pid (even this one) is a live daemon.
      if (holder.pid && pidAlive(holder.pid)) {
        throw new FridayError(
          'invalid_request',
          `a Friday daemon is already running for this project (pid ${holder.pid})`,
          {
            pid: holder.pid,
          },
        );
      }
      rmSync(lock, { force: true });
    }
  }
  throw new FridayError('internal_error', 'could not acquire the daemon lock');
}

/**
 * Starts the Friday daemon for a project (plan M1.5): private dir and tokens, database,
 * HTTP server on 127.0.0.1, discovery files, lease manager. `close()` reverses all of it.
 */
export async function createDaemon(opts: DaemonOptions): Promise<Daemon> {
  const project = loadProject(opts.projectRoot);
  const env = opts.stateDir ? { ...process.env, FRIDAY_STATE_DIR: opts.stateDir } : process.env;
  const privateDir = ensurePrivateDir(privateDirFor(project, env));
  const fridayDir = path.join(project.root, FRIDAY_DIR);
  mkdirSync(path.join(fridayDir, 'run'), { recursive: true });

  // Task worktrees need a git project with a commit (ADR-0023 §2); otherwise runs use the main checkout.
  const gitRoot = await GitRoot.open(project.root).catch(() => null);
  const head = gitRoot ? ((await gitRoot.refs().catch(() => null))?.head ?? null) : null;
  const worktreeMode = project.config.worktrees.mode === 'per_task' && head ? 'per_task' : 'off';

  // The project's own policy (ADR-0028): what tracked files tighten applies now, what they loosen
  // only once this clone trusted exactly that.
  let policy = loadEffectivePolicy(project, privateDir);

  const leases = project.config.leases;
  const stateConfig: Partial<StateConfig> = {
    ...(leases.heartbeat_interval_ms ? { heartbeatIntervalMs: leases.heartbeat_interval_ms } : {}),
    ...(leases.lease_ttl_ms ? { leaseTtlMs: leases.lease_ttl_ms } : {}),
    ...(leases.reconnect_window_ms !== undefined ? { reconnectWindowMs: leases.reconnect_window_ms } : {}),
    ...(leases.clean_exit_grace_ms !== undefined ? { cleanExitGraceMs: leases.clean_exit_grace_ms } : {}),
    ...(leases.ack_timeout_ms ? { ackTimeoutMs: leases.ack_timeout_ms } : {}),
    ...(leases.max_delivery_attempts ? { maxDeliveryAttempts: leases.max_delivery_attempts } : {}),
    // Sessions below the project's enforcement requirement cannot take work (review F09).
    enforcementRequired: policy.enforcement_required,
    requireEnforcingHooks: project.config.security.require_enforcing_hooks,
    reservationTtlMs: project.config.master_brain.reservation_ttl_ms,
    allowBroadcast: project.config.communication.allow_broadcast,
    messageReservationMs: project.config.communication.delivery_reservation_ms,
    messageMaxAttempts: project.config.communication.max_delivery_attempts,
    messageTtlMs: project.config.communication.message_ttl_ms,
    blockingReplyMs: project.config.communication.blocking_reply_ms,
    maxOpenPerRecipient: project.config.communication.max_open_per_recipient,
    worktreeMode,
    // This clone's worktree folder: a worktree recorded anywhere else is another clone's (review F08).
    worktreeRoot: gitRoot ? path.join(worktreesDir(env), rootKey(gitRoot.root)) : null,
    fileReservationTtlMs: project.config.reservations.ttl_ms,
    ...opts.state,
  };

  const db = openDatabase(path.join(fridayDir, 'project.db'));
  let state: FridayState;
  try {
    state = new FridayState({
      db,
      ...(opts.clock ? { clock: opts.clock } : {}),
      ...(opts.ids ? { ids: opts.ids } : {}),
      artifactsDir: path.join(fridayDir, 'artifacts'),
      config: stateConfig,
    });
  } catch (e) {
    closeDatabase(db);
    throw e;
  }
  const instanceId = state.ids.next('inst');
  let lockFile: string;
  try {
    lockFile = acquireLock(privateDir, instanceId);
  } catch (e) {
    closeDatabase(db);
    throw e;
  }

  const logger =
    opts.logToFile === false && !opts.logToConsole
      ? silentLogger
      : createLogger({
          ...(opts.logToFile === false ? {} : { file: path.join(fridayDir, 'logs', 'daemon.jsonl') }),
          level: opts.logLevel ?? project.config.daemon.log_level,
          console: opts.logToConsole ?? false,
          redact: (line) => state.redactor.redactString(line).value,
        });

  state.ensureProject({ project_id: project.project_id, name: project.name, root_path: project.root });

  const tokens = { operator: '', bootstrap: '' };
  const rotateTokens = () => {
    for (const cls of ['operator', 'bootstrap'] as const) {
      state.revokeTokens({ token_class: cls, project_id: project.project_id }, 'rotated');
      tokens[cls] = state.issueToken(project.project_id, cls);
      writePrivateFile(privateDir, `${cls}.token`, tokens[cls]);
    }
    return { ...tokens };
  };
  rotateTokens();

  let port = 0;
  let draining = false;
  const streams = new Set<AbortController>();
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((r) => {
    resolveClosed = r;
  });

  const graph = new GraphService({ root: project.root, cacheDir: path.join(fridayDir, 'graph') });
  // Every new run is routed in its own transaction (ADR-0031 §6): set before anything can create one.
  const routing = new RoutingService({ state, project, logger });
  state.setRouter(routing.router);
  // Laya, when enabled: asked as a task becomes READY; its stored answer feeds routing (ADR-0031 §10).
  const laya = new LayaService({ state, project, logger, routing });
  routing.laya = (taskId) => laya.answerFor(taskId);
  routing.layaStatus = (taskId) => {
    const t = state.q.findTask(project.project_id, taskId);
    return t ? laya.status(t) : 'off';
  };
  const stopLaya = state.transport.subscribe(
    { project_id: project.project_id, types: ['task.ready', 'task.cancelled'] },
    (e) => {
      const taskId = (e.payload as { task_id?: string }).task_id;
      if (!taskId || !laya.enabled) return;
      // A cancelled task's question no longer matters (review F11).
      if (e.type === 'task.cancelled') laya.cancel(taskId);
      else void laya.ask(taskId);
    },
  );
  // READY tasks whose question was never answered (the daemon stopped meanwhile) are asked again.
  void laya.sweep().catch((err) => logger.warn('asking Laya again failed', { message: (err as Error).message }));
  // Every check's and operation's process tree is a group that ends with it (review F07).
  const groups = new ProcessGroups(env);
  // Set once the execution gateway exists: a task's operations stop before its worktree is reused.
  let quiesce: DaemonContext['quiesce'] = async () => undefined;
  // Task worktrees: prepared as soon as a run needs one, released when its task ends (ADR-0023).
  const workspaces = new WorkspaceManager({
    state,
    project,
    logger,
    env,
    quiesce: (taskId) => quiesce(taskId, 'a new attempt needs its worktree'),
  });
  // Checks and operations run in the execution profile of the effective policy (ADR-0029 §4).
  const stateRoot = path.dirname(path.dirname(privateDir));
  const profileOf = profileCache({ forbiddenRoots: () => [project.root, workspaces.dir], stateDir: stateRoot, env });
  const profile = () => profileOf(policy);
  // A completed goal task's verified work goes to its goal branch before its worktree is released (ADR-0025).
  const integration = new IntegrationManager({ state, project, logger, workspaces, profile, groups });
  const stopWorkspaces = state.transport.subscribe(
    { project_id: project.project_id, types: ['run.created', 'task.cancelled', 'task.completed'] },
    (e) => {
      if (e.type === 'run.created') {
        const run = (e.payload as { run?: { run_id: string; workspace?: string } }).run;
        if (run?.workspace === 'pending') void workspaces.prepare(run.run_id);
        return;
      }
      const taskId = (e.payload as { task_id?: string }).task_id;
      if (!taskId) return;
      const done =
        e.type === 'task.completed'
          ? integration.completed(taskId)
          : quiesce(taskId, 'the task was cancelled')
              .catch(() => undefined)
              .then(() => workspaces.release(taskId, 'the task was cancelled'));
      void Promise.resolve(done).catch((err) =>
        logger.warn('finishing a task worktree failed', { task_id: taskId, message: (err as Error).message }),
      );
    },
  );
  // Lost and failed attempts: assessed, preserved, fenced and reassigned within limits (ADR-0026).
  const recovery = new RecoveryManager({
    state,
    project,
    logger,
    workspaces,
    settings: {
      maxRetries: project.config.recovery.max_retries,
      maxSameErrorRetries: project.config.recovery.max_same_error_retries,
      reconnectWindowMs: state.config.reconnectWindowMs,
    },
  });
  void integration
    .sweep()
    .catch((err) => logger.warn('integrating completed tasks failed', { message: (err as Error).message }));
  // The per-user state folder (it holds every project's private folder): never gathered into context.
  const context = createContextService({
    state,
    project,
    graph,
    stateDir: path.dirname(path.dirname(privateDir)),
    policy: () => policy,
  });
  // One judgment of host tool calls for every host: the hooks and spawn adapters (ADR-0032 §4).
  const judgeTool = createToolJudge({
    state,
    project,
    policy: () => policy,
    stateDir: path.dirname(path.dirname(privateDir)),
  });
  const ctx: DaemonContext = {
    state,
    project,
    privateDir,
    logger,
    port: () => port,
    bootstrapToken: () => tokens.bootstrap,
    compile: (input, actor) => context.compile(input, actor),
    graph,
    verifying: new Set(),
    policy: () => policy,
    reloadPolicy: () => {
      policy = loadEffectivePolicy(project, privateDir);
      (state.config as { enforcementRequired: StateConfig['enforcementRequired'] }).enforcementRequired =
        policy.enforcement_required;
      logger.info('policy reloaded', {
        version: policy.version,
        trusted: policy.trusted,
        errors: policy.errors.length,
      });
      return policy;
    },
    profile,
    groups,
    quiesce: (taskId, reason) => quiesce(taskId, reason),
    judgeTool,
  };
  for (const e of policy.errors) logger.error('policy file not applied', e);
  if (!policy.trusted) logger.warn('policy settings wait for "friday policy trust"', { loosening: policy.loosening });
  // Checks run inside the daemon: a verification still RUNNING from before this start has no runner.
  for (const id of state.interruptOrphanedVerifications(
    project.project_id,
    'the daemon stopped while its checks ran',
    ctx.verifying,
  )) {
    logger.warn('verification interrupted at start', { verification_id: id });
  }
  // The execution gateway (ADR-0029): operations a project declared, run with stored secrets.
  const operations = new OperationManager({ state, project, logger, policy: () => policy, profile, env, groups });
  quiesce = (taskId, reason) => operations.stopTask(taskId, reason);
  for (const id of operations.sweep()) logger.warn('operation interrupted at start', { operation_run_id: id });
  // Automatic verification, once this clone trusted it (ADR-0029 §6): a claim is verified at once.
  const verify = (taskId: string, actor: Actor) => (opts.verify ?? runVerification)(ctx, taskId, actor);
  const AUTO: Actor = { kind: 'system', id: 'auto-verification' };
  const autoVerify = (taskId: string) =>
    verify(taskId, AUTO).catch((e: unknown) =>
      logger.warn('automatic verification did not run', { task_id: taskId, message: (e as Error).message }),
    );
  const stopAutoVerify = state.transport.subscribe(
    { project_id: project.project_id, types: ['task.completion_claimed'] },
    (e) => {
      const taskId = (e.payload as { task_id?: string }).task_id;
      if (taskId && policy.auto_verification && project.config.verification.checks.length) void autoVerify(taskId);
    },
  );
  if (policy.auto_verification && project.config.verification.checks.length) {
    // Claims made while the daemon was down, or whose verification it interrupted.
    void (async () => {
      for (const t of state.q.tasks(project.project_id, { statuses: ['READY_FOR_VERIFICATION'] })) {
        await autoVerify(t.task_id);
      }
    })();
  }

  const brain =
    opts.brain === false
      ? undefined
      : createMasterBrain({
          state,
          project,
          env,
          logger,
          policy: () => policy,
          modelFit: (task, agentId) => routing.fitFor(task, agentId),
          // A task Laya is still asked about waits for the answer, or its deadline (review F11).
          routingReady: (task) => laya.ready(task),
          ...(opts.brain && opts.brain.model !== undefined ? { model: opts.brain.model } : {}),
        });

  let closing: Promise<void> | undefined;
  const app = buildApp({
    state,
    project,
    logger,
    instanceId,
    daemonVersion: FRIDAY_VERSION,
    port: () => port,
    trustedOrigins: () => project.config.daemon.trusted_origins,
    isDraining: () => draining,
    requestShutdown: (reason) => {
      setTimeout(() => void close(reason), 50);
    },
    rotateTokens,
    streams,
    verify,
    ...(opts.pollIntervalMs ? { pollIntervalMs: opts.pollIntervalMs } : {}),
    ...(brain ? { brain } : {}),
    graph,
    context,
    workspaces,
    integration,
    recovery,
    stateDir: path.dirname(path.dirname(privateDir)),
    policy: () => policy,
    reloadPolicy: () => ctx.reloadPolicy(),
    trustPolicy: (hash: string) => {
      writePolicyTrust(privateDir, hash, 'human');
      return ctx.reloadPolicy();
    },
    operations,
    routing,
    laya,
    judgeTool,
  });
  for (const ext of opts.extensions ?? []) ext(app as unknown as Hono, ctx);

  const server = await new Promise<Server>((resolve, reject) => {
    const s = serve(
      { fetch: app.fetch, hostname: '127.0.0.1', port: opts.port ?? project.config.daemon.port },
      (info) => {
        port = info.port;
        resolve(s as Server);
      },
    ) as Server;
    s.once('error', reject);
  }).catch((e: NodeJS.ErrnoException) => {
    rmSync(lockFile, { force: true });
    closeDatabase(db);
    if (e.code === 'EADDRINUSE') throw new FridayError('invalid_request', `port ${opts.port} is already in use`);
    throw e;
  });
  // Long-lived SSE and long-poll requests must not be cut by Node's default timeouts.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;

  const url = `http://127.0.0.1:${port}`;
  const startedAt = state.clock.now();
  const discovery: DaemonDiscovery = {
    schema_version: 1,
    instance_id: instanceId,
    project_id: project.project_id,
    pid: process.pid,
    host: '127.0.0.1',
    port,
    url,
    api_version: API_VERSION,
    protocol_versions: [...PROTOCOL_VERSIONS],
    started_at: startedAt,
    daemon_version: FRIDAY_VERSION,
  };
  writePrivateFile(privateDir, 'daemon.json', `${JSON.stringify(discovery, null, 2)}\n`);
  // Non-secret pointer inside the project, for humans and tooling (ADR-0008).
  const pointer = path.join(fridayDir, 'run', 'daemon.json');
  writeFileSync(pointer, `${JSON.stringify(discovery, null, 2)}\n`);
  db.prepare(
    'INSERT INTO daemon_instances (instance_id, project_id, pid, port, version, started_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(instanceId, project.project_id, process.pid, port, FRIDAY_VERSION, startedAt);
  state.recordObservation(project.project_id, { kind: 'system', id: 'daemon' }, 'daemon.started', {
    instance_id: instanceId,
    port,
    version: FRIDAY_VERSION,
  });
  logger.info('daemon started', { url, project_id: project.project_id, instance_id: instanceId });

  // Sessions from before this start could not heartbeat while Friday was down: each gets one
  // lease to report again before its work counts as lost (M3.1, R09).
  state.holdLeaseJudgement(project.project_id);
  const tick = () => state.tick(project.project_id);
  const tickMs = opts.tickMs ?? 1000;
  // A tick far later than scheduled means the process was paused (a laptop asleep, a long
  // collection): nobody could heartbeat meanwhile, so the same hold applies.
  const pauseMs = Math.max(5_000, state.config.heartbeatIntervalMs / 2);
  let lastTick = Date.now();
  const timer =
    tickMs > 0
      ? setInterval(() => {
          const at = Date.now();
          const late = at - lastTick - tickMs;
          lastTick = at;
          if (late > pauseMs) {
            const hold = state.holdLeaseJudgement(project.project_id);
            logger.warn('the daemon was paused; sessions get one lease to report again', {
              paused_ms: late,
              until: hold.until,
            });
            try {
              state.recordObservation(project.project_id, { kind: 'system', id: 'daemon' }, 'daemon.paused', {
                paused_ms: late,
                judged_again_at: hold.until,
              });
            } catch {
              // Recording is best effort; the hold is what matters.
            }
          }
          try {
            const r = tick();
            // Runs still waiting for a worktree (after a restart or a failure) are prepared again.
            void workspaces
              .sweep()
              .catch((e) => logger.warn('preparing worktrees failed', { message: (e as Error).message }));
            void recovery
              .sweep()
              .catch((e) => logger.warn('automatic recovery failed', { message: (e as Error).message }));
            if (
              r.lost.length ||
              r.degraded.length ||
              r.terminated.length ||
              r.declined.length ||
              r.messages_escalated.length ||
              r.messages_replied.length
            )
              logger.info('lease tick', r);
            if (r.messages_reply_failed.length)
              logger.warn('lease tick: replies not sent', { failed: r.messages_reply_failed });
          } catch (e) {
            logger.error('lease tick failed', { message: (e as Error).message });
          }
        }, tickMs)
      : undefined;
  const sweep = setInterval(() => state.bus.sweepIdempotency(), 60 * 60 * 1000);
  sweep.unref();
  if (brain && !(opts.brain && opts.brain.autoStart === false)) brain.brain.start();

  async function close(reason = 'shutdown'): Promise<void> {
    if (closing) return closing;
    closing = (async () => {
      draining = true;
      // Stop the Master Brain first: it aborts a model call in flight and finishes its current step.
      if (brain) await brain.brain.stop().catch(() => undefined);
      if (timer) clearInterval(timer);
      clearInterval(sweep);
      stopWorkspaces();
      stopAutoVerify();
      stopLaya();
      laya.close();
      // Integrations and worktree jobs in flight finish first, within a bound: no git process the
      // daemon started outlives it in the user's checkout, and none records into a closed database.
      const settled = (await integration.idle(60_000)) && (await workspaces.idle(30_000));
      if (!settled) logger.warn('stopping with an integration or a worktree job still running', { reason });
      // Every operation's processes end, confirmed, before the database closes (review F07).
      await operations
        .close()
        .catch((e: unknown) => logger.error('stopping operations failed', { message: (e as Error).message }));
      await groups.close().catch(() => undefined);
      graph.close();
      for (const s of streams) s.abort();
      await new Promise((r) => setTimeout(r, 30));
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      try {
        state.recordObservation(project.project_id, { kind: 'system', id: 'daemon' }, 'daemon.stopped', {
          instance_id: instanceId,
          reason,
        });
        db.prepare('UPDATE daemon_instances SET stopped_at = ?, stop_reason = ? WHERE instance_id = ?').run(
          state.clock.now(),
          reason,
          instanceId,
        );
        state.revokeTokens({ token_class: 'operator', project_id: project.project_id }, 'daemon stopped');
        state.revokeTokens({ token_class: 'bootstrap', project_id: project.project_id }, 'daemon stopped');
      } catch (e) {
        logger.error('shutdown bookkeeping failed', { message: (e as Error).message });
      }
      logger.info('daemon stopped', { reason });
      closeDatabase(db);
      for (const f of ['daemon.json', 'operator.token', 'bootstrap.token'])
        rmSync(path.join(privateDir, f), { force: true });
      if (existsSync(pointer)) rmSync(pointer, { force: true });
      rmSync(lockFile, { force: true });
      resolveClosed();
    })();
    return closing;
  }

  return {
    ...ctx,
    url,
    instanceId,
    tokens,
    app: app as unknown as Hono,
    tick,
    brain,
    recovery,
    integration,
    operations,
    close,
    closed,
  };
}
