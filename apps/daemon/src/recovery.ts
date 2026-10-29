import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import {
  agentIdentity,
  changedBetween,
  commitsSince,
  GitRoot,
  listRefs,
  parentOf,
  preserveCommit,
  preservedPrefix,
  resetWorktree,
  resolveCommit,
  restoredRef,
  runGit,
  snapshotWorktree,
  taskBranch,
} from '@friday/git';
import {
  type Actor,
  FridayError,
  type RecoveryAction,
  type RecoveryAssessment,
  type RunView,
  type TaskView,
} from '@friday/protocol';
import type { ProjectRef } from '@friday/sdk';
import type { FridayState } from '@friday/state';
import type { Logger } from './log.js';
import { elsewhereReason, missingCodeReason, type WorkspaceManager } from './workspaces.js';

const SYSTEM: Actor = { kind: 'system', id: 'friday' };
const ACTIVE = ['ASSIGNED', 'RUNNING', 'WAITING', 'HARNESS_LOST'];
const TERMINAL = ['COMPLETED', 'CANCELLED', 'ABANDONED'];

/** Whether two paths name one folder: as written, else by their real paths when both exist. */
function sameDir(a: string, b: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  if (norm(a) === norm(b)) return true;
  try {
    return norm(realpathSync.native(a)) === norm(realpathSync.native(b));
  } catch {
    return false;
  }
}

/**
 * The paths a run's completion claim lists that `head` does not change since `base` (review M7.1
 * R05). A claim brought into this clone without the uncommitted work a backup recorded is judged
 * here on its branch alone, which must then hold what the claim describes. When the base is not
 * here, nothing can be shown to be here.
 */
