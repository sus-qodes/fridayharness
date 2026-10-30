import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { blastRadius, lookupSymbol, skeletonOf } from '@friday/code-graph';
import { patternsOverlap } from '@friday/policy';
import {
  type Actor,
  API_VERSION,
  type ErrorBody,
  FridayError,
  HumanMessageRequest,
  isFridayError,
  PROTOCOL_VERSIONS,
  TaskActionRequest,
  TaskCreateRequest,
  TaskRoleAssignRequest,
  TaskSplitRequest,
  type TaskStatus,
  TaskStatus as TaskStatusEnum,
  type TokenClass,
  VerifyRequest,
} from '@friday/protocol';
import { FRIDAY_DIR, FRIDAY_VERSION, type ProjectRef } from '@friday/sdk';
import {
  backupTo,
  createSnapshot,
  type FridayState,
  listSnapshots,
  type MemoryActor,
  type MemoryInput,
  type MemoryKind,
  replayInto,
} from '@friday/state';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { ZodError, z } from 'zod';
import { backupCode } from './backup-code.js';
import type { BrainHandle } from './brain.js';
import { escalationView, mountBrainRoutes } from './brain-routes.js';
import type { CompileInput, ContextService } from './context.js';
import type { ControlManager } from './control.js';
import { countMatches, listFiles } from './files.js';
import { type GraphService, query as graphQuery, summary as graphSummary } from './graph-service.js';
import type { IntegrationManager } from './integration.js';
import type { Logger } from './log.js';
import type { OperationManager } from './operations.js';
import type { EffectivePolicy } from './policy.js';
import type { RecoveryManager } from './recovery.js';
import type { RoutingService } from './routing.js';
import { type AuthInfo, callerFor, dispatchRpc } from './rpc.js';
import { goalDiff, taskDiff } from './task-diff.js';
import type { ToolJudge } from './tool-policy.js';
import { statusPageHtml } from './ui.js';
import type { UiAuth } from './ui-auth.js';
import { UI_PREFS_MAX_BYTES, UiPrefs } from './ui-prefs.js';
import { buildUiSnapshot, toolCallTally, type UiSnapshotInfo } from './ui-snapshot.js';
import { mountUiStatic, type UiBundle, uiPath } from './ui-static.js';
import type { WorkspaceManager } from './workspaces.js';

export interface AppDeps {
  state: FridayState;
  project: ProjectRef;
  logger: Logger;
  instanceId: string;
  daemonVersion: string;
  /** Filled in once the server is listening (used by the Host / Origin checks). */
  port: () => number;
  trustedOrigins: () => string[];
  isDraining: () => boolean;
  requestShutdown: (reason: string) => void;
  rotateTokens: () => { operator: string; bootstrap: string };
  /** Long-lived streams register here so shutdown can close them. */
  streams: Set<AbortController>;
  /** Runs the configured verification checks (wired by the daemon; M1c). */
  verify?: (taskId: string, actor: Actor) => Promise<unknown>;
  pollIntervalMs?: number;
  /** The Master Brain (M2); goals and plans are served even without one. */
  brain?: BrainHandle;
  /** The code graph of the execution root (M4b). */
  graph?: GraphService;
  /** The context compiler (M4d). */
  context: ContextService;
  /** Task worktrees (M5a). */
  workspaces?: WorkspaceManager;
  /** Integration into goal branches (M5c). */
  integration?: IntegrationManager;
  /** Recovery of lost and failed attempts (M5d). */
  recovery?: RecoveryManager;
  /** The per-user state folder, for Friday's protected paths. */
  stateDir?: string;
  /** The project's effective policy and its reload (ADR-0028). */
  policy?: () => EffectivePolicy;
  reloadPolicy?: () => EffectivePolicy;
  /** Records this clone's trust in exactly the loosening with this hash, then reloads. */
  trustPolicy?: (looseningHash: string) => EffectivePolicy;
  /** The execution gateway (M6c, ADR-0029). */
  operations?: OperationManager;
  /** Model routing (M7, ADR-0031). */
  routing?: RoutingService;
  /** Judges a host's tool call the way the hooks do (ADR-0032 §4). */
  judgeTool?: ToolJudge;
  /** The interface's built bundle, served at /ui/ (M9); without it /ui is the legacy status page. */
  ui?: UiBundle;
  /** Browser sign-in by one-time link (M9). */
  uiAuth?: UiAuth;
  /** Halt: stop every running attempt, its work preserved (M9). */
  control?: ControlManager;
  /** What the board snapshot says about the daemon itself (M9). */
  uiInfo?: () => UiSnapshotInfo;
}

type Env = { Variables: { auth: AuthInfo } };
export type AppEnv = Env;

const OPERATOR: TokenClass[] = ['operator'];
/** Routes a UI session may not call (plan M9 §5.2). */
const UI_SESSION_REFUSED = /^\/admin\/|^\/protocol\/|\/harness-sessions\/bind$|\/ui\/login-codes$/;
const HUMAN: Actor = { kind: 'human', id: 'local-operator' };

function errorResponse(c: Context, err: FridayError) {
  return c.json(err.toBody() as ErrorBody, err.http as 400);
}

