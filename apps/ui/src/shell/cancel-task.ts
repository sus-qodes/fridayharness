/**
 * Cancelling a task, wherever the button is (its card, the inspector, a question): one flow, so
 * each asks the same things.
 *
 * A task that waits for a cancelled one never starts (a cancelled prerequisite is not a completed
 * one), so its goal never finished and nothing said why. When unfinished tasks depend on the one
 * being cancelled, the person first says what becomes of them (2026-11-17): they are cancelled too,
 * through every level, or they are kept and no longer wait for it. Then the cancellation itself is
 * confirmed, saying that choice: in the desktop's own dialog (`confirm_and_send`), in the page's in
 * a browser. Backing out there changes nothing.
 */
import type { SnapshotTask, UiSnapshot } from '@friday/protocol';
import { cleanText, plural, truncate } from '../ui/format.js';
import type { AppContext } from './context.js';

const DONE = new Set(['COMPLETED', 'CANCELLED', 'ABANDONED']);
/** How many waiting tasks the question names before "and N more". */
const NAMED = 5;

/** The unfinished tasks that depend on `taskId`, directly or through another, as the board lists them. */
export function openDependents(board: UiSnapshot | null | undefined, taskId: string): SnapshotTask[] {
  if (!board) return [];
  const out: SnapshotTask[] = [];
  const seen = new Set<string>([taskId]);
  const queue = [taskId];
  while (queue.length) {
    const id = queue.shift() as string;
    for (const t of board.tasks) {
      if (seen.has(t.task_id) || !Array.isArray(t.dependencies) || !t.dependencies.includes(id)) continue;
      seen.add(t.task_id);
      if (DONE.has(t.status)) continue;
      out.push(t);
      queue.push(t.task_id);
    }
  }
  return out;
}

export interface CancelTaskOptions {
  /** The reason recorded with the cancellation. */
  reason?: string;
  /** A line about the task for the page's confirmation (its summary by default). */
  line?: string;
}

/**
 * Asks and cancels. Resolves true when the task was cancelled, false when the person backed out or
 * Friday refused (the refusal is shown as every failed action is).
 */
export async function cancelTask(
  ctx: AppContext,
  task: { task_id: string; summary?: string | null },
  opts: CancelTaskOptions = {},
): Promise<boolean> {
  const waiting = openDependents(ctx.store.select('board'), task.task_id);
  let dependents: 'cancel' | 'release' | undefined;
  if (waiting.length) {
    const names = waiting.slice(0, NAMED).map((t) => `• ${truncate(cleanText(t.summary), 120)}`);
    const also = await ctx.confirm({
      title: `${plural(waiting.length, 'other task')} ${waiting.length === 1 ? 'waits' : 'wait'} for this one`,
      body: [
        ...names,
        ...(waiting.length > NAMED ? [`and ${waiting.length - NAMED} more`] : []),
        'A task that waits for a cancelled one can never start. Cancel them as well, or keep them and let them start without this task?',
        'You can still back out in the next step.',
      ],
      confirmLabel: waiting.length === 1 ? 'Cancel it too' : 'Cancel them too',
      cancelLabel: waiting.length === 1 ? 'Keep it' : 'Keep them',
      danger: true,
    });
    dependents = also ? 'cancel' : 'release';
  }
  const consequence =
    dependents === 'cancel'
      ? `${plural(waiting.length, 'task')} that ${waiting.length === 1 ? 'depends' : 'depend'} on it ${waiting.length === 1 ? 'is' : 'are'} cancelled too.`
      : dependents === 'release'
        ? `${plural(waiting.length, 'task')} that ${waiting.length === 1 ? 'depends' : 'depend'} on it ${waiting.length === 1 ? 'is' : 'are'} kept and no longer ${waiting.length === 1 ? 'waits' : 'wait'} for it.`
        : null;
  // The desktop asks in its own dialog, which says the same; a browser asks here.
  if (!ctx.platform.desktop) {
    const ok = await ctx.confirm({
      title: 'Cancel this task?',
      body: [
        opts.line ??
          `“${truncate(cleanText(task.summary ?? task.task_id), 160)}” stops for good: it will not run again.`,
        'Its worktree and its preserved work are kept.',
        ...(consequence ? [consequence] : []),
      ],
      confirmLabel: 'Cancel task',
      cancelLabel: 'Keep it',
      danger: true,
    });
    if (!ok) return false;
  }
  const r = await ctx.act(
    'Cancel the task',
    () => ctx.api.taskAction(task.task_id, 'cancel', opts.reason, dependents ? { dependents } : undefined),
    dependents === 'cancel'
      ? `Task cancelled, and ${plural(waiting.length, 'task')} that waited for it`
      : 'Task cancelled',
  );
  if (r) ctx.refresh();
  return Boolean(r);
}
