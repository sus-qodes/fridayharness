import type { TaskStatus, TaskView } from '@friday/protocol';
import { isTerminalTaskStatus } from './machines/task.js';

/** Statuses in which a task holds a current run. */
export const STATUSES_WITH_RUN: readonly TaskStatus[] = [
  'ASSIGNED',
  'RUNNING',
  'WAITING',
  'HARNESS_LOST',
  'READY_FOR_VERIFICATION',
  'VERIFYING',
];

/**
 * Structural invariants for a task row (spec Part 01 §6, plan M1.2). Returns the list of
 * violations; an empty list means the row is consistent. Used by the projector's tests
 * and by `friday doctor` against a live database.
 */
export function taskInvariantViolations(task: TaskView): string[] {
  const out: string[] = [];
  if (task.assigned_agent_id && !task.assigned_harness_id) out.push('assigned_agent_id without assigned_harness_id');
  if (task.current_run_id && !STATUSES_WITH_RUN.includes(task.status)) {
    out.push(`current_run_id set while ${task.status}`);
  }
  if (task.status === 'WAITING' && !task.waiting_reason) out.push('WAITING without waiting_reason');
  if (task.status !== 'WAITING' && task.waiting_reason) out.push(`waiting_reason set while ${task.status}`);
  if (task.status === 'COMPLETED' && !task.completed_at) out.push('COMPLETED without completed_at');
  if (task.status === 'CANCELLED' && !task.cancelled_at) out.push('CANCELLED without cancelled_at');
  if (isTerminalTaskStatus(task.status) && task.current_run_id)
    out.push(`terminal task ${task.status} still has a run`);
  return out;
}
