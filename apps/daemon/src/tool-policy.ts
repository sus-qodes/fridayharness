import path from 'node:path';
import {
  type Autonomy,
  type Capability,
  type CommandClass,
  DEFAULT_RISK,
  evaluate,
  mcpLevel,
  type OtherWriter,
  type PolicyAction,
  type PolicyResult,
  patternsOverlap,
} from '@friday/policy';
import { type Actor, isFridayError, type TaskView } from '@friday/protocol';
import { type ProjectRef, policyVersion } from '@friday/sdk';
import type { FridayState, HarnessRecord } from '@friday/state';
import type { EffectivePolicy } from './policy.js';

export interface ToolJudgeInput {
  /** The session the action comes from, and the agent bound to it. */
  harness: HarnessRecord | undefined;
  agent: { agent_id: string; role: string } | undefined;
  /** What the host is about to do, with the host's name for the tool. */
  action: PolicyAction;
  actor: Actor;
  /** Claude Code's hook launcher already denied it, from what it could check alone. */
  decidedLocally?: boolean;
  /**
   * No human is at the host (a spawn adapter's session): where a human decides, one pending
   * approval is recorded for exactly this action, and the host is told no until it is granted.
   */
  askHuman?: boolean;
}

export interface ToolJudgement {
  result: PolicyResult;
  /** The task the session holds, which the decision was made for. */
  task: TaskView | null;
  /** The pending approval a human decides, when `askHuman` asked for one. */
  approval_id: string | null;
}

/** Judges one host tool call and records it (see `createToolJudge`). */
export type ToolJudge = (input: ToolJudgeInput) => ToolJudgement;

/**
 * One judgment of a host tool call (ADR-0032 §4), used by Claude Code's PreToolUse hook and by the
 * `tool.check` method of spawn adapters, so every host is held to the same effective policy (the
 * M3 lesson: one rule on every path). It applies the protected locations, the task and team
 * scopes, the project's deny rules and autonomy, file reservations, the one-live-writer rule and
 * worktree ownership; it takes the reservations an allowed write needs, spends the approvals an
 * allowed action relied on, and records the decision (`policy.evaluated`).
 */
