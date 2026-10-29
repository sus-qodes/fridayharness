import { type CompileInput, ContextCache, type ContextDeps, compileContext, packetStaleness } from '@friday/context';
import { GitRoot } from '@friday/git';
import type { Actor, ContextExplanation, ContextPacket } from '@friday/protocol';
import type { ProjectRef } from '@friday/sdk';
import type { FridayState } from '@friday/state';
import type { GraphService } from './graph-service.js';

export type { CompileInput } from '@friday/context';

/**
 * The context compiler of the daemon (ADR-0022) over the project's execution root: the main
 * checkout until M5 (ADR-0014). Packets are cached by their key and explained.
 */
export interface ContextService {
  compile(input: CompileInput, actor: Actor): Promise<ContextPacket>;
  /** The stored packet with a fresh staleness verdict. */
  packet(contextId: string): Promise<ContextPacket | undefined>;
  explanation(contextId: string): ContextExplanation | undefined;
}

export function createContextService(opts: {
  state: FridayState;
  project: ProjectRef;
  graph: GraphService;
  stateDir?: string;
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
    graph: (dir) => opts.graph.graph(dir),
    ...(opts.stateDir ? { stateDir: opts.stateDir } : {}),
    cache: new ContextCache(),
  };
  const explanation = (id: string) => opts.state.q.contextExplanation(id) as ContextExplanation | undefined;
  return {
    async compile(input, actor) {
      return (await compileContext(deps, input, actor)).packet;
    },
    async packet(id) {
      const packet = opts.state.q.contextPacket(id);
      return packet ? packetStaleness(deps, packet, explanation(id)) : undefined;
    },
    explanation,
  };
}
