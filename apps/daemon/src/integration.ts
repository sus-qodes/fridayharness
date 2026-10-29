import path from 'node:path';
import {
  agentIdentity,
  checkoutForVerification,
  commitAll,
  commitTree,
  GitRoot,
  goalBranch,
  isAncestor,
  mergeCommits,
  moveRef,
  resolveCommit,
} from '@friday/git';
import type { Actor, IntegrationView } from '@friday/protocol';
import type { ProjectRef } from '@friday/sdk';
import type { FridayState } from '@friday/state';
import { runCheck, selectChecks, summarizeOutcome } from '@friday/verification';
import type { Logger } from './log.js';
import type { WorkspaceManager } from './workspaces.js';

const SYSTEM: Actor = { kind: 'system', id: 'friday' };

type Outcome = Omit<IntegrationView, 'integration_id' | 'created_at'>;

/**
 * Brings each verified task branch of a goal into the goal branch `friday/goal-<goal_id>`
 * (ADR-0025 §2–§5): the verified work is committed on its task branch if it is not yet, merged
 * without a checkout, the merged revision verified in Friday's own checkout, and only then is the
 * goal branch moved, from the commit Friday saw. One integration at a time per goal; the main
 * checkout is never touched, and landing the goal branch stays a human's step.
 */
export class IntegrationManager {
  readonly #chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly opts: {
      state: FridayState;
      project: ProjectRef;
      logger: Logger;
      workspaces: WorkspaceManager;
    },
  ) {}

  private get pid() {
    return this.opts.project.project_id;
  }

  /** A task completed: its work is integrated when it waits for that, else its worktree is released. */
  completed(taskId: string): Promise<IntegrationView | null> {
    const { state, workspaces } = this.opts;
    const task = state.q.findTask(this.pid, taskId);
    if (task?.status !== 'COMPLETED') return Promise.resolve(null);
    if (!state.awaitsIntegration(task)) {
      return workspaces.release(taskId, 'the task completed').then(() => null);
    }
    return this.integrate(taskId, SYSTEM);
  }

  /** Integrates a completed task now (also `friday integrate <task>` after a human resolved a conflict). */
  integrate(taskId: string, actor: Actor): Promise<IntegrationView> {
    const goalId = this.opts.state.q.task(this.pid, taskId).goal_id ?? 'none';
    const prev = this.#chains.get(goalId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.#integrate(taskId, actor));
    this.#chains.set(goalId, next);
    return next;
  }

  /** Completed tasks of goals that still wait for integration (after a restart). */
  async sweep(): Promise<void> {
    const { state } = this.opts;
    for (const t of state.q.tasks(this.pid, { statuses: ['COMPLETED'] })) {
      if (state.awaitsIntegration(t) && !state.q.latestIntegration(this.pid, t.task_id))
        await this.completed(t.task_id);
    }
  }

  async #integrate(taskId: string, actor: Actor): Promise<IntegrationView> {
    const { state, project, logger, workspaces } = this.opts;
    const task = state.q.task(this.pid, taskId);
    const goalId = task.goal_id as string;
    const branch = goalBranch(goalId);
    const ref = `refs/heads/${branch}`;
    const base: Outcome = {
      goal_id: goalId,
      task_id: taskId,
      status: 'failed',
      branch,
      task_commit: null,
      base_commit: null,
      merged_commit: null,
      conflicts: [],
      checks: [],
      summary: null,
    };
    const record = async (o: Outcome) => {
      const rec = state.recordIntegration(this.pid, actor, o);
      logger.info('task integration', { task_id: taskId, goal_id: goalId, status: o.status, summary: o.summary });
      if (o.status === 'integrated' || o.status === 'not_needed') {
        await workspaces.release(taskId, `integrated into ${branch}`).catch(() => undefined);
      }
      return rec;
    };
    const tree = state.q.worktreeForTask(taskId);
    if (!tree) return record({ ...base, status: 'not_needed', summary: 'the task did not work on a task branch' });
    try {
      // 1. The verified work, as a commit on the task branch.
      const verified = state.q.latestVerification(taskId);
      if (verified?.status !== 'PASSED') {
        return record({ ...base, summary: 'the task has no passed verification to integrate' });
      }
      const git = await GitRoot.open(tree.path);
      const now = await git.identity();
      if (verified.source_version && now.version !== verified.source_version) {
        return record({
          ...base,
          summary: `the worktree changed after it was verified (${verified.source_version} became ${now.version}); verify the work again before integrating it`,
        });
      }
      let taskCommit = now.head;
      if (now.dirty) {
        const agentId = task.assigned_agent_id ?? state.q.runs(taskId).at(-1)?.agent_id;
        const agentKey = (agentId && state.q.findAgent(agentId)?.agent_key) || 'agent';
        taskCommit = await commitAll(
          tree.path,
          `${task.summary}\n\nFriday task ${taskId}, verified as ${verified.source_version}.`,
          agentIdentity(agentKey),
        );
      }
      if (!taskCommit) return record({ ...base, summary: 'the task branch has no commit' });

      // 2. The goal branch, created from the main checkout's HEAD the first time.
      let goalHead = await resolveCommit(project.root, ref);
      if (!goalHead) {
        const start = await resolveCommit(project.root, 'HEAD');
        if (!start) return record({ ...base, task_commit: taskCommit, summary: 'the main checkout has no commit' });
        await moveRef(project.root, ref, start, null);
        goalHead = start;
      }

      // 3. Already there, a fast-forward (the result is the verified commit itself), or a merge.
      if (await isAncestor(project.root, taskCommit, goalHead)) {
        return record({
          ...base,
          status: 'integrated',
          task_commit: taskCommit,
          base_commit: goalHead,
          merged_commit: goalHead,
          summary: `already contained in ${branch}`,
        });
      }
      if (await isAncestor(project.root, goalHead, taskCommit)) {
        await moveRef(project.root, ref, taskCommit, goalHead);
        return record({
          ...base,
          status: 'integrated',
          task_commit: taskCommit,
          base_commit: goalHead,
          merged_commit: taskCommit,
          summary: `fast-forward: ${branch} now points at the verified commit`,
        });
      }
      const merged = await mergeCommits(project.root, goalHead, taskCommit);
      if (merged.conflicts.length) {
        return record({
          ...base,
          status: 'conflicted',
          task_commit: taskCommit,
          base_commit: goalHead,
          conflicts: merged.conflicts,
          summary: `${merged.conflicts.length} file(s) conflict with ${branch}`,
        });
      }
      const commit = await commitTree(
        project.root,
        merged.tree,
        [goalHead, taskCommit],
        `Integrate ${taskId}: ${task.summary}`,
      );

      // 4. Verify the merged revision in Friday's own checkout before the goal branch moves.
      const checks = selectChecks(project.config.verification.checks, task.kind);
      const results: Outcome['checks'] = [];
      let failed = 0;
      if (checks.length) {
        const dir = await checkoutForVerification(project.root, workspaces.dir, `goal-${goalId.slice(-8)}`, commit);
        for (const check of checks) {
          const outcome = await runCheck({
            name: check.name,
            command: check.command,
            args: check.args,
            cwd: check.cwd ? path.resolve(dir, check.cwd) : dir,
            timeoutMs: check.timeout_ms,
          });
          const artifact = state.artifacts?.storeText(
            this.pid,
            'verification',
            `$ ${check.command} ${check.args.join(' ')}\n(integrated revision ${commit} in ${dir})\n${outcome.output}`,
          );
          results.push({
            name: check.name,
            status: outcome.passed ? 'PASSED' : 'FAILED',
            exit_code: outcome.exit_code,
            artifact_ref: artifact ? `artifact:${artifact.artifact_id}` : null,
            summary: summarizeOutcome(outcome),
          });
          if (!outcome.passed && check.required) failed += 1;
        }
      }
      if (failed) {
        return record({
          ...base,
          task_commit: taskCommit,
          base_commit: goalHead,
          checks: results,
          summary: `${failed} required check(s) failed on the merged revision ${commit.slice(0, 12)}; ${branch} was not moved`,
        });
      }

      // 5. Move the goal branch, only from the commit Friday merged into.
      await moveRef(project.root, ref, commit, goalHead);
      return record({
        ...base,
        status: 'integrated',
        task_commit: taskCommit,
        base_commit: goalHead,
        merged_commit: commit,
        checks: results,
        summary: checks.length
          ? `${results.length} check(s) passed on the merged revision`
          : 'merged; no configured check applies to this kind of task',
      });
    } catch (e) {
      logger.warn('task integration failed', { task_id: taskId, message: (e as Error).message });
      return record({ ...base, summary: (e as Error).message });
    }
  }
}