async function claimedNotOn(root: string, run: RunView | undefined, base: string | null, head: string) {
  const claim = run?.claim as { changed_paths?: unknown } | null | undefined;
  if (!claim || !Array.isArray(claim.changed_paths)) return [];
  const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const claimed = claim.changed_paths
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .map((p) => (path.isAbsolute(p) && run?.execution_root ? path.relative(run.execution_root, p) : p))
    .map((p) => p.split(path.sep).join('/').replaceAll('\\', '/').replace(/^\.\//, ''));
  const changed = base ? await changedBetween(root, base, head).catch(() => null) : null;
  if (!changed) return claimed;
  const here = new Set(changed.map(fold));
  return [...new Set(claimed)].filter((p) => !here.has(fold(p))).sort();
}

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
      /** Rebuilds a task's worktree in this clone for a human's choice (review F16). */
      workspaces?: WorkspaceManager;
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
    const branch = taskBranch(taskId);
    const branchHere = await resolveCommit(project.root, `refs/heads/${branch}`).catch(() => null);
    // A backup's record of the worktree's uncommitted work, restored into this clone (review F16).
    const restoredHere = await resolveCommit(project.root, restoredRef(taskId)).catch(() => null);
    // Earlier attempts worked on the task's branch, which this clone does not have (review F16).
    const missingCode =
      !branchHere && (elsewhere || state.q.runs(taskId).some((r) => r.branch_ref === branch))
        ? missingCodeReason(taskId)
        : null;
    // The last attempt worked in a checkout that is not this clone's, and no worktree record
    // covers it (a session in another clone's main checkout): its uncommitted changes are not here.
    const ranElsewhere =
      !tree &&
      run?.execution_root &&
      !sameDir(run.execution_root, project.root) &&
      !state.inThisClone(run.execution_root)
        ? run.execution_root
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
        branch_here: elsewhere ? branchHere : null,
        restored_here: restoredHere,
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
        ? elsewhereReason(taskId, tree.path, branchHere, restoredHere)
        : missingCode
          ? missingCode
          : ranElsewhere
            ? `its last attempt worked in ${ranElsewhere}, which is not a checkout of this clone, so changes it did not commit to a branch this clone has are not here; a backup does not copy a main checkout. Continue in this clone as it is with "friday recover ${taskId} --action reassign"`
            : alive === true
              ? `its host process (pid ${harness?.host_pid}) is still running on this machine, so it may still be writing`
              : exhausted
                ? `it has had ${attempts} attempt(s), and recovery.max_retries is ${settings.maxRetries}`
                : repeating
                  ? `the same error repeated ${same} time(s): ${last}`
                  : null;
    // A task waiting in READY because its work is elsewhere is recovered by a human's choice too.
    const movable = active || ((elsewhere || missingCode !== null) && task.status === 'READY');
    // Work claimed, or verified and not yet integrated, in another clone: it is brought here as it is,
    // and its task keeps its state, to be verified or integrated here (review M7.1 R05).
    const settled =
      task.status === 'READY_FOR_VERIFICATION' ||
      (task.status === 'COMPLETED' &&
        state.awaitsIntegration(task) &&
        !['integrated', 'not_needed'].includes(state.q.latestIntegration(this.pid, taskId)?.status ?? ''));
    // Without the uncommitted work a backup recorded, a claim is brought over only when its branch
    // here holds what it lists: verification must judge the work the claim describes. Verified work
    // needs no such check, as integration accepts only the exact tree verified (ADR-0025).
    const notHere =
      elsewhere && task.status === 'READY_FOR_VERIFICATION' && branchHere && !restoredHere && tree
        ? await claimedNotOn(project.root, run, tree.base_commit, branchHere)
        : [];
    const next = task.status === 'COMPLETED' ? 'integrate it here ("friday integrate")' : 'verify it here';
    const fromBase = `the next attempt starts over in this clone from the task's base, without the earlier attempts' work${restoredHere ? `; the uncommitted work a backup recorded is kept as a preserved state` : ''}`;
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
        available: movable && missingCode === null,
        recommended: active && lost && !windowOpen && whyHuman === null,
        reason: missingCode
          ? `this clone has no ${branch}: restore a backup that holds it, or fetch it from a clone that has it, first`
          : elsewhere
            ? restoredHere
              ? `the next attempt continues in a worktree of this clone, from ${branch} with the uncommitted work a backup recorded`
              : `the next attempt continues from ${branch} in this clone; uncommitted work in the other clone's worktree is not included`
            : worktree?.exists
              ? 'the next attempt continues in the same worktree and branch; uncommitted work is preserved first'
              : ranElsewhere
                ? `the next attempt works in this clone as it is; changes that were only in ${ranElsewhere} are not included`
                : 'the task goes back to READY for the next agent',
      },
      {
        action: 'restart',
        available: elsewhere || missingCode ? movable : active && Boolean(worktree?.exists),
        recommended: false,
        reason: missingCode
          ? fromBase
          : elsewhere
            ? `the next attempt starts over in this clone, from the last commit of ${branch}${restoredHere ? '; the uncommitted work a backup recorded is kept as a preserved state' : ''}`
            : 'the next attempt starts from the last commit; uncommitted work is preserved first',
      },
      {
        action: 'rebind',
        available: elsewhere && settled && branchHere !== null && notHere.length === 0,
        recommended: elsewhere && settled && branchHere !== null && notHere.length === 0,
        reason: !elsewhere
          ? 'its work is in this clone already'
          : !settled
            ? 'only work claimed, or verified and not yet integrated, is brought here as it is; an attempt still under way is reassigned or restarted'
            : branchHere === null
              ? `this clone has no ${branch}: restore a backup that holds it, or fetch it from the clone that has it, first`
              : notHere.length
                ? `the claim lists changes ${branch} does not hold here (${notHere.slice(0, 5).join(', ')}${notHere.length > 5 ? ` and ${notHere.length - 5} more` : ''}), and no backup's record of its uncommitted work is here, so verifying it here would judge other code than the claim describes. Restore a backup that recorded that work; if it is lost, record it ("friday verify ${taskId} --result failed --note ...") and rework the task`
                : `its work is brought into a worktree of this clone from ${branch}${restoredHere ? ' with the uncommitted work a backup recorded' : ''}, and the task stays ${task.status}; then ${next}`,
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
      missing_code: missingCode,
      errors: { total: errors.length, same_as_last: same, last },
      preserved: await listRefs(project.root, preservedPrefix(taskId)).catch(() => []),
      options,
    };
  }

  /** Whether a recovery action is under way for the task (halt leaves such a task alone). */
  isBusy(taskId: string): boolean {
    return this.#busy.has(taskId);
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
      if (action === 'rebind') return await this.#rebind(taskId, a, actor, why);
      let preserved: string | null = null;
      let note: string | null = null;
      const moving = action === 'reassign' || action === 'restart';
      if (moving && (a.worktree?.elsewhere || a.missing_code)) {
        // Never written from this clone: the human's choice retires it here, and the next attempt
        // gets a worktree of this clone (review F08).
        const tree = state.q.worktreeForTask(taskId);
        const restored = a.worktree?.restored_here ?? (await resolveCommit(project.root, restoredRef(taskId)));
        // The work comes back into a worktree of this clone (reassign with a backup's record), or
        // the task starts over from its base when its branch is not here (restart): an explicit
        // choice, never taken for the earlier work (review F16).
        if ((action === 'reassign' && restored) || (action === 'restart' && a.missing_code)) {
          if (!this.opts.workspaces) throw new FridayError('invalid_request', 'task worktrees are not managed here');
          const rebuilt = await this.opts.workspaces.rebuild(taskId, actor, action === 'reassign' ? restored : null);
          note = rebuilt.note;
        }
        // A backup's record is used once; it stays as a preserved state of the task.
        if (restored) {
          preserved = await preserveCommit(project.root, preservedPrefix(taskId), 'restored', restored);
          await runGit(project.root, ['update-ref', '-d', restoredRef(taskId), restored]);
        }
        if (tree && !state.inThisClone(tree.path)) {
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
            { task_id: taskId, action, reason: why, preserved_ref: preserved, note },
            [{ kind: 'task', id: taskId }],
          );
          logger.info('task recovered', { task_id: taskId, action, reason: why, preserved_ref: preserved, note });
          return { task: state.q.task(this.pid, taskId), preserved_ref: preserved, assessment: a };
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
          ...(note ? { note } : {}),
        },
      });
      logger.info('task recovered', { task_id: taskId, action, preserved_ref: preserved, reason: why, note });
      // A human acted on the task: its recovery question is settled, or the Master Brain would
      // keep skipping the task and the card would stay (plan M9 §5.7).
      // (`needs_human` is the action that asks it.)
      if (actor.kind === 'human' && action !== 'needs_human') {
        state.settleRecoveryQuestions(this.pid, actor, taskId, action);
      }
      return { task, preserved_ref: preserved, assessment: a };
    } finally {
      this.#busy.delete(taskId);
    }
  }

  /**
   * Brings a task's claimed or verified work from another clone's worktree into one of this clone,
   * exactly as the backup recorded it, without changing the task's state (review M7.1 R05): the
   * task branch, with the uncommitted work on top, and the run that claimed it pointed there. The
   * task is then verified, or integrated, here. Another clone's checkout is never written.
   */
  async #rebind(
    taskId: string,
    a: RecoveryAssessment,
    actor: Actor,
    why: string,
  ): Promise<{ task: TaskView; preserved_ref: string | null; assessment: RecoveryAssessment }> {
    const { state, project, logger, workspaces } = this.opts;
    if (!workspaces) throw new FridayError('invalid_request', 'task worktrees are not managed here');
    const restored = a.worktree?.restored_here ?? null;
    // The exact work or nothing: a record whose branch moved since is not written onto other code.
    if (restored && (await parentOf(project.root, restored)) !== a.worktree?.branch_here) {
      throw new FridayError(
        'invalid_request',
        `${taskBranch(taskId)} moved since the backup recorded the uncommitted work of ${taskId}; its work cannot be brought here exactly. Compare ${restoredRef(taskId)} with the branch, then reassign or restart the task`,
      );
    }
    const foreign = state.q.worktreeForTask(taskId);
    const rebuilt = await workspaces.rebuild(taskId, actor, restored);
    // The run that claimed the work now works from here: verification judges it in this clone.
    const task = state.q.task(this.pid, taskId);
    const runId = task.current_run_id ?? state.q.runs(taskId).at(-1)?.run_id ?? null;
    if (runId) state.rebindRun(this.pid, actor, runId, rebuilt.worktree.path, why);
    let preserved: string | null = null;
    if (restored) {
      preserved = await preserveCommit(project.root, preservedPrefix(taskId), 'restored', restored);
      await runGit(project.root, ['update-ref', '-d', restoredRef(taskId), restored]);
    }
    if (foreign && !state.inThisClone(foreign.path)) {
      state.releaseWorktree(
        this.pid,
        actor,
        foreign.worktree_id,
        'released',
        `it belongs to another clone of the project; its work was brought into this clone: ${why}`,
      );
    }
    for (const e of state.q.escalations(this.pid, 'pending')) {
      if (e.task_id === taskId && e.kind === 'recovery_needed' && actor.kind === 'human') {
        state.answerEscalation(this.pid, actor, String(e.escalation_id), `rebind: ${why}`);
      }
    }
    state.recordObservation(
      this.pid,
      actor,
      'recovery.performed',
      { task_id: taskId, action: 'rebind', reason: why, preserved_ref: preserved, note: rebuilt.note },
      [{ kind: 'task', id: taskId }],
    );
    logger.info('task work brought into this clone', {
      task_id: taskId,
      path: rebuilt.worktree.path,
      status: task.status,
      preserved_ref: preserved,
    });
    return { task: state.q.task(this.pid, taskId), preserved_ref: preserved, assessment: a };
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
