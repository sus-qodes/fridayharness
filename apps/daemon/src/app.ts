import { setTimeout as sleep } from 'node:timers/promises';
import {
  type Actor,
  API_VERSION,
  type ErrorBody,
  FridayError,
  isFridayError,
  PROTOCOL_VERSIONS,
  TaskActionRequest,
  TaskCreateRequest,
  type TaskStatus,
  TaskStatus as TaskStatusEnum,
  type TokenClass,
  VerifyRequest,
} from '@friday/protocol';
import type { ProjectRef } from '@friday/sdk';
import type { FridayState } from '@friday/state';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { ZodError } from 'zod';
import type { BrainHandle } from './brain.js';
import { escalationView, mountBrainRoutes } from './brain-routes.js';
import { type CompileInput, compileContext, withStaleness } from './context.js';
import type { Logger } from './log.js';
import { type AuthInfo, callerFor, dispatchRpc } from './rpc.js';
import { statusPageHtml } from './ui.js';

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
  const compile = (input: CompileInput, actor: Actor) => compileContext(state, project, input, actor);

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
    const inbox = state.store
      .readSince(pid, 0, { types: ['communication.recorded'], limit: 5000 })
      .filter((e) => {
        const to = (e.payload as { to?: string }).to;
        return to === agent.agent_key || to === agent.agent_id;
      })
      .slice(-20)
      .map((e) => {
        const p = e.payload as Record<string, unknown>;
        return {
          message_id: p.message_id,
          from: e.actor.id,
          mode: p.mode,
          content: p.content,
          response_to: p.response_to,
          sent_at: e.occurred_at,
          trust: 'peer-untrusted',
        };
      });
    return c.json({
      project: { project_id: pid, name: project.name },
      harness: { ...harness, shadow: harness.shadow },
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

  const action = (name: 'ready' | 'release' | 'cancel' | 'rework' | 'assign') =>
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
        case 'assign': {
          if (!body.agent_key) throw new FridayError('invalid_request', 'agent_key is required');
          return c.json(state.assignTask(pid, HUMAN, tid, body.agent_key));
        }
      }
    });
  for (const a of ['ready', 'release', 'cancel', 'rework', 'assign'] as const) action(a);

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
    app.post(`${P}/approvals/:aid/${verb}`, allow(...OPERATOR), (c) => {
      state.decideApproval(pid, HUMAN, c.req.param('aid'), granted);
      return c.json({ ok: true, approval_id: c.req.param('aid'), status: granted ? 'granted' : 'denied' });
    });
  }
  app.get(`${P}/escalations`, allow(...OPERATOR), (c) =>
    c.json({ escalations: state.q.escalations(pid, c.req.query('status')).map(escalationView) }),
  );
  app.post(`${P}/escalations/:eid/answer`, allow(...OPERATOR), async (c) => {
    const body = await json(c);
    if (typeof body.answer !== 'string' || !body.answer) throw new FridayError('invalid_request', 'answer is required');
    state.answerEscalation(pid, HUMAN, c.req.param('eid'), body.answer);
    return c.json({ ok: true });
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
      const packet = compile(
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
      compile(
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

  app.get(`${P}/context/:cid`, allow('operator', 'harness'), (c) => {
    const packet = state.q.contextPacket(c.req.param('cid'));
    if (!packet) throw new FridayError('context_unavailable', 'unknown context packet');
    const auth = c.get('auth');
    if (auth.token_class === 'harness' && auth.harness_id && packet.recipient.harness_id !== auth.harness_id) {
      throw new FridayError('permission_denied', 'this packet was compiled for another session');
    }
    return c.json(withStaleness(packet, state.store.head(pid)));
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
