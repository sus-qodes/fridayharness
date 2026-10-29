import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import type { Clock, IdGenerator } from '@friday/core';
import { closeDatabase, openDatabase } from '@friday/db';
import { type ExecutionProfile, ProcessGroups } from '@friday/execution';
import { GitRoot, rootKey, worktreesDir } from '@friday/git';
import type { PlannerModel } from '@friday/planner';
import { type Actor, API_VERSION, type ContextPacket, FridayError, PROTOCOL_VERSIONS } from '@friday/protocol';
import { loadGuide, type ModelRecord, type ModelRecordInput, mergeModels, type RoutingSettings } from '@friday/routing';
import {
  type DaemonDiscovery,
  ensurePrivateDir,
  FRIDAY_DIR,
  FRIDAY_VERSION,
  type FridayConfig,
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
import { reloadingConfig } from './config-reload.js';
import { type CompileInput, createContextService } from './context.js';
import { ControlManager } from './control.js';
import { profileCache } from './execution.js';
import { GraphService } from './graph-service.js';
import { IntegrationManager } from './integration.js';
import { LayaService } from './laya.js';
import { createLogger, type Level, type Logger, silentLogger } from './log.js';
import { OperationManager } from './operations.js';
import { type EffectivePolicy, loadEffectivePolicy, reloadingPolicy, writePolicyTrust } from './policy.js';
import { RecoveryManager } from './recovery.js';
import { RoutingService } from './routing.js';
import { createToolJudge, type ToolJudge } from './tool-policy.js';
import { UiAuth } from './ui-auth.js';
import { fileHasher } from './ui-snapshot.js';
import { openUiBundle } from './ui-static.js';
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
  /**
   * Routes mounted after the daemon's own (the Claude Code hooks, the agent launcher). One may return
   * a `close()` that the daemon awaits, bounded, before it drains: its children can still reach it
   * to disconnect (plan M9 §5.9, LESSONS UI-33).
   */
  extensions?: ((app: Hono, ctx: DaemonContext) => void | { close(): Promise<void> })[];
  /** Runs verification checks for `POST /tasks/:id/verify` without a manual result. */
  verify?: (ctx: DaemonContext, taskId: string, actor: Actor) => Promise<unknown>;
  state?: Partial<StateConfig>;
  /**
   * The Master Brain (M2): false leaves it out; `model` replaces the configured provider (tests);
   * `autoStart: false` leaves it idle until `brain.runOnce()`.
   */
  brain?: false | { model?: PlannerModel | null; autoStart?: boolean };
  /** The interface's built bundle (`apps/ui/dist`), served at /ui/ (M9); `friday run` passes it. */
  uiDir?: string;
}

