import type { DaemonContext } from '@friday/daemon';
import { canonicalize } from '@friday/policy';
import { type Actor, FridayError, HarnessRegisterParams, type TaskView } from '@friday/protocol';
import { renderContextMarkdown } from '@friday/sdk';
import type { HarnessRecord } from '@friday/state';
import type { Hono } from 'hono';
import { actionFromTool } from './actions.js';
import { claudeHookOutput } from './hosts/claude-code.js';
import { cursorHookFailure } from './hosts/cursor.js';
import { HOST_MODULES } from './hosts/index.js';
import { type HookJudgment, type HookVendor, isHookVendor, WRITE_TOOLS } from './types.js';

interface HookBody {
  schema_version?: number;
  launcher_version?: string;
  /** Claude Code's launcher sends its parent as `claude_pid`; every launcher from M8b.1 also as `host_pid`. */
  claude_pid?: number;
  host_pid?: number;
  agent_key?: string | null;
  local_decision?: 'deny' | null;
  /** The hook in Friday's vocabulary: Claude Code's own input, or another host's translated by its module. */
  hook: Record<string, unknown>;
  /** For a host other than Claude Code: what its module read beside the hook. */
  host?: {
    vendor?: string;
    event?: string;
    tool_name?: string | null;
    version?: string | null;
    /** False where the host's hook cannot ask a human (Cursor's `preToolUse`). */
    can_ask?: boolean;
    /** Stop: false where the host says the turn ended other than by the agent (a human's stop, an error). */
    stop_completed?: boolean | null;
    stop_reason?: string | null;
  };
}

/** The router's answer: Friday's judgment, or the `allow` only Claude Code's spawned sessions get (ADR-0032 §11). */
type Outcome = HookJudgment | { decision: 'allow'; reason: string };

/**
 * Daemon routes for every host's hooks (plan M1.10, M8b.1): POST
 * /api/v1/projects/:pid/hooks/:vendor/:event with the bootstrap token, `:event` in Friday's names.
 * Friday only restricts: "allow" returns no decision, so the host's own permission rules still
 * apply. Claude Code gets its hook output (`hook_output`), as it always has; every host gets
 * Friday's judgment (`judgment`), which the launcher's host module turns into the host's reply.
 */
