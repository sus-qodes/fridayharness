import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ExecutionProfile, ProcessGroups } from '@friday/execution';
import {
  agentIdentity,
  changedBetween,
  checkoutForVerification,
  commitContent,
  commitMessage,
  commitSubject,
  commitTree,
  GitRoot,
  goalBranch,
  isAncestor,
  mergeJoining,
  moveRef,
  parentOf,
  resolveCommit,
  runGit,
  sameRepository,
  treeOf,
  verifiedRef,
} from '@friday/git';
import type { Actor, IntegrationView, TaskView } from '@friday/protocol';
import type { ProjectRef } from '@friday/sdk';
import type { FridayState } from '@friday/state';
import { checksForChange, selectChecks, summarizeOutcome } from '@friday/verification';
import { runCheckWithSecondTry, timedSummary } from './check-time.js';
import type { FileCopier } from './copy-files.js';
import { runCheckInProfile } from './execution.js';
import { InFlight } from './in-flight.js';
import type { Logger } from './log.js';
import type { WorkspaceManager } from './workspaces.js';
import { LOCKFILE_NAMES, type SetupOutcome } from './worktree-setup.js';

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

/** One check of a trial (`IntegrationManager.startCheckTrial`). */
export interface CheckTrialRow {
  name: string;
  kind: string;
  required: boolean;
  status: 'waiting' | 'running' | 'passed' | 'failed';
  summary: string | null;
  duration_ms: number | null;
  /** It was stopped at its time limit (2026-11-19): said as that, not as failed work. */
  timed_out: boolean;
  /** The check's time limit. */
  timeout_ms: number;
  /** The end of what a failing check printed, credentials removed. */
  output_tail: string | null;
}

/** The project's checks run on the commit the project folder is on, in a copy of Friday's own. */
export interface CheckTrialView {
  status: 'idle' | 'running' | 'done' | 'failed';
  started_at: string | null;
  finished_at: string | null;
  /** The commit tried, short. */
  commit: string | null;
  /** The project folder has changes that are not in that commit, so they were not tried. */
  uncommitted: boolean;
  /** `preparing`, or the name of the check that runs now. */
  running: string | null;
  /** What Friday's copy lacks, or why the trial could not run. */
  problem: string | null;
  checks: CheckTrialRow[];
}

const idleTrial = (): CheckTrialView => ({
  status: 'idle',
  started_at: null,
  finished_at: null,
  commit: null,
  uncommitted: false,
  running: null,
  problem: null,
  checks: [],
});

