import { setTimeout as sleep } from 'node:timers/promises';
import { blastRadius, type CodeGraph, lookupSymbol, skeletonOf } from '@friday/code-graph';
import { GitRoot, type SourceIdentity } from '@friday/git';
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
import { type GraphService, query as graphQuery } from './graph-service.js';
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
  /** The code graphs of the project's checkouts (ADR-0038 §2); absent in a daemon without one. */
  graph?: GraphService;
}

/** The most an artifact read answers with (ADR-0038 §3). */
const ARTIFACT_READ_CHARS = 16_000;

/**
 * The caller's checkout, as the context compiler resolves it (ADR-0023): its run's execution root,
 * else its session's folder, else its task's worktree, else the project root.
 */
function executionRootOf(deps: RpcDeps, c: Caller): string {
  const { state, project } = deps;
  const agent = state.q.agent(c.agent_id);
  const task = agent.current_task_id ? state.q.findTask(project.project_id, agent.current_task_id) : undefined;
  const run = task?.current_run_id ? state.q.findRun(task.current_run_id) : undefined;
  if (run?.execution_root) return run.execution_root;
  const cwd = state.q.findHarness(c.harness_id)?.host_cwd;
  if (cwd) return cwd;
  const worktree = task ? state.q.worktreeForTask(task.task_id) : undefined;
  return worktree?.path ?? project.root;
}

/** The code graph of the caller's checkout (ADR-0038 §2). */
async function graphFor(deps: RpcDeps, c: Caller): Promise<CodeGraph> {
  if (!deps.graph) throw new FridayError('capability_unsupported', 'this daemon has no code graph');
  const root = executionRootOf(deps, c);
  let identity: SourceIdentity | null = null;
  try {
    identity = await (await GitRoot.open(root)).identity();
  } catch {
    // outside git: the service identifies the checkout itself
  }
  return deps.graph.graph(root, identity);
}

const cleanPath = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * Lines of an artifact the caller may read (ADR-0038 §3): it belongs to a task the caller holds or
 * held, or to a message delivered to it. Redacted again on the way out, bounded in lines and characters.
 */
