import { allocateWorktree, GitRoot, goalBranch, removeWorktree, resolveCommit, worktreesDir } from '@friday/git';
import type { Actor, WorktreeView } from '@friday/protocol';
import type { ProjectRef } from '@friday/sdk';
import type { FridayState } from '@friday/state';
import type { Logger } from './log.js';

const SYSTEM: Actor = { kind: 'system', id: 'friday' };

/**
 * Task worktrees for the daemon (ADR-0023): prepares the worktree of every spawn run that waits
 * for one, creates worktrees humans ask for, releases them when their task ends and prunes the
 * clean ones. Git runs here, never inside a state transaction.
 */
export class WorkspaceManager {
  readonly #preparing = new Set<string>();

  constructor(
    private readonly opts: { state: FridayState; project: ProjectRef; logger: Logger; env: NodeJS.ProcessEnv },
  ) {}

  /** Where this machine keeps task worktrees. */
  get dir(): string {
    return worktreesDir(this.opts.env);
  }

  private get pid() {
    return this.opts.project.project_id;
  }

  /**
   * Where a task's new branch starts (ADR-0025 §4): a goal's task starts from the goal branch, which
   * holds its completed dependencies' integrated work; any other task from the main checkout's HEAD.
   */
  private async baseFor(taskId: string): Promise<string | undefined> {
    const goalId = this.opts.state.q.findTask(this.pid, taskId)?.goal_id;
    if (!goalId) return undefined;
    return (await resolveCommit(this.opts.project.root, `refs/heads/${goalBranch(goalId)}`)) ?? undefined;
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
      const alloc = await allocateWorktree({
        mainRoot: project.root,
        worktreesDir: this.dir,
        taskId: run.task_id,
        project: { project_id: project.project_id, name: project.name },
        ...(await this.baseFor(run.task_id).then((base) => (base ? { base } : {}))),
      });
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

  /** A worktree for a human to start a session in (`friday task worktree <task>`). */
  async forTask(
    taskId: string,
    actor: Actor,
  ): Promise<{ worktree: WorktreeView; warnings: string[]; created: boolean }> {
    const { state, project } = this.opts;
    state.q.task(this.pid, taskId);
    const alloc = await allocateWorktree({
      mainRoot: project.root,
      worktreesDir: this.dir,
      taskId,
      ...(await this.baseFor(taskId).then((base) => (base ? { base } : {}))),
      project: { project_id: project.project_id, name: project.name },
    });
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
