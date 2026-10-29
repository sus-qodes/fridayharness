import {
  type Allocation,
  allocateWorktree,
  applyState,
  GitRoot,
  goalBranch,
  isAncestor,
  parentOf,
  removeWorktree,
  resolveCommit,
  restoredRef,
  runGit,
  taskBranch,
  worktreesDir,
} from '@friday/git';
import { type Actor, FridayError, type WorktreeView } from '@friday/protocol';
import type { ProjectRef } from '@friday/sdk';
import type { FridayState } from '@friday/state';
import type { Logger } from './log.js';

const SYSTEM: Actor = { kind: 'system', id: 'friday' };

/**
 * Why a task whose worktree belongs to another clone of the project waits for a human, and what
 * the human can do (review F08). This clone never writes that worktree, and never starts the task
 * over on its own: the work may only be there. A backup may have brought the task's branch and the
 * worktree's uncommitted work (review F16).
 */
export function elsewhereReason(
  taskId: string,
  dir: string,
  branchHere: string | null,
  restoredHere: string | null = null,
): string {
  const branch = taskBranch(taskId);
  if (branchHere && restoredHere) {
    return `its worktree belongs to another clone of the project (${dir}); this clone has its branch ${branch} at ${branchHere.slice(0, 12)} and the uncommitted work a backup recorded there (${restoredRef(taskId)}). Continue with both in a worktree of this clone with "friday recover ${taskId} --action reassign", or from the branch's last commit with "friday recover ${taskId} --action restart"`;
  }
  return branchHere
    ? `its worktree belongs to another clone of the project (${dir}); this clone has its branch ${branch} at ${branchHere.slice(0, 12)}, but not the uncommitted work that may be there. Continue from the branch with "friday recover ${taskId} --action reassign", or start over with "friday recover ${taskId} --action restart"`
    : `its worktree belongs to another clone of the project (${dir}), and this clone has no branch ${branch}, so its work is not here. Restore a backup that holds the project's code ("friday restore"), or fetch the branch from that clone (git fetch <that clone> ${branch}:${branch}), and continue with "friday recover ${taskId} --action reassign"; or start over from the task's base with "friday recover ${taskId} --action restart"`;
}

/**
 * Why a task whose earlier attempts worked on its branch waits for a human when this clone has no
 * such branch (review F16): a new branch from the base would pass for their work.
 */
export function missingCodeReason(taskId: string): string {
  const branch = taskBranch(taskId);
  return `earlier attempts worked on its branch ${branch}, which this clone does not have, so their work is not here. Restore a backup that holds the project's code ("friday restore"), or fetch the branch from a clone that has it, and continue with "friday recover ${taskId} --action reassign"; or start over from the task's base with "friday recover ${taskId} --action restart"`;
}

/**
 * Where a task's new branch starts (ADR-0025 §4): a goal's task starts from the goal branch, which
 * holds its completed dependencies' integrated work; any other task from the main checkout's HEAD.
 */
export async function taskBase(state: FridayState, project: ProjectRef, taskId: string): Promise<string | undefined> {
  const goalId = state.q.findTask(project.project_id, taskId)?.goal_id;
  if (!goalId) return undefined;
  return (await resolveCommit(project.root, `refs/heads/${goalBranch(goalId)}`)) ?? undefined;
}

/**
 * Task worktrees for the daemon (ADR-0023): prepares the worktree of every spawn run that waits
 * for one, creates worktrees humans ask for, releases them when their task ends and prunes the
 * clean ones. Git runs here, never inside a state transaction.
 */
export class WorkspaceManager {
  readonly #preparing = new Set<string>();

  constructor(
    private readonly opts: {
      state: FridayState;
      project: ProjectRef;
      logger: Logger;
      env: NodeJS.ProcessEnv;
      /** Stops the task's gateway operations, confirmed (review F07). */
      quiesce?: (taskId: string) => Promise<void>;
    },
  ) {}

  /** Where this machine keeps task worktrees. */
  get dir(): string {
    return worktreesDir(this.opts.env);
  }

  private get pid() {
    return this.opts.project.project_id;
  }

  private baseFor(taskId: string): Promise<string | undefined> {
    return taskBase(this.opts.state, this.opts.project, taskId);
  }

  /** Prepares every run still waiting for its worktree (after a restart, or a failed attempt). */
  async sweep(): Promise<void> {
    for (const run of this.opts.state.runsAwaitingWorkspace(this.pid)) await this.prepare(run.run_id);
  }

