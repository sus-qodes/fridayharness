import { globsOverlap } from '@friday/policy';

/**
 * Which tasks may work at the same time (2026-11-18).
 *
 * The first rule was a single live writer: two tasks that could touch one file never ran together.
 * Every feature of an ordinary application touches a few files all features touch (a list of
 * routes, a file of texts, a changelog), so with that rule no two tasks of a project ever ran
 * together: in the trial of that week, seven goals and not one moment with two agents at work.
 *
 * Agents Friday starts each work in a folder of their own, and Friday merges their verified work
 * into the goal. So two tasks may share files, as long as each also has files that are its own:
 * they are then different pieces of work that meet in a few places. Two tasks whose files are the
 * same, or one of which lies wholly inside the other, are the same piece of work and stay ordered.
 */

/** `a` names something `b` does not reach: files of its own. */
const hasOwnFiles = (a: readonly string[], b: readonly string[]) => a.some((p) => !globsOverlap([p], b));

/**
 * Whether two writing tasks may run at the same time, each in a folder of its own. A task without
 * a write scope may write anything, so it runs beside nothing that writes.
 */
export function canRunSideBySide(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (!globsOverlap(a, b)) return true;
  return hasOwnFiles(a, b) && hasOwnFiles(b, a);
}

/** The entries of `a` that reach into `b`: what two tasks running side by side share. */
export function sharedWith(a: readonly string[], b: readonly string[]): string[] {
  return a.filter((p) => globsOverlap([p], b));
}
