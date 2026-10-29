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
  let root: Promise<GitRoot | null> | undefined;
  const deps: ContextDeps = {
    state: opts.state,
    project: opts.project as unknown as ContextDeps['project'],
    git: () => {
      root ??= GitRoot.open(opts.project.root).catch(() => null);
      return root;
    },
    graph: () => opts.graph.graph(),
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