export function createToolJudge(deps: {
  state: FridayState;
  project: ProjectRef;
  policy?: () => EffectivePolicy;
  /** The per-user state folder, which holds every project's private folder. */
  stateDir: string;
}): ToolJudge {
  const { state, project } = deps;
  const pid = project.project_id;

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

  /**
   * The one pending approval for an action a human decides (ADR-0032 §4): asking again while it
   * waits does not ask a human twice. The verdict is what a human decides: exactly the capability
   * and target the policy looks for when the host tries again.
   */
  const pendingApproval = (
    caller: { agent_id: string; harness_id: string },
    task: TaskView,
    toolName: string,
    result: PolicyResult,
  ): string | null => {
    if (!result.grant) return null;
    const { capability, target } = result.grant;
    const pending = (
      state.q.approvals(pid, 'pending') as {
        approval_id: string;
        requested_by_id: string;
        run_id: string | null;
        capability: string;
        target: string | null;
      }[]
    ).find(
      (a) =>
        a.requested_by_id === caller.agent_id &&
        a.run_id === task.current_run_id &&
        a.capability === capability &&
        a.target === target,
    );
    if (pending) return pending.approval_id;
    const effective = deps.policy?.();
    return state.requestPermission(
      pid,
      caller,
      {
        task_id: task.task_id,
        ...(task.current_run_id ? { run_id: task.current_run_id } : {}),
        action_class: capability,
        resource: target,
        justification: `${toolName}: ${result.reason}`.slice(0, 1000),
        ttl_s: 3600,
        reuse: 'once',
      },
      {
        capability,
        decision: 'review',
        risk: effective?.risk?.[capability as Capability] ?? DEFAULT_RISK[capability as Capability] ?? 'high',
        reason: result.reason,
        policy_version: effective?.version ?? policyVersion(project.config),
      },
    ).approval_id;
  };

  return ({ harness, agent, action, actor, decidedLocally, askHuman }) => {
    const toolName = action.tool;
    const task = heldTask(agent?.agent_id);
    const root = executionRoot(harness, task);
    const effective = deps.policy?.();
    const refs = [
      ...(task ? [{ kind: 'task' as const, id: task.task_id }] : []),
      ...(harness ? [{ kind: 'harness' as const, id: harness.harness_id }] : []),
    ];
    /** The approval that covers this session's use of a capability on a target (ADR-0027 §4). */
    const approvalFor = (capability: string, target: string) =>
      state.q.usableApproval(pid, {
        capability,
        target,
        task_id: task?.task_id ?? null,
        run_id: task?.current_run_id ?? null,
        agent_id: agent?.agent_id ?? null,
        policy_version: deps.policy?.().version ?? policyVersion(project.config),
        now: state.clock.now(),
      });
    // Conflict-prone files (ADR-0025): what other tasks hold, and what a first write takes.
    const reservations =
      action.kind === 'write' &&
      task &&
      (deps.policy?.().reservations_mode ?? project.config.reservations.mode) !== 'off'
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
      ctx: { projectRoot: root, mainRoot: project.root, stateDir: deps.stateDir },
      task: task
        ? {
            task_id: task.task_id,
            status: task.status,
            scope: task.scope,
            kind: task.kind,
            // The team scopes of the agent's role only tighten (ADR-0028).
            teams: (agent?.role ? effective?.teams[agent.role] : undefined) ?? [],
          }
        : null,
      otherWriters: action.kind === 'write' ? otherWriters(agent?.agent_id, root) : [],
      approved: (capability, target) => Boolean(approvalFor(capability, target)),
      autonomy: effective?.autonomy ?? (project.config.autonomy as Partial<Record<CommandClass, Autonomy>>),
      ...(effective ? { deny: effective.deny } : {}),
      ...(reservations ? { reservations } : {}),
      // Third-party MCP tools: the project's level for the server and tool (ADR-0030 §3).
      mcp: (server, tool) => (effective ? mcpLevel(effective, server, tool) : 'review'),
    });
    // A task worktree belongs to its task: a session that does not hold it (a stale attempt after
    // recovery, or one that never claimed it) may not write there (ADR-0026 §2).
    const tree = action.kind === 'write' && result.decision !== 'deny' ? state.q.worktreeAt(pid, root) : undefined;
    if (tree && tree.task_id !== task?.task_id) {
      result = {
        ...result,
        decision: 'deny',
        rule: 'write.not_your_worktree',
        reason: `this checkout is the worktree of ${tree.task_id}, which this session does not hold. Claim it with friday_task_claim to continue its work; if Friday gave it to another attempt, stop here.`,
      };
    }
    // While a human has paused Friday, nothing that changes the project runs; reads and searches
    // still pass (plan M9 §5.4). Judged here, so attached and spawned hosts stop alike.
    if (
      result.decision !== 'deny' &&
      action.kind !== 'read' &&
      action.kind !== 'search' &&
      state.q.control(pid).paused
    ) {
      result = {
        ...result,
        decision: 'deny',
        rule: 'control.paused',
        reason:
          'Friday is paused by a human. Wait and do not retry another way: nothing that changes the project runs until they resume Friday.',
        reserve: [],
        relied_on: [],
      };
    }
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
        decided_locally: decidedLocally === true,
        enforcement_level: harness?.enforcement_level ?? 'L0',
        enforcement_status: harness?.enforcement_status ?? 'observed',
      },
      refs,
    );
    if (result.rule === 'write.outside_scope' || result.rule === 'write.single_live_writer') {
      state.recordObservation(
        pid,
        actor,
        'scope.violation',
        { tool: toolName, targets: result.targets, rule: result.rule, task_id: task?.task_id ?? null },
        refs,
      );
    }
    // Approvals the allowed action relied on are used up now (ADR-0027 §5).
    if (result.decision === 'allow' && result.relied_on?.length) {
      const uses = result.relied_on
        .map((r) => ({ approval_id: approvalFor(r.capability, r.target), tool: toolName, target: r.target }))
        .filter((u): u is { approval_id: string; tool: string; target: string } => Boolean(u.approval_id));
      state.useApprovals(pid, actor, uses);
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
    const approvalId =
      askHuman && result.decision === 'ask' && task && agent && harness
        ? pendingApproval({ agent_id: agent.agent_id, harness_id: harness.harness_id }, task, toolName, result)
        : null;
    return { result, task, approval_id: approvalId };
  };
}
