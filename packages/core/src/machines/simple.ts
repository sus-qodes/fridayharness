import { type AgentStatus, FridayError, type HarnessStatus, type RunStatus } from '@friday/protocol';

type Table<S extends string> = Readonly<Record<S, readonly S[]>>;

/**
 * Agent states (spec Part 14 §5). An agent state is distinct from its task's state.
 * Any state may also move to UNHEALTHY or TERMINATED.
 */
export const AGENT_TRANSITIONS: Table<AgentStatus> = {
  REGISTERED: ['AVAILABLE'],
  AVAILABLE: ['ASSIGNED', 'DISCONNECTED'],
  ASSIGNED: ['BUSY', 'AVAILABLE', 'DISCONNECTED'],
  BUSY: ['WAITING', 'AVAILABLE', 'DISCONNECTED'],
  WAITING: ['BUSY', 'AVAILABLE', 'DISCONNECTED'],
  DISCONNECTED: ['AVAILABLE', 'BUSY'],
  UNHEALTHY: ['AVAILABLE'],
  TERMINATED: [],
};

/** Harness states (spec Part 14 §6). Any state may also move to TERMINATED. */
export const HARNESS_TRANSITIONS: Table<HarnessStatus> = {
  REGISTERED: ['READY', 'DISCONNECTED'],
  READY: ['BUSY', 'DEGRADED', 'DISCONNECTED'],
  BUSY: ['READY', 'DEGRADED', 'DISCONNECTED'],
  DEGRADED: ['READY', 'BUSY', 'DISCONNECTED'],
  DISCONNECTED: ['RECONNECTING'],
  RECONNECTING: ['READY', 'BUSY', 'DISCONNECTED'],
  TERMINATED: [],
};

/** Task run states (plan A.3). */
export const RUN_TRANSITIONS: Table<RunStatus> = {
  STARTING: ['ACTIVE', 'DECLINED', 'ENDED'],
  ACTIVE: ['SUSPENDED', 'ENDED'],
  SUSPENDED: ['ACTIVE', 'ENDED'],
  DECLINED: [],
  ENDED: [],
};

export function canAgentTransition(from: AgentStatus, to: AgentStatus): boolean {
  if (from === 'TERMINATED') return false;
  if (to === 'TERMINATED' || to === 'UNHEALTHY') return from !== to;
  return AGENT_TRANSITIONS[from].includes(to);
}

export function canHarnessTransition(from: HarnessStatus, to: HarnessStatus): boolean {
  if (from === 'TERMINATED') return false;
  if (to === 'TERMINATED') return true;
  return HARNESS_TRANSITIONS[from].includes(to);
}

export function canRunTransition(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

function assert(ok: boolean, what: string, from: string, to: string): void {
  if (!ok) throw new FridayError('invalid_state_transition', `${what} cannot move from ${from} to ${to}`, { from, to });
}

export const assertAgentTransition = (from: AgentStatus, to: AgentStatus) =>
  assert(canAgentTransition(from, to), 'agent', from, to);
export const assertHarnessTransition = (from: HarnessStatus, to: HarnessStatus) =>
  assert(canHarnessTransition(from, to), 'harness', from, to);
export const assertRunTransition = (from: RunStatus, to: RunStatus) =>
  assert(canRunTransition(from, to), 'run', from, to);
