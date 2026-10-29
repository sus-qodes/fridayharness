import { existsSync } from 'node:fs';
import {
  agentIdentity,
  commitsSince,
  GitRoot,
  listRefs,
  preserveCommit,
  preservedPrefix,
  resetWorktree,
  resolveCommit,
  snapshotWorktree,
  taskBranch,
} from '@friday/git';
import { type Actor, FridayError, type RecoveryAction, type RecoveryAssessment, type TaskView } from '@friday/protocol';
import type { ProjectRef } from '@friday/sdk';
import type { FridayState } from '@friday/state';
import type { Logger } from './log.js';
import { elsewhereReason } from './workspaces.js';

const SYSTEM: Actor = { kind: 'system', id: 'friday' };
const ACTIVE = ['ASSIGNED', 'RUNNING', 'WAITING', 'HARNESS_LOST'];
const TERMINAL = ['COMPLETED', 'CANCELLED', 'ABANDONED'];

/** Whether a process with this pid runs on this machine (EPERM: it does, as someone else's). */
export function processAlive(pid: number | null): boolean | null {
  if (!pid || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface RecoverySettings {
  maxRetries: number;
  maxSameErrorRetries: number;
  reconnectWindowMs: number;
}

/**
 * Recovery of lost and failed attempts (ADR-0026): an assessment of what is known, actions that
 * preserve the worktree's state before fencing and releasing the attempt, and an automatic sweep
 * with limits. Git runs here, never inside a state transaction.
 */
export class RecoveryManager {
  readonly #busy = new Set<string>();

  constructor(
    private readonly opts: {
      state: FridayState;
      project: ProjectRef;
      logger: Logger;
      settings: RecoverySettings;
      /** Process check; tests replace it. */
      alive?: (pid: number | null) => boolean | null;
    },
  ) {}

  private get pid() {
    return this.opts.project.project_id;
  }

  async assess(taskId: string): Promise<RecoveryAssessment> {
    const { state, project, settings } = this.opts;
    const task = state.q.task(this.pid, taskId);
    const run = (task.current_run_id ? state.q.findRun(task.current_run_id) : undefined) ?? state.q.runs(taskId).at(-1);
    const harness = run ? state.q.findHarness(run.harness_id) : undefined;
    const reconnectUntil =
      harness?.status === 'DISCONNECTED' && harness.lease_expires_at
        ? new Date(Date.parse(harness.lease_expires_at) + settings.reconnectWindowMs).toISOString()
        : null;
    const alive = harness ? (this.opts.alive ?? processAlive)(harness.host_pid) : null;
    const lastEvent = run ? state.store.readByRef(this.pid, 'run', run.run_id).at(-1) : undefined;

    const tree = state.q.worktreeForTask(taskId);
    let worktree: RecoveryAssessment['worktree'] = null;
    // A worktree of another clone (a restored database) is only ever read from here (review F08).
    const elsewhere = tree ? !state.inThisClone(tree.path) : false;
    const branchHere = elsewhere
      ? await resolveCommit(project.root, `refs/heads/${taskBranch(taskId)}`).catch(() => null)
      : null;
    if (tree) {
      const exists = existsSync(tree.path);
      const git = exists ? await GitRoot.open(tree.path).catch(() => null) : null;
      const identity = git ? await git.identity().catch(() => null) : null;
      worktree = {
        path: tree.path,
        branch: tree.branch,
        exists,
        base_commit: tree.base_commit,
        head: identity?.head ?? null,
        commits_since_base: exists ? await commitsSince(tree.path, tree.base_commit).catch(() => null) : null,
        uncommitted: identity?.paths.slice(0, 50) ?? [],
        elsewhere,
        branch_here: branchHere,
      };
    }
    const errors = state.agentErrors(this.pid, taskId);
    const last = errors.at(-1) ?? null;
    const same = last === null ? 0 : errors.filter((e) => e === last).length;
    const attempts = state.q.attemptsOf(taskId).length;

    const nowMs = Date.parse(state.clock.now());
    const windowOpen = reconnectUntil !== null && Date.parse(reconnectUntil) > nowMs;
    const active = ACTIVE.includes(task.status);
    const lost =
      (task.status === 'HARNESS_LOST' && harness?.status === 'TERMINATED') ||
      (task.status === 'WAITING' && task.waiting_reason === 'agent_error');
    const exhausted = attempts > settings.maxRetries;
    const repeating = same > settings.maxSameErrorRetries;
    const whyHuman =
      elsewhere && tree
        ? elsewhereReason(taskId, tree.path, branchHere)
        : alive === true
          ? `its host process (pid ${harness?.host_pid}) is still running on this machine, so it may still be writing`
          : exhausted
            ? `it has had ${attempts} attempt(s), and recovery.max_retries is ${settings.maxRetries}`
            : repeating
              ? `the same error repeated ${same} time(s): ${last}`
              : null;
    // A task waiting in READY because its work is elsewhere is recovered by a human's choice too.
    const movable = active || (elsewhere && task.status === 'READY');
    const options: RecoveryAssessment['options'] = [
      {
        action: 'reconnect',
        available: windowOpen,
        recommended: windowOpen,
        reason: windowOpen
          ? `the session may still come back and resume until ${reconnectUntil}`
          : 'no session is waiting to come back',
      },
      {
        action: 'reassign',
        available: movable && (!elsewhere || branchHere !== null),
        recommended: active && lost && !windowOpen && whyHuman === null,
        reason: elsewhere
          ? branchHere
            ? `the next attempt continues from ${taskBranch(taskId)} in this clone; uncommitted work in the other clone's worktree is not included`
            : `this clone has no ${taskBranch(taskId)}: fetch it from the clone that has it first`
          : worktree?.exists
            ? 'the next attempt continues in the same worktree and branch; uncommitted work is preserved first'
            : 'the task goes back to READY for the next agent',
      },
      {
        action: 'restart',
        available: elsewhere ? movable : active && Boolean(worktree?.exists),
        recommended: false,
        reason: elsewhere
          ? `the next attempt starts over in this clone, from ${branchHere ? `the last commit of ${taskBranch(taskId)}` : 'its base'}`
          : 'the next attempt starts from the last commit; uncommitted work is preserved first',
      },
      {
        action: 'needs_human',
        available: !TERMINAL.includes(task.status),
        recommended: active && lost && !windowOpen && whyHuman !== null,
        reason: whyHuman ?? 'a human decides what happens next',
      },
      { action: 'cancel', available: !TERMINAL.includes(task.status), recommended: false, reason: 'stop the task' },
    ];
    return {
      task_id: taskId,
      task_status: task.status,
      waiting_reason: task.waiting_reason ?? null,
      attempts,
      run: run ? { run_id: run.run_id, attempt: run.attempt, status: run.status, outcome: run.outcome ?? null } : null,
      harness: harness
        ? {
            harness_id: harness.harness_id,
            status: harness.status,
            agent_key: run ? (state.q.findAgent(run.agent_id)?.agent_key ?? null) : null,
            last_heartbeat_at: harness.last_heartbeat_at ?? null,
            reconnect_until: reconnectUntil,
            host_pid: harness.host_pid ?? null,
            process_alive: alive,
          }
        : null,
      last_activity: lastEvent ? { type: lastEvent.type, at: lastEvent.occurred_at } : null,
      worktree,
      errors: { total: errors.length, same_as_last: same, last },
      preserved: await listRefs(project.root, preservedPrefix(taskId)).catch(() => []),
      options,
    };
  }

  /** Performs one recovery action, preserving the worktree's state first where work could be lost. */
  async perform(
    taskId: string,
    action: Exclude<RecoveryAction, 'reconnect'>,
    actor: Actor,
    reason?: string,
  ): Promise<{ task: TaskView; preserved_ref: string | null; assessment: RecoveryAssessment }> {
    const { state, project, logger } = this.opts;
    if (this.#busy.has(taskId)) throw new FridayError('invalid_request', `${taskId} is being recovered already`);
    this.#busy.add(taskId);
    try {
      const a = await this.assess(taskId);
      const option = a.options.find((o) => o.action === action);
      if (!option?.available) {
        throw new FridayError(
          'invalid_request',
          `${action} is not possible for ${taskId} (${a.task_status}): ${option?.reason}`,
        );
      }
      const why = reason ?? option.reason;
      let preserved: string | null = null;
      const moving = action === 'reassign' || action === 'restart';
      if (moving && a.worktree?.elsewhere) {
        // Never written from this clone: the human's choice retires it here, and the next attempt
        // gets a worktree of this clone (review F08).
        const tree = state.q.worktreeForTask(taskId);
        if (tree) {
          state.releaseWorktree(
            this.pid,
            actor,
            tree.worktree_id,
            'released',
            `it belongs to another clone of the project; ${action} here: ${why}`,
          );
        }
        for (const e of state.q.escalations(this.pid, 'pending')) {
          if (e.task_id === taskId && e.kind === 'recovery_needed' && actor.kind === 'human') {
            state.answerEscalation(this.pid, actor, String(e.escalation_id), `${action}: ${why}`);
          }
        }
        if (a.task_status === 'READY') {
          state.recordObservation(
            this.pid,
            actor,
            'recovery.performed',
            { task_id: taskId, action, reason: why, preserved_ref: null },
            [{ kind: 'task', id: taskId }],
          );
          logger.info('task recovered', { task_id: taskId, action, reason: why });
          return { task: state.q.task(this.pid, taskId), preserved_ref: null, assessment: a };
        }
      } else if (moving && a.worktree?.exists && a.worktree.uncommitted.length) {
        const commit = await snapshotWorktree(
          a.worktree.path,
          `Preserved work of ${taskId}, attempt ${a.run?.attempt ?? 0}\n\n${why}`,
          agentIdentity(a.harness?.agent_key ?? 'agent'),
        );
        if (commit) {
          preserved = await preserveCommit(
            project.root,
            preservedPrefix(taskId),
            `attempt-${a.run?.attempt ?? 0}`,
            commit,
          );
        }
      }
      if (action === 'restart' && a.worktree?.exists && !a.worktree.elsewhere) await resetWorktree(a.worktree.path);
      const task = state.recoverTask(this.pid, actor, taskId, action, {
        reason: why,
        preserved_ref: preserved,
        details: {
          attempts: a.attempts,
          harness: a.harness,
          worktree: a.worktree ? { ...a.worktree, uncommitted: a.worktree.uncommitted.length } : null,
          errors: a.errors,
        },
      });
      logger.info('task recovered', { task_id: taskId, action, preserved_ref: preserved, reason: why });
      return { task, preserved_ref: preserved, assessment: a };
    } finally {
      this.#busy.delete(taskId);
    }
  }

  /**
   * Automatic recovery (ADR-0026 §5): attempts whose harness will not come back, or that ended in a
   * fatal agent error, are reassigned within the limits; otherwise a human is asked, once.
   */
  async sweep(): Promise<string[]> {
    const { state, logger } = this.opts;
    const done: string[] = [];
    const candidates = state.q
      .tasks(this.pid, { statuses: ['HARNESS_LOST', 'WAITING'] })
      .filter((t) => t.status === 'HARNESS_LOST' || t.waiting_reason === 'agent_error');
    for (const t of candidates) {
      if (this.#busy.has(t.task_id)) continue;
      if (t.status === 'HARNESS_LOST') {
        const h = t.assigned_harness_id ? state.q.findHarness(t.assigned_harness_id) : undefined;
        if (h && h.status !== 'TERMINATED') continue;
      }
      try {
        const a = await this.assess(t.task_id);
        const pick = a.options.find((o) => o.recommended && (o.action === 'reassign' || o.action === 'needs_human'));
        if (!pick) continue;
        if (pick.action === 'needs_human' && this.#asked(t.task_id)) continue;
        await this.perform(t.task_id, pick.action as 'reassign' | 'needs_human', SYSTEM, `automatic: ${pick.reason}`);
        done.push(`${t.task_id}: ${pick.action}`);
      } catch (e) {
        logger.warn('automatic recovery failed', { task_id: t.task_id, message: (e as Error).message });
      }
    }
    return done;
  }

  /** A human was already asked about this task and has not answered. */
  #asked(taskId: string): boolean {
    return this.opts.state.q
      .escalations(this.pid, 'pending')
      .some((e) => e.task_id === taskId && e.kind === 'recovery_needed');
  }
}
