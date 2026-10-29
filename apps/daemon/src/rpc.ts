import { setTimeout as sleep } from 'node:timers/promises';
import { GitRoot } from '@friday/git';
import {
  type Autonomy,
  type Capability,
  type CommandClass,
  capabilityOf,
  evaluateCapability,
  mcpLevel,
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
  type ParsedParamsOf,
  RESERVED_METHODS,
  type ResultOf,
  RpcRequest,
  type RpcResponse,
  rpcError,
  rpcResult,
  type TokenClass,
} from '@friday/protocol';
import { type ProjectRef, policyVersion } from '@friday/sdk';
import type { Caller, FridayState } from '@friday/state';
import type { CompileInput } from './context.js';
import type { OperationManager } from './operations.js';
import type { ToolJudge } from './tool-policy.js';

/** The commit a checkout is at, or null where git cannot read one (a folder outside git). */
async function checkoutHead(cwd: string | null): Promise<string | null> {
  if (!cwd) return null;
  try {
    return (await (await GitRoot.open(cwd)).refs()).head || null;
  } catch {
    return null;
  }
}

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
  /** The execution gateway (ADR-0029). */
  operations?: OperationManager;
  /** Judges a host's tool call the way the hooks do (ADR-0032 §4). */
  judgeTool?: ToolJudge;
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

/**
 * A human's answer given in the host (MCP elicitation, ADR-0030 §5), relayed by the session that
 * asked: it counts only for that agent's pending request in this session's attempt, at low or
 * medium risk, from a session whose Friday hooks are enforcing, and grants one use.
 */
function elicitedAnswer(deps: RpcDeps, c: Caller, approvalId: string, decision: 'approve' | 'reject') {
  const { state, project } = deps;
  const pid = project.project_id;
  if (deps.policy && !deps.policy().elicitation) {
    throw new FridayError(
      'permission_denied',
      'this project decides approvals on the CLI and the status page (approvals.elicitation: false)',
    );
  }
  const harness = state.q.harness(c.harness_id);
  if (harness.enforcement_level !== 'L1' || harness.enforcement_status !== 'enforcing') {
    throw new FridayError(
      'permission_denied',
      'an answer given in the host counts only from a session whose Friday hooks are enforcing; decide it with "friday approve"',
    );
  }
  const row = state.q.approvals(pid).find((a) => a.approval_id === approvalId) as
    | { requested_by_kind: string; requested_by_id: string; run_id: string | null; risk: string | null; status: string }
    | undefined;
  if (row?.requested_by_kind !== 'agent' || row.requested_by_id !== c.agent_id) {
    throw new FridayError('permission_denied', `${approvalId} is not a request of this agent`);
  }
  const run = row.run_id ? state.q.findRun(row.run_id) : undefined;
  if (!run || run.harness_id !== c.harness_id) {
    throw new FridayError('permission_denied', `${approvalId} was not asked for in this session's attempt`);
  }
  if (row.risk !== 'low' && row.risk !== 'medium') {
    throw new FridayError(
      'permission_denied',
      `${approvalId} is ${row.risk ?? 'of unknown'} risk: a human decides it with "friday approve" or on the status page`,
    );
  }
  if (row.status !== 'pending') {
    return { approval_id: approvalId, status: row.status as ResultOf<'approval.elicited'>['status'] };
  }
  state.decideApproval(pid, { kind: 'human', id: 'host-user' }, approvalId, decision === 'approve', {
    reuse: 'once',
    via: 'elicitation',
    note: `answered in the ${harness.vendor} session ${harness.harness_id}`,
  });
  return { approval_id: approvalId, status: decision === 'approve' ? ('granted' as const) : ('denied' as const) };
}

function gateway(deps: RpcDeps): OperationManager {
  if (!deps.operations) throw new FridayError('capability_unsupported', 'this daemon runs no operations');
  return deps.operations;
}

/**
 * Judges a capability request and records it (ADR-0027 §3): granted when the policy allows it, denied
 * when it never does, otherwise a pending approval bound to the task and attempt for a human.
 */
function requestCapability(deps: RpcDeps, c: Caller, p: ParsedParamsOf<'permission.request'>) {
  const { state, project } = deps;
  const pid = project.project_id;
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
          // Asked for a command: judged as that command, not as a path (M8a).
          ...(p.command && !p.resource ? { command: p.command } : {}),
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
          // A third-party MCP tool, `<server>/<tool>`: the project's level for it (ADR-0030 §4).
          ...(capability === 'mcp.call' && effective && p.resource?.includes('/')
            ? {
                mcpLevel: mcpLevel(
                  effective,
                  p.resource.slice(0, p.resource.indexOf('/')),
                  p.resource.slice(p.resource.indexOf('/') + 1),
                ),
              }
            : {}),
        });
        // An agent asking for a secret is pointed at the operations that use one (Part 12 §5).
        const ops = capability === 'secret.resolve' ? (deps.operations?.withSecrets() ?? []) : [];
        const reason = ops.length
          ? `${v.reason}. Friday runs these with their secrets: ${ops
              .map((o) => `${o.name} (${Object.keys(o.credentials).join(', ')})`)
              .join('; ')}; call friday_run_operation`
          : v.reason;
        return { capability, decision: v.decision, risk: v.risk, reason, policy_version: version };
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

