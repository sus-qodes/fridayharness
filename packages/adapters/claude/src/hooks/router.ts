import path from 'node:path';
import type { DaemonContext } from '@friday/daemon';
import {
  type Autonomy,
  type CommandClass,
  canonicalize,
  evaluate,
  type OtherWriter,
  type PolicyResult,
  patternsOverlap,
} from '@friday/policy';
import { type Actor, FridayError, HarnessRegisterParams, isFridayError, type TaskView } from '@friday/protocol';
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
    const sameRoot = (a: string, b: string) =>
      process.platform === 'win32'
        ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
        : path.resolve(a) === path.resolve(b);

    /** Live writers in the same checkout: one live writer per working tree (plan B26, ADR-0023 §6). */
    const otherWriters = (agentId: string | undefined, root: string): OtherWriter[] => {
      const now = state.clock.now();
      return state.q
        .tasks(pid, { statuses: ['RUNNING'] })
        .filter(
          (t) =>
            t.assigned_agent_id !== agentId &&
            t.assigned_harness_id &&
            state.q.isHarnessLive(t.assigned_harness_id, now) &&
            sameRoot(executionRoot(state.q.findHarness(t.assigned_harness_id), t), root),
        )
        .map((t) => ({
          task_id: t.task_id,
          agent_key: (t.assigned_agent_id && state.q.findAgent(t.assigned_agent_id)?.agent_key) || 'another agent',
          scope: t.scope,
        }));
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
          if (!action) return c.json({ ok: true, hook_output: null });
          const task = heldTask(agent?.agent_id);
          const root = executionRoot(harness, task);
          // Conflict-prone files (ADR-0025): what other tasks hold, and what a first write takes.
          const reservations =
            action.kind === 'write' && task && project.config.reservations.mode !== 'off'
              ? {
                  required: project.config.reservations.required,
                  held: state.q
                    .fileReservations(pid, ['active'])
                    .filter((r) => r.task_id !== task.task_id)
                    .map((r) => ({ pattern: r.pattern, task_id: r.task_id })),
                }
              : undefined;
          let result: PolicyResult = evaluate({
            action,
            ctx: { projectRoot: root, mainRoot: project.root, stateDir: path.dirname(path.dirname(ctx.privateDir)) },
            task: task ? { task_id: task.task_id, status: task.status, scope: task.scope, kind: task.kind } : null,
            otherWriters: action.kind === 'write' ? otherWriters(agent?.agent_id, root) : [],
            approved: (capability, target) => state.q.grantedApproval(pid, capability, target, state.clock.now()),
            autonomy: project.config.autonomy as Partial<Record<CommandClass, Autonomy>>,
            ...(reservations ? { reservations } : {}),
          });
          if (result.decision === 'allow' && result.reserve?.length && task) {
            try {
              state.reserveFiles(pid, actor, task.task_id, result.reserve, 'write', patternsOverlap);
            } catch (e) {
              // Another task took the files between the check and now: refuse like any held file.
              if (!isFridayError(e) || e.errorName !== 'reservation_conflict') throw e;
              const d = (e.details ?? {}) as { holder_task_id?: string; pattern?: string };
              result = {
                ...result,
                decision: 'deny',
                rule: 'write.reserved',
                reason: `${e.message}. Wait for it, or coordinate through friday_communicate.`,
                reserved_by: { task_id: d.holder_task_id ?? 'another task', pattern: d.pattern ?? '' },
              };
            }
          }
          state.recordObservation(
            pid,
            actor,
            'policy.evaluated',
            {
              tool: toolName,
              kind: action.kind,
              decision: result.decision,
              rule: result.rule,
              reason: result.reason,
              targets: result.targets,
              command_class: result.command_class ?? null,
              sensitive_class: result.sensitive_class ?? null,
              task_id: task?.task_id ?? null,
              decided_locally: body.local_decision === 'deny',
              enforcement_level: harness?.enforcement_level ?? 'L0',
              enforcement_status: harness?.enforcement_status ?? 'observed',
            },
            refs(task),
          );
          if (result.rule === 'write.outside_scope' || result.rule === 'write.single_live_writer') {
            state.recordObservation(
              pid,
              actor,
              'scope.violation',
              { tool: toolName, targets: result.targets, rule: result.rule, task_id: task?.task_id ?? null },
              refs(task),
            );
          }
          if (result.rule === 'write.reserved' && result.reserved_by) {
            state.ownershipConflict(pid, actor, {
              task_id: task?.task_id ?? null,
              targets: result.targets,
              holder_task_id: result.reserved_by.task_id,
              pattern: result.reserved_by.pattern,
              tool: toolName,
            });
          }
          if (result.decision === 'allow') return c.json({ ok: true, hook_output: null });
          return c.json({
            ok: true,
            hook_output: {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: result.decision,
                permissionDecisionReason: `Friday: ${result.reason}`,
              },
            },
          });
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
          const run = task?.current_run_id ? state.q.findRun(task.current_run_id) : undefined;
          if (changed.length && run && harness && run.harness_id === harness.harness_id && run.status === 'ACTIVE') {
            state.observePaths(pid, { kind: 'harness', id: harness.harness_id }, run.run_id, changed);
          }
          state.recordObservation(
            pid,
            actor,
            'agent.event',
            {
              task_id: task?.task_id ?? null,
              run_id: run?.run_id ?? null,
              event_type: failed ? 'tool.failed' : 'tool.completed',
              tool: toolName,
              summary:
                action?.kind === 'command' ? String(action.command).slice(0, 200) : changed.join(', ') || toolName,
              changed_paths: changed,
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
          if (hook.stop_hook_active || !agent) return c.json({ ok: true, hook_output: null });
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
