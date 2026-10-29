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
  parentOf,
  resolveCommit,
  sameRepository,
  treeOf,
} from '@friday/git';
import type { Actor, IntegrationView, TaskView } from '@friday/protocol';
import type { ProjectRef } from '@friday/sdk';
import type { FridayState } from '@friday/state';
import { selectChecks, summarizeOutcome } from '@friday/verification';
import { runCheckInProfile } from './execution.js';
import { InFlight } from './in-flight.js';
import type { Logger } from './log.js';
import type { WorkspaceManager } from './workspaces.js';

const SYSTEM: Actor = { kind: 'system', id: 'friday' };

type Outcome = Omit<IntegrationView, 'integration_id' | 'created_at'>;

/** How an integration attempt runs (`friday integrate <task> [--repaired]`). */
export interface IntegrateOptions {
  /**
   * A human repaired a failed or conflicted integration on the task branch (review M7.1 R04): the
   * branch's tip, which must keep the verified work, is integrated only after its checks pass.
   */
  repaired?: boolean;
}

/**
 * Brings each verified task branch of a goal into the goal branch `friday/goal-<goal_id>`
 * (ADR-0025 §2–§5): exactly the tree the verification judged is committed on its task branch if it
 * is not yet, merged without a checkout, the merged revision verified in Friday's own checkout (and
 * refused if the checks changed it), and only then is the goal branch moved, from the commit Friday
 * saw. One integration at a time per goal; the main checkout is never touched, and landing the goal
 * branch stays a human's step.
 *
 * A retry continues from the commit Friday made of the verified tree (review M7.1 R04), so a cause
 * outside the task (a flaky check, a goal branch fixed meanwhile) needs no new verification. A goal
 * branch only ever moves to a revision Friday verified: the verified commit itself (a
 * fast-forward), or a revision whose checks passed in Friday's checkout (a merge, a human's repair).
 */
export class IntegrationManager {
  readonly #chains = new Map<string, Promise<unknown>>();
  readonly #inFlight = new InFlight();

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

  /**
   * Integrates a completed task now: again after a failure whose cause is gone, or after a human
   * resolved a conflict (`friday integrate <task>`, with `repaired` for a repair on the task branch).
   */
  integrate(taskId: string, actor: Actor, opts: IntegrateOptions = {}): Promise<IntegrationView> {
    const goalId = this.opts.state.q.task(this.pid, taskId).goal_id ?? 'none';
    const prev = this.#chains.get(goalId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.#integrate(taskId, actor, opts));
    this.#chains.set(goalId, next);
    return this.#inFlight.track(next);
  }

  /** Resolves once the integrations in flight have finished, or after `ms` (the daemon's shutdown). */
  idle(ms: number): Promise<boolean> {
    return this.#inFlight.idle(ms);
  }

  /**
   * Completed tasks of goals that still wait for integration (after a restart), also one whose
   * verified work Friday had committed before it stopped (review M7.1 R04).
   */
  async sweep(): Promise<void> {
    const { state } = this.opts;
    for (const t of state.q.tasks(this.pid, { statuses: ['COMPLETED'] })) {
      if (state.awaitsIntegration(t) && !state.q.latestIntegration(this.pid, t.task_id))
        await this.completed(t.task_id);
    }
  }

