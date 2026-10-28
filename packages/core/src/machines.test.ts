import {
  type ActorKind,
  ActorKind as ActorKindEnum,
  type TaskStatus,
  TaskStatus as TaskStatusEnum,
  TaskView,
} from '@friday/protocol';
import { describe, expect, it } from 'vitest';
import {
  canAgentTransition,
  canHarnessTransition,
  canRunTransition,
  isTerminalTaskStatus,
  sequentialIds,
  TASK_RULES,
  type TaskTrigger,
  taskEdgeExists,
  taskInvariantViolations,
  transitionTask,
} from './index.js';

const ALL_STATUSES = TaskStatusEnum.options;
const ALL_ACTORS = ActorKindEnum.options;
const ALL_TRIGGERS = [...new Set(TASK_RULES.map((r) => r.trigger))] as TaskTrigger[];
const NON_TERMINAL = ALL_STATUSES.filter((s) => !['COMPLETED', 'CANCELLED', 'ABANDONED'].includes(s));

/**
 * Independent statement of the allowed edges: spec Part 14 §4 plus ADR-0003.
 * Written by hand on purpose; it must not be derived from TASK_RULES.
 */
const EXPECTED_EDGES = new Set<string>([
  'PROPOSED>READY',
  'READY>ASSIGNED',
  'ASSIGNED>RUNNING',
  'ASSIGNED>READY',
  'RUNNING>WAITING',
  'WAITING>RUNNING',
  'WAITING>READY',
  'RUNNING>READY_FOR_VERIFICATION',
  'READY_FOR_VERIFICATION>VERIFYING',
  'VERIFYING>COMPLETED',
  'VERIFYING>FAILED',
  'FAILED>REWORK',
  'REWORK>READY',
  'RUNNING>HARNESS_LOST',
  'WAITING>HARNESS_LOST',
  'HARNESS_LOST>RUNNING',
  'HARNESS_LOST>READY',
  ...NON_TERMINAL.map((s) => `${s}>CANCELLED`),
]);

describe('task state machine', () => {
  it('allows exactly the Part 14 + ADR-0003 edges', () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        expect(taskEdgeExists(from, to), `${from} -> ${to}`).toBe(EXPECTED_EDGES.has(`${from}>${to}`));
      }
    }
  });

  it('every (status, trigger, actor) either follows a rule or returns COS-2002 / a validation error', () => {
    let allowed = 0;
    for (const status of ALL_STATUSES) {
      for (const trigger of ALL_TRIGGERS) {
        for (const actor of ALL_ACTORS) {
          const rule = TASK_RULES.find((r) => r.trigger === trigger && r.from.includes(status));
          const res = transitionTask(status, { trigger, actor, waiting_reason: 'blocked' });
          if (rule?.actors.includes(actor)) {
            expect(res.ok, `${status} ${trigger} by ${actor}`).toBe(true);
            if (res.ok) expect(res.value.to).toBe(rule.to);
            allowed += 1;
          } else {
            expect(res.ok, `${status} ${trigger} by ${actor}`).toBe(false);
            if (!res.ok) expect(res.error.code).toBe('COS-2002');
          }
        }
      }
    }
    expect(allowed).toBeGreaterThan(30);
  });

  it('terminal states have no way out', () => {
    for (const status of ['COMPLETED', 'CANCELLED', 'ABANDONED'] as TaskStatus[]) {
      expect(isTerminalTaskStatus(status)).toBe(true);
      for (const to of ALL_STATUSES) expect(taskEdgeExists(status, to)).toBe(false);
    }
  });

  it('a completion claim never completes a task', () => {
    const res = transitionTask('RUNNING', { trigger: 'agent.completion_claim', actor: 'agent' });
    expect(res.ok && res.value.to).toBe('READY_FOR_VERIFICATION');
    for (const actor of ['agent', 'harness'] as ActorKind[]) {
      for (const trigger of ['verification.pass', 'verification.start'] as TaskTrigger[]) {
        for (const status of ALL_STATUSES) {
          expect(transitionTask(status, { trigger, actor }).ok, `${actor} ${trigger} from ${status}`).toBe(false);
        }
      }
    }
  });

  it('agents can claim but not assign, cancel, rework or verify', () => {
    expect(transitionTask('READY', { trigger: 'task.claim', actor: 'agent' }).ok).toBe(true);
    expect(transitionTask('READY', { trigger: 'task.assign', actor: 'agent' }).ok).toBe(false);
    expect(transitionTask('RUNNING', { trigger: 'task.cancel', actor: 'agent' }).ok).toBe(false);
    expect(transitionTask('FAILED', { trigger: 'task.rework', actor: 'agent' }).ok).toBe(false);
    expect(transitionTask('VERIFYING', { trigger: 'verification.pass', actor: 'agent' }).ok).toBe(false);
    expect(transitionTask('READY', { trigger: 'task.claim', actor: 'human' }).ok).toBe(false);
  });

  it('WAITING requires a reason and records it', () => {
    const missing = transitionTask('RUNNING', { trigger: 'task.wait', actor: 'agent' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('COS-1000');
    const res = transitionTask('RUNNING', { trigger: 'task.wait', actor: 'agent', waiting_reason: 'human_approval' });
    expect(res.ok && res.value.waiting_reason).toBe('human_approval');
    const resumed = transitionTask('WAITING', { trigger: 'task.resume', actor: 'agent' });
    expect(resumed.ok && resumed.value.waiting_reason).toBe(null);
  });

  it('emits semantic event names', () => {
    const lost = transitionTask('RUNNING', { trigger: 'harness.lost', actor: 'system', reason: 'lease expired' });
    expect(lost.ok && lost.value).toMatchObject({ event: 'task.harness_lost', reason: 'lease expired' });
    const done = transitionTask('VERIFYING', { trigger: 'verification.pass', actor: 'system' });
    expect(done.ok && done.value.event).toBe('task.completed');
  });
});

