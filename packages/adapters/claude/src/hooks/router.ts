import type { DaemonContext } from '@friday/daemon';
import { canonicalize } from '@friday/policy';
import { type Actor, FridayError, HarnessRegisterParams, type TaskView } from '@friday/protocol';
import { renderContextMarkdown } from '@friday/sdk';
import type { HarnessRecord } from '@friday/state';
import type { Hono } from 'hono';
import { actionFromTool } from './actions.js';
import { WRITE_TOOLS } from './types.js';

interface HookBody {
  schema_version?: number;
  launcher_version?: string;
  claude_pid?: number;
  agent_key?: string | null;
  local_decision?: 'deny' | null;
  hook: Record<string, unknown>;
}

const VENDOR = 'claude-code';

/**
 * Daemon routes for Claude Code hooks (plan M1.10): POST /api/v1/projects/:pid/hooks/claude-code/:event
 * with the bootstrap token. Friday only restricts: "allow" returns no decision, so Claude Code's
 * own permission rules still apply.
 */
export function claudeCodeHooks(): (app: Hono, ctx: DaemonContext) => void {
  return (app, ctx) => {
    const { state, project } = ctx;
    const pid = project.project_id;

    const harnessFor = (hook: Record<string, unknown>, body: HookBody): HarnessRecord | undefined => {
      const sid = typeof hook.session_id === 'string' ? hook.session_id : undefined;
      const bySession = sid ? state.q.harnessBySession(pid, VENDOR, sid) : undefined;
      if (bySession && bySession.status !== 'TERMINATED') return bySession;
      return body.claude_pid ? state.q.harnessByKey(pid, `${VENDOR}:${pid}:pid:${body.claude_pid}`) : undefined;
    };

    const ensureHarness = (hook: Record<string, unknown>, body: HookBody): HarnessRecord | undefined => {
      let h = harnessFor(hook, body);
      const sid = typeof hook.session_id === 'string' ? hook.session_id : undefined;
      if (!h && body.claude_pid) {
        // The hook can arrive before the MCP server registered; register the same harness key it will use.
        state.registerHarness(
          pid,
          HarnessRegisterParams.parse({
            protocol_version: '1.0',
            harness_key: `${VENDOR}:${pid}:pid:${body.claude_pid}`,
            vendor: VENDOR,
            name: 'Claude Code',
            attach_mode: 'attach',
            project_id: pid,
            capabilities: { hooks: true },
            host: { pid: body.claude_pid, ...(sid ? { session_id: sid } : {}) },
            agent: { ...(body.agent_key ? { agent_key: body.agent_key } : {}) },
          }),
        );
        h = harnessFor(hook, body);
      }
      if (h && sid && h.host_session_id !== sid) state.bindSession(pid, VENDOR, sid, h.harness_id, null);
      return h;
    };

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

    app.post('/api/v1/projects/:pid/hooks/claude-code/:event', async (c) => {
      const auth = (c as unknown as { get(k: 'auth'): { token_class: string } }).get('auth');
      if (auth.token_class !== 'bootstrap') {
        throw new FridayError('token_scope_insufficient', 'hook endpoints need the bootstrap token');
      }
      if (c.req.param('pid') !== pid) throw new FridayError('project_not_found', 'unknown project');
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
      const found = event === 'SessionStart' ? ensureHarness(hook, body) : harnessFor(hook, body);
      // A Friday hook from this session reached the daemon: the evidence behind L1 (review F09).
      const harness = found ? state.noteHookEvidence(pid, found.harness_id) : undefined;
      const agent = agentOf(harness);
      // A session Friday's spawn adapter started (ADR-0032 §11): no human is at it, the adapter gives
      // it its context and ends it, and the adapter's harness outlives each session.
      const spawned = harness?.attach_mode === 'spawn';
      const actor: Actor = agent
        ? { kind: 'agent', id: agent.agent_id }
        : { kind: 'harness', id: harness?.harness_id ?? `claude-pid:${body.claude_pid ?? '?'}` };
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
            return c.json({
              ok: true,
              hook_output: 'Friday could not identify this session yet. Call friday_whoami before editing.',
            });
          // The model this session runs, when Claude Code reports it (ADR-0031 §7).
          const model = typeof hook.model === 'string' ? hook.model : (hook.model as { id?: unknown } | undefined)?.id;
          if (typeof model === 'string' && model) {
            state.observeModel(pid, actor, { harness_id: harness.harness_id }, model, 'session_start');
          }
          if (spawned) return c.json({ ok: true, hook_output: null });
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
          return c.json({
            ok: true,
            hook_output: { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } },
          });
        }

        case 'PreToolUse': {
          const toolName = String(hook.tool_name ?? '');
          const action = actionFromTool(toolName, (hook.tool_input as Record<string, unknown>) ?? {});
          if (!action) {
            if (!spawned) return c.json({ ok: true, hook_output: null });
            // A spawned session has only the tools Friday judges, and the one that hands back its
            // final answer (`--json-schema`), which acts on nothing: anything else is refused.
            const decision = toolName === 'StructuredOutput' ? 'allow' : 'deny';
            return c.json({
              ok: true,
              hook_output: {
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: decision,
                  permissionDecisionReason:
                    decision === 'allow'
                      ? 'Friday: the final answer, which Friday verifies'
                      : `Friday: ${toolName} is not a tool Friday judges, so a spawned session may not use it`,
                },
              },
            });
          }
          // The same judgment as every other host's tool calls (ADR-0032 §4).
          const { result, approval_id } = ctx.judgeTool({
            harness,
            agent: agent ? { agent_id: agent.agent_id, role: agent.role } : undefined,
            action,
            actor,
            decidedLocally: body.local_decision === 'deny',
            askHuman: spawned,
          });
          const decide = (decision: string, reason: string) =>
            c.json({
              ok: true,
              hook_output: {
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: decision,
                  permissionDecisionReason: `Friday: ${reason}`,
                },
              },
            });
          if (spawned) {
            // Friday decides for a spawned session: what it allows goes ahead without a prompt
            // nobody would answer, and what a human decides is declined until one has.
            if (result.decision === 'allow') return decide('allow', result.reason);
            if (result.decision === 'ask') {
              return decide(
                'deny',
                `${result.reason}. A human decides this${approval_id ? ` (approval ${approval_id})` : ''}: it is declined until then. Do not try it another way; if you cannot finish without it, end as blocked and say so.`,
              );
            }
            return decide('deny', result.reason);
          }
          // Attached sessions: Friday only restricts, and Claude Code's own rules still apply.
          if (result.decision === 'allow') return c.json({ ok: true, hook_output: null });
          return decide(result.decision, result.reason);
        }

        case 'PostToolUse':
        case 'PostToolUseFailure': {
          const toolName = String(hook.tool_name ?? '');
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
              tool: toolName,
              summary:
                action?.kind === 'command' ? String(action.command).slice(0, 200) : changed.join(', ') || toolName,
              changed_paths: changed,
              read,
              error: failed ? String(hook.error ?? '').slice(0, 500) : null,
            },
            refs(task),
          );
          return c.json({ ok: true, hook_output: null });
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
          if (hook.stop_hook_active || !agent || spawned) return c.json({ ok: true, hook_output: null });
          // Urgent and blocking messages surface before the session stops (Part 05 §15, M3b).
          const waiting = state
            .peekInbox(pid, agent.agent_id, 20)
            .items.filter(
              (m) => m.state === 'queued' && (m.blocking || m.priority === 'urgent' || m.priority === 'high'),
            );
          if (waiting.length) {
            const first = waiting[0] as (typeof waiting)[number];
            return c.json({
              ok: true,
              hook_output: {
                decision: 'block',
                reason: `Friday: ${waiting.length} ${waiting.length === 1 ? 'message needs' : 'messages need'} your attention (first: ${first.priority}${first.blocking ? ', blocking' : ''} ${first.mode} from ${first.from.agent_key ?? first.from.kind}: "${(first.subject ?? first.body).slice(0, 80)}"). Read them with friday_check_inbox, answer or acknowledge, then stop.`,
              },
            });
          }
          if (task?.status !== 'RUNNING') return c.json({ ok: true, hook_output: null });
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
          if (reported) return c.json({ ok: true, hook_output: null });
          return c.json({
            ok: true,
            hook_output: {
              decision: 'block',
              reason: `Friday: task ${task.task_id} is RUNNING and nothing was reported this turn. Call friday_report_progress (or friday_claim_done if the work is finished) before stopping.`,
            },
          });
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
          return c.json({ ok: true, hook_output: null });
        }

        default:
          return c.json({ ok: true, hook_output: null });
      }
    });
  };
}
