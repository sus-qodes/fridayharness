import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
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
  type TaskStatus,
  TaskStatus as TaskStatusEnum,
  type TokenClass,
  VerifyRequest,
} from '@friday/protocol';
import { fitThresholds } from '@friday/routing';
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
import type { BrainHandle } from './brain.js';
import { escalationView, mountBrainRoutes } from './brain-routes.js';
import type { CompileInput, ContextService } from './context.js';
import { type GraphService, query as graphQuery, summary as graphSummary } from './graph-service.js';
import type { IntegrationManager } from './integration.js';
import type { LayaService } from './laya.js';
import type { Logger } from './log.js';
import type { OperationManager } from './operations.js';
import type { EffectivePolicy } from './policy.js';
import type { RecoveryManager } from './recovery.js';
import type { RoutingService } from './routing.js';
import { type AuthInfo, callerFor, dispatchRpc } from './rpc.js';
import { statusPageHtml } from './ui.js';
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
  /** Laya (M7c, ADR-0031 §10). */
  laya?: LayaService;
}

type Env = { Variables: { auth: AuthInfo; requestId: string } };
export type AppEnv = Env;

const OPERATOR: TokenClass[] = ['operator'];
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

  app.use('*', async (c, next) => {
    c.set('requestId', state.ids.next('aud'));
    await next();
  });

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

  // Static status page: public HTML, the data behind it needs the operator token.
  app.get('/ui', (c) => c.html(statusPageHtml(pid, project.name)));
  app.get('/', (c) => c.redirect('/ui'));

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
    c.set('auth', {
      token_class: status.info.token_class,
      harness_id: status.info.harness_id,
      credential_id: status.info.credential_id,
    });
    return next();
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
    });
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

  app.get(`${P}/tasks/:tid/events`, allow(...OPERATOR), (c) => {
    const tid = c.req.param('tid');
    state.q.task(pid, tid);
    const limit = Number(c.req.query('limit') ?? 500);
    return c.json({ events: state.store.readByRef(pid, 'task', tid, { limit }) });
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
    if (auth.token_class === 'harness' && auth.harness_id) {
      const caller = callerFor(state, pid, auth.harness_id);
      const packet = await compile(
        {
          recipient: { kind: 'agent', id: caller.agent_id, harness_id: auth.harness_id },
          task_id: taskId ?? state.q.agent(caller.agent_id).current_task_id ?? undefined,
          purpose,
          ...(maxChars ? { max_chars: maxChars } : {}),
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
          ...(maxChars ? { max_chars: maxChars } : {}),
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
    const events = task
      ? state.store
          .readByRef(pid, 'task', task, { limit, ...(types ? { types } : {}) })
          .filter((e) => e.sequence > since)
      : state.store.readSince(pid, since, { limit, ...(types ? { types } : {}) });
    return c.json({ events, head: state.store.head(pid) });
  });

  app.get(`${P}/events/stream`, allow(...OPERATOR), (c) => {
    let since = Number(c.req.header('last-event-id') ?? c.req.query('since') ?? 0);
    const types = c.req.queries('type');
    const ctrl = new AbortController();
    deps.streams.add(ctrl);
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => ctrl.abort());
      let lastPing = Date.now();
      try {
        while (!ctrl.signal.aborted && !stream.aborted) {
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
      await backupTo(state, pid, target(body, 'a backup'), { artifactsDir, fridayVersion: FRIDAY_VERSION }),
      201,
    );
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
    const body = z.object({ loosening_hash: z.string().min(1).max(64) }).parse(await c.req.json());
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
        action: z.enum(['reassign', 'restart', 'needs_human', 'cancel']),
        reason: z.string().min(1).max(500).optional(),
      })
      .parse(await c.req.json());
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
      evidence: state.q.modelEvidence(pid),
      settings: r.settings,
      guide_version: r.guideVersion,
      min_samples: r.settings.min_samples,
    });
  });
  app.get(`${P}/routing/explain/:tid`, allow(...OPERATOR), (c) => {
    const tid = c.req.param('tid');
    return c.json({ dry_run: routingOf().explain(tid), decisions: state.q.routingDecisions(pid, { task_id: tid }) });
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
        mode: z.enum(['manual', 'policy', 'auto', 'hybrid']).nullable().default(null),
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

  // Laya (M7c, ADR-0031 §10): its settings, the thresholds fitted for it, and fitting new ones.
  app.get(`${P}/laya`, allow(...OPERATOR), (c) => {
    const cfg = project.config.routing.laya;
    return c.json({
      enabled: cfg.enabled,
      url: cfg.url,
      model: cfg.model ?? null,
      calibrations: state.q.layaCalibrations(pid),
    });
  });
  app.post(`${P}/laya/calibrate`, allow(...OPERATOR), async (c) => {
    const body = z
      .object({
        records: z
          .array(
            z.object({
              checkpoint: z.string().min(1).max(200),
              options: z.number().int().min(2).max(100),
              confidence: z.number().min(0).max(1),
              correct: z.boolean(),
            }),
          )
          .min(1)
          .max(100_000),
        target: z.number().min(0.5).max(1).default(0.9),
        min_support: z.number().int().min(1).max(100_000).default(20),
        source: z.string().max(200).default('friday laya calibrate'),
      })
      .parse(await c.req.json().catch(() => ({})));
    const fitted = fitThresholds(body.records, { target: body.target, minSupport: body.min_support });
    state.recordLayaCalibrations(pid, HUMAN, fitted, body.source);
    return c.json({ calibrations: fitted });
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
    return c.json({ integration: await deps.integration.integrate(task.task_id, HUMAN) });
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
      .parse(await c.req.json());
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