describe('agent, harness and run machines', () => {
  it('agents', () => {
    expect(canAgentTransition('REGISTERED', 'AVAILABLE')).toBe(true);
    expect(canAgentTransition('BUSY', 'DISCONNECTED')).toBe(true);
    expect(canAgentTransition('AVAILABLE', 'BUSY')).toBe(false);
    expect(canAgentTransition('BUSY', 'TERMINATED')).toBe(true);
    expect(canAgentTransition('TERMINATED', 'AVAILABLE')).toBe(false);
  });

  it('harnesses', () => {
    expect(canHarnessTransition('READY', 'DEGRADED')).toBe(true);
    expect(canHarnessTransition('DEGRADED', 'DISCONNECTED')).toBe(true);
    expect(canHarnessTransition('DISCONNECTED', 'READY')).toBe(false);
    expect(canHarnessTransition('DISCONNECTED', 'RECONNECTING')).toBe(true);
    expect(canHarnessTransition('TERMINATED', 'READY')).toBe(false);
  });

  it('runs', () => {
    expect(canRunTransition('STARTING', 'ACTIVE')).toBe(true);
    expect(canRunTransition('ACTIVE', 'SUSPENDED')).toBe(true);
    expect(canRunTransition('ENDED', 'ACTIVE')).toBe(false);
    expect(canRunTransition('DECLINED', 'ACTIVE')).toBe(false);
  });
});

describe('ids and invariants', () => {
  it('sequential ids are valid, ordered and deterministic', () => {
    const a = sequentialIds();
    const b = sequentialIds();
    const first = [a.next('task'), a.next('task'), a.next('run')];
    expect(first).toEqual([b.next('task'), b.next('task'), b.next('run')]);
    expect(first[0]).toMatch(/^task_0{25}1$/);
    expect((first[0] as string) < (first[1] as string)).toBe(true);
  });

  it('reports invariant violations for inconsistent rows', () => {
    const base = TaskView.parse({
      task_id: 'task_x',
      project_id: 'proj_x',
      goal_id: null,
      plan_id: null,
      kind: 'implementation',
      summary: 's',
      description: null,
      acceptance_criteria: [],
      status: 'RUNNING',
      waiting_reason: null,
      priority: 'normal',
      risk_level: 'low',
      scope: null,
      dependencies: [],
      reserved_for_agent_key: null,
      assigned_agent_id: 'agent_a',
      assigned_harness_id: 'harness_h',
      current_run_id: 'run_r',
      created_by: { kind: 'human', id: 'local' },
      created_at: 't',
      updated_at: 't',
      started_at: 't',
      completed_at: null,
      cancelled_at: null,
      revision: 1,
    });
    expect(taskInvariantViolations(base)).toEqual([]);
    expect(taskInvariantViolations({ ...base, assigned_harness_id: null })).toContain(
      'assigned_agent_id without assigned_harness_id',
    );
    expect(taskInvariantViolations({ ...base, status: 'WAITING' })).toContain('WAITING without waiting_reason');
    expect(taskInvariantViolations({ ...base, status: 'COMPLETED', completed_at: 't' })).toContain(
      'terminal task COMPLETED still has a run',
    );
  });
});
