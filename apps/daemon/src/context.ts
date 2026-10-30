import {
  type CompileInput,
  ContextCache,
  type ContextDeps,
  type ContextPolicy,
  compileContext,
  packetStaleness,
} from '@friday/context';
import { GitRoot } from '@friday/git';
import type { Actor, ContextExplanation, ContextPacket } from '@friday/protocol';
import type { ProjectRef } from '@friday/sdk';
import type { FridayState } from '@friday/state';
import type { GraphService } from './graph-service.js';

export type { CompileInput } from '@friday/context';

import { createReadFilter, executionRootOf } from '@friday/context';

/** The task states of an active attempt, in which read grants count. */
const ACTIVE = new Set(['ASSIGNED', 'RUNNING', 'WAITING']);

/**
 * The context compiler of the daemon (ADR-0022) over the project's execution root: the main
 * checkout until M5 (ADR-0014). Packets are cached by their key and explained.
 */
/** What an agent may read of a checkout, judged as the compiler judges it (review 2026-10-22 R1). */
export interface RecipientReadFilter {
  /** The recipient's execution root, where the paths are relative to. */
  root: string;
  readable: (relativePath: string) => boolean;
}

export interface ContextService {
  compile(input: CompileInput, actor: Actor): Promise<ContextPacket>;
  /**
   * The read permission of an agent for a graph answer (ADR-0038 §2): the task's and team's read
   * scopes, `deny.read` and the protected locations, under the policy as it is now. A human's read
   * grant opens a file through `friday_request_context`, not through the graph, so no grant counts
   * here and none is spent.
   */
  readFilter(recipient: { agent_id: string; harness_id: string }): RecipientReadFilter;
  /** The stored packet with a fresh staleness verdict. */
  packet(contextId: string): Promise<ContextPacket | undefined>;
  explanation(contextId: string): ContextExplanation | undefined;
}

export function createContextService(opts: {
  state: FridayState;
  project: ProjectRef;
  graph: GraphService;
  stateDir?: string;
  /** The effective policy (ADR-0028): context applies its read rule and keys packets by its version (review F02). */
  policy?: () => ContextPolicy;
}): ContextService {
  // One git view per checkout: the main one and each task worktree (ADR-0023).
  const roots = new Map<string, Promise<GitRoot | null>>();
  const deps: ContextDeps = {
    state: opts.state,
    project: opts.project as unknown as ContextDeps['project'],
    git: (dir) => {
      const key = process.platform === 'win32' ? dir.toLowerCase() : dir;
      let root = roots.get(key);
      if (!root) {
        root = GitRoot.open(dir).catch(() => null);
        roots.set(key, root);
        if (roots.size > 32) roots.delete(roots.keys().next().value as string);
      }
      return root;
    },
    graph: (dir, identity) => opts.graph.graph(dir, identity),
    ...(opts.stateDir ? { stateDir: opts.stateDir } : {}),
    cache: new ContextCache(),
    ...(opts.policy ? { policy: opts.policy } : {}),
    // The exact paths a human let this agent read for this task, under the current policy.
    readGrants: (input, task) => {
      if (input.recipient.kind !== 'agent' || !task) return [];
      // Grants are bound to an attempt: they count only while the recipient holds the task in an
      // active attempt, so a task cancelled or reassigned meanwhile ends them (review M7.1 R02).
      if (task.assigned_agent_id !== input.recipient.id || !ACTIVE.has(task.status)) return [];
      return opts.state.q.usableGrants(opts.project.project_id, {
        capability: 'file.read',
        task_id: task.task_id,
        run_id: task.current_run_id,
        agent_id: input.recipient.id,
        policy_version: opts.policy?.().version ?? null,
        now: opts.state.clock.now(),
      });
    },
  };
  const explanation = (id: string) => opts.state.q.contextExplanation(id) as ContextExplanation | undefined;
  return {
    async compile(input, actor) {
      return (await compileContext(deps, input, actor)).packet;
    },
    readFilter(recipient) {
      const agent = opts.state.q.findAgent(recipient.agent_id);
      const task = agent?.current_task_id
        ? opts.state.q.findTask(opts.project.project_id, agent.current_task_id)
        : undefined;
      const input: CompileInput = {
        recipient: { kind: 'agent', id: recipient.agent_id, harness_id: recipient.harness_id },
        purpose: 'graph',
        ...(task ? { task_id: task.task_id } : {}),
      };
      const root = executionRootOf(deps, input, task);
      const { readable } = createReadFilter({
        root,
        mainRoot: opts.project.root,
        stateDir: opts.stateDir,
        policy: opts.policy?.() ?? null,
        task,
        role: agent?.role,
        forAgents: true,
        grants: [],
      });
      return { root, readable };
    },
    async packet(id) {
      const packet = opts.state.q.contextPacket(id);
      return packet ? packetStaleness(deps, packet, explanation(id)) : undefined;
    },
    explanation,
  };
}