export function claudeCodeHooks(): (app: Hono, ctx: DaemonContext) => void {
  return (app, ctx) => {
    const { state, project } = ctx;
    const pid = project.project_id;

    const hostPid = (body: HookBody) => body.host_pid ?? body.claude_pid;
    const keyFor = (vendor: HookVendor, body: HookBody) => `${vendor}:${pid}:pid:${hostPid(body)}`;

    const harnessFor = (
      vendor: HookVendor,
      hook: Record<string, unknown>,
      body: HookBody,
    ): HarnessRecord | undefined => {
      const sid = typeof hook.session_id === 'string' ? hook.session_id : undefined;
      const bySession = sid ? state.q.harnessBySession(pid, vendor, sid) : undefined;
      if (bySession && bySession.status !== 'TERMINATED') return bySession;
      const byKey = hostPid(body) ? state.q.harnessByKey(pid, keyFor(vendor, body)) : undefined;
      if (byKey || vendor === 'claude-code' || !sid) return byKey;
      // Cursor, Antigravity and Gemini CLI run hooks through a shell, so a hook's parent is never
      // the process that started the MCP server, and the server is not told the session's id: the
      // session is the live attached one of this host and agent that no hook has reached yet.
      const agentKey = body.agent_key || state.config.defaultAgentKey;
      const mcp = state.q.hooklessAttachHarness(pid, vendor, agentKey, state.clock.now());
      if (!mcp) return undefined;
      state.bindSession(pid, vendor, sid, mcp.harness_id, null);
      return state.q.harness(mcp.harness_id);
    };

    const ensureHarness = (
      vendor: HookVendor,
      hook: Record<string, unknown>,
      body: HookBody,
    ): HarnessRecord | undefined => {
      let h = harnessFor(vendor, hook, body);
      const sid = typeof hook.session_id === 'string' ? hook.session_id : undefined;
      const hostVersion = typeof body.host?.version === 'string' && body.host.version ? body.host.version : undefined;
      const hp = hostPid(body);
      if (!h && hp) {
        // The hook can arrive before the MCP server registered; register the same harness key it will use.
        state.registerHarness(
          pid,
          HarnessRegisterParams.parse({
            protocol_version: '1.0',
            harness_key: keyFor(vendor, body),
            vendor,
            name: HOST_MODULES[vendor].name,
            // A host that tells its hooks its version (Cursor) is recorded with it; Claude Code tells its MCP server.
            ...(hostVersion ? { version: hostVersion.slice(0, 100) } : {}),
            attach_mode: 'attach',
            project_id: pid,
            // Another host's MCP server registers apart from its hooks (another parent pid): when it
            // does, it takes this session over (`hooks_route`), so the agent keeps one harness.
            capabilities: vendor === 'claude-code' ? { hooks: true } : { hooks: true, hooks_route: true },
            host: { pid: hp, ...(sid ? { session_id: sid.slice(0, 200) } : {}) },
            agent: { ...(body.agent_key ? { agent_key: body.agent_key } : {}) },
          }),
        );
        h = harnessFor(vendor, hook, body);
      }
      if (h && sid && h.host_session_id !== sid) state.bindSession(pid, vendor, sid, h.harness_id, null);
      return h;
    };

    /**
     * Stops a host nudged without saying so (no `stop_hook_active`): the next stop after a nudge
     * passes, so a session is held at most once in a row, as Claude Code's flag makes it.
     */
    const nudged = new Set<string>();

    const agentOf = (h: HarnessRecord | undefined) => {
      if (!h) return undefined;
      const bound = state.q.agents(pid).find((a) => a.harness_id === h.harness_id);
      return bound ?? (h.requested_agent_key ? state.q.agentByKey(pid, h.requested_agent_key) : undefined);
    };

    const heldTask = (agentId: string | undefined): TaskView | null => {
      if (!agentId) return null;
      return (
        state.q.tasks(pid, { statuses: ['RUNNING', 'WAITING'] }).find((t) => t.assigned_agent_id === agentId) ?? null
      );
    };

    /** The checkout a session works in (ADR-0023 §6): its run's execution root, else its own checkout. */
    const executionRoot = (h: HarnessRecord | undefined, task: TaskView | null): string => {
      const run = task?.current_run_id ? state.q.findRun(task.current_run_id) : undefined;
      if (run?.execution_root && h && run.harness_id === h.harness_id) return run.execution_root;
      return h?.host_cwd ?? project.root;
    };

    app.post('/api/v1/projects/:pid/hooks/:vendor/:event', async (c) => {
      const auth = (c as unknown as { get(k: 'auth'): { token_class: string } }).get('auth');
      if (auth.token_class !== 'bootstrap') {
        throw new FridayError('token_scope_insufficient', 'hook endpoints need the bootstrap token');
      }
      if (c.req.param('pid') !== pid) throw new FridayError('project_not_found', 'unknown project');
      const vendor = c.req.param('vendor');
      if (!isHookVendor(vendor)) throw new FridayError('invalid_request', `Friday has no hooks for "${vendor}"`);
      const claude = vendor === 'claude-code';
      const event = c.req.param('event');
      let body: HookBody;
      try {
        body = (await c.req.json()) as HookBody;
      } catch {
        throw new FridayError('invalid_request', 'hook body must be JSON');
      }
      const hook = body.hook ?? {};
      if (hook.hook_event_name && hook.hook_event_name !== event) {
        throw new FridayError('invalid_request', `hook event mismatch (${String(hook.hook_event_name)} vs ${event})`);
      }
      /**
       * The reply: Claude Code's hook output as it has always been, and Friday's judgment for every
       * host. Friday's judgment never says allow, even where Claude Code's spawned session is told so.
       */
      const reply = (o: Outcome) =>
        c.json({
          ok: true,
          hook_output: claude ? claudeHookOutput(o) : null,
          judgment: (o.decision === 'allow' ? { decision: 'none' } : o) satisfies HookJudgment,
        });
      const none = () => reply({ decision: 'none' });
      const found = event === 'SessionStart' ? ensureHarness(vendor, hook, body) : harnessFor(vendor, hook, body);
      // A Friday hook from this session reached the daemon: the evidence behind L1 (review F09).
      // For an attached Cursor session, the level also rests on its hooks file and the version its
      // hooks report (plan B21): read once, when the first hook arrives.
      const evidence =
        found && !found.hooks_seen_at && vendor === 'cursor' && found.attach_mode === 'attach'
          ? {
              host_version: typeof body.host?.version === 'string' && body.host.version ? body.host.version : null,
              hook_failure: cursorHookFailure(found.host_cwd ?? project.root),
            }
          : undefined;
      const harness = found ? state.noteHookEvidence(pid, found.harness_id, evidence) : undefined;
      const agent = agentOf(harness);
      // A session Friday's spawn adapter started (ADR-0032 §11): no human is at it, the adapter gives
      // it its context and ends it, and the adapter's harness outlives each session.
      const spawned = harness?.attach_mode === 'spawn';
      const actor: Actor = agent
        ? { kind: 'agent', id: agent.agent_id }
        : {
            kind: 'harness',
            id: harness?.harness_id ?? `${claude ? 'claude' : vendor}-pid:${hostPid(body) ?? '?'}`,
          };
      const refs = (task: TaskView | null) => [
        ...(task ? [{ kind: 'task' as const, id: task.task_id }] : []),
        ...(harness ? [{ kind: 'harness' as const, id: harness.harness_id }] : []),
      ];

      switch (event) {
        case 'SessionStart': {
          const task = heldTask(agent?.agent_id);
          state.recordObservation(
            pid,
            actor,
            'harness.session_started',
            {
              source: hook.source ?? null,
              session_id: hook.session_id ?? null,
              harness_id: harness?.harness_id ?? null,
            },
            refs(task),
          );
          if (!agent || !harness)
            return reply({
              decision: 'context',
              brief: true,
              text: 'Friday could not identify this session yet. Call friday_whoami before editing.',
            });
          // The model this session runs, when the host reports it (ADR-0031 §7).
          const model = typeof hook.model === 'string' ? hook.model : (hook.model as { id?: unknown } | undefined)?.id;
          if (typeof model === 'string' && model) {
            state.observeModel(pid, actor, { harness_id: harness.harness_id }, model, 'session_start');
          }
          if (spawned) return none();
          const packet = await ctx.compile(
            {
              recipient: { kind: 'agent', id: agent.agent_id, harness_id: harness.harness_id },
              task_id: task?.task_id,
              purpose: `session_${String(hook.source ?? 'start')}`,
              max_chars: project.config.context.session_start_max_chars,
            },
            actor,
          );
          const shadowNote = harness.shadow
            ? `\n\nNOTE: agent "${agent.agent_key}" is already attached to another live session, so this session is a shadow and cannot claim tasks. Ask the human to start this session with a different FRIDAY_AGENT.`
            : '';
          const additionalContext =
            renderContextMarkdown(packet, project.config.context.session_start_max_chars - shadowNote.length) +
            shadowNote;
          return reply({ decision: 'context', text: additionalContext });
        }

        case 'PreToolUse': {
          const toolName = String(hook.tool_name ?? '');
          const action = actionFromTool(toolName, (hook.tool_input as Record<string, unknown>) ?? {});
          // Claude Code's spawned sessions run only tools Friday judges (`--tools`); Friday answers
          // their calls itself. Another host's spawned session keeps tools Friday cannot judge, and
          // Friday only restricts there (B9).
          const decidesForHost = spawned && claude;
          if (!action) {
            if (!decidesForHost) return none();
            // A spawned session has only the tools Friday judges, and the one that hands back its
            // final answer (`--json-schema`), which acts on nothing: anything else is refused.
            return reply(
              toolName === 'StructuredOutput'
                ? { decision: 'allow', reason: 'the final answer, which Friday verifies' }
                : {
                    decision: 'deny',
                    reason: `${toolName} is not a tool Friday judges, so a spawned session may not use it`,
                  },
            );
          }
          // Where no human answers in the host (a spawned session, or a hook that cannot ask), a
          // human's decision is one pending approval, and the call is declined until it is granted.
          const cannotAsk = spawned || body.host?.can_ask === false;
          // The same judgment as every other host's tool calls (ADR-0032 §4).
          const { result, approval_id } = ctx.judgeTool({
            harness,
            agent: agent ? { agent_id: agent.agent_id, role: agent.role } : undefined,
            action,
            actor,
            decidedLocally: body.local_decision === 'deny',
            askHuman: cannotAsk,
          });
          if (result.decision === 'ask' && cannotAsk) {
            return reply({
              decision: 'deny',
              reason: `${result.reason}. A human decides this${approval_id ? ` (approval ${approval_id})` : ''}: it is declined until then. Do not try it another way; if you cannot finish without it, end as blocked and say so.`,
            });
          }
          if (result.decision === 'allow') {
            // Friday decides for Claude Code's spawned session: what it allows goes ahead without a
            // prompt nobody would answer. Attached sessions: Friday only restricts, and the host's
            // own rules still apply.
            return decidesForHost ? reply({ decision: 'allow', reason: result.reason }) : none();
          }
          return reply({ decision: result.decision, reason: result.reason });
        }

        case 'PostToolUse':
        case 'PostToolUseFailure': {
          const toolName = String(hook.tool_name ?? '');
          // What is recorded: Friday's name for the tool, else the host's own (a tool Friday does not judge).
          const recordedTool = toolName || String(body.host?.tool_name ?? '');
          const task = heldTask(agent?.agent_id);
          const action = actionFromTool(toolName, (hook.tool_input as Record<string, unknown>) ?? {});
          const failed = event === 'PostToolUseFailure';
          let changed: string[] = [];
          if (!failed && WRITE_TOOLS.has(toolName) && action?.paths?.length) {
            const root = executionRoot(harness, task);
            changed = action.paths
              .map((p) => canonicalize(p, { projectRoot: root }).relative)
              .filter((p): p is string => Boolean(p));
          }
          // The call counts for the attempt only when this session is the one running it: a second
          // live session of the same agent (a shadow, or one restarted during the reconnect grace)
          // resolves to the same agent and task, and its reads and edits are not the attempt's.
          const current = task?.current_run_id ? state.q.findRun(task.current_run_id) : undefined;
          const run = current && harness && current.harness_id === harness.harness_id ? current : undefined;
          if (changed.length && run && run.status === 'ACTIVE') {
            state.observePaths(pid, { kind: 'harness', id: run.harness_id }, run.run_id, changed);
          }
          // What a read looked at and whether it asked for a line range (`offset` or `limit`): the
          // token baseline counts whole-file reads against ranged ones per attempt (plan M10a).
          const input = (hook.tool_input as Record<string, unknown>) ?? {};
          const asked = (v: unknown) => typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v));
          const read =
            !failed && action?.kind === 'read' && action.paths?.[0]
              ? {
                  path: canonicalize(action.paths[0], { projectRoot: executionRoot(harness, task) }).relative ?? null,
                  ranged: asked(input.offset) || asked(input.limit),
                }
              : null;
          state.recordObservation(
            pid,
            actor,
            'agent.event',
            {
              task_id: task?.task_id ?? null,
              run_id: run?.run_id ?? null,
              harness_id: harness?.harness_id ?? null,
              event_type: failed ? 'tool.failed' : 'tool.completed',
              tool: recordedTool,
              summary:
                action?.kind === 'command' ? String(action.command).slice(0, 200) : changed.join(', ') || recordedTool,
              changed_paths: changed,
              read,
              error: failed ? String(hook.error ?? '').slice(0, 500) : null,
            },
            refs(task),
          );
          return none();
        }

        case 'Stop': {
          const task = heldTask(agent?.agent_id);
          const previous = harness
            ? state.store
                .readByRef(pid, 'harness', harness.harness_id, { types: ['agent.turn_ended'], limit: 1000 })
                .at(-1)
            : undefined;
          state.recordObservation(
            pid,
            actor,
            'agent.turn_ended',
            { harness_id: harness?.harness_id ?? null, task_id: task?.task_id ?? null },
            refs(task),
          );
          // A spawned session's end is its adapter's to report.
          if (hook.stop_hook_active || !agent || spawned) return none();
          // A turn the host says ended other than by the agent (a human's stop, an error, a step
          // limit) is never held: the host would send Friday's message as the next prompt and the
          // agent would go on against the human's decision, at a model turn's cost (B31).
          if (!claude && body.host?.stop_completed === false) return none();
          // A host that does not say whether it is already continuing for a stop hook: the stop
          // right after Friday held the session passes, so it is held at most once in a row.
          if (!claude && typeof hook.stop_hook_active !== 'boolean' && harness && nudged.delete(harness.harness_id)) {
            return none();
          }
          const hold = (reason: string) => {
            if (!claude && harness) nudged.add(harness.harness_id);
            return reply({ decision: 'continue', reason });
          };
          // Urgent and blocking messages surface before the session stops (Part 05 §15, M3b).
          const waiting = state
            .peekInbox(pid, agent.agent_id, 20)
            .items.filter(
              (m) => m.state === 'queued' && (m.blocking || m.priority === 'urgent' || m.priority === 'high'),
            );
          if (waiting.length) {
            const first = waiting[0] as (typeof waiting)[number];
            return hold(
              `${waiting.length} ${waiting.length === 1 ? 'message needs' : 'messages need'} your attention (first: ${first.priority}${first.blocking ? ', blocking' : ''} ${first.mode} from ${first.from.agent_key ?? first.from.kind}: "${(first.subject ?? first.body).slice(0, 80)}"). Read them with friday_check_inbox, answer or acknowledge, then stop.`,
            );
          }
          if (task?.status !== 'RUNNING') return none();
          const since = previous?.sequence ?? 0;
          const reported = state.store
            .readByRef(pid, 'task', task.task_id, { limit: 2000 })
            .some(
              (e) =>
                e.sequence > since &&
                e.actor.id === agent.agent_id &&
                e.type === 'agent.event' &&
                (e.payload as { event_type?: string }).event_type === 'progress',
            );
          if (reported) return none();
          return hold(
            `task ${task.task_id} is RUNNING and nothing was reported this turn. Call friday_report_progress (or friday_claim_done if the work is finished) before stopping.`,
          );
        }

        case 'SessionEnd': {
          const reason = String(hook.reason ?? 'other');
          state.recordObservation(
            pid,
            actor,
            'harness.session_ended',
            { reason, session_id: hook.session_id ?? null },
            refs(null),
          );
          if (
            harness &&
            !spawned &&
            !['clear', 'resume', 'compact'].includes(reason) &&
            harness.status !== 'DISCONNECTED' &&
            harness.status !== 'TERMINATED'
          ) {
            state.disconnectHarness(pid, harness.harness_id, `session_end:${reason}`, false);
          }
          if (harness) nudged.delete(harness.harness_id);
          return none();
        }

        default:
          return none();
      }
    });
  };
}
