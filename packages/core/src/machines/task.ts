import {
  type ActorKind,
  FridayError,
  type TaskStatus,
  TERMINAL_TASK_STATUSES,
  type WaitingReason,
} from '@friday/protocol';
import { err, ok, type Result } from '../result.js';

export type TaskTrigger =
  | 'task.ready'
  | 'task.assign'
  | 'task.claim'
  | 'run.accepted'
  | 'task.release'
  | 'task.wait'
  | 'task.resume'
  | 'agent.completion_claim'
  | 'verification.start'
  | 'verification.pass'
  | 'verification.fail'
  | 'verification.interrupt'
  | 'task.rework'
  | 'harness.lost'
  | 'run.resumed'
  | 'task.cancel';

export interface TaskRule {
  readonly from: readonly TaskStatus[];
  readonly to: TaskStatus;
  readonly trigger: TaskTrigger;
  readonly actors: readonly ActorKind[];
  /** Semantic event type emitted for this transition (plan B16). */
  readonly event: string;
}

const NON_TERMINAL: readonly TaskStatus[] = [
  'PROPOSED',
  'READY',
  'ASSIGNED',
  'RUNNING',
  'WAITING',
  'READY_FOR_VERIFICATION',
  'VERIFYING',
  'FAILED',
  'REWORK',
  'HARNESS_LOST',
];

const PLANNERS: readonly ActorKind[] = ['human', 'master_brain', 'system'];
const EXECUTORS: readonly ActorKind[] = ['agent', 'harness', 'system'];

/**
 * The task state machine: spec Part 14 §4 plus the additions in ADR-0003.
 * Anything not listed here is rejected with COS-2002 and mutates nothing.
 */
export const TASK_RULES: readonly TaskRule[] = [
  { from: ['PROPOSED'], to: 'READY', trigger: 'task.ready', actors: PLANNERS, event: 'task.ready' },
  { from: ['READY'], to: 'ASSIGNED', trigger: 'task.assign', actors: PLANNERS, event: 'task.assigned' },
  { from: ['READY'], to: 'ASSIGNED', trigger: 'task.claim', actors: ['agent'], event: 'task.assigned' },
  { from: ['ASSIGNED'], to: 'RUNNING', trigger: 'run.accepted', actors: EXECUTORS, event: 'task.started' },
  // ADR-0003: a harness can decline an assignment, or the ack can time out.
  { from: ['ASSIGNED'], to: 'READY', trigger: 'task.release', actors: [...EXECUTORS, 'human'], event: 'task.released' },
  { from: ['RUNNING'], to: 'WAITING', trigger: 'task.wait', actors: EXECUTORS, event: 'task.waiting' },
  { from: ['WAITING'], to: 'RUNNING', trigger: 'task.resume', actors: [...EXECUTORS, 'human'], event: 'task.resumed' },
  // ADR-0003: after an agent error (or an agent hand-off) the task can go back to READY.
  { from: ['WAITING'], to: 'READY', trigger: 'task.release', actors: PLANNERS, event: 'task.released' },
  {
    from: ['RUNNING'],
    to: 'READY_FOR_VERIFICATION',
    trigger: 'agent.completion_claim',
    actors: ['agent', 'harness'],
    event: 'task.completion_claimed',
  },
  {
    from: ['READY_FOR_VERIFICATION'],
    to: 'VERIFYING',
    trigger: 'verification.start',
    actors: ['system', 'human'],
    event: 'task.verification_started',
  },
  {
    from: ['VERIFYING'],
    to: 'COMPLETED',
    trigger: 'verification.pass',
    actors: ['system', 'human'],
    event: 'task.completed',
  },
  {
    from: ['VERIFYING'],
    to: 'FAILED',
    trigger: 'verification.fail',
    actors: ['system', 'human'],
    event: 'task.failed',
  },
  // ADR-0024: a verification that could not finish (the daemon stopped, or the code changed while
  // it ran) judged nothing; the task waits to be verified again.
  {
    from: ['VERIFYING'],
    to: 'READY_FOR_VERIFICATION',
    trigger: 'verification.interrupt',
    actors: ['system', 'human'],
    event: 'task.verification_interrupted',
  },
  { from: ['FAILED'], to: 'REWORK', trigger: 'task.rework', actors: PLANNERS, event: 'task.rework' },
  { from: ['REWORK'], to: 'READY', trigger: 'task.ready', actors: PLANNERS, event: 'task.ready' },
  // ADR-0003: harness loss and recovery.
  {
    from: ['RUNNING', 'WAITING'],
    to: 'HARNESS_LOST',
    trigger: 'harness.lost',
    actors: ['system', 'harness'],
    event: 'task.harness_lost',
  },
  { from: ['HARNESS_LOST'], to: 'RUNNING', trigger: 'run.resumed', actors: EXECUTORS, event: 'task.resumed' },
  { from: ['HARNESS_LOST'], to: 'READY', trigger: 'task.release', actors: PLANNERS, event: 'task.released' },
  { from: NON_TERMINAL, to: 'CANCELLED', trigger: 'task.cancel', actors: PLANNERS, event: 'task.cancelled' },
];

export interface TaskTransitionRequest {
  trigger: TaskTrigger;
  actor: ActorKind;
  /** Required when the result is WAITING. */
  waiting_reason?: WaitingReason;
  reason?: string;
}

export interface TaskTransition {
  from: TaskStatus;
  to: TaskStatus;
  trigger: TaskTrigger;
  event: string;
  waiting_reason: WaitingReason | null;
  reason?: string;
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}

/** True when some rule moves `from` to `to` (any trigger, any actor). */
export function taskEdgeExists(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_RULES.some((r) => r.to === to && r.from.includes(from));
}

/**
 * Validates a transition without touching any state. Returns what the caller should
 * record, or COS-2002 when the trigger is not allowed from this status for this actor.
 */
export function transitionTask(current: TaskStatus, req: TaskTransitionRequest): Result<TaskTransition> {
  const rule = TASK_RULES.find((r) => r.trigger === req.trigger && r.from.includes(current));
  if (!rule) {
    return err(
      new FridayError('invalid_state_transition', `cannot ${req.trigger} a task that is ${current}`, {
        from: current,
        trigger: req.trigger,
      }),
    );
  }
  if (!rule.actors.includes(req.actor)) {
    return err(
      new FridayError('invalid_state_transition', `${req.actor} may not ${req.trigger} (task is ${current})`, {
        from: current,
        trigger: req.trigger,
        actor: req.actor,
      }),
    );
  }
  if (rule.to === 'WAITING' && !req.waiting_reason) {
    return err(new FridayError('invalid_request', 'a waiting_reason is required to move a task to WAITING'));
  }
  const transition: TaskTransition = {
    from: current,
    to: rule.to,
    trigger: req.trigger,
    event: rule.event,
    waiting_reason: rule.to === 'WAITING' ? (req.waiting_reason ?? null) : null,
  };
  if (req.reason !== undefined) transition.reason = req.reason;
  return ok(transition);
}
