import { runGit } from '@friday/git';
import { type Actor, FridayError } from '@friday/protocol';
import type { ProjectRef } from '@friday/sdk';
import type { FridayState } from '@friday/state';

/** What landing a goal did, or why it did nothing. */
export interface LandResult {
  goal_id: string;
  /** `landed`: the branch was merged; `already`: there was nothing to bring. */
  status: 'landed' | 'already';
  branch: string;
  /** The person's branch it was merged into. */
  into: string;
  /** The checkout's HEAD after it. */
  head: string;
  fast_forward: boolean;
}

const MAX_REASON = 600;

/** The first lines git said, without its hints: what a person reads in the refusal. */
function said(text: string): string {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('hint:'))
    .join(' ')
    .slice(0, MAX_REASON);
}

/**
 * Lands a completed goal (2026-11-16): merges `friday/goal-<id>` into the branch the main checkout
 * has checked out, as `git merge` in that folder would. A person asks for it (the desktop shows its
 * own confirmation first); Friday never does it by itself. It merges or it does nothing: a detached
 * HEAD, local changes in the way, or a conflict leave the checkout as it was, with git's reason.
 */
export async function landGoal(
  state: FridayState,
  project: ProjectRef,
  goalId: string,
  actor: Actor,
): Promise<LandResult> {
  const pid = project.project_id;
  const goal = state.q.findGoal(pid, goalId);
  if (!goal) throw new FridayError('goal_not_found', `no goal ${goalId}`);
  if (goal.status !== 'COMPLETED') {
    throw new FridayError('invalid_state_transition', `goal ${goalId} is ${goal.status}; only a completed goal lands`);
  }
  const root = project.root;
  const branch = `friday/goal-${goalId}`;
  const tip = await runGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { okCodes: [1, 128] });
  if (tip.code !== 0)
    throw new FridayError('invalid_request', `the goal has no branch ${branch}: nothing was integrated`);
  const current = await runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { okCodes: [1, 128] });
  if (current.code !== 0) {
    throw new FridayError(
      'invalid_request',
      'the project folder is not on a branch (a detached HEAD): check out your branch first, then land the goal',
    );
  }
  const into = current.stdout.trim();
  const before = (await runGit(root, ['rev-parse', 'HEAD'])).stdout.trim();
  const landed = await runGit(root, ['merge-base', '--is-ancestor', tip.stdout.trim(), before], { okCodes: [1] });
  if (landed.code === 0) {
    return { goal_id: goalId, status: 'already', branch, into, head: before, fast_forward: false };
  }

  const summary = (goal.objective ?? goal.request).replace(/\s+/g, ' ').slice(0, 72);
  const merge = await runGit(root, ['merge', '--no-edit', '-m', `Land goal ${goalId}: ${summary}`, branch], {
    okCodes: [1, 128],
    timeoutMs: 60_000,
  });
  if (merge.code !== 0) {
    // A merge that started and stopped on a conflict is taken back: the checkout is as it was.
    const midway = await runGit(root, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { okCodes: [1, 128] });
    if (midway.code === 0) await runGit(root, ['merge', '--abort'], { okCodes: [128] });
    const why = said(`${merge.stdout}\n${merge.stderr}`);
    const conflict = /CONFLICT/.test(merge.stdout);
    throw new FridayError(
      'invalid_request',
      conflict
        ? `the goal's changes conflict with ${into}; nothing was changed. Merge ${branch} yourself (VS Code shows the conflicts): ${why}`
        : `git did not merge ${branch} into ${into}; nothing was changed: ${why}`,
      { branch, into, conflict },
    );
  }
  const head = (await runGit(root, ['rev-parse', 'HEAD'])).stdout.trim();
  const parents = (await runGit(root, ['rev-list', '--parents', '-n', '1', head])).stdout.trim().split(' ');
  const result: LandResult = {
    goal_id: goalId,
    status: 'landed',
    branch,
    into,
    head,
    fast_forward: parents.length === 2 && parents[1] === tip.stdout.trim(),
  };
  // An observation refers to agents, harnesses, tasks and runs; the goal is named in the payload.
  state.recordObservation(pid, actor, 'goal.landed', { ...result, before }, []);
  return result;
}
