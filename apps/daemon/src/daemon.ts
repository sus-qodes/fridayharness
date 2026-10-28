import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import type { Clock, IdGenerator } from '@friday/core';
import { closeDatabase, openDatabase } from '@friday/db';
import type { PlannerModel } from '@friday/planner';
import { type Actor, API_VERSION, FridayError, PROTOCOL_VERSIONS } from '@friday/protocol';
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
import { createLogger, type Level, type Logger, silentLogger } from './log.js';
import { runVerification } from './verify.js';

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
}

export interface Daemon extends DaemonContext {
  url: string;
  instanceId: string;
  tokens: { operator: string; bootstrap: string };
  app: Hono;
  tick(): ReturnType<FridayState['tick']>;
  /** The Master Brain, unless it was disabled. */
  brain: BrainHandle | undefined;
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

  const leases = project.config.leases;
  const stateConfig: Partial<StateConfig> = {
    ...(leases.heartbeat_interval_ms ? { heartbeatIntervalMs: leases.heartbeat_interval_ms } : {}),
    ...(leases.lease_ttl_ms ? { leaseTtlMs: leases.lease_ttl_ms } : {}),
    ...(leases.reconnect_window_ms !== undefined ? { reconnectWindowMs: leases.reconnect_window_ms } : {}),
    ...(leases.clean_exit_grace_ms !== undefined ? { cleanExitGraceMs: leases.clean_exit_grace_ms } : {}),
    ...(leases.ack_timeout_ms ? { ackTimeoutMs: leases.ack_timeout_ms } : {}),
    ...(leases.max_delivery_attempts ? { maxDeliveryAttempts: leases.max_delivery_attempts } : {}),
    // Sessions below the project's enforcement requirement cannot take work (review F09).
    enforcementRequired: project.config.security.enforcement_required,
    requireEnforcingHooks: project.config.security.require_enforcing_hooks,
    reservationTtlMs: project.config.master_brain.reservation_ttl_ms,
    allowBroadcast: project.config.communication.allow_broadcast,
    messageReservationMs: project.config.communication.delivery_reservation_ms,
    messageMaxAttempts: project.config.communication.max_delivery_attempts,
    messageTtlMs: project.config.communication.message_ttl_ms,
    blockingReplyMs: project.config.communication.blocking_reply_ms,
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

  const ctx: DaemonContext = {
    state,
    project,
    privateDir,
    logger,
    port: () => port,
    bootstrapToken: () => tokens.bootstrap,
  };

  const brain =
    opts.brain === false
      ? undefined
      : createMasterBrain({
          state,
          project,
          env,
          logger,
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
    verify: (taskId: string, actor: Actor) => (opts.verify ?? runVerification)(ctx, taskId, actor),
    ...(opts.pollIntervalMs ? { pollIntervalMs: opts.pollIntervalMs } : {}),
    ...(brain ? { brain } : {}),
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

  const tick = () => state.tick(project.project_id);
  const tickMs = opts.tickMs ?? 1000;
  const timer =
    tickMs > 0
      ? setInterval(() => {
          try {
            const r = tick();
            if (r.lost.length || r.degraded.length || r.terminated.length || r.declined.length)
              logger.info('lease tick', r);
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

  return { ...ctx, url, instanceId, tokens, app: app as unknown as Hono, tick, brain, close, closed };
}
