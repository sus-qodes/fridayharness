import path from 'node:path';
import type { ExecutionProfile, ProcessGroups } from '@friday/execution';
import {
  agentIdentity,
  changedBetween,
  checkoutForVerification,
  commitContent,
  commitTree,
  GitRoot,
  goalBranch,
  isAncestor,
  mergeCommits,
  moveRef,
  resolveCommit,
  sameRepository,
  treeOf,
} from '@friday/git';
import type { Actor, IntegrationView } from '@friday/protocol';
import type { ProjectRef } from '@friday/sdk';
import type { FridayState } from '@friday/state';
import { selectChecks, summarizeOutcome } from '@friday/verification';
import { runCheckInProfile } from './execution.js';
import type { Logger } from './log.js';
import type { WorkspaceManager } from './workspaces.js';

const SYSTEM: Actor = { kind: 'system', id: 'friday' };

type Outcome = Omit<IntegrationView, 'integration_id' | 'created_at'>;

/**
 * Brings each verified task branch of a goal into the goal branch `friday/goal-<goal_id>`
 * (ADR-0025 §2–§5): exactly the tree the verification judged is committed on its task branch if it
 * is not yet, merged without a checkout, the merged revision verified in Friday's own checkout (and
 * refused if the checks changed it), and only then is the goal branch moved, from the commit Friday
 * saw. One integration at a time per goal; the main checkout is never touched, and landing the goal
 * branch stays a human's step.
 */
export class IntegrationManager {
  readonly #chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly opts: {
      state: FridayState;
      project: ProjectRef;
      logger: Logger;
      workspaces: WorkspaceManager;
      /** The execution profile the merged revision's checks run in (ADR-0029 §6). */
      profile: () => ExecutionProfile;
      /** Each check's process tree ends with it (review F07). */
      groups?: ProcessGroups;
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
      // 1. The verified work, as a commit on the task branch: exactly the tree the verification
      // judged, never what the worktree holds by the time it is committed (review F04).
      const verified = state.q.latestVerification(taskId);
      if (verified?.status !== 'PASSED') {
        return record({ ...base, summary: 'the task has no passed verification to integrate' });
      }
      // A worktree of another clone (a restored database) is never written from here (review F08).
      if (!state.inThisClone(tree.path) || !(await sameRepository(tree.path, project.root))) {
        return record({
          ...base,
          summary: `its worktree ${tree.path} belongs to another clone of the project, which this clone never writes; integrate it there, or verify the work again in this clone`,
        });
      }
      const git = await GitRoot.open(tree.path);
      const now = await git.identity();
      const changedAfter = (detail: string) =>
        record({
          ...base,
          summary: `the worktree changed after it was verified (${detail}); verify the work again before integrating it`,
        });
      if (verified.source_version && now.version !== verified.source_version) {
        return changedAfter(`${verified.source_version} became ${now.version}`);
      }
      const content = await git.contentTree();
      let candidate: string;
      let basis: string;
      if (verified.tree) {
        if (content.tree !== verified.tree || content.head !== verified.commit_sha) {
          const paths = await changedBetween(project.root, verified.tree, content.tree).catch(() => []);
          return changedAfter(paths.length ? `${paths.slice(0, 5).join(', ')} changed` : 'its HEAD moved');
        }
        candidate = verified.tree;
        basis = `verified as ${verified.source_version ?? verified.tree}`;
      } else if (verified.checks.some((c) => c.kind === 'manual')) {
        // A human recorded the result: their word covers the work as it is now.
        candidate = content.tree;
        basis = 'passed by a human result';
      } else {
        return record({
          ...base,
          summary:
            'the verification recorded no exact tree to integrate (it predates Friday recording one); verify the work again',
        });
      }
      let taskCommit = content.head;
      if (!taskCommit || candidate !== (await treeOf(tree.path, taskCommit))) {
        const agentId = task.assigned_agent_id ?? state.q.runs(taskId).at(-1)?.agent_id;
        const agentKey = (agentId && state.q.findAgent(agentId)?.agent_key) || 'agent';
        taskCommit = await commitContent(
          tree.path,
          candidate,
          content.head,
          `${task.summary}\n\nFriday task ${taskId}, ${basis}.`,
          agentIdentity(agentKey),
        );
      }
      if (!taskCommit) return record({ ...base, summary: 'the task branch has no commit' });
      if ((await treeOf(project.root, taskCommit)) !== candidate) {
        return record({ ...base, task_commit: taskCommit, summary: 'the task commit does not hold the verified tree' });
      }

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

      // 4. Verify the merged revision in Friday's own checkout before the goal branch moves. The
      // checks must judge exactly the merged tree and leave it as it was: a check that changes what
      // it checks (a formatter, a generator) passed something else (review F04).
      const checks = selectChecks(project.config.verification.checks, task.kind);
      const results: Outcome['checks'] = [];
      let failed = 0;
      let altered: string[] = [];
      if (checks.length) {
        const dir = await checkoutForVerification(project.root, workspaces.dir, `goal-${goalId.slice(-8)}`, commit);
        const checkout = await GitRoot.open(dir);
        if ((await checkout.contentTree()).tree !== merged.tree) {
          return record({
            ...base,
            task_commit: taskCommit,
            base_commit: goalHead,
            summary: `Friday's checkout of the merged revision does not hold it; ${branch} was not moved`,
          });
        }
        for (const check of checks) {
          const outcome = await runCheckInProfile(
            this.opts.profile(),
            {
              name: check.name,
              command: check.command,
              args: check.args,
              root: dir,
              cwd: check.cwd ? path.resolve(dir, check.cwd) : dir,
              env: check.env,
              timeoutMs: check.timeout_ms,
            },
            this.opts.groups,
          );
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
        const after = await checkout.contentTree();
        if (after.tree !== merged.tree) altered = await changedBetween(project.root, merged.tree, after.tree);
      }
      if (altered.length) {
        return record({
          ...base,
          task_commit: taskCommit,
          base_commit: goalHead,
          checks: results,
          summary: `the checks changed ${altered.slice(0, 5).join(', ')}${altered.length > 5 ? ` and ${altered.length - 5} more` : ''} in the merged revision ${commit.slice(0, 12)}, so what passed is not what would land; ${branch} was not moved`,
        });
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
