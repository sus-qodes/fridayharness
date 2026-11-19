import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { WorktreeRefresh } from '@friday/git';
import type { FridayState } from '@friday/state';

/**
 * Work that collides with what other tasks of the goal changed (2026-11-18). Friday merges the
 * goal's work into the task's folder itself (`refreshWorktree`); a file git cannot merge is left
 * with both versions between git's markers, and its agent finishes it by editing. This is what the
 * agent is told, and how Friday knows whether a file is finished.
 */

/** Larger files are not read for markers: a file that size is no hand-merged source file. */
const MARKED_MAX_BYTES = 2_000_000;

/** The files of `files` that hold a marked collision in `dir`: an opening and a closing marker line. */
export function stillMarked(dir: string, files: readonly string[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    const file = path.join(dir, f);
    try {
      if (!existsSync(file) || statSync(file).size > MARKED_MAX_BYTES) continue;
      const text = readFileSync(file, 'utf8');
      if (/^<{7} \S/m.test(text) && /^>{7} \S/m.test(text)) out.push(f);
    } catch {
      // A file that cannot be read is not said to be unfinished.
    }
  }
  return out;
}

/**
 * The files Friday left marked in the task's folder at its latest merge of the goal's work that
 * left any. An agent's session may end before it finished them: the next one is told again, and a
 * claim is refused while one is still marked.
 */
export function leftMarked(state: FridayState, projectId: string, taskId: string): string[] {
  const events = state.store.readByRef(projectId, 'task', taskId, {
    types: ['run.workspace_ready'],
    desc: true,
    limit: 10,
  });
  for (const e of events) {
    const refresh = (e.payload as { refresh?: { conflicts?: unknown; marked?: unknown } }).refresh;
    if (refresh?.marked === true && Array.isArray(refresh.conflicts) && refresh.conflicts.length) {
      return refresh.conflicts.filter((c): c is string => typeof c === 'string');
    }
  }
  return [];
}

const list = (files: readonly string[], max = 30) =>
  `${files.slice(0, max).join(', ')}${files.length > max ? ` and ${files.length - max} more` : ''}`;

/** What the agent is told when its folder was merged with the goal's work and files are left to finish. */
export function collisionNote(result: WorktreeRefresh, artifactRef: string | null): string {
  const files = result.conflicts.map((c) => c.path);
  return [
    `Other tasks of this goal changed files you changed too. Friday merged their work (goal commit ${result.goal_head.slice(0, 12)}) into your worktree; everything that merged by itself is there. ${files.length} file(s) could not be merged by themselves and now hold both versions: ${list(files)}.`,
    'In each of them, the lines between "<<<<<<<" and "=======" are your version and the lines between "=======" and ">>>>>>>" are what the other tasks made of the same place. Edit the file so that it keeps what both meant, and remove the three marker lines. A listed file without those lines was deleted or renamed on one side: decide which is right.',
    'The merge itself is made: do not run git merge, rebase, reset or checkout. Then run the checks and claim done again.',
    result.joined?.length
      ? `Where both sides only added lines (${list(result.joined, 10)}), both additions are kept, yours first: see that the order reads well.`
      : '',
    artifactRef ? `What each side changed in those files: ${artifactRef}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** The reminder for a later attempt that finds some of those files still marked. */
export function unfinishedNote(files: readonly string[]): string {
  return [
    `${files.length} file(s) in your worktree still hold two versions from the merge with the goal's other work: ${list(files)}.`,
    'In each, the lines between "<<<<<<<" and "=======" are this task\'s version and the lines between "=======" and ">>>>>>>" are the other tasks\'. Edit the file so that it keeps what both meant, remove the three marker lines, run the checks and claim done again. Do not run git merge, rebase, reset or checkout.',
  ].join('\n\n');
}