  /** Creates or reuses the run's task worktree, then lets the state deliver `task.start`. */
  async prepare(runId: string): Promise<void> {
    if (this.#preparing.has(runId)) return;
    this.#preparing.add(runId);
    const { state, project, logger } = this.opts;
    try {
      const run = state.q.findRun(runId);
      if (run?.workspace !== 'pending' || run.status !== 'STARTING') return;
      // The task's work is in another clone's worktree: a human decides (review F08).
      const prev = state.q.worktreeForTask(run.task_id);
      const branch = taskBranch(run.task_id);
      const here = await resolveCommit(project.root, `refs/heads/${branch}`);
      if (prev && !state.inThisClone(prev.path)) {
        const restored = await resolveCommit(project.root, restoredRef(run.task_id));
        const reason = elsewhereReason(run.task_id, prev.path, here, restored);
        this.#askHuman(run.task_id, reason, { worktree: prev.path, branch_here: here, restored_here: restored });
        throw new FridayError('invalid_request', reason);
      }
      // Earlier attempts worked on the task's branch, and this clone has none: a new branch from
      // the base would pass for their work (review F16). A human decides.
      if (!here && state.q.runs(run.task_id).some((r) => r.run_id !== runId && r.branch_ref === branch)) {
        const reason = missingCodeReason(run.task_id);
        this.#askHuman(run.task_id, reason, { branch });
        throw new FridayError('invalid_request', reason);
      }
      // A gateway operation of an earlier attempt still works there: it ends first (review F07).
      if (state.q.operationRuns(this.pid, { task_id: run.task_id, status: 'running', limit: 1 }).length) {
        await this.opts.quiesce?.(run.task_id);
      }
      const alloc = await this.#allocate(run.task_id);
      state.workspaceReady(this.pid, runId, alloc);
      logger.info('task worktree ready', {
        task_id: run.task_id,
        run_id: runId,
        path: alloc.path,
        created: alloc.created,
      });
      for (const w of alloc.warnings) logger.warn('task worktree', { task_id: run.task_id, warning: w });
    } catch (e) {
      const reason = (e as Error).message;
      logger.warn('task worktree could not be prepared', { run_id: runId, reason });
      try {
        state.workspaceFailed(this.pid, runId, reason);
      } catch (inner) {
        logger.error('declining the run failed', { run_id: runId, message: (inner as Error).message });
      }
    } finally {
      this.#preparing.delete(runId);
    }
  }

  /**
   * Allocates the task's worktree. On a branch an earlier attempt left, the worktree keeps the
   * commit the branch started from, so verification judges all of the task's changes, not only
   * those made after this worktree was created (review F16).
   */
  async #allocate(taskId: string, base?: string): Promise<Allocation> {
    const { project } = this.opts;
    const from = base ?? (await this.baseFor(taskId));
    const alloc = await allocateWorktree({
      mainRoot: project.root,
      worktreesDir: this.dir,
      taskId,
      project: { project_id: project.project_id, name: project.name },
      ...(from ? { base: from } : {}),
    });
    if (!alloc.reused_branch || !alloc.base_commit) return alloc;
    // The newest allocation whose base the branch still contains: a task started over has a newer one.
    for (const w of this.opts.state.q.worktrees(this.pid)) {
      if (w.task_id !== taskId || !w.base_commit) continue;
      if (await isAncestor(project.root, w.base_commit, alloc.base_commit).catch(() => false)) {
        return { ...alloc, base_commit: w.base_commit };
      }
    }
    return alloc;
  }

  /**
   * A task worktree of this clone for a human's recovery choice (review F16): on the task's branch,
   * which is created at the task's base when it does not exist (`restart` without the earlier
   * work), and with the uncommitted work a backup recorded written on top, as uncommitted changes,
   * when the branch is where that record was taken. Recorded for the task, so its next run works there.
   */
  async rebuild(
    taskId: string,
    actor: Actor,
    restored: string | null,
  ): Promise<{ worktree: WorktreeView; applied: boolean; note: string | null }> {
    const { state, project } = this.opts;
    const branch = taskBranch(taskId);
    const head = await resolveCommit(project.root, `refs/heads/${branch}`);
    const recordedOn = restored ? await parentOf(project.root, restored) : null;
    const fits = restored !== null && head !== null && recordedOn === head;
    const existed = (await (await GitRoot.open(project.root)).worktrees()).some((w) => w.branch === branch);
    const alloc = await this.#allocate(taskId);
    let applied = false;
    if (fits && restored) {
      const clean = !(await (await GitRoot.open(alloc.path)).identity()).dirty;
      if (clean) {
        try {
          await applyState(alloc.path, restored);
          applied = true;
        } catch (e) {
          if (!existed)
            await runGit(project.root, ['worktree', 'remove', '--force', alloc.path]).catch(() => undefined);
          throw new FridayError(
            'internal_error',
            `the uncommitted work a backup recorded could not be written into ${alloc.path}: ${(e as Error).message}`,
          );
        }
      }
    }
    const note = !restored
      ? null
      : applied
        ? `the uncommitted work a backup recorded is in ${alloc.path} again`
        : fits
          ? `${alloc.path} already holds uncommitted changes, so the work a backup recorded was not written there`
          : `${branch} is at ${head?.slice(0, 12) ?? 'nothing'}, not at ${recordedOn?.slice(0, 12) ?? '?'} where a backup recorded the uncommitted work, so that work was not written into ${alloc.path}`;
    const worktree = state.recordWorktree(this.pid, actor, taskId, alloc);
    return { worktree, applied, note };
  }

