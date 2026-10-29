import { existsSync } from 'node:fs';
import { agentIdentity, preserveCommit, preservedPrefix, snapshotWorktree } from '@friday/git';
import type { Actor, ControlResult, ControlTaskStop, TaskView } from '@friday/protocol';
import type { ProjectRef } from '@friday/sdk';
import type { FridayState } from '@friday/state';
import type { Logger } from './log.js';
import type { OperationManager } from './operations.js';

/**
 * Pause, resume and halt by effect (plan M9, `docs/frontend/PLAN.md` §5.5, ADR-0033 §6).
 *
 * Pause records the control; the state then holds every effect where it commits. Spawned hosts
 * that change files without asking (Codex: not held at the tool boundary) cannot be paused, so
 * their attempts are stopped the way halt stops one, their work preserved.
 *
 * Halt pauses, then stops every running attempt: operations first, the worktree's uncommitted work
 * preserved, the task released to READY and the stop sent to a spawned host. No task is cancelled
 * and no worktree removed. A stop is reported as sent, never as done: a spawned host stops when its
 * adapter takes the cancel, and an attached session in an editor cannot be stopped at all.
 */
export class ControlManager {
  constructor(
    private readonly opts: {
      state: FridayState;
      project: ProjectRef;
      logger: Logger;
      operations?: OperationManager;
      /** Tasks the recovery manager is working on; halt leaves them to it. */
      recovering?: (taskId: string) => boolean;
    },
  ) {}

  private get pid(): string {
    return this.opts.project.project_id;
  }

  async pause(actor: Actor, reason: string | null): Promise<ControlResult> {
    const { state } = this.opts;
    const control = state.pauseProject(this.pid, actor, reason);
    const why = `Friday was paused${reason ? `: ${reason}` : ''}`;
    let operationsStopped = 0;
    const tasks: ControlTaskStop[] = [];
    for (const task of this.#running()) {
      const harness = this.#harnessOf(task);
      if (harness?.attach_mode !== 'spawn' || this.#heldAtToolBoundary(harness.capabilities)) continue;
      const r = await this.#stop(actor, task, why);
      operationsStopped += r.operations;
      if (r.stop) tasks.push(r.stop);
    }
    if (tasks.length) this.opts.logger.info('paused, stopping hosts that cannot be held', { stopped: tasks.length });
    return { control, tasks, operations_stopped: operationsStopped };
  }

  resume(actor: Actor): ControlResult {
    const control = this.opts.state.resumeProject(this.pid, actor);
    return { control, tasks: [], operations_stopped: 0 };
  }

  async halt(actor: Actor, reason: string | null): Promise<ControlResult> {
    const { state, logger } = this.opts;
    const why = reason ?? 'a human halted Friday';
    const paused = await this.pause(actor, why);
    const tasks = [...paused.tasks];
    let operationsStopped = paused.operations_stopped;
    const done = new Set(tasks.map((t) => t.task_id));
    for (const task of this.#running()) {
      if (done.has(task.task_id)) continue;
      const r = await this.#stop(actor, task, `halted: ${why}`);
      operationsStopped += r.operations;
      if (r.stop) tasks.push(r.stop);
    }
    const control = state.recordHalt(
      this.pid,
      actor,
      reason,
      tasks.map((t) => ({ task_id: t.task_id, preserved_ref: t.preserved_ref })),
    );
    logger.info('halted', { stopped: tasks.length, operations_stopped: operationsStopped });
    return { control, tasks, operations_stopped: operationsStopped };
  }

  /** Tasks with an attempt that could be at work, except those recovery is handling. */
  #running(): TaskView[] {
    const { state } = this.opts;
    return state.q
      .tasks(this.pid, { statuses: ['ASSIGNED', 'RUNNING', 'WAITING', 'HARNESS_LOST'] })
      .filter((t) => t.current_run_id && !this.opts.recovering?.(t.task_id));
  }

  #harnessOf(task: TaskView) {
    const { state } = this.opts;
    const run = task.current_run_id ? state.q.findRun(task.current_run_id) : undefined;
    return run ? state.q.findHarness(run.harness_id) : undefined;
  }

  /** A host whose every tool call passes Friday's hooks can be held by the pause (Claude Code). */
  #heldAtToolBoundary(capabilities: Record<string, unknown> | null | undefined): boolean {
    return capabilities?.hooks === true;
  }

  /** Stops one attempt: operations, then the worktree preserved, then released and the host told. */
  async #stop(
    actor: Actor,
    task: TaskView,
    why: string,
  ): Promise<{ stop: ControlTaskStop | null; operations: number }> {
    const { state, project, logger } = this.opts;
    const run = task.current_run_id ? state.q.findRun(task.current_run_id) : undefined;
    const harness = run ? state.q.findHarness(run.harness_id) : undefined;
    let operations = 0;
    // Operations write into the worktree: stop them before its state is recorded.
    if (this.opts.operations) {
      const running = state.q.operationRuns(this.pid, { task_id: task.task_id }).filter((o) => o.status === 'running');
      if (running.length) {
        await this.opts.operations.stopTask(task.task_id, why);
        operations = running.length;
      }
    }
    let preserved: string | null = null;
    const tree = state.q.worktreeForTask(task.task_id);
    const root = run?.execution_root;
    if (tree && root && existsSync(root) && state.inThisClone(tree.path)) {
      try {
        const agentKey = task.assigned_agent_id ? state.q.findAgent(task.assigned_agent_id)?.agent_key : undefined;
        const commit = await snapshotWorktree(
          root,
          `Preserved work of ${task.task_id}, attempt ${run?.attempt ?? 0}\n\n${why}`,
          agentIdentity(agentKey ?? 'agent'),
        );
        if (commit) {
          preserved = await preserveCommit(
            project.root,
            preservedPrefix(task.task_id),
            `attempt-${run?.attempt ?? 0}`,
            commit,
          );
        }
      } catch (e) {
        logger.warn('could not preserve a worktree', { task_id: task.task_id, error: (e as Error).message });
      }
    }
    const live = harness && !['DISCONNECTED', 'TERMINATED'].includes(harness.status);
    const host: ControlTaskStop['host'] =
      !harness || !live ? 'none' : harness.attach_mode === 'spawn' ? 'spawned' : 'attached';
    const stop: ControlTaskStop['stop'] =
      host === 'spawned' && run?.status === 'ACTIVE' ? 'sent' : host === 'attached' ? 'not_possible' : 'none';
    try {
      state.haltTask(this.pid, actor, task.task_id, why, preserved);
      return { stop: { task_id: task.task_id, preserved_ref: preserved, host, stop }, operations };
    } catch (e) {
      // Already released by someone else (recovery, a human), or no longer running: nothing to stop.
      logger.warn('could not stop a task', { task_id: task.task_id, error: (e as Error).message });
      return { stop: null, operations };
    }
  }
}