  async #integrate(taskId: string, actor: Actor, opts: IntegrateOptions): Promise<IntegrationView> {
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
    // What came before: a repair follows a failed or conflicted attempt, and keeps the commit of the
    // verified work the last attempt that got that far made.
    const last = state.q.latestIntegration(this.pid, taskId);
    const unresolved = last?.status === 'failed' || last?.status === 'conflicted';
    const verifiedCommit =
      state.q
        .integrations(this.pid, { task_id: taskId })
        .filter((i) => i.task_commit)
        .at(-1)?.task_commit ?? null;
    try {
      const verified = state.q.latestVerification(taskId);
      if (verified?.status !== 'PASSED') {
        return record({ ...base, summary: 'the task has no passed verification to integrate' });
      }
      // A worktree of another clone (a restored database) is never written from here (review F08).
      if (!state.inThisClone(tree.path) || !(await sameRepository(tree.path, project.root))) {
        return record({
          ...base,
          summary: `its worktree ${tree.path} belongs to another clone of the project, which this clone never writes; bring its work into this clone with "friday recover ${taskId} --action rebind" and integrate it again`,
        });
      }
      const git = await GitRoot.open(tree.path);
      const content = await git.contentTree();
      const changedAfter = (detail: string) =>
        record({
          ...base,
          summary: `the worktree changed after it was verified (${detail}); verify the work again before integrating it${unresolved ? `, or, if this is your repair of the failed integration, run "friday integrate ${taskId} --repaired"` : ''}`,
        });

      // 1. The commit to integrate.
      let taskCommit: string | null;
      let candidate: string;
      let checked: boolean;
      if (opts.repaired) {
        // A human's repair on the task branch: its tip, committed, keeping the verified work. Its
        // content is new, so it is integrated only after its checks pass (review M7.1 R04).
        if (actor.kind !== 'human') {
          return record({ ...base, summary: 'only a human says that a task branch holds a repair' });
        }
        if (!unresolved || !verifiedCommit) {
          return record({
            ...base,
            summary:
              'there is no failed or conflicted integration of this task to repair; integrate it without --repaired',
          });
        }
        if (!content.head || content.tree !== (await treeOf(tree.path, content.head))) {
          return record({ ...base, summary: 'the repair is not committed: commit it on the task branch first' });
        }
        if (!(await isAncestor(tree.path, verifiedCommit, content.head))) {
          return record({
            ...base,
            summary: `the repair must keep the verified work, but ${verifiedCommit.slice(0, 12)} is not in the history of ${content.head.slice(0, 12)}`,
          });
        }
        taskCommit = content.head;
        candidate = content.tree;
        checked = false;
      } else if (verified.tree) {
        // Exactly the verified tree, never what the worktree holds by the time it is committed
        // (review F04): the verified commit itself with the verified content on it, or the commit
        // Friday made of exactly that tree on top of it in an earlier attempt (review M7.1 R04).
        if (content.tree !== verified.tree) {
          const paths = await changedBetween(project.root, verified.tree, content.tree).catch(() => []);
          return changedAfter(paths.length ? `${paths.slice(0, 5).join(', ')} changed` : 'its files changed');
        }
        if (content.head !== verified.commit_sha) {
          const own =
            content.head !== null &&
            (await treeOf(tree.path, content.head)) === verified.tree &&
            (await parentOf(tree.path, content.head)) === verified.commit_sha;
          if (!own) return changedAfter('its HEAD moved');
        }
        candidate = verified.tree;
        taskCommit = content.head;
        checked = true;
        if (!taskCommit || candidate !== (await treeOf(tree.path, taskCommit))) {
          taskCommit = await this.#commitVerified(task, tree.path, candidate, content.head, verified.source_version);
        }
      } else if (verified.checks.some((c) => c.kind === 'manual')) {
        // A human recorded the result: their word covers the work as it is now.
        candidate = content.tree;
        taskCommit = content.head;
        checked = true;
        if (!taskCommit || candidate !== (await treeOf(tree.path, taskCommit))) {
          taskCommit = await this.#commitVerified(task, tree.path, candidate, content.head, null);
        }
      } else {
        return record({
          ...base,
          summary:
            'the verification recorded no exact tree to integrate (it predates Friday recording one); verify the work again',
        });
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
      const repair = opts.repaired ? ' (a repair by a human)' : '';

      // 3. Already there, a fast-forward, or a merge.
      if (await isAncestor(project.root, taskCommit, goalHead)) {
        if (!unresolved) {
          return record({
            ...base,
            status: 'integrated',
            task_commit: taskCommit,
            base_commit: goalHead,
            merged_commit: goalHead,
            summary: `already contained in ${branch}`,
          });
        }
        // After a failed attempt, the goal branch reached the work some other way (a human resolved
        // it there): what it holds now is checked before the task counts as integrated.
        const goalTree = (await treeOf(project.root, goalHead)) as string;
        const outcome = await this.#checkRevision(task, goalId, goalHead, goalTree);
        if (outcome.problem) {
          return record({ ...base, task_commit: taskCommit, base_commit: goalHead, ...outcome.problem });
        }
        return record({
          ...base,
          status: 'integrated',
          task_commit: taskCommit,
          base_commit: goalHead,
          merged_commit: goalHead,
          checks: outcome.results,
          summary: `contained in ${branch}, where it was resolved after the failed attempt; ${outcome.ran ? `${outcome.results.length} check(s) passed on it` : 'no configured check applies to this kind of task'}`,
        });
      }
      if (await isAncestor(project.root, goalHead, taskCommit)) {
        if (checked) {
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
        // A repair is new content: its checks run before the goal branch moves to it.
        const outcome = await this.#checkRevision(task, goalId, taskCommit, candidate);
        if (outcome.problem) {
          return record({ ...base, task_commit: taskCommit, base_commit: goalHead, ...outcome.problem });
        }
        await moveRef(project.root, ref, taskCommit, goalHead);
        return record({
          ...base,
          status: 'integrated',
          task_commit: taskCommit,
          base_commit: goalHead,
          merged_commit: taskCommit,
          checks: outcome.results,
          summary: `fast-forward${repair}: ${outcome.ran ? `${outcome.results.length} check(s) passed on it` : 'no configured check applies to this kind of task'}`,
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
      const outcome = await this.#checkRevision(task, goalId, commit, merged.tree);
      if (outcome.problem) {
        return record({ ...base, task_commit: taskCommit, base_commit: goalHead, ...outcome.problem });
      }

      // 5. Move the goal branch, only from the commit Friday merged into.
      await moveRef(project.root, ref, commit, goalHead);
      return record({
        ...base,
        status: 'integrated',
        task_commit: taskCommit,
        base_commit: goalHead,
        merged_commit: commit,
        checks: outcome.results,
        summary: outcome.ran
          ? `${outcome.results.length} check(s) passed on the merged revision${repair}`
          : `merged${repair}; no configured check applies to this kind of task`,
      });
    } catch (e) {
      logger.warn('task integration failed', { task_id: taskId, message: (e as Error).message });
      return record({ ...base, summary: (e as Error).message });
    }
  }

  /** Commits the verified tree on the task branch, in the agent's name (ADR-0025 §2, review F04). */
  async #commitVerified(
    task: TaskView,
    dir: string,
    tree: string,
    head: string | null,
    version: string | null,
  ): Promise<string> {
    const { state } = this.opts;
    const agentId = task.assigned_agent_id ?? state.q.runs(task.task_id).at(-1)?.agent_id;
    const agentKey = (agentId && state.q.findAgent(agentId)?.agent_key) || 'agent';
    const basis = version ? `verified as ${version}` : 'passed by a human result';
    return commitContent(
      dir,
      tree,
      head,
      `${task.summary}\n\nFriday task ${task.task_id}, ${basis}.`,
      agentIdentity(agentKey),
    );
  }

  /**
   * Runs the task's checks on a revision in Friday's own checkout. The checks must judge exactly
   * that tree and leave it as it was: a check that changes what it checks (a formatter, a
   * generator) passed something else (review F04).
   */
  async #checkRevision(
    task: TaskView,
    goalId: string,
    commit: string,
    expected: string,
  ): Promise<{
    results: Outcome['checks'];
    ran: boolean;
    problem: Pick<Outcome, 'summary' | 'checks'> | null;
  }> {
    const { state, project, workspaces } = this.opts;
    const branch = goalBranch(goalId);
    const checks = selectChecks(project.config.verification.checks, task.kind);
    const results: Outcome['checks'] = [];
    if (!checks.length) return { results, ran: false, problem: null };
    const dir = await checkoutForVerification(project.root, workspaces.dir, `goal-${goalId.slice(-8)}`, commit);
    const checkout = await GitRoot.open(dir);
    if ((await checkout.contentTree()).tree !== expected) {
      return {
        results,
        ran: false,
        problem: {
          checks: [],
          summary: `Friday's checkout of the revision ${commit.slice(0, 12)} does not hold it; ${branch} was not moved`,
        },
      };
    }
    let failed = 0;
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
    const altered = after.tree !== expected ? await changedBetween(project.root, expected, after.tree) : [];
    if (altered.length) {
      return {
        results,
        ran: true,
        problem: {
          checks: results,
          summary: `the checks changed ${altered.slice(0, 5).join(', ')}${altered.length > 5 ? ` and ${altered.length - 5} more` : ''} in the merged revision ${commit.slice(0, 12)}, so what passed is not what would land; ${branch} was not moved`,
        },
      };
    }
    if (failed) {
      return {
        results,
        ran: true,
        problem: {
          checks: results,
          summary: `${failed} required check(s) failed on the merged revision ${commit.slice(0, 12)}; ${branch} was not moved`,
        },
      };
    }
    return { results, ran: true, problem: null };
  }
}