  /** Asks a human once; the Master Brain does not delegate the task while the question is open. */
  #askHuman(taskId: string, reason: string, details: Record<string, unknown>): void {
    const { state } = this.opts;
    const asked = state.q
      .escalations(this.pid, 'pending')
      .some((e) => e.task_id === taskId && e.kind === 'recovery_needed');
    if (!asked) state.recoverTask(this.pid, SYSTEM, taskId, 'needs_human', { reason, details });
  }

  /** A worktree for a human to start a session in (`friday task worktree <task>`). */
  async forTask(
    taskId: string,
    actor: Actor,
  ): Promise<{ worktree: WorktreeView; warnings: string[]; created: boolean }> {
    const { state, project } = this.opts;
    state.q.task(this.pid, taskId);
    // A new branch from the base would pass for earlier attempts' work that is not here (review F16).
    const branch = taskBranch(taskId);
    if (
      state.q.runs(taskId).some((r) => r.branch_ref === branch) &&
      !(await resolveCommit(project.root, `refs/heads/${branch}`))
    ) {
      throw new FridayError('invalid_request', missingCodeReason(taskId));
    }
    const alloc = await this.#allocate(taskId);
    const worktree = state.recordWorktree(this.pid, actor, taskId, alloc);
    return { worktree, warnings: alloc.warnings, created: alloc.created };
  }

  /** The task ended: its worktree is released, or preserved when it holds uncommitted work. */
  async release(taskId: string, reason: string): Promise<void> {
    const { state, logger } = this.opts;
    const w = state.q.worktreeForTask(taskId);
    if (w?.status !== 'active') return;
    const identity = await GitRoot.open(w.path)
      .then((r) => r.identity())
      .catch(() => null);
    const dirty = identity?.dirty ?? false;
    state.releaseWorktree(
      this.pid,
      SYSTEM,
      w.worktree_id,
      dirty ? 'preserved' : 'released',
      dirty ? `${reason}; ${identity?.files} uncommitted change(s) are kept` : reason,
    );
    if (dirty) logger.warn('task worktree preserved: it holds uncommitted work', { task_id: taskId, path: w.path });
  }

  /** Removes released worktrees that are clean; anything with uncommitted work stays (ADR-0023 §7). */
  async prune(actor: Actor): Promise<{ removed: string[]; kept: { path: string; reason: string }[] }> {
    const { state, project } = this.opts;
    const removed: string[] = [];
    const kept: { path: string; reason: string }[] = [];
    for (const w of state.q.worktrees(this.pid, ['released'])) {
      if (!state.inThisClone(w.path)) {
        kept.push({ path: w.path, reason: 'it belongs to another clone of the project; this clone never touches it' });
        continue;
      }
      try {
        await removeWorktree(project.root, w.path);
        state.worktreeRemoved(this.pid, actor, w.worktree_id);
        removed.push(w.path);
      } catch (e) {
        kept.push({ path: w.path, reason: (e as Error).message });
      }
    }
    return { removed, kept };
  }

  /** Worktrees with their present state on disk. */
  async list(all: boolean): Promise<(WorktreeView & { present: boolean; uncommitted: number | null })[]> {
    const rows = this.opts.state.q.worktrees(this.pid, all ? undefined : ['active', 'preserved', 'released']);
    return Promise.all(
      rows.map(async (w) => {
        if (w.status === 'removed') return { ...w, present: false, uncommitted: null };
        const identity = await GitRoot.open(w.path)
          .then((r) => r.identity())
          .catch(() => null);
        return { ...w, present: identity !== null, uncommitted: identity ? identity.files : null };
      }),
    );
  }
}