/** How much of a failing check's output a trial keeps. */
const TRIAL_TAIL = 3000;

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
      /**
       * Installs a checkout's dependencies as a task worktree's are (`WorktreeSetup.run`): the
       * merged revision is checked in Friday's own checkout, which has none of its own, so a check
       * that passed in each task's worktree failed there for the want of them (2026-11-17).
       */
      setup?: (checkout: { path: string }, ids: { task_id: string; run_id: string }) => Promise<SetupOutcome | null>;
      /**
       * Gives the checkout the files the project lists for its copies (`worktrees.files`), as a
       * task worktree gets them: the merged revision's checks read the same settings file.
       */
      files?: FileCopier;
    },
  ) {}

  /**
   * The dependencies of Friday's checkout of a merged revision, before its checks run. What an
   * earlier revision's install left is kept while the manifest and lockfile are the same (the
   * stamp, kept in the checkout's own git folder, outside its tree), and removed with everything
   * else git ignores when they are not, so a check never runs against another revision's packages.
   * Null when nothing was to do; a setup that did not pass is said beside a failing check.
   */
  async #dependencies(dir: string, ids: { task_id: string; run_id: string }): Promise<SetupOutcome | null> {
    const setup = this.opts.setup;
    if (!setup) return null;
    let stampFile: string | null = null;
    try {
      const gitDir = (await runGit(dir, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
      stampFile = gitDir ? path.join(gitDir, 'friday-dependencies') : null;
    } catch {
      stampFile = null;
    }
    const files = ['package.json', ...LOCKFILE_NAMES].filter((f) => existsSync(path.join(dir, f)));
    const hash = createHash('sha256');
    for (const f of files)
      hash
        .update(f)
        .update('\0')
        .update(readFileSync(path.join(dir, f)))
        .update('\0');
    const stamp = files.length ? hash.digest('hex') : null;
    const kept = (() => {
      try {
        return stampFile && stamp && existsSync(stampFile) && readFileSync(stampFile, 'utf8') === stamp;
      } catch {
        return false;
      }
    })();
    if (kept && existsSync(path.join(dir, 'node_modules'))) return null;
    if (stampFile) rmSync(stampFile, { force: true });
    // Ignored files only: the tree itself is the revision, checked before this and after the checks.
    await runGit(dir, ['clean', '-q', '-fdX'], { timeoutMs: 300_000 }).catch(() => undefined);
    const outcome = await setup({ path: dir }, ids);
    if (outcome?.status === 'passed' && stampFile && stamp) {
      try {
        writeFileSync(stampFile, stamp);
      } catch {
        // Without the stamp the next integration installs again; nothing else depends on it.
      }
    }
    return outcome;
  }

  private get pid() {
    return this.opts.project.project_id;
  }

  #trial: CheckTrialView = idleTrial();

  /** Where the trial of the project's checks stands (`startCheckTrial`). */
  checkTrial(): CheckTrialView {
    return this.#trial;
  }

  /**
   * Runs the project's checks on the commit the project folder is on, before any agent changed
   * anything (2026-11-18): in a checkout of Friday's own, prepared as a merged revision's is
   * (dependencies, the files the project lists for its copies), so what it finds is what an agent's
   * work will be judged against. A check that fails here fails for every task, whatever the work:
   * a database that is not running, a settings file the copy lacks, a test that was red already.
   * One trial at a time; answers at once, and `checkTrial` says how far it is.
   */
  startCheckTrial(): CheckTrialView {
    if (this.#trial.status === 'running') return this.#trial;
    const { project, workspaces, logger, state } = this.opts;
    const checks = project.config.verification.checks;
    const view: CheckTrialView = {
      ...idleTrial(),
      status: 'running',
      started_at: new Date().toISOString(),
      running: 'preparing',
      checks: checks.map((c) => ({
        name: c.name,
        kind: c.kind,
        required: c.required,
        status: 'waiting',
        summary: null,
        duration_ms: null,
        timed_out: false,
        timeout_ms: c.timeout_ms,
        output_tail: null,
      })),
    };
    this.#trial = view;
    const ids = { task_id: 'check-trial', run_id: 'check-trial' };
    const work = (async () => {
      try {
        const main = await GitRoot.open(project.root);
        const head = (await runGit(main.root, ['rev-parse', '--verify', 'HEAD'])).stdout.trim();
        view.commit = head.slice(0, 12);
        view.uncommitted = Boolean(
          (await runGit(main.root, ['status', '--porcelain', '--untracked-files=no'])).stdout.trim(),
        );
        const dir = await checkoutForVerification(project.root, workspaces.dir, 'check-trial', head);
        const dependencies = await this.#dependencies(dir, ids);
        const lacking = await this.opts.files?.(dir, ids);
        view.problem =
          [
            dependencies && (dependencies.status === 'failed' || dependencies.status === 'refused')
              ? `The project's packages could not be installed in Friday's copy (${dependencies.reason}).`
              : null,
            lacking ? lacking.split(' A check or a program')[0] : null,
          ]
            .filter(Boolean)
            .join(' ') || null;
        for (const [i, check] of checks.entries()) {
          const row = view.checks[i];
          if (!row) continue;
          view.running = check.name;
          row.status = 'running';
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
          row.status = outcome.passed ? 'passed' : 'failed';
          row.summary = summarizeOutcome(outcome);
          row.duration_ms = outcome.duration_ms;
          row.timed_out = outcome.timed_out;
          row.output_tail = outcome.passed
            ? null
            : state.redactor.redactString(outcome.output.slice(-TRIAL_TAIL)).value || null;
        }
        view.status = 'done';
      } catch (e) {
        view.status = 'failed';
        view.problem = `The checks could not be tried: ${(e as Error).message}`;
        logger.warn('trial of the project checks failed', { message: (e as Error).message });
      } finally {
        view.running = null;
        view.finished_at = new Date().toISOString();
        for (const row of view.checks) if (row.status === 'running') row.status = 'waiting';
        logger.info('trial of the project checks ended', {
          status: view.status,
          commit: view.commit,
          checks: view.checks.map((c) => `${c.name}:${c.status}`),
        });
      }
    })();
    void this.#inFlight.track(work);
    return view;
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
    // How often work that does not fit goes back to its agent before a person is asked, read now:
    // a change of the setting applies to the next integration.
    const limit = project.config.integration.back_to_agent;
    const record = async (o: Outcome, back: string | null = null) => {
      const rec = state.recordIntegration(this.pid, actor, o, {
        back: back && limit > 0 ? { reason: back, limit } : null,
      });
      logger.info('task integration', { task_id: taskId, goal_id: goalId, status: o.status, summary: o.summary });
      if (o.status === 'integrated' || o.status === 'not_needed') {
        await workspaces.release(taskId, `integrated into ${branch}`).catch(() => undefined);
      }
      return rec;
    };
    const tree = state.q.worktreeForTask(taskId);
    // Work made in the project folder (a session its person runs there): the commit verification
    // kept of this task's own files (2026-11-17). Without one there is nothing to bring anywhere:
    // the task changed no file, or was verified before Friday kept such commits.
    let kept: string | null = null;
    if (!tree) {
      const passed = state.q.latestVerification(taskId);
      kept =
        passed?.status === 'PASSED'
          ? await resolveCommit(project.root, verifiedRef(taskId, passed.verification_id)).catch(() => null)
          : null;
      if (!kept) {
        return record({ ...base, status: 'not_needed', summary: 'the task did not work on a task branch' });
      }
    }
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
      // 1. The commit to integrate.
      let taskCommit: string | null;
      let candidate: string;
      let checked: boolean;
      if (!tree) {
        // It was verified in a folder that holds other things too, so the revision it becomes on the
        // goal branch is checked in Friday's own checkout before the branch moves (`checked: false`).
        taskCommit = kept;
        candidate = (kept && (await treeOf(project.root, kept))) || '';
        checked = false;
      } else {
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
          const { unfit: _unfit, ...problem } = outcome.problem;
          return record({ ...base, task_commit: taskCommit, base_commit: goalHead, ...problem });
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
        const outcome = await this.#checkRevision(
          task,
          goalId,
          taskCommit,
          candidate,
          await changedBetween(project.root, goalHead, taskCommit).catch(() => null),
        );
        if (outcome.problem) {
          const { unfit: _unfit, ...problem } = outcome.problem;
          return record({ ...base, task_commit: taskCommit, base_commit: goalHead, ...problem });
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
      // Where this task and the goal's other tasks only added lines at the same place of a file
      // (an entry in a changelog, a route in a list), both additions are kept (2026-11-18).
      const merged = await mergeJoining(project.root, goalHead, taskCommit);
      const joined = merged.joined?.length
        ? `; both sides' added lines were kept in ${merged.joined.slice(0, 5).join(', ')}${merged.joined.length > 5 ? ` and ${merged.joined.length - 5} more` : ''}`
        : '';
      // Work made in a folder of its own goes back to its agent there before a person is asked;
      // a person's own repair, and work made in the project folder, do not.
      const canGoBack = Boolean(tree) && !opts.repaired;
      if (merged.conflicts.length) {
        const files = merged.conflicts;
        return record(
          {
            ...base,
            status: 'conflicted',
            task_commit: taskCommit,
            base_commit: goalHead,
            conflicts: files,
            summary: `${files.length} file(s) conflict with ${branch}`,
          },
          canGoBack
            ? `Your verified work collides with what other tasks of this goal changed meanwhile, in ${files.length} file(s): ${files.slice(0, 20).join(', ')}${files.length > 20 ? ` and ${files.length - 20} more` : ''}. Keep what both sides meant.`
            : null,
        );
      }
      // Plain words, no ids (2026-11-19): this commit lands in the project's history.
      const toward = state.q.findGoal(this.pid, goalId)?.objective ?? '';
      const commit = await commitTree(
        project.root,
        merged.tree,
        [goalHead, taskCommit],
        commitMessage(
          commitSubject(`Merge: ${task.summary}`),
          task.summary,
          toward ? `Merged by Friday with the other work toward: ${commitSubject(toward, 200)}` : '',
        ),
      );

      // 4. Verify the merged revision in Friday's own checkout before the goal branch moves.
      const outcome = await this.#checkRevision(
        task,
        goalId,
        commit,
        merged.tree,
        await changedBetween(project.root, goalHead, merged.tree).catch(() => null),
      );
      if (outcome.problem) {
        const { unfit, ...problem } = outcome.problem;
        return record(
          { ...base, task_commit: taskCommit, base_commit: goalHead, ...problem },
          canGoBack && unfit
            ? `Your work passed its checks alone, but merged with what other tasks of this goal changed meanwhile it does not: ${unfit}. Run those checks in your worktree and make them pass.`
            : null,
        );
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
        summary: `${
          outcome.ran
            ? `${outcome.results.length} check(s) passed on the merged revision${repair}`
            : `merged${repair}; no configured check applies to this kind of task`
        }${joined}`,
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
    // Plain words, no ids (2026-11-19): the task, and what passed it.
    const basis = version ? 'Checked by Friday: its checks passed.' : 'Passed by a person in Friday.';
    return commitContent(
      dir,
      tree,
      head,
      commitMessage(commitSubject(task.summary), task.summary, basis),
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
    // What the revision changes in the goal branch, when that is known: the checks fit it
    // (`checksForChange`). A merge that brings only documents has the code the branch had.
    changed: readonly string[] | null = null,
  ): Promise<{
    results: Outcome['checks'];
    ran: boolean;
    /**
     * `unfit` names the required checks that failed on a revision Friday's checkout was fully
     * prepared for: the work itself does not fit, and its agent can make it. Absent when the
     * checkout lacked something (packages, a settings file), which no agent's rework changes.
     */
    problem: (Pick<Outcome, 'summary' | 'checks'> & { unfit?: string }) | null;
  }> {
    const { state, project, workspaces } = this.opts;
    const branch = goalBranch(goalId);
    const checks = checksForChange(selectChecks(project.config.verification.checks, task.kind), changed, task.kind).run;
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
    const dependencies = await this.#dependencies(dir, {
      task_id: task.task_id,
      run_id: task.current_run_id ?? 'integration',
    });
    // Not installed (refused, or the install failed): the checks still run, since not every check
    // needs them, and a failure then says so instead of blaming the merged work alone.
    // After the dependencies: their clean-up removes what git ignores, these files included.
    const lacking = await this.opts.files?.(dir, { task_id: task.task_id, goal_id: goalId });
    const unprepared = [
      dependencies && (dependencies.status === 'failed' || dependencies.status === 'refused')
        ? `; the project's dependencies were not installed in Friday's checkout of it (${dependencies.reason}), which may be why`
        : '',
      lacking ? `; Friday's checkout of it lacks a file the project lists for its copies, which may be why` : '',
    ].join('');
    let failed = 0;
    let ranOut = 0;
    for (const check of checks) {
      // One that runs out of time is tried once more with twice the time (2026-11-19).
      const timed = await runCheckWithSecondTry(
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
      const { outcome } = timed;
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
        summary: timedSummary(check.name, timed, check.timeout_ms).summary,
      });
      if (!outcome.passed && check.required) {
        failed += 1;
        if (outcome.timed_out) ranOut += 1;
      }
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
      const names = results
        .filter((r) => r.status === 'FAILED')
        .map((r) => `${r.name}${r.summary ? ` (${r.summary.slice(0, 200)})` : ''}`)
        .join('; ');
      return {
        results,
        ran: true,
        problem: {
          checks: results,
          // Checks that only ran out of time say so, and the work is not sent back to its agent for
          // them: a busy computer is not the work (2026-11-19).
          summary:
            ranOut === failed
              ? `${failed} required check(s) ran out of time on the merged revision ${commit.slice(0, 12)}, also on a second try with twice the time${unprepared}; ${branch} was not moved. Give ${failed === 1 ? 'it' : 'them'} more time in Settings → Checks, then try again`
              : `${failed} required check(s) failed on the merged revision ${commit.slice(0, 12)}${unprepared}; ${branch} was not moved`,
          ...(unprepared || ranOut === failed ? {} : { unfit: names.slice(0, 1200) }),
        },
      };
    }
    return { results, ran: true, problem: null };
  }
}
