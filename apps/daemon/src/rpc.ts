import { setTimeout as sleep } from 'node:timers/promises';
import {
  type Autonomy,
  type Capability,
  type CommandClass,
  capabilityOf,
  evaluateCapability,
  type ProjectPolicy,
  type Risk,
} from '@friday/policy';
import {
  type Actor,
  type ContextPacket,
  FridayError,
  isFridayError,
  isMethodName,
  METHODS,
  RESERVED_METHODS,
  RpcRequest,
  type RpcResponse,
  rpcError,
  rpcResult,
  type TokenClass,
} from '@friday/protocol';
import { type ProjectRef, policyVersion } from '@friday/sdk';
import type { Caller, FridayState } from '@friday/state';
import type { CompileInput } from './context.js';

export interface AuthInfo {
  token_class: TokenClass;
  harness_id: string | null;
  credential_id: string;
}

export interface RpcDeps {
  state: FridayState;
  project: ProjectRef;
  compile: (input: CompileInput, actor: Actor) => Promise<ContextPacket>;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  /** The per-user state folder, for Friday's protected paths. */
  stateDir?: string;
  /** The project's effective policy (ADR-0028). */
  policy?: () => ProjectPolicy;
}

function issuesOf(err: { issues: { path: PropertyKey[]; message: string }[] }) {
  return err.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
}

/** Resolves who is calling from the harness token (never from request fields). */
export function callerFor(state: FridayState, projectId: string, harnessId: string): Caller {
  const harness = state.q.harness(harnessId);
  const bound = state.q.agents(projectId).find((a) => a.harness_id === harnessId);
  const agent =
    bound ?? (harness.requested_agent_key ? state.q.agentByKey(projectId, harness.requested_agent_key) : undefined);
  if (!agent) throw new FridayError('agent_not_found', 'no agent is attached to this session');
  return { harness_id: harnessId, agent_id: agent.agent_id };
}

/** Handles one JSON-RPC request to /protocol/v1/rpc. Errors become JSON-RPC error objects. */
export async function dispatchRpc(deps: RpcDeps, auth: AuthInfo, body: unknown): Promise<RpcResponse> {
  const parsed = RpcRequest.safeParse(body);
  if (!parsed.success) {
    return rpcError(
      null,
      new FridayError('schema_mismatch', 'not a JSON-RPC 2.0 request', { issues: issuesOf(parsed.error) }),
    );
  }
  const req = parsed.data;
  try {
    return rpcResult(req.id, await handle(deps, auth, req.method, req.params ?? {}));
  } catch (err) {
    if (isFridayError(err)) return rpcError(req.id, err);
    return rpcError(req.id, new FridayError('internal_error', (err as Error).message ?? 'internal error'));
  }
}