/** Builds the daemon's HTTP application (plan M1.5, Appendix 8). */
export function buildApp(deps: AppDeps): Hono<Env> {
  const { state, project, logger } = deps;
  const pid = project.project_id;
  const app = new Hono<Env>();
  const compile = (input: CompileInput, actor: Actor) => deps.context.compile(input, actor);

  // ---- middleware --------------------------------------------------------------------------

  // Host and Origin policy (plan B22): blocks DNS rebinding and cross-site requests, allows the status page.
  app.use('*', async (c, next) => {
    const host = c.req.header('host');
    if (host !== `127.0.0.1:${deps.port()}`) {
      return errorResponse(c, new FridayError('permission_denied', `unexpected Host header ${host ?? '(none)'}`));
    }
    const origin = c.req.header('origin');
    if (origin) {
      const trusted = [`http://127.0.0.1:${deps.port()}`, ...deps.trustedOrigins()];
      if (!trusted.includes(origin)) {
        return errorResponse(c, new FridayError('permission_denied', `origin ${origin} is not trusted`));
      }
      if (origin !== `http://127.0.0.1:${deps.port()}`) {
        c.header('access-control-allow-origin', origin);
        c.header('vary', 'Origin');
        if (c.req.method === 'OPTIONS') {
          c.header('access-control-allow-headers', 'authorization, content-type, idempotency-key');
          c.header('access-control-allow-methods', 'GET, POST');
          return c.body(null, 204);
        }
      }
    }
    return next();
  });

  app.use(
    '*',
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) => errorResponse(c, new FridayError('payload_too_large', 'request body exceeds 1 MB')),
    }),
  );

  // The interface's bundle (or the legacy status page): public files, the data behind them needs a token.
  mountUiStatic(app, deps.ui, () => statusPageHtml(pid, project.name));
  app.get('/', (c) => c.redirect('/ui'));

  // Exchanging a one-time sign-in code for a UI session (plan M9 §5.1): public, but only from the
  // daemon's own origin (never `trusted_origins`) and only as JSON, so no other page can do it.
  app.post('/ui/session', async (c) => {
    if (!deps.uiAuth) throw new FridayError('capability_unsupported', 'browser sign-in is not available here');
    if (deps.isDraining()) throw new FridayError('daemon_shutting_down', 'the daemon is shutting down');
    if (c.req.header('origin') !== `http://127.0.0.1:${deps.port()}`) {
      throw new FridayError('permission_denied', 'sign in from the page Friday opened');
    }
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      throw new FridayError('invalid_request', 'the sign-in request must be JSON');
    }
    const body = await json(c);
    c.header('cache-control', 'no-store');
    return c.json(deps.uiAuth.session(body.code));
  });

  app.use('*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!raw) return errorResponse(c, new FridayError('authentication_failed', 'missing bearer token'));
    const status = state.tokenStatus(raw);
    if (status.status === 'revoked')
      return errorResponse(c, new FridayError('token_revoked', 'this token was revoked'));
    if (status.status !== 'valid') return errorResponse(c, new FridayError('authentication_failed', 'unknown token'));
    if (status.info.project_id !== pid)
      return errorResponse(c, new FridayError('permission_denied', 'token belongs to another project'));
    // A UI session past its age limit is revoked here, on the request that finds it (plan M9 §5.1).
    if (deps.uiAuth?.expire(status.info.credential_id)) {
      return errorResponse(c, new FridayError('token_revoked', 'the interface session ended; open Friday again'));
    }
    // A UI session is for the interface's own routes: no admin, no protocol, no session binding
    // (plan M9 §5.2). The CLI and the desktop shell use the operator token itself.
    if (deps.uiAuth?.isSession(status.info.credential_id) && UI_SESSION_REFUSED.test(c.req.path)) {
      return errorResponse(
        c,
        new FridayError('token_scope_insufficient', 'an interface session cannot use this route; use the CLI'),
      );
    }
    c.set('auth', {
      token_class: status.info.token_class,
      harness_id: status.info.harness_id,
      credential_id: status.info.credential_id,
    });
    await next();
    // Nothing the API answers is kept in a browser's cache (plan M9 §5.2, FD-30).
    if (c.req.path.startsWith('/api/')) c.res.headers.set('cache-control', 'no-store');
  });

  app.use('*', async (c, next) => {
    if (deps.isDraining() && c.req.path !== '/health') {
      c.header('retry-after', '2');
      return errorResponse(c, new FridayError('daemon_shutting_down', 'the daemon is shutting down'));
    }
    return next();
  });

  const allow =
    (...classes: TokenClass[]): MiddlewareHandler<Env> =>
    async (c, next) => {
      if (!classes.includes(c.get('auth').token_class)) {
        return errorResponse(
          c,
          new FridayError('token_scope_insufficient', `this endpoint needs a ${classes.join(' or ')} token`),
        );
      }
      return next();
    };

  app.use('/api/v1/projects/:pid/*', async (c, next) => {
    if (c.req.param('pid') !== pid) return errorResponse(c, new FridayError('project_not_found', 'unknown project'));
    return next();
  });
  app.use('/api/v1/projects/:pid', async (c, next) => {
    if (c.req.param('pid') !== pid) return errorResponse(c, new FridayError('project_not_found', 'unknown project'));
    return next();
  });

  const json = async (c: Context): Promise<Record<string, unknown>> => {
    const text = await c.req.text();
    if (!text) return {};
    try {
      const v = JSON.parse(text);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // fall through
    }
    throw new FridayError('invalid_request', 'body must be a JSON object');
  };

  // ---- health, project, status -------------------------------------------------------------

  app.get('/health', (c) =>
    c.json({
      status: deps.isDraining() ? 'draining' : 'ok',
      instance_id: deps.instanceId,
      project_id: pid,
      daemon_version: deps.daemonVersion,
      api_version: API_VERSION,
      protocol_versions: [...PROTOCOL_VERSIONS],
    }),
  );

  const P = '/api/v1/projects/:pid';
  app.get('/api/v1/projects', allow(...OPERATOR), (c) => c.json({ projects: [projectInfo()] }));
  app.get(P, allow(...OPERATOR), (c) => c.json(projectInfo()));

  // ---- browser sign-in (plan M9 §5.1) --------------------------------------------------------

  // Minting needs the operator token itself: a UI session cannot create more sessions.
  app.post(`${P}/ui/login-codes`, allow(...OPERATOR), (c) => {
    if (!deps.uiAuth) throw new FridayError('capability_unsupported', 'browser sign-in is not available here');
    if (deps.uiAuth.isSession(c.get('auth').credential_id)) {
      throw new FridayError('permission_denied', 'an interface session cannot mint sign-in links');
    }
    c.header('cache-control', 'no-store');
    return c.json(deps.uiAuth.loginCode(deps.port(), deps.ui ? uiPath(deps.ui) : '/ui/'), 201);
  });
  app.post(`${P}/ui/logout`, allow(...OPERATOR), (c) => {
    const credential = c.get('auth').credential_id;
    if (!deps.uiAuth?.isSession(credential)) {
      throw new FridayError('permission_denied', 'only an interface session can log out');
    }
    deps.uiAuth.end(credential, 'logged out');
    return c.json({ ok: true });
  });

  // ---- the interface's views and controls (plan M9 §5.2–§5.4) ------------------------------

  // This daemon's running count of each task's tool calls: each read counts only the new events.
  const toolCalls = toolCallTally();
  app.get(`${P}/ui/snapshot`, allow(...OPERATOR), (c) => {
    c.header('cache-control', 'no-store');
    return c.json(
      buildUiSnapshot({
        state,
        project,
        port: deps.port(),
        daemonVersion: deps.daemonVersion,
        brain: deps.brain,
        info: deps.uiInfo?.(),
        toolCalls,
        nowMs: state.clock.nowMs(),
      }),
    );
  });
  // The interface's preferences, per project: a browser's own storage belongs to an origin, which
  // changes with the port at every start (docs/frontend/PLAN.md §6 rule 8).
  const uiPrefs = deps.stateDir ? UiPrefs.forProject(project, deps.stateDir, state) : undefined;
  const prefsStore = (): UiPrefs => {
    if (!uiPrefs) throw new FridayError('capability_unsupported', 'this daemon keeps no interface preferences');
    return uiPrefs;
  };
  app.get(`${P}/ui/prefs`, allow(...OPERATOR), (c) => c.json({ prefs: prefsStore().read() }));
  app.post(
    `${P}/ui/prefs`,
    allow(...OPERATOR),
    bodyLimit({
      maxSize: UI_PREFS_MAX_BYTES,
      onError: (c) => errorResponse(c, new FridayError('payload_too_large', 'the preferences exceed 64 KB')),
    }),
    async (c) => {
      prefsStore().write((await json(c)).prefs);
      return c.json({ ok: true });
    },
  );
  const diffOpts = (c: Context) => ({
    stat: c.req.query('stat') === '1' || c.req.query('stat') === 'true',
    ...(deps.stateDir ? { stateDir: deps.stateDir } : {}),
  });
  app.get(`${P}/tasks/:tid/diff`, allow(...OPERATOR), async (c) =>
    c.json(await taskDiff(state, project, c.req.param('tid'), diffOpts(c))),
  );
  app.get(`${P}/goals/:gid/diff`, allow(...OPERATOR), async (c) =>
    c.json(await goalDiff(state, project, c.req.param('gid'), diffOpts(c))),
  );
  // The scope picker's view of the repository (plan M9 §5.11): tracked files only, capped.
  app.get(`${P}/files`, allow(...OPERATOR), async (c) =>
    c.json(await listFiles(project.root, c.req.query('dir') ?? '')),
  );
  app.post(`${P}/files/match`, allow(...OPERATOR), async (c) => {
    const body = z.object({ globs: z.array(z.string().trim().min(1).max(300)).max(50) }).parse(await json(c));
    return c.json(await countMatches(project.root, body.globs));
  });
  const ControlBody = z.object({ reason: z.string().trim().min(1).max(500).optional() });
  app.post(`${P}/control/pause`, allow(...OPERATOR), async (c) => {
    const body = ControlBody.parse(await json(c));
    if (!deps.control)
      return c.json({ control: state.pauseProject(pid, HUMAN, body.reason ?? null), tasks: [], operations_stopped: 0 });
    return c.json(await deps.control.pause(HUMAN, body.reason ?? null));
  });
  app.post(`${P}/control/resume`, allow(...OPERATOR), (c) =>
    c.json(
      deps.control
        ? deps.control.resume(HUMAN)
        : { control: state.resumeProject(pid, HUMAN), tasks: [], operations_stopped: 0 },
    ),
  );
  app.post(`${P}/control/halt`, allow(...OPERATOR), async (c) => {
    const body = ControlBody.parse(await json(c));
    if (!deps.control) throw new FridayError('capability_unsupported', 'halt is not available in this daemon');
    return c.json(await deps.control.halt(HUMAN, body.reason ?? null));
  });
  function projectInfo() {
    return {
      project_id: pid,
      name: project.name,
      root: project.root,
      head: state.store.head(pid),
      counts: state.q.statusCounts(pid),
    };
  }

  app.get(`${P}/status`, allow(...OPERATOR), (c) => {
    const agents = state.q.agents(pid);
    const keyOf = new Map(agents.map((a) => [a.agent_id, a.agent_key]));
    const tasks = state.q.tasks(pid, { limit: 200 }).map((t) => ({
      task_id: t.task_id,
      status: t.status,
      waiting_reason: t.waiting_reason,
      summary: t.summary,
      reserved_for_agent_key: t.reserved_for_agent_key,
      agent_key: t.assigned_agent_id ? (keyOf.get(t.assigned_agent_id) ?? null) : null,
      updated_at: t.updated_at,
    }));
    const head = state.store.head(pid);
    return c.json({
      project: { project_id: pid, name: project.name },
      head,
      counts: state.q.statusCounts(pid),
      // What the daemon did with a changed config.yaml (plan M11.2), so `friday status` need not
      // build the board's snapshot for it.
      config: deps.uiInfo?.().config ?? null,
      tasks,
      harnesses: state.q.harnesses(pid),
      agents,
      approvals: state.q.approvals(pid, 'pending'),
      escalations: state.q.escalations(pid, 'pending').map(escalationView),
      goals: state.q.goals(pid, { statuses: ['OPEN', 'ACTIVE'] }),
      events: state.store.readSince(pid, Math.max(0, head - 25), { limit: 25 }).reverse(),
    });
  });

  // ---- goals, plans, the Master Brain (M2) ---------------------------------------------------

  mountBrainRoutes({ app, allow, json, state, project, brain: deps.brain, human: HUMAN });

  // ---- tasks ---------------------------------------------------------------------------------

  app.get(`${P}/tasks`, allow(...OPERATOR), (c) => {
    const statuses = c.req.queries('status')?.flatMap((s) => s.split(',')) ?? [];
    for (const s of statuses)
      if (!TaskStatusEnum.safeParse(s).success) throw new FridayError('invalid_request', `unknown status ${s}`);
    const limit = Number(c.req.query('limit') ?? 200);
    return c.json({ tasks: state.q.tasks(pid, { statuses: statuses as TaskStatus[], limit }) });
  });

  app.post(`${P}/tasks`, allow(...OPERATOR), async (c) => {
    const body = await json(c);
    const key = c.req.header('idempotency-key');
    const task = state.createTask(pid, HUMAN, TaskCreateRequest.parse(body), key ? { idempotency_key: key } : {});
    return c.json(task, 201);
  });

  /** Everything an attached session needs about itself (harness tokens only). */
  app.get(`${P}/me`, allow('harness'), (c) => {
    const harnessId = c.get('auth').harness_id as string;
    const harness = state.q.harness(harnessId);
    const caller = callerFor(state, pid, harnessId);
    const agent = state.q.agent(caller.agent_id);
    const held = state.q
      .tasks(pid, { statuses: ['ASSIGNED', 'RUNNING', 'WAITING', 'HARNESS_LOST', 'READY_FOR_VERIFICATION'] })
      .filter((t) => t.assigned_agent_id === agent.agent_id);
    const current =
      held.find((t) => t.task_id === agent.current_task_id) ??
      held.find((t) => t.status !== 'READY_FOR_VERIFICATION') ??
      null;
    const run = current?.current_run_id ? (state.q.findRun(current.current_run_id) ?? null) : null;
    // A peek: nothing is reserved and no delivery attempt is counted (ADR-0017 §6).
    const inbox = state.inbox(pid, caller, { max: 20, peek: true }).items;
    return c.json({
      project: { project_id: pid, name: project.name },
      harness: { ...harness, shadow: harness.shadow },
      // Why this session may not take work under the project's security settings (review F09).
      enforcement_gap: state.enforcementGap(harness),
      agent,
      current_task: current,
      current_run: run && run.harness_id === harnessId ? run : run,
      run_is_mine: Boolean(run && run.harness_id === harnessId && run.status === 'ACTIVE'),
      awaiting_verification: held.filter((t) => t.status === 'READY_FOR_VERIFICATION').map((t) => t.task_id),
      claimable: state.claimableTasks(pid, agent.agent_key, 10).filter((t) => t.status === 'READY'),
      inbox,
      // What this daemon can answer, so a server lists only the tools that work here (ADR-0038 §2).
      capabilities: { graph: Boolean(deps.graph), artifacts: Boolean(state.artifacts) },
    });
  });

  /**
   * Who else works with this session (plan M12.4): the agents on its task's goal and the task each
   * holds, or, while it holds no task of a goal, the project's agents. One bounded read, so an agent
   * learns who its peers are from Friday's records instead of asking the human or sending a message.
   * Never a token or a harness id; a peer's word grants nothing (ADR-0017).
   */
  app.get(`${P}/me/peers`, allow('harness'), (c) => {
    const caller = callerFor(state, pid, c.get('auth').harness_id as string);
    const me = state.q.agent(caller.agent_id);
    const current = me.current_task_id ? state.q.findTask(pid, me.current_task_id) : undefined;
    const taskOf = (t: { task_id: string; summary: string; status: string; waiting_reason: string | null }) => ({
      task_id: t.task_id,
      summary: t.summary,
      status: t.status,
      waiting_reason: t.waiting_reason,
    });
    if (current?.goal_id) {
      const ended = new Set(['COMPLETED', 'CANCELLED', 'ABANDONED']);
      const peers: Record<string, unknown>[] = [];
      const unassigned: Record<string, unknown>[] = [];
      for (const t of state.q.goalTasks(pid, current.goal_id)) {
        if (ended.has(t.status) || t.assigned_agent_id === me.agent_id) continue;
        const agent = t.assigned_agent_id ? state.q.findAgent(t.assigned_agent_id) : undefined;
        if (!agent) {
          unassigned.push({ ...taskOf(t), role: t.role, reserved_for_agent_key: t.reserved_for_agent_key });
          continue;
        }
        peers.push({ agent_key: agent.agent_key, role: agent.role, status: agent.status, task: taskOf(t) });
      }
      return c.json({ scope: 'goal', goal_id: current.goal_id, peers, unassigned });
    }
    const peers = state.q
      .agents(pid)
      .filter((a) => a.agent_id !== me.agent_id)
      .map((a) => {
        const held = a.current_task_id ? state.q.findTask(pid, a.current_task_id) : undefined;
        return { agent_key: a.agent_key, role: a.role, status: a.status, task: held ? taskOf(held) : null };
      });
    return c.json({ scope: 'project', goal_id: null, peers, unassigned: [] });
  });

  /**
   * What the project and this session's goal are for (ADR-0034 §5): the approved project intent and
   * the intent of the goal its current task serves. Read-only; a proposal waiting for a human is
   * never shown to an agent.
   */
  app.get(`${P}/me/intent`, allow('harness'), (c) => {
    const caller = callerFor(state, pid, c.get('auth').harness_id as string);
    const me = state.q.agent(caller.agent_id);
    const current = me.current_task_id ? state.q.findTask(pid, me.current_task_id) : undefined;
    const goal = current?.goal_id ? state.q.findGoal(pid, current.goal_id) : undefined;
    return c.json({
      project: state.q.approvedProjectIntent(pid) ?? null,
      goal: goal
        ? {
            goal_id: goal.goal_id,
            objective: goal.objective ?? goal.request,
            intent_revision: goal.intent_revision,
            constraints: goal.constraints,
            outcomes: goal.outcomes,
            non_goals: goal.non_goals,
            definition_of_done: goal.definition_of_done,
            inferred_constraints: goal.inferred_constraints,
            inferred_outcomes: goal.inferred_outcomes,
            inferred_non_goals: goal.inferred_non_goals,
            inferred_definition_of_done: goal.inferred_definition_of_done,
          }
        : null,
    });
  });

  /**
   * The receipt of a message this session's agent sent (plan M12.4): whether each recipient has
   * it, read it or answered, so the sender need not send it again or ask the human. Only the
   * sender reads it; a receipt, like the message, grants nothing.
   */
  app.get(`${P}/me/messages/:mid`, allow('harness'), (c) => {
    const caller = callerFor(state, pid, c.get('auth').harness_id as string);
    const m = state.q.message(c.req.param('mid'));
    if (m.sender.kind !== 'agent' || m.sender.id !== caller.agent_id) {
      throw new FridayError('permission_denied', `message ${m.message_id} was not sent by you`);
    }
    return c.json({
      message_id: m.message_id,
      mode: m.mode,
      subject: m.subject,
      status: m.status,
      settled_reason: m.settled_reason,
      created_at: m.created_at,
      reply_by: m.reply_by,
      expires_at: m.expires_at,
      deliveries: m.deliveries.map((d) => ({
        recipient: d.agent_key ?? `${d.recipient_kind}:${d.recipient_id}`,
        state: d.state,
        attempts: d.attempts,
        delivered_at: d.delivered_at,
        acknowledged_at: d.acknowledged_at,
        ended_at: d.ended_at,
        end_reason: d.end_reason,
      })),
    });
  });

  // The newest packet the task's agent was given, for `friday context explain <task>` (LESSONS D-49).
  app.get(`${P}/tasks/:tid/delivered-context`, allow(...OPERATOR), (c) => {
    const task = state.q.task(pid, c.req.param('tid'));
    const runs = state.q.runs(task.task_id);
    const agentId = task.assigned_agent_id ?? runs.at(-1)?.agent_id ?? null;
    const contextId = agentId ? (state.q.deliveredPacketId(pid, task.task_id, agentId) ?? null) : null;
    const agent = agentId ? state.q.findAgent(agentId) : undefined;
    return c.json({ context_id: contextId, agent_id: agentId, agent_key: agent?.agent_key ?? null });
  });

  app.get(`${P}/tasks/:tid`, allow('operator', 'harness'), (c) => {
    const task = state.q.task(pid, c.req.param('tid'));
    const auth = c.get('auth');
    if (auth.token_class === 'harness' && auth.harness_id) {
      const caller = callerFor(state, pid, auth.harness_id);
      const agent = state.q.agent(caller.agent_id);
      const visible =
        task.assigned_agent_id === caller.agent_id ||
        (task.status === 'READY' && (!task.reserved_for_agent_key || task.reserved_for_agent_key === agent.agent_key));
      if (!visible) throw new FridayError('permission_denied', `task ${task.task_id} is not assigned to you`);
    }
    return c.json({
      task,
      runs: state.q.runs(task.task_id),
      verification: state.q.latestVerification(task.task_id) ?? null,
      open_dependencies: state.q.openDependencies(task.task_id),
    });
  });

  // A task's history: oldest first by default; `order=desc` with `before` pages back from the newest
  // (plan M9 §5.11), since a busy task has more events than one page.
  app.get(`${P}/tasks/:tid/events`, allow(...OPERATOR), (c) => {
    const tid = c.req.param('tid');
    state.q.task(pid, tid);
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 500) || 500, 1), 500);
    const before = c.req.query('before');
    const desc = c.req.query('order') === 'desc';
    return c.json({
      events: state.store.readByRef(pid, 'task', tid, {
        limit,
        desc,
        ...(before !== undefined && Number.isFinite(Number(before)) ? { before: Number(before) } : {}),
      }),
    });
  });
  app.post(`${P}/tasks/:tid/continue`, allow(...OPERATOR), async (c) => {
    const body = z.object({ note: z.string().trim().min(1).max(2000).optional() }).parse(await json(c));
    return c.json(state.continueTask(pid, HUMAN, c.req.param('tid'), body.note ?? null));
  });

  const action = (name: 'ready' | 'release' | 'cancel' | 'rework' | 'assign' | 'unreserve') =>
    app.post(`${P}/tasks/:tid/${name}`, allow(...OPERATOR), async (c) => {
      const tid = c.req.param('tid');
      const body = TaskActionRequest.parse(await json(c));
      const reason = body.reason ?? `${name} by operator`;
      switch (name) {
        case 'ready':
          return c.json({ task: state.readyTask(pid, HUMAN, tid) });
        case 'release':
          return c.json({ task: state.releaseTask(pid, HUMAN, tid, reason) });
        case 'cancel':
          return c.json({ task: state.cancelTask(pid, HUMAN, tid, reason) });
        case 'rework':
          return c.json({ task: state.reworkTask(pid, HUMAN, tid, reason) });
        case 'unreserve':
          return c.json({ task: state.unreserveTask(pid, HUMAN, tid, reason) });
        case 'assign': {
          if (!body.agent_key) throw new FridayError('invalid_request', 'agent_key is required');
          return c.json(state.assignTask(pid, HUMAN, tid, body.agent_key));
        }
      }
    });
  for (const a of ['ready', 'release', 'cancel', 'rework', 'assign', 'unreserve'] as const) action(a);

  app.post(`${P}/tasks/:tid/role`, allow(...OPERATOR), async (c) => {
    const body = TaskRoleAssignRequest.parse(await json(c));
    return c.json({ task: state.assignTaskRole(pid, HUMAN, c.req.param('tid'), body.role) });
  });
  // A human approves a multi-role proposal by splitting the task into one task per role (ADR-0035 §5).
  app.post(`${P}/tasks/:tid/split`, allow(...OPERATOR), async (c) => {
    const body = TaskSplitRequest.parse(await json(c));
    return c.json(state.splitTask(pid, HUMAN, c.req.param('tid'), body.note ?? null));
  });

  app.post(`${P}/tasks/:tid/verify`, allow(...OPERATOR), async (c) => {
    const tid = c.req.param('tid');
    const body = VerifyRequest.parse(await json(c));
    if (body.result) {
      // Manual override: a human records the outcome.
      let task = state.q.task(pid, tid);
      const { verification_id } = state.startVerification(pid, HUMAN, tid);
      state.recordVerificationCheck(pid, HUMAN, verification_id, {
        name: 'manual',
        kind: 'manual',
        status: body.result === 'passed' ? 'PASSED' : 'FAILED',
        exit_code: null,
        artifact_ref: null,
        summary: body.note ?? `recorded by operator as ${body.result}`,
      });
      task = state.finishVerification(
        pid,
        HUMAN,
        verification_id,
        body.result === 'passed',
        body.note ?? `manual: ${body.result}`,
      );
      return c.json({ task, verification: state.q.verification(verification_id) });
    }
    if (!deps.verify) throw new FridayError('verification_unavailable', 'no verification runner is configured');
    return c.json(await deps.verify(tid, HUMAN));
  });

  // ---- harnesses, agents, approvals, escalations ---------------------------------------------

  app.get(`${P}/harnesses`, allow(...OPERATOR), (c) =>
    c.json({ harnesses: state.q.harnesses(pid, { all: c.req.query('all') === 'true' }) }),
  );
  app.get(`${P}/harnesses/:hid`, allow(...OPERATOR), (c) => c.json(state.q.harness(c.req.param('hid'))));
  app.get(`${P}/agents`, allow(...OPERATOR), (c) => c.json({ agents: state.q.agents(pid) }));

  app.post(`${P}/harness-sessions/bind`, allow('operator', 'bootstrap'), async (c) => {
    const body = await json(c);
    const vendor = String(body.vendor ?? '');
    const sid = String(body.host_session_id ?? '');
    const hid = String(body.harness_id ?? '');
    if (!vendor || !sid || !hid)
      throw new FridayError('invalid_request', 'vendor, host_session_id and harness_id are required');
    state.bindSession(pid, vendor, sid, hid, typeof body.transcript_path === 'string' ? body.transcript_path : null);
    return c.json({ ok: true });
  });

  app.get(`${P}/approvals`, allow(...OPERATOR), (c) =>
    c.json({ approvals: state.q.approvals(pid, c.req.query('status')) }),
  );
  for (const [verb, granted] of [
    ['approve', true],
    ['reject', false],
  ] as const) {
    app.post(`${P}/approvals/:aid/${verb}`, allow(...OPERATOR), async (c) => {
      const body = z
        .object({
          reuse: z.enum(['once', 'run', 'task']).optional(),
          ttl_s: z
            .number()
            .int()
            .min(10)
            .max(7 * 24 * 3600)
            .optional(),
          note: z.string().max(500).optional(),
          via: z.enum(['cli', 'ui']).optional(),
        })
        .parse(await c.req.json().catch(() => ({})));
      state.decideApproval(pid, HUMAN, c.req.param('aid'), granted, {
        ...(body.reuse ? { reuse: body.reuse } : {}),
        ...(body.ttl_s ? { ttl_s: body.ttl_s } : {}),
        ...(body.note ? { note: body.note } : {}),
        via: body.via ?? 'cli',
      });
      return c.json({ ok: true, approval_id: c.req.param('aid'), status: granted ? 'granted' : 'denied' });
    });
  }
  app.post(`${P}/approvals/:aid/revoke`, allow(...OPERATOR), async (c) => {
    const body = z.object({ note: z.string().max(500).optional() }).parse(await c.req.json().catch(() => ({})));
    state.revokeApproval(pid, HUMAN, c.req.param('aid'), body.note ?? 'revoked by a human');
    return c.json({ ok: true, approval_id: c.req.param('aid'), status: 'revoked' });
  });
  app.get(`${P}/escalations`, allow(...OPERATOR), (c) =>
    c.json({ escalations: state.q.escalations(pid, c.req.query('status')).map(escalationView) }),
  );
  app.post(`${P}/escalations/:eid/answer`, allow(...OPERATOR), async (c) => {
    const body = await json(c);
    if (typeof body.answer !== 'string' || !body.answer) throw new FridayError('invalid_request', 'answer is required');
    state.answerEscalation(pid, HUMAN, c.req.param('eid'), body.answer);
    return c.json({ ok: true });
  });

  // ---- messages (M3, ADR-0017) -----------------------------------------------------------------

  app.get(`${P}/messages`, allow(...OPERATOR), (c) => {
    const agentKey = c.req.query('agent');
    const agent = agentKey ? state.q.agentByKey(pid, agentKey) : undefined;
    if (agentKey && !agent) throw new FridayError('agent_not_found', `no agent "${agentKey}"`);
    const to = c.req.query('to');
    return c.json({
      messages: state.q.messages(pid, {
        ...(c.req.query('task') ? { taskId: c.req.query('task') as string } : {}),
        ...(agent ? { agentId: agent.agent_id } : {}),
        ...(c.req.query('status') ? { status: c.req.query('status') as string } : {}),
        ...(to === 'human' || to === 'master_brain' ? { to } : {}),
        limit: Math.min(500, Number(c.req.query('limit') ?? 100) || 100),
      }),
    });
  });
  app.get(`${P}/messages/:mid`, allow(...OPERATOR), (c) => c.json(state.q.message(c.req.param('mid'))));
  /** A human sends a message (`friday say`); with `reply_to` it answers that message. */
  app.post(`${P}/messages`, allow(...OPERATOR), async (c) => {
    const body = HumanMessageRequest.parse(await json(c));
    const key = c.req.header('idempotency-key');
    const res = state.sendMessage(
      pid,
      { kind: 'human', actor: HUMAN },
      {
        to: body.to,
        mode: body.reply_to ? 'response' : 'notification',
        content: body.content,
        ...(body.subject ? { subject: body.subject } : {}),
        ...(body.reply_to ? { response_to: body.reply_to } : {}),
        priority: body.priority,
      },
      key ? { idempotency_key: key } : {},
    );
    return c.json(res, 201);
  });
  /** What waits for humans or the Master Brain, or (peek) for one agent. */
  app.get(`${P}/inbox/:who`, allow(...OPERATOR), (c) => {
    const who = c.req.param('who');
    if (who === 'human' || who === 'master') {
      const kind = who === 'human' ? 'human' : 'master_brain';
      return c.json({ items: state.q.openDeliveriesFor(pid, kind).map((d) => state.inboxItem(pid, d, null)) });
    }
    const agent = state.q.agentByKey(pid, who);
    if (!agent) throw new FridayError('agent_not_found', `no agent "${who}"`);
    return c.json({ items: state.peekInbox(pid, agent.agent_id, 50).items });
  });
  /** A human acknowledges messages addressed to humans. */
  app.post(`${P}/inbox/human/ack`, allow(...OPERATOR), async (c) => {
    const body = await json(c);
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : [];
    if (!ids.length) throw new FridayError('invalid_request', 'ids is required');
    return c.json({ acknowledged: state.acknowledgeAs(pid, HUMAN, 'human', ids) });
  });

  // ---- context -------------------------------------------------------------------------------

  app.post(`${P}/context/compile`, allow('operator', 'harness'), async (c) => {
    const body = await json(c);
    const auth = c.get('auth');
    const taskId = typeof body.task_id === 'string' ? body.task_id : undefined;
    const maxChars = typeof body.max_chars === 'number' ? body.max_chars : undefined;
    const purpose = typeof body.purpose === 'string' ? body.purpose : 'request';
    // What is asked for beyond the task (review F17), as an agent's context request names it: a
    // kind, a query and paths; a request of another shape is ignored and the task packet compiled.
    const kinds = ['task', 'scope_files', 'file', 'symbol', 'history', 'decision', 'learnings', 'freeform'];
    const asked = body.request && typeof body.request === 'object' ? (body.request as Record<string, unknown>) : null;
    const request =
      asked && typeof asked.kind === 'string' && kinds.includes(asked.kind)
        ? {
            kind: asked.kind,
            ...(typeof asked.query === 'string' ? { query: asked.query.slice(0, 500) } : {}),
            ...(Array.isArray(asked.paths)
              ? { paths: asked.paths.filter((p): p is string => typeof p === 'string').slice(0, 50) }
              : {}),
          }
        : undefined;
    if (auth.token_class === 'harness' && auth.harness_id) {
      const caller = callerFor(state, pid, auth.harness_id);
      const packet = await compile(
        {
          recipient: { kind: 'agent', id: caller.agent_id, harness_id: auth.harness_id },
          task_id: taskId ?? state.q.agent(caller.agent_id).current_task_id ?? undefined,
          purpose,
          ...(request ? { request } : {}),
          // A size the caller asked for is kept, or the answer says what fits (review F12).
          ...(maxChars ? { max_chars: maxChars, overflow: 'refuse' as const } : {}),
        },
        { kind: 'agent', id: caller.agent_id },
      );
      return c.json(packet);
    }
    const recipientId = typeof body.recipient_id === 'string' ? body.recipient_id : 'local-operator';
    return c.json(
      await compile(
        {
          recipient: { kind: 'human', id: recipientId },
          task_id: taskId,
          purpose,
          ...(request ? { request } : {}),
          ...(maxChars ? { max_chars: maxChars, overflow: 'refuse' as const } : {}),
        },
        HUMAN,
      ),
    );
  });

  const ownPacket = (c: Context<Env>, id: string) => {
    const packet = state.q.contextPacket(id);
    if (!packet) throw new FridayError('context_unavailable', 'unknown context packet');
    const auth = c.get('auth');
    if (auth.token_class === 'harness' && auth.harness_id && packet.recipient.harness_id !== auth.harness_id) {
      throw new FridayError('permission_denied', 'this packet was compiled for another session');
    }
    return packet;
  };
  app.get(`${P}/context/:cid`, allow('operator', 'harness'), async (c) => {
    ownPacket(c, c.req.param('cid'));
    return c.json(await deps.context.packet(c.req.param('cid')));
  });
  // Why a packet holds what it holds (ADR-0022 §8).
  app.get(`${P}/context/:cid/explain`, allow('operator', 'harness'), (c) => {
    const packet = ownPacket(c, c.req.param('cid'));
    const explanation = deps.context.explanation(packet.context_id);
    if (!explanation)
      throw new FridayError('context_unavailable', 'this packet was compiled before explanations existed (M4d)');
    return c.json({ packet, explanation });
  });

  // ---- events --------------------------------------------------------------------------------

  app.get(`${P}/events`, allow(...OPERATOR), (c) => {
    const since = Number(c.req.query('since') ?? 0);
    const limit = Math.min(Number(c.req.query('limit') ?? 200), 1000);
    const types = c.req.queries('type');
    const task = c.req.query('task');
    // `since` applies before `limit`, so a task's events page forward (plan M9 §5.11).
    const events = task
      ? state.store.readByRef(pid, 'task', task, { limit, after: since, ...(types ? { types } : {}) })
      : state.store.readSince(pid, since, { limit, ...(types ? { types } : {}) });
    return c.json({ events, head: state.store.head(pid) });
  });

  app.get(`${P}/events/stream`, allow(...OPERATOR), (c) => {
    let since = Number(c.req.header('last-event-id') ?? c.req.query('since') ?? 0);
    const types = c.req.queries('type');
    const ctrl = new AbortController();
    deps.streams.add(ctrl);
    // A stream is authenticated when it opens; it ends as soon as its credential does (logout,
    // the session cap, rotation, any revocation), checked on every pass (LESSONS UI-23).
    const header = c.req.header('authorization') ?? '';
    const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const credential = c.get('auth').credential_id;
    const stillValid = () => state.tokenStatus(raw).status === 'valid' && !deps.uiAuth?.expire(credential);
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => ctrl.abort());
      let lastPing = Date.now();
      try {
        while (!ctrl.signal.aborted && !stream.aborted) {
          if (!stillValid()) break;
          const events = state.store.readSince(pid, since, { limit: 200, ...(types ? { types } : {}) });
          for (const e of events) {
            await stream.writeSSE({ id: String(e.sequence), event: e.type, data: JSON.stringify(e) });
            since = e.sequence;
          }
          if (events.length === 0) {
            if (Date.now() - lastPing > 15_000) {
              await stream.write(': ping\n\n');
              lastPing = Date.now();
            }
            await sleep(deps.pollIntervalMs ?? 300, undefined, { signal: ctrl.signal }).catch(() => undefined);
          }
        }
        if (deps.isDraining()) await stream.writeSSE({ event: 'shutdown', data: '{}' }).catch(() => undefined);
      } finally {
        deps.streams.delete(ctrl);
      }
    });
  });

  // ---- harness protocol ----------------------------------------------------------------------

  app.post('/protocol/v1/rpc', allow('bootstrap', 'harness'), async (c) => {
    let body: unknown;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      body = null;
    }
    const ctrl = new AbortController();
    deps.streams.add(ctrl);
    c.req.raw.signal?.addEventListener('abort', () => ctrl.abort());
    try {
      const res = await dispatchRpc(
        {
          state,
          project,
          compile,
          signal: ctrl.signal,
          ...(deps.pollIntervalMs ? { pollIntervalMs: deps.pollIntervalMs } : {}),
          ...(deps.stateDir ? { stateDir: deps.stateDir } : {}),
          ...(deps.policy ? { policy: deps.policy } : {}),
          ...(deps.operations ? { operations: deps.operations } : {}),
          ...(deps.judgeTool ? { judgeTool: deps.judgeTool } : {}),
          ...(deps.graph ? { graph: deps.graph } : {}),
          readFilter: (recipient) => deps.context.readFilter(recipient),
        },
        c.get('auth'),
        body,
      );
      return c.json(res);
    } finally {
      deps.streams.delete(ctrl);
    }
  });

  app.get('/protocol/v1/stream', allow('harness'), (c) => {
    const harnessId = c.get('auth').harness_id as string;
    const ctrl = new AbortController();
    deps.streams.add(ctrl);
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => ctrl.abort());
      try {
        while (!ctrl.signal.aborted && !stream.aborted) {
          for (const m of state.pollOutbox(pid, harnessId, 10)) {
            await stream.writeSSE({ id: m.message_id, event: m.method, data: JSON.stringify(m) });
          }
          await sleep(deps.pollIntervalMs ?? 300, undefined, { signal: ctrl.signal }).catch(() => undefined);
        }
      } finally {
        deps.streams.delete(ctrl);
      }
    });
  });

  // ---- admin ---------------------------------------------------------------------------------

  app.post('/admin/shutdown', allow(...OPERATOR), (c) => {
    deps.requestShutdown('admin request');
    return c.json({ ok: true, status: 'shutting_down' }, 202);
  });
  // The interface's Stop Friday (plan M9 §5.2): the same graceful stop, open to UI sessions.
  app.post(`${P}/daemon/stop`, allow(...OPERATOR), (c) => {
    deps.requestShutdown('stopped from the interface');
    return c.json({ ok: true, status: 'shutting_down' }, 202);
  });

  app.post('/admin/rotate-tokens', allow(...OPERATOR), (c) => {
    deps.rotateTokens();
    return c.json({ ok: true, note: 'new tokens were written to the private state directory' });
  });

  // Snapshots, isolated replay and backup (M3c, ADR-0018).
  const fridayDir = path.join(project.root, FRIDAY_DIR);
  const target = (body: Record<string, unknown>, what: string): string => {
    if (typeof body.into !== 'string' || !path.isAbsolute(body.into)) {
      throw new FridayError('invalid_request', `${what} needs "into": an absolute path to a new or empty directory`);
    }
    return body.into;
  };
  // Each runs off the event loop's critical path (M3.1, R09) and one at a time.
  const artifactsDir = path.join(fridayDir, 'artifacts');
  app.post('/admin/snapshot', allow(...OPERATOR), async (c) =>
    c.json(await createSnapshot(state, pid, { artifactsDir }), 201),
  );
  app.get('/admin/snapshots', allow(...OPERATOR), (c) =>
    c.json({ snapshots: listSnapshots(state, pid, { artifactsDir }) }),
  );
  app.post('/admin/replay', allow(...OPERATOR), async (c) => {
    const body = await json(c);
    const into = target(body, 'a replay');
    let snapshotFile: string | undefined;
    if (typeof body.snapshot === 'string' && body.snapshot) {
      const snap = listSnapshots(state, pid, { artifactsDir }).find((s) => s.snapshot_id === body.snapshot);
      if (!snap) throw new FridayError('invalid_request', `no snapshot ${body.snapshot}`);
      if (!snap.file || !snap.present) {
        throw new FridayError(
          'invalid_request',
          `the file of snapshot ${body.snapshot} (${snap.state_ref}) is missing`,
        );
      }
      snapshotFile = snap.file;
    }
    return c.json(await replayInto(state, pid, into, snapshotFile ? { snapshotFile } : {}));
  });
  app.post('/admin/backup', allow(...OPERATOR), async (c) => {
    const body = await json(c);
    return c.json(
      await backupTo(state, pid, target(body, 'a backup'), {
        artifactsDir,
        fridayVersion: FRIDAY_VERSION,
        code: (staging) => backupCode(state, project, staging),
      }),
      201,
    );
  });

  // Learnings agents proposed for the project (ADR-0034 §7): a human lists, approves or rejects them.
  app.get(`${P}/learnings`, allow(...OPERATOR), (c) => {
    const status = c.req.query('status');
    if (status && !['proposed', 'promoted', 'rejected'].includes(status)) {
      throw new FridayError('invalid_request', `unknown learning status ${status}`);
    }
    return c.json({
      learnings: state.q.learningProposals(pid, {
        ...(status ? { status: status as 'proposed' | 'promoted' | 'rejected' } : {}),
        ...(c.req.query('task') ? { task_id: c.req.query('task') as string } : {}),
        limit: Number(c.req.query('limit') ?? 200) || 200,
      }),
    });
  });
  app.get(`${P}/learnings/:lid`, allow(...OPERATOR), (c) => c.json(state.q.learningProposal(pid, c.req.param('lid'))));
  app.post(`${P}/learnings/:lid/approve`, allow(...OPERATOR), async (c) => {
    const body = await json(c);
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : undefined;
    return c.json(state.learnings.approve(pid, HUMAN, c.req.param('lid'), note));
  });
  app.post(`${P}/learnings/:lid/reject`, allow(...OPERATOR), async (c) => {
    const body = await json(c);
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : undefined;
    return c.json(state.learnings.reject(pid, HUMAN, c.req.param('lid'), note));
  });

  // Scoped memory (M4c, ADR-0021). A human here: every scope is readable and writable.
  const humanMemory: MemoryActor = { kind: 'human', actor: HUMAN };
  app.get(`${P}/memory`, allow(...OPERATOR), (c) => {
    const kinds = c.req.queries('kind')?.flatMap((k) => k.split(',')) as MemoryKind[] | undefined;
    return c.json({
      memories: state.memory.search(pid, humanMemory, {
        ...(c.req.query('query') ? { query: c.req.query('query') as string } : {}),
        ...(kinds?.length ? { kinds } : {}),
        include_inactive: c.req.query('all') === 'true',
        limit: Number(c.req.query('limit') ?? 20) || 20,
      }),
    });
  });
  app.get(`${P}/memory/review`, allow(...OPERATOR), (c) =>
    c.json({ memories: state.memory.search(pid, humanMemory, { limit: 200 }).filter((m) => m.needs_review) }),
  );
  app.get(`${P}/memory/:mid`, allow(...OPERATOR), (c) => c.json(state.memory.get(c.req.param('mid'))));
  app.post(`${P}/memory`, allow(...OPERATOR), async (c) => {
    const body = await json(c);
    return c.json(state.memory.record(pid, humanMemory, body as unknown as MemoryInput), 201);
  });
  app.post(`${P}/memory/:mid/approve`, allow(...OPERATOR), (c) =>
    c.json(state.memory.approve(pid, HUMAN, c.req.param('mid'))),
  );
  app.post(`${P}/memory/:mid/retract`, allow(...OPERATOR), async (c) => {
    const body = await json(c);
    return c.json(
      state.memory.retract(pid, humanMemory, c.req.param('mid'), String(body.reason ?? 'retracted by a human')),
    );
  });
  app.post(`${P}/memory/:mid/supersede`, allow(...OPERATOR), async (c) => {
    const body = await json(c);
    if (typeof body.by !== 'string')
      throw new FridayError('invalid_request', 'supersede needs "by": the memory that replaces it');
    return c.json(
      state.memory.supersede(
        pid,
        humanMemory,
        c.req.param('mid'),
        body.by,
        String(body.reason ?? 'superseded by a human'),
      ),
    );
  });

  // Task worktrees (M5a, ADR-0023).
  const workspaces = (): WorkspaceManager => {
    if (!deps.workspaces) throw new FridayError('capability_unsupported', 'this daemon manages no task worktrees');
    return deps.workspaces;
  };
  app.get(`${P}/worktrees`, allow(...OPERATOR), async (c) =>
    c.json({ dir: workspaces().dir, worktrees: await workspaces().list(c.req.query('all') === 'true') }),
  );
  app.post(`${P}/worktrees/prune`, allow(...OPERATOR), async (c) => c.json(await workspaces().prune(HUMAN)));
  app.post(`${P}/tasks/:tid/worktree`, allow(...OPERATOR), async (c) =>
    c.json(await workspaces().forTask(c.req.param('tid'), HUMAN), 201),
  );

  // The project's policy and this clone's trust (M6b, ADR-0028).
  const effective = (): EffectivePolicy => {
    if (!deps.policy) throw new FridayError('capability_unsupported', 'this daemon has no project policy');
    return deps.policy();
  };
  app.get(`${P}/policy`, allow(...OPERATOR), (c) => c.json({ policy: effective() }));
  app.post(`${P}/policy/reload`, allow(...OPERATOR), (c) => c.json({ policy: deps.reloadPolicy?.() ?? effective() }));
  app.post(`${P}/policy/trust`, allow(...OPERATOR), async (c) => {
    const body = z.object({ loosening_hash: z.string().min(1).max(64) }).parse(await json(c));
    const now = deps.reloadPolicy?.() ?? effective();
    // Trust is for exactly what the human was shown: refused when the files changed since.
    if (now.loosening_hash !== body.loosening_hash) {
      throw new FridayError(
        'invalid_request',
        now.loosening_hash
          ? `the policy files changed since you looked: run "friday policy show" again (now ${now.loosening_hash})`
          : "nothing in the policy files loosens Friday's defaults; there is nothing to trust",
      );
    }
    if (!deps.trustPolicy) throw new FridayError('capability_unsupported', 'this daemon cannot record trust');
    return c.json({ policy: deps.trustPolicy(body.loosening_hash) });
  });

  // Recovery of lost and failed attempts (M5d, ADR-0026).
  const recovery = (): RecoveryManager => {
    if (!deps.recovery) throw new FridayError('capability_unsupported', 'this daemon has no recovery');
    return deps.recovery;
  };
  app.get(`${P}/tasks/:tid/recovery`, allow(...OPERATOR), async (c) =>
    c.json({ assessment: await recovery().assess(c.req.param('tid')) }),
  );
  app.post(`${P}/tasks/:tid/recover`, allow(...OPERATOR), async (c) => {
    const body = z
      .object({
        action: z.enum(['reassign', 'restart', 'rebind', 'needs_human', 'cancel']),
        reason: z.string().min(1).max(500).optional(),
      })
      .parse(await json(c));
    return c.json(await recovery().perform(c.req.param('tid'), body.action, HUMAN, body.reason));
  });

  // Integration into goal branches (M5c, ADR-0025).
  // Model routing (M7, ADR-0031): the registry with its evidence, decisions, and human pins.
  const routingOf = () => {
    if (!deps.routing) throw new FridayError('capability_unsupported', 'this daemon routes no models');
    return deps.routing;
  };
  app.get(`${P}/models`, allow(...OPERATOR), (c) => {
    const r = routingOf();
    return c.json({
      models: r.models,
      // Measured outcomes under the current checks; assumed ones and other cohorts are counted apart.
      evidence: state.q.modelEvidence(pid, { checksVersion: r.checksVersion }),
      settings: r.settings,
    });
  });
  // The token baseline (plan M10a): one usage row per run attempt, joined from the event log. An
  // unknown goal or task answers with the usual not-found error.
  app.get(`${P}/usage`, allow(...OPERATOR), (c) =>
    c.json(
      state.q.usageReport(pid, {
        ...(c.req.query('goal') ? { goalId: c.req.query('goal') as string } : {}),
        ...(c.req.query('task') ? { taskId: c.req.query('task') as string } : {}),
      }),
    ),
  );
  app.get(`${P}/routing/explain/:tid`, allow(...OPERATOR), (c) => {
    const tid = c.req.param('tid');
    return c.json({
      dry_run: routingOf().explain(tid),
      decisions: state.q.routingDecisions(pid, { task_id: tid }),
      role_decision: state.q.latestTaskRoleDecision(pid, tid) ?? null,
    });
  });
  app.get(`${P}/routing/decisions`, allow(...OPERATOR), (c) =>
    c.json({
      decisions: state.q.routingDecisions(pid, {
        ...(c.req.query('task') ? { task_id: c.req.query('task') as string } : {}),
        limit: Math.min(Number(c.req.query('limit') ?? 50) || 50, 500),
      }),
    }),
  );
  app.get(`${P}/routing/pins`, allow(...OPERATOR), (c) =>
    c.json({
      pins: c.req.query('all') === 'true' ? state.q.routingPins(pid) : state.q.routingPins(pid, state.clock.now()),
    }),
  );
  app.post(`${P}/routing/pins`, allow(...OPERATOR), async (c) => {
    const body = z
      .object({
        scope: z.enum(['project', 'kind', 'role', 'task']),
        target: z.string().min(1).max(200).nullable().default(null),
        model: z.string().min(1).max(100).nullable().default(null),
        sensitive: z.boolean().default(false),
        needs_vision: z.boolean().default(false),
        until: z.string().datetime().nullable().default(null),
        note: z.string().max(500).nullable().default(null),
      })
      .parse(await c.req.json().catch(() => ({})));
    if (body.model && !routingOf().models.some((m) => m.id === body.model)) {
      throw new FridayError(
        'invalid_request',
        `${body.model} is not in the registry; add it under routing.models in .friday/config.yaml first`,
      );
    }
    return c.json({ pin: state.pinRouting(pid, HUMAN, body) }, 201);
  });
  app.post(`${P}/routing/pins/:pin/revoke`, allow(...OPERATOR), (c) =>
    c.json({ pin: state.unpinRouting(pid, HUMAN, c.req.param('pin')) }),
  );

  // Runtime readiness (ADR-0035): what this machine has seen of each host and model, and the verdict.
  app.get(`${P}/readiness`, allow(...OPERATOR), (c) => c.json(routingOf().readinessReport()));
  app.get(`${P}/readiness/evidence`, allow(...OPERATOR), (c) =>
    c.json({
      evidence: state.q.readinessEvidence(pid, {
        ...(c.req.query('host') ? { host: c.req.query('host') as string } : {}),
        all: c.req.query('all') === 'true',
        limit: Math.min(Number(c.req.query('limit') ?? 200) || 200, 2000),
      }),
    }),
  );
  // What a host check outside the daemon saw (`friday harness doctor <host>`): a day's evidence.
  app.post(`${P}/readiness/evidence`, allow(...OPERATOR), async (c) =>
    c.json({ evidence: state.readiness.record(pid, HUMAN, await c.req.json().catch(() => ({}))) }, 201),
  );
  app.post(`${P}/readiness/clear`, allow(...OPERATOR), async (c) => {
    const body = z
      .object({ host: z.string().min(1).max(40), model: z.string().min(1).max(200).nullable().default(null) })
      .parse(await c.req.json().catch(() => ({})));
    return c.json({ ended: state.readiness.clear(pid, HUMAN, body.host, body.model) });
  });

  // Operations the gateway runs, and their runs (M6c, ADR-0029). Secret names only, never values.
  app.get(`${P}/operations`, allow(...OPERATOR), (c) => {
    const p = deps.policy?.();
    return c.json({ operations: Object.values(p?.operations ?? {}), held: p?.operations_held ?? [] });
  });
  app.get(`${P}/operation-runs`, allow(...OPERATOR), (c) =>
    c.json({
      runs: deps.state.q.operationRuns(pid, {
        ...(c.req.query('task') ? { task_id: c.req.query('task') as string } : {}),
        limit: Math.min(Number(c.req.query('limit') ?? 50) || 50, 500),
      }),
    }),
  );
  app.get(`${P}/operation-runs/:oid`, allow(...OPERATOR), (c) => {
    const run = deps.state.q.operationRun(c.req.param('oid'));
    if (!run) throw new FridayError('invalid_request', `operation run ${c.req.param('oid')} not found`);
    return c.json({ run, result: deps.operations?.result(run.operation_run_id) ?? null });
  });
  app.get(`${P}/integrations`, allow(...OPERATOR), (c) =>
    c.json({
      integrations: deps.state.q.integrations(pid, {
        ...(c.req.query('goal') ? { goal_id: c.req.query('goal') as string } : {}),
        ...(c.req.query('task') ? { task_id: c.req.query('task') as string } : {}),
      }),
    }),
  );
  app.post(`${P}/tasks/:tid/integrate`, allow(...OPERATOR), async (c) => {
    if (!deps.integration) throw new FridayError('capability_unsupported', 'this daemon integrates no task branches');
    const task = deps.state.q.task(pid, c.req.param('tid'));
    if (task.status !== 'COMPLETED' || !task.goal_id) {
      throw new FridayError(
        'invalid_request',
        `only a completed task of a goal is integrated; ${task.task_id} is ${task.status}${task.goal_id ? '' : ' without a goal'}`,
      );
    }
    // `repaired`: a human repaired a failed or conflicted integration on the task branch (review M7.1 R04).
    const body = await c.req.json().catch(() => ({}));
    const repaired = z.object({ repaired: z.boolean().optional() }).parse(body ?? {}).repaired === true;
    return c.json({ integration: await deps.integration.integrate(task.task_id, HUMAN, { repaired }) });
  });

  // File reservations (M5c, ADR-0025).
  app.get(`${P}/file-reservations`, allow(...OPERATOR), (c) =>
    c.json({
      mode: project.config.reservations.mode,
      required: project.config.reservations.required,
      reservations: deps.state.q.fileReservations(pid, c.req.query('all') === 'true' ? undefined : ['active']),
    }),
  );
  app.post(`${P}/file-reservations`, allow(...OPERATOR), async (c) => {
    const body = z
      .object({ task_id: z.string().min(1), pattern: z.string().min(1), note: z.string().max(500).optional() })
      .parse(await json(c));
    const [reservation] = deps.state.reserveFiles(
      pid,
      HUMAN,
      body.task_id,
      [body.pattern],
      'human',
      patternsOverlap,
      body.note,
    );
    return c.json({ reservation }, 201);
  });
  app.post(`${P}/file-reservations/:rid/release`, allow(...OPERATOR), async (c) => {
    const body = z.object({ note: z.string().max(500).optional() }).parse(await c.req.json().catch(() => ({})));
    return c.json({
      reservation: deps.state.releaseFileReservation(
        pid,
        HUMAN,
        c.req.param('rid'),
        body.note ?? 'released by a human',
      ),
    });
  });

  // Code graph (M4b, ADR-0020).
  const graphService = (): GraphService => {
    if (!deps.graph) throw new FridayError('capability_unsupported', 'this daemon has no code graph');
    return deps.graph;
  };
  app.get(`${P}/graph`, allow(...OPERATOR), async (c) => c.json(graphSummary(await graphService().graph())));
  app.get(`${P}/graph/query`, allow(...OPERATOR), async (c) => {
    const file = c.req.query('path');
    if (!file) throw new FridayError('invalid_request', 'graph/query needs ?path=<file>');
    const depth = Math.min(Math.max(Number(c.req.query('depth') ?? 1) || 1, 1), 5);
    return c.json(graphQuery(await graphService().graph(), file, depth));
  });
  // The questions of ADR-0037 §3: a symbol, what a change would reach, a file with its bodies folded, keywords.
  app.get(`${P}/graph/symbol`, allow(...OPERATOR), async (c) => {
    const name = c.req.query('name');
    if (!name) throw new FridayError('invalid_request', 'graph/symbol needs ?name=<symbol>');
    const g = await graphService().graph();
    const found = lookupSymbol(g, name, {
      ...(c.req.query('path') ? { path: c.req.query('path') as string } : {}),
      ...(c.req.query('prefix') ? { prefix: c.req.query('prefix') as string } : {}),
      limit: Math.min(Number(c.req.query('limit') ?? 20) || 20, 100),
    });
    return c.json({ version: g.version, ...found });
  });
  app.get(`${P}/graph/blast-radius`, allow(...OPERATOR), async (c) => {
    const g = await graphService().graph();
    const clean = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');
    const paths = (c.req.queries('path') ?? []).map(clean);
    const symbols = (c.req.queries('symbol') ?? [])
      .map((s) => {
        const at = s.lastIndexOf('#');
        return at > 0 ? { path: clean(s.slice(0, at)), symbol: s.slice(at + 1) } : null;
      })
      .filter((x): x is { path: string; symbol: string } => x !== null);
    // `diff`: the working tree's changed files, as the source identity lists them.
    const seeds = c.req.query('diff') === 'true' ? [...new Set([...paths, ...g.identity.paths])] : paths;
    if (!seeds.length && !symbols.length) {
      throw new FridayError(
        'invalid_request',
        'graph/blast-radius needs ?path=<file>, ?symbol=<file#symbol> or ?diff=true',
      );
    }
    const depth = Math.min(Math.max(Number(c.req.query('depth') ?? 2) || 2, 1), 5);
    return c.json({
      version: g.version,
      ...blastRadius(g, { paths: seeds, symbols }, { depth, includeNameMatches: c.req.query('names') === 'true' }),
    });
  });
  app.get(`${P}/graph/skeleton`, allow(...OPERATOR), async (c) => {
    const file = c.req.query('path');
    if (!file) throw new FridayError('invalid_request', 'graph/skeleton needs ?path=<file>');
    const g = await graphService().graph();
    const rel = file.replace(/\\/g, '/').replace(/^\.\//, '');
    const sk = await skeletonOf(g, g.root, rel, c.req.query('level') === '2' ? 2 : 1);
    if (!sk)
      throw new FridayError('invalid_request', `${rel} is not in the code graph (only TS/JS files git sees are)`);
    return c.json({ version: g.version, ...sk });
  });
  app.get(`${P}/graph/search`, allow(...OPERATOR), async (c) => {
    const q = c.req.query('q');
    if (!q) throw new FridayError('invalid_request', 'graph/search needs ?q=<words>');
    const kind = c.req.query('kind');
    const hits = await graphService().search(q, {
      limit: Math.min(Number(c.req.query('limit') ?? 20) || 20, 100),
      ...(kind === 'symbol' || kind === 'file' ? { kind } : {}),
    });
    return c.json({ hits });
  });
  app.post(`${P}/graph/reindex`, allow(...OPERATOR), async (c) => c.json(graphSummary(await graphService().reindex())));

  // ---- errors --------------------------------------------------------------------------------

  app.notFound((c) => errorResponse(c, new FridayError('invalid_request', `no route ${c.req.method} ${c.req.path}`)));
  app.onError((err, c) => {
    if (isFridayError(err)) {
      if (err.http >= 500) logger.error('request failed', { path: c.req.path, code: err.code, message: err.message });
      return errorResponse(c, err);
    }
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
      return errorResponse(c, new FridayError('schema_mismatch', 'request does not match the schema', { issues }));
    }
    logger.error('unhandled error', { path: c.req.path, message: (err as Error).message, stack: (err as Error).stack });
    return errorResponse(c, new FridayError('internal_error', 'internal error'));
  });

  return app;
}
