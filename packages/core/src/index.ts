/**
 * @friday/core
 * Domain invariants and pure state machines (task, agent, harness, run). No I/O.
 */
export const PACKAGE_NAME = '@friday/core';

export { addMs, type Clock, systemClock } from './clock.js';
export { type IdGenerator, randomIds, sequentialIds } from './ids.js';
export { STATUSES_WITH_RUN, taskInvariantViolations } from './invariants.js';
export {
  AGENT_TRANSITIONS,
  assertAgentTransition,
  assertHarnessTransition,
  assertRunTransition,
  canAgentTransition,
  canHarnessTransition,
  canRunTransition,
  HARNESS_TRANSITIONS,
  RUN_TRANSITIONS,
} from './machines/simple.js';
export {
  isTerminalTaskStatus,
  TASK_RULES,
  type TaskRule,
  type TaskTransition,
  type TaskTransitionRequest,
  type TaskTrigger,
  taskEdgeExists,
  transitionTask,
} from './machines/task.js';
export { err, ok, type Result, unwrap } from './result.js';