async function handle(deps: RpcDeps, auth: AuthInfo, method: string, raw: Record<string, unknown>): Promise<unknown> {
  const { state, project } = deps;
  const pid = project.project_id;
  if (!isMethodName(method)) {
    if ((RESERVED_METHODS as readonly string[]).includes(method)) {
      throw new FridayError('capability_unsupported', `${method} is reserved and not served in this version`);
    }
    throw new FridayError('invalid_request', `unknown method ${method}`);
  }
  const res = METHODS[method].params.safeParse(raw);
  if (!res.success)
    throw new FridayError('schema_mismatch', `invalid params for ${method}`, { issues: issuesOf(res.error) });

  if (method === 'harness.register') {
    if (auth.token_class !== 'bootstrap') {
      throw new FridayError('token_scope_insufficient', 'harness.register needs the bootstrap token');
    }
    const p = METHODS['harness.register'].params.parse(raw);
    return state.registerHarness(pid, p);
  }
  if (auth.token_class !== 'harness' || !auth.harness_id) {
    throw new FridayError('token_scope_insufficient', `${method} needs a harness token (from harness.register)`);
  }
  const harnessId = auth.harness_id;
  const caller = () => callerFor(state, pid, harnessId);

  switch (method) {
    case 'harness.heartbeat':
      return state.heartbeat(pid, harnessId);
    case 'harness.capabilities': {
      const p = METHODS[method].params.parse(raw);
      state.setCapabilities(pid, harnessId, p.capabilities);
      return { ok: true };
    }
    case 'harness.disconnect': {
      const p = METHODS[method].params.parse(raw);
      state.disconnectHarness(pid, harnessId, p.reason, p.final);
      return { ok: true };
    }
    case 'harness.poll': {
      const p = METHODS[method].params.parse(raw);
      const deadline = Date.now() + p.wait_ms;
      for (;;) {
        const messages = state.pollOutbox(pid, harnessId, p.max);
        if (messages.length > 0 || Date.now() >= deadline || deps.signal?.aborted) return { messages };
        await sleep(Math.min(deps.pollIntervalMs ?? 200, Math.max(0, deadline - Date.now())));
      }
    }
    case 'harness.ack': {
      const p = METHODS[method].params.parse(raw);
      return state.ackOutbox(pid, harnessId, p.acks);
    }
    case 'task.claim': {
      const p = METHODS[method].params.parse(raw);
      const c = caller();
      const out = state.claimTask(pid, c, { task_id: p.task_id, next: p.next }, { idempotency_key: p.idempotency_key });
      const context = await deps.compile(
        {
          recipient: { kind: 'agent', id: c.agent_id, harness_id: harnessId, run_id: out.run_id },
          task_id: out.task.task_id,
          purpose: 'task_claim',
        },
        { kind: 'agent', id: c.agent_id },
      );
      return { ...out, context };
    }
    case 'task.update': {
      const p = METHODS[method].params.parse(raw);
      return state.updateTask(pid, caller(), p);
    }
    case 'context.request': {
      const p = METHODS[method].params.parse(raw);
      const c = caller();
      if (p.task_id) {
        const task = state.q.task(pid, p.task_id);
        const allowed = task.assigned_agent_id === c.agent_id || task.status === 'READY';
        if (!allowed) throw new FridayError('permission_denied', `task ${p.task_id} is assigned to another agent`);
      }
      const agent = state.q.agent(c.agent_id);
      return deps.compile(
        {
          recipient: {
            kind: 'agent',
            id: c.agent_id,
            harness_id: harnessId,
            ...(p.run_id ? { run_id: p.run_id } : {}),
          },
          task_id: p.task_id ?? agent.current_task_id ?? undefined,
          purpose: `request:${p.kind}`,
          max_chars: p.max_chars,
        },
        { kind: 'agent', id: c.agent_id },
      );
    }
    case 'agent.event': {
      const p = METHODS[method].params.parse(raw);
      const c = caller();
      if (p.run_id) {
        const run = state.q.run(p.run_id);
        if (run.harness_id !== harnessId) throw new FridayError('permission_denied', 'run belongs to another session');
      }
      const refs: { kind: 'task' | 'run'; id: string }[] = [];
      if (p.task_id) refs.push({ kind: 'task', id: p.task_id });
      if (p.run_id) refs.push({ kind: 'run', id: p.run_id });
      const ev = state.recordObservation(
        pid,
        { kind: 'agent', id: c.agent_id },
        'agent.event',
        {
          task_id: p.task_id ?? null,
          run_id: p.run_id ?? null,
          event_type: p.event_type,
          summary: p.summary ?? null,
          data: p.data ?? {},
        },
        refs,
      );
      const paths = (p.data as { changed_paths?: unknown } | undefined)?.changed_paths;
      if (p.run_id && Array.isArray(paths)) {
        state.observePaths(
          pid,
          { kind: 'harness', id: harnessId },
          p.run_id,
          paths.filter((x): x is string => typeof x === 'string'),
        );
      }
      return { event_id: ev.event_id };
    }
    case 'agent.result': {
      const p = METHODS[method].params.parse(raw);
      return state.submitResult(pid, caller(), p);
    }
    case 'agent.error': {
      const p = METHODS[method].params.parse(raw);
      return state.reportAgentError(pid, caller(), p);
    }
    case 'communication.request': {
      const p = METHODS[method].params.parse(raw);
      const { idempotency_key, protocol_version: _v, ...input } = p;
      return state.sendMessage(pid, { kind: 'agent', caller: caller() }, input, { idempotency_key });
    }
    case 'message.inbox': {
      const p = METHODS[method].params.parse(raw);
      const c = caller();
      const deadline = Date.now() + p.wait_ms;
      for (;;) {
        const r = state.inbox(pid, c, { max: p.max, peek: p.peek });
        if (r.items.length > 0 || Date.now() >= deadline || deps.signal?.aborted) return r;
        await sleep(Math.min(deps.pollIntervalMs ?? 200, Math.max(0, deadline - Date.now())));
      }
    }
    case 'message.ack': {
      const p = METHODS[method].params.parse(raw);
      return state.acknowledgeMessages(pid, caller(), p.ids);
    }
    case 'memory.record': {
      const p = METHODS[method].params.parse(raw);
      return state.memory.record(
        pid,
        { kind: 'agent', caller: caller() },
        {
          scope_type: p.scope,
          ...(p.scope === 'task' && p.task_id ? { scope_id: p.task_id } : {}),
          kind: p.kind,
          subject: p.subject,
          content: p.content,
          tags: p.tags,
          source_events: p.source_events,
        },
        p.idempotency_key ? { idempotency_key: p.idempotency_key } : {},
      );
    }
    case 'memory.search': {
      const p = METHODS[method].params.parse(raw);
      const hits = state.memory.search(
        pid,
        { kind: 'agent', caller: caller() },
        { ...(p.query ? { query: p.query } : {}), ...(p.kinds ? { kinds: p.kinds } : {}), limit: p.limit },
      );
      return { memories: hits.map(({ why: _why, ...m }) => m) };
    }
    case 'permission.request': {
      const p = METHODS[method].params.parse(raw);
      const c = caller();
      // Bound to the task and attempt it is for: the named one, else the one this agent holds (ADR-0027 §4).
      const task = p.task_id
        ? state.q.findTask(pid, p.task_id)
        : state.q.tasks(pid, { statuses: ['RUNNING', 'WAITING'] }).find((t) => t.assigned_agent_id === c.agent_id);
      const run = p.run_id
        ? state.q.findRun(p.run_id)
        : task?.current_run_id
          ? state.q.findRun(task.current_run_id)
          : undefined;
      const capability = capabilityOf(p.action_class);
      const effective = deps.policy?.();
      const version = effective?.version ?? policyVersion(project.config);
      const verdict = capability
        ? (() => {
            const v = evaluateCapability({
              capability,
              target: p.resource ?? p.command ?? null,
              task: task
                ? {
                    task_id: task.task_id,
                    status: task.status,
                    scope: task.scope,
                    kind: task.kind,
                    teams: effective?.teams[state.q.findAgent(c.agent_id)?.role ?? ''] ?? [],
                  }
                : null,
              ctx: {
                projectRoot: run?.execution_root ?? state.q.findHarness(c.harness_id)?.host_cwd ?? project.root,
                mainRoot: project.root,
                ...(deps.stateDir ? { stateDir: deps.stateDir } : {}),
              },
              autonomy: effective?.autonomy ?? (project.config.autonomy as Partial<Record<CommandClass, Autonomy>>),
              risk: effective?.risk ?? (project.config.risk as Partial<Record<Capability, Risk>>),
              ...(effective ? { deny: effective.deny } : {}),
            });
            return { capability, decision: v.decision, risk: v.risk, reason: v.reason, policy_version: version };
          })()
        : {
            capability: p.action_class,
            decision: 'review' as const,
            risk: 'high' as const,
            reason: `${p.action_class} is not a capability Friday knows; a human decides`,
            policy_version: version,
          };
      return state.requestPermission(
        pid,
        c,
        { ...p, task_id: p.task_id ?? task?.task_id, run_id: p.run_id ?? run?.run_id },
        verdict,
      );
    }
    case 'task.release': {
      const p = METHODS[method].params.parse(raw);
      const c = caller();
      const task = state.releaseTask(
        pid,
        { kind: 'agent', id: c.agent_id },
        p.task_id,
        p.note ? `${p.reason}: ${p.note}` : p.reason,
        c,
      );
      return { task_status: task.status };
    }
    case 'human.escalation': {
      const p = METHODS[method].params.parse(raw);
      return state.requestEscalation(pid, caller(), p);
    }
  }
  throw new FridayError('invalid_request', `unhandled method ${method}`);
}