function readArtifact(deps: RpcDeps, c: Caller, p: ParsedParamsOf<'artifact.read'>): ResultOf<'artifact.read'> {
  const { state, project } = deps;
  const pid = project.project_id;
  if (!state.artifacts) throw new FridayError('capability_unsupported', 'this daemon keeps no artifacts');
  const owner = state.q.artifactOwner(pid, p.artifact_ref);
  if (!owner) throw new FridayError('permission_denied', `${p.artifact_ref} is not an output you may read`);
  const mine =
    owner.kind === 'message'
      ? state.q.messageDeliveredTo(owner.id, c.agent_id)
      : state.q.runs(owner.task_id).some((r) => r.agent_id === c.agent_id) ||
        state.q.findTask(pid, owner.task_id)?.assigned_agent_id === c.agent_id;
  if (!mine) throw new FridayError('permission_denied', `${p.artifact_ref} belongs to work that is not yours`);
  const id = p.artifact_ref.slice('artifact:'.length);
  const record = state.artifacts.get(id);
  if (!record || record.project_id !== pid) throw new FridayError('invalid_request', `${p.artifact_ref} is gone`);
  const whole = state.redactor.redactString(state.artifacts.readText(id)).value;
  const lines = whole.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const picked: string[] = [];
  let from = 0;
  let to = 0;
  let matched: number | null = null;
  let truncated = false;
  let chars = 0;
  /** Keeps a line while the bounds allow; false once they do not. */
  const take = (text: string, n: number): boolean => {
    if (picked.length >= p.limit || chars + text.length + 1 > ARTIFACT_READ_CHARS) return false;
    picked.push(text);
    chars += text.length + 1;
    if (!from) from = n;
    to = n;
    return true;
  };
  if (p.find) {
    const needle = p.find.toLowerCase();
    matched = 0;
    let eligible = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (!line.toLowerCase().includes(needle)) continue;
      matched++;
      if (i + 1 < p.offset) continue;
      eligible++;
      take(`${i + 1}: ${line}`, i + 1);
    }
    truncated = picked.length < eligible;
  } else {
    for (let i = p.offset - 1; i < lines.length; i++) {
      if (!take(lines[i] as string, i + 1)) break;
    }
    truncated = to < lines.length;
  }
  return {
    artifact_ref: p.artifact_ref,
    kind: owner.kind,
    of: { kind: owner.kind, id: owner.id, task_id: owner.task_id },
    bytes: record.bytes,
    lines_total: lines.length,
    from,
    to,
    text: picked.join('\n'),
    truncated,
    matched,
  };
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
                // The ceiling of the task is its own role's team scope (plan M12.2).
                ceiling: (task.role ? effective?.teams[task.role] : undefined) ?? [],
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
      // The claim is committed: the agent holds the task whatever happens to its context. A packet
      // that cannot be compiled or recorded (the context evals of plan M12.6 found one whose record
      // was too large) must not turn the claim into an error that leaves the agent holding a task
      // it was told nothing about; it gets the claim, the reason, and the way to ask again.
      let context: ContextPacket | null = null;
      let note: string | null = null;
      try {
        context = await deps.compile(
          {
            recipient: { kind: 'agent', id: c.agent_id, harness_id: harnessId, run_id: out.run_id },
            task_id: out.task.task_id,
            purpose: 'task_claim',
          },
          { kind: 'agent', id: c.agent_id },
        );
      } catch (e) {
        note = `the task is yours, but its context could not be delivered: ${(e as Error).message}. Ask for it with friday_request_context.`;
      }
      // Friday's model suggestion for this run (ADR-0031 §6): advisory unless the harness applies it.
      const run = state.q.findRun(out.run_id);
      const decision = run?.routing_decision_id ? state.q.routingDecision(run.routing_decision_id) : undefined;
      const routing = decision ? { model: decision.model, binding: decision.binding, reason: decision.reason } : null;
      return { ...out, context, routing, note };
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
      const taskId = p.task_id ?? agent.current_task_id ?? null;
      // The request is recorded as it arrives, before the compiler answers or refuses it, so the
      // usage row (plan M10a) counts what the attempt asked for, refusals included. It is the
      // attempt's when it names this session's run, or when this session's active run is about the
      // task asked about; a shadow session's request names no run.
      const named = p.run_id ? state.q.findRun(p.run_id) : state.q.activeRunForAgent(c.agent_id);
      const runId =
        named && named.harness_id === harnessId && (p.run_id || taskId === null || named.task_id === taskId)
          ? named.run_id
          : null;
      state.recordObservation(
        pid,
        { kind: 'agent', id: c.agent_id },
        'context.requested',
        { task_id: taskId, run_id: runId, kind: p.kind, harness_id: harnessId, max_chars: p.max_chars },
        [
          ...(taskId ? [{ kind: 'task' as const, id: taskId }] : []),
          ...(runId ? [{ kind: 'run' as const, id: runId }] : []),
        ],
      );
      return deps.compile(
        {
          recipient: {
            kind: 'agent',
            id: c.agent_id,
            harness_id: harnessId,
            ...(p.run_id ? { run_id: p.run_id } : {}),
          },
          task_id: taskId ?? undefined,
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
      // The task's spending cap (plan M11.5): a `host.usage` whose cost reached
      // `routing.task_budget_usd` ends the attempt, once. The cap is read from the project's
      // configuration at each report, so a changed setting applies to the next one; a report
      // without a cost never trips it, and the state service decides the rest.
      if (p.event_type === 'host.usage' && p.run_id) {
        state.enforceTaskBudget(pid, {
          run_id: p.run_id,
          cost_usd: (p.data as { cost_usd?: unknown } | undefined)?.cost_usd,
          cap_usd: deps.project.config.routing.task_budget_usd ?? null,
        });
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
    case 'learning.propose': {
      const p = METHODS[method].params.parse(raw);
      const { protocol_version: _v, correlation_id: _c, idempotency_key, ...input } = p;
      const proposal = state.learnings.propose(pid, caller(), input, idempotency_key ? { idempotency_key } : {});
      return { proposal };
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
    // The code graph of the caller's checkout (ADR-0038 §2): the daemon routes' questions and bounds.
    case 'graph.query': {
      const p = METHODS[method].params.parse(raw);
      const c = caller();
      const g = await graphFor(deps, c);
      if (p.name) {
        const found = lookupSymbol(g, p.name, {
          ...(p.in_path ? { path: cleanPath(p.in_path) } : {}),
          ...(p.prefix ? { prefix: cleanPath(p.prefix) } : {}),
          limit: p.limit,
        });
        return { version: g.version, asked: 'symbol', symbol: found };
      }
      if (p.path) {
        const { version: _v, ...file } = graphQuery(g, p.path, p.depth);
        return { version: g.version, asked: 'file', file };
      }
      const hits = await (deps.graph as GraphService).search(p.words as string, {
        limit: p.limit,
        root: g.root,
        ...(p.kind ? { kind: p.kind } : {}),
      });
      return { version: g.version, asked: 'search', hits };
    }
    case 'graph.blast_radius': {
      const p = METHODS[method].params.parse(raw);
      const g = await graphFor(deps, caller());
      const symbols = p.symbols
        .map((s) => {
          const at = s.lastIndexOf('#');
          return at > 0 ? { path: cleanPath(s.slice(0, at)), symbol: s.slice(at + 1) } : null;
        })
        .filter((x): x is { path: string; symbol: string } => x !== null);
      const paths = p.paths.map(cleanPath);
      const seeds = p.diff ? [...new Set([...paths, ...g.identity.paths])] : paths;
      if (!seeds.length && !symbols.length) {
        throw new FridayError('invalid_request', 'the working tree has no changed file to seed the blast radius with');
      }
      return {
        version: g.version,
        ...blastRadius(g, { paths: seeds, symbols }, { depth: p.depth, includeNameMatches: p.names }),
      };
    }
    case 'graph.skeleton': {
      const p = METHODS[method].params.parse(raw);
      const g = await graphFor(deps, caller());
      const files: ResultOf<'graph.skeleton'>['files'] = [];
      const missing: ResultOf<'graph.skeleton'>['missing'] = [];
      for (const raw of p.paths) {
        const rel = cleanPath(raw);
        const sk = await skeletonOf(g, g.root, rel, p.level);
        if (sk) files.push(sk);
        else
          missing.push({
            path: rel,
            reason: 'not in the code graph (only TypeScript and JavaScript files git sees are)',
          });
      }
      return { version: g.version, files, missing };
    }
    case 'artifact.read': {
      const p = METHODS[method].params.parse(raw);
      return readArtifact(deps, caller(), p);
    }
  }
  throw new FridayError('invalid_request', `unhandled method ${method}`);
}