export interface DaemonContext {
  state: FridayState;
  /** The project; its `config` is the configuration in force, read again when config.yaml changes (plan M11.2). */
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

/**
 * The state's settings that follow config.yaml while Friday runs: the state reads each where it
 * uses it, so a reload assigns them in place (plan M11.2). The lease timers are not among them.
 */
function stateSettings(cfg: FridayConfig): Partial<StateConfig> {
  return {
    requireEnforcingHooks: cfg.security.require_enforcing_hooks,
    reservationTtlMs: cfg.master_brain.reservation_ttl_ms,
    // The spending cap per task (plan M11.5), carried by every `task.start` as `budget_usd`.
    taskBudgetUsd: cfg.routing.task_budget_usd ?? null,
    allowBroadcast: cfg.communication.allow_broadcast,
    messageReservationMs: cfg.communication.delivery_reservation_ms,
    messageMaxAttempts: cfg.communication.max_delivery_attempts,
    messageTtlMs: cfg.communication.message_ttl_ms,
    blockingReplyMs: cfg.communication.blocking_reply_ms,
    maxOpenPerRecipient: cfg.communication.max_open_per_recipient,
    fileReservationTtlMs: cfg.reservations.ttl_ms,
  };
}

/**
 * The routing registry a configuration gives: Friday's priors, the project's models and, when the
 * Master Brain plans on this machine, its local model (plan M12.1); throws on a bad record.
 */
function routingRegistry(cfg: FridayConfig): ModelRecord[] {
  return mergeModels(loadGuide().models, cfg.routing.models as ModelRecordInput[], cfg.master_brain);
}

/**
 * Routing copied its settings and registry when it was made (routing.ts); a changed config.yaml
 * brings the one instance every reader holds up to date in place, so the next decision uses it.
 */
function applyRouting(routing: RoutingService, cfg: FridayConfig): void {
  const r = cfg.routing;
  Object.assign(routing.settings, {
    mode: r.mode,
    optimize: r.optimize,
    default_model: r.default_model,
    must_use_local: r.must_use_local,
    prefer_cheaper_if_score_delta_below: r.prefer_cheaper_if_score_delta_below,
    low_confidence: r.low_confidence,
    min_samples: r.min_samples,
    sensitive: r.sensitive,
  } satisfies RoutingSettings);
  routing.models.splice(0, routing.models.length, ...routingRegistry(cfg));
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
  // config.yaml is read again when it changes (`reloadingConfig` below, plan M11.2); the board and
  // `friday status` name the changed keys that still wait for a restart.
  const configFile = path.join(fridayDir, 'config.yaml');
  const configHash = fileHasher(configFile);

  // The project's own policy (ADR-0028): what tracked files tighten applies now, what they loosen
  // only once this clone trusted exactly that.
  let policy = loadEffectivePolicy(project, privateDir);
  // A fixed port from the tracked config applies once this clone trusts it (plan M9 §5.13).
  const listenPort = policy.daemon_port ?? 0;

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
    ...stateSettings(project.config),
    worktreeMode,
    // This clone's worktree folder: a worktree recorded anywhere else is another clone's (review F08).
    worktreeRoot: gitRoot ? path.join(worktreesDir(env), rootKey(gitRoot.root)) : null,
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

  // Read again whenever the policy files change, so what they tighten applies at once (LESSONS D-43).
  let policyReason: string | null = null;
  const policies = reloadingPolicy({
    projectRoot: project.root,
    initial: policy,
    load: () => loadEffectivePolicy(project, privateDir),
    onLoad: (p, why) => {
      policy = p;
      (state.config as { enforcementRequired: StateConfig['enforcementRequired'] }).enforcementRequired =
        p.enforcement_required;
      logger.info('policy reloaded', {
        why: policyReason ?? why,
        version: p.version,
        trusted: p.trusted,
        errors: p.errors.length,
      });
    },
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
  // config.yaml, read again whenever it changes (plan M11.2): `project.config`, which every service
  // holds, becomes the configuration in force, so a key read where it is used applies at the next
  // use; the keys captured at start keep their start values and are named as needing a restart.
  const configs = reloadingConfig({
    file: configFile,
    initial: project.config,
    check: (next) => void routingRegistry(next),
    onApply: (change) => {
      project.config = change.config;
      // The state reads these where it uses them; settings a caller fixed (tests) stay as given.
      const live = stateSettings(change.config);
      for (const k of Object.keys(opts.state ?? {}) as (keyof StateConfig)[]) delete live[k];
      Object.assign(state.config, live);
      applyRouting(routing, change.config);
      // What config.yaml tightens or loosens is part of the policy: read again, under the trust rule.
      policyReason = 'config.yaml changed';
      try {
        policies.reload();
      } finally {
        policyReason = null;
      }
      const detail = { applied: change.applied, restart_needed: change.restart_needed, hash: change.hash };
      logger.info('config.yaml read again', detail);
      try {
        state.recordObservation(project.project_id, { kind: 'system', id: 'daemon' }, 'config.reloaded', detail);
      } catch (e) {
        logger.error('config.reloaded was not recorded', { message: (e as Error).message });
      }
    },
    onError: (error) => logger.error('config.yaml not applied; the settings in force are unchanged', { error }),
  });
  const currentPolicy = () => {
    // The file first: what it changed is part of the policy read next.
    configs.current();
    return policies.current();
  };
  // The ceiling on delegated work (plan M12.2): every plan proposed or approved is bounded by the
  // team scopes of the effective policy as it stands at that moment, so a tightened policy applies
  // to the next plan without a restart.
  state.planBounds = () => ({ teams: currentPolicy().teams });
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
  const profile = () => profileOf(currentPolicy());
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
      // While a human has paused Friday nothing moves a goal branch; the resume sweeps (plan M9 §5.5).
      if (e.type === 'task.completed' && state.q.control(project.project_id).paused) {
        const t = state.q.findTask(project.project_id, taskId);
        if (t && state.awaitsIntegration(t)) return;
      }
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
      // Read where they are used: a change to `recovery` in config.yaml decides the next assessment.
      get maxRetries() {
        return project.config.recovery.max_retries;
      },
      get maxSameErrorRetries() {
        return project.config.recovery.max_same_error_retries;
      },
      reconnectWindowMs: state.config.reconnectWindowMs,
    },
  });
  // Paused at start (Friday stopped while paused): the resume sweeps instead (plan M9 §5.5).
  if (!state.q.control(project.project_id).paused) {
    void integration
      .sweep()
      .catch((err) => logger.warn('integrating completed tasks failed', { message: (err as Error).message }));
  }
  // The per-user state folder (it holds every project's private folder): never gathered into context.
  const context = createContextService({
    state,
    project,
    graph,
    stateDir: path.dirname(path.dirname(privateDir)),
    policy: currentPolicy,
  });
  // One judgment of host tool calls for every host: the hooks and spawn adapters (ADR-0032 §4).
  const judgeTool = createToolJudge({
    state,
    project,
    policy: currentPolicy,
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
    policy: currentPolicy,
    reloadPolicy: () => policies.reload(),
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
  const operations = new OperationManager({ state, project, logger, policy: currentPolicy, profile, env, groups });
  quiesce = (taskId, reason) => operations.stopTask(taskId, reason);
  for (const id of operations.sweep()) logger.warn('operation interrupted at start', { operation_run_id: id });
  // Automatic verification, once this clone trusted it (ADR-0029 §6): a claim is verified at once.
  const verify = (taskId: string, actor: Actor) => {
    // A human's request reads the configured checks before anything consults the policy (verify.ts).
    configs.current();
    return (opts.verify ?? runVerification)(ctx, taskId, actor);
  };
  const AUTO: Actor = { kind: 'system', id: 'auto-verification' };
  const autoVerify = (taskId: string) =>
    verify(taskId, AUTO).catch((e: unknown) =>
      logger.warn('automatic verification did not run', { task_id: taskId, message: (e as Error).message }),
    );
  const autoVerifies = () => currentPolicy().auto_verification && project.config.verification.checks.length > 0;
  const paused = () => state.q.control(project.project_id).paused;
  const stopAutoVerify = state.transport.subscribe(
    { project_id: project.project_id, types: ['task.completion_claimed'] },
    (e) => {
      const taskId = (e.payload as { task_id?: string }).task_id;
      // A claim made while Friday is paused is recorded; its checks run after the resume (plan M9 §5.5).
      if (taskId && autoVerifies() && !paused()) void autoVerify(taskId);
    },
  );
  // A human resumed Friday: what waited for it runs now, as after a restart.
  const stopResumeSweep = state.transport.subscribe(
    { project_id: project.project_id, types: ['control.resumed'] },
    () => {
      void (async () => {
        if (autoVerifies()) {
          for (const t of state.q.tasks(project.project_id, { statuses: ['READY_FOR_VERIFICATION'] })) {
            await autoVerify(t.task_id);
          }
        }
        await integration.sweep();
      })().catch((err) =>
        logger.warn('running what waited for the resume failed', { message: (err as Error).message }),
      );
    },
  );
  if (autoVerifies() && !paused()) {
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
          policy: currentPolicy,
          modelFit: (task, agentId) => routing.fitFor(task, agentId),
          // A task Laya is still asked about waits for the answer, or its deadline (review F11).
          routingReady: (task) => laya.ready(task),
          ...(opts.brain && opts.brain.model !== undefined ? { model: opts.brain.model } : {}),
        });

  let closing: Promise<void> | undefined;
  const uiAuth = new UiAuth(state, project.project_id, () => state.clock.nowMs(), { privateDir });
  const app = buildApp({
    state,
    project,
    logger,
    ui: openUiBundle(opts.uiDir),
    uiAuth,
    control: new ControlManager({ state, project, logger, operations, recovering: (t) => recovery.isBusy(t) }),
    uiInfo: () => {
      configs.current();
      return {
        has_commit: Boolean(head),
        worktrees_mode: worktreeMode,
        config: { loaded_hash: configHash.loaded, current_hash: configHash.current(), changes: configs.changes() },
        auto_verification: autoVerifies(),
        // Whether the project's loosening applies on this clone: the rail's "Policy change not yet
        // trusted" row and the checklist's item rest on it (M9k.8).
        policy_trusted: currentPolicy().trusted,
      };
    },
    instanceId,
    daemonVersion: FRIDAY_VERSION,
    port: () => port,
    trustedOrigins: () => project.config.daemon.trusted_origins,
    isDraining: () => draining,
    requestShutdown: (reason) => {
      setTimeout(() => void close(reason), 50);
    },
    // Rotation revokes every operator-class credential, UI sessions included; forget their records too.
    rotateTokens: () => {
      uiAuth.clear();
      return rotateTokens();
    },
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
    policy: currentPolicy,
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
  const extensionClosers: (() => Promise<void>)[] = [];
  for (const ext of opts.extensions ?? []) {
    const handle = ext(app as unknown as Hono, ctx) as { close(): Promise<void> } | undefined;
    if (handle) extensionClosers.push(() => handle.close());
  }

  if (opts.port === undefined && project.config.daemon.port && !policy.daemon_port) {
    logger.warn(
      'config.yaml fixes daemon.port, which applies once this clone trusts it ("friday policy trust"); using a random port',
      {
        port: project.config.daemon.port,
      },
    );
  }
  const server = await new Promise<Server>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: opts.port ?? listenPort }, (info) => {
      port = info.port;
      resolve(s as Server);
    }) as Server;
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
          // A changed config.yaml applies within a second even while nothing else reads it.
          try {
            configs.current();
          } catch (e) {
            logger.error('reading config.yaml again failed', { message: (e as Error).message });
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
              r.messages_replied.length ||
              r.budget_stopped.length
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
      // Extensions first, while requests are still answered (their children disconnect over RPC).
      if (extensionClosers.length) {
        const all = Promise.allSettled(extensionClosers.map((close) => close()));
        const bound = new Promise((r) => setTimeout(r, 15_000).unref());
        await Promise.race([all, bound]);
      }
      draining = true;
      // Stop the Master Brain first: it aborts a model call in flight and finishes its current step.
      if (brain) await brain.brain.stop().catch(() => undefined);
      if (timer) clearInterval(timer);
      clearInterval(sweep);
      stopWorkspaces();
      stopAutoVerify();
      stopResumeSweep();
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
        uiAuth.clear();
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