/**
 * A spawn adapter's question before its host acts (ADR-0032 §4): the same judgment as Claude Code's
 * PreToolUse hook, for the task this session holds. Nobody is at the host to ask, so where a human
 * decides, one pending approval for exactly this action is recorded, and the action passes once
 * it is granted.
 */
function checkTool(deps: RpcDeps, c: Caller, p: ParsedParamsOf<'tool.check'>): ResultOf<'tool.check'> {
  const { state, project } = deps;
  const pid = project.project_id;
  if (!deps.judgeTool) throw new FridayError('capability_unsupported', 'this daemon judges no host tool calls');
  const held = state.q.tasks(pid, { statuses: ['RUNNING', 'WAITING'] }).find((t) => t.assigned_agent_id === c.agent_id);
  if (p.task_id && p.task_id !== held?.task_id) {
    throw new FridayError('permission_denied', `${p.task_id} is not a task this session holds`);
  }
  if (p.run_id && p.run_id !== held?.current_run_id) {
    throw new FridayError('permission_denied', `${p.run_id} is not the run this session works in`);
  }
  const agent = state.q.findAgent(c.agent_id);
  // No human is at a spawn adapter's host: where one decides, one pending approval is recorded.
  const { result, approval_id } = deps.judgeTool({
    harness: state.q.harness(c.harness_id),
    agent: agent ? { agent_id: agent.agent_id, role: agent.role } : undefined,
    action: { ...p.action, tool: p.tool },
    actor: { kind: 'agent', id: c.agent_id },
    askHuman: true,
  });
  return { decision: result.decision, reason: result.reason, rule: result.rule, approval_id };
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
      // Where an attached session's work starts: the commit its checkout is at now (LESSONS D-41).
      const harness = state.q.harness(harnessId);
      const head = harness.attach_mode === 'spawn' ? null : await checkoutHead(harness.host_cwd);
      const out = state.claimTask(
        pid,
        c,
        { task_id: p.task_id, next: p.next },
        { idempotency_key: p.idempotency_key, head },
      );
      const context = await deps.compile(
        {
          recipient: { kind: 'agent', id: c.agent_id, harness_id: harnessId, run_id: out.run_id },
          task_id: out.task.task_id,
          purpose: 'task_claim',
        },
        { kind: 'agent', id: c.agent_id },
      );
      // Friday's model suggestion for this run (ADR-0031 §6): advisory unless the harness applies it.
      const run = state.q.findRun(out.run_id);
      const decision = run?.routing_decision_id ? state.q.routingDecision(run.routing_decision_id) : undefined;
      const routing = decision ? { model: decision.model, binding: decision.binding, reason: decision.reason } : null;
      return { ...out, context, routing };
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
          // The size was asked for: a packet that cannot fit says so (review F12); and what was
          // asked for is gathered, or the answer says why not (review F17).
          overflow: 'refuse',
          request: { kind: p.kind, query: p.query, paths: p.paths },
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
      // The model the host reports running for this run (ADR-0031 §7).
      const reported = p.data as { model?: unknown; basis?: unknown } | undefined;
      if (p.event_type === 'model.observed' && p.run_id && typeof reported?.model === 'string') {
        state.observeModel(
          pid,
          { kind: 'harness', id: harnessId },
          { run_id: p.run_id },
          reported.model,
          typeof reported.basis === 'string' ? reported.basis : 'reported',
        );
      }
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
      return requestCapability(deps, caller(), p);
    }
    case 'tool.check': {
      const p = METHODS[method].params.parse(raw);
      return checkTool(deps, caller(), p);
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
    case 'approval.elicited': {
      const p = METHODS[method].params.parse(raw);
      return elicitedAnswer(deps, caller(), p.approval_id, p.decision);
    }
    case 'operation.list':
      return gateway(deps).list(caller());
    case 'operation.run': {
      const p = METHODS[method].params.parse(raw);
      return gateway(deps).run(caller(), p, deps.signal);
    }
    case 'operation.status': {
      const p = METHODS[method].params.parse(raw);
      return gateway(deps).status(caller(), p.operation_run_id, p.wait_ms, deps.signal);
    }
  }
  throw new FridayError('invalid_request', `unhandled method ${method}`);
}
