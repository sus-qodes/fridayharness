import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  BACKUP_PREFIX,
  BACKUP_REF_PREFIXES,
  commitTree,
  FRIDAY_IDENTITY,
  GitRoot,
  listRefs,
  RESTORED_PREFIX,
  runGit,
  writeBundle,
} from '@friday/git';
import type { ProjectRef } from '@friday/sdk';
import type { BackupCode, FridayState } from '@friday/state';

/** The bundle's file name in a backup. */
export const CODE_BUNDLE = 'code.bundle';

async function hashFile(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

type Kind = NonNullable<BackupCode['refs']>[number]['kind'];

/** What a ref of the bundle is, and the task it belongs to. */
function kindOf(ref: string): { kind: Kind; task_id: string | null } {
  const task = (s: string | undefined) => (s?.startsWith('task_') ? (s.split('.')[0] ?? null) : null);
  if (ref.startsWith('refs/heads/friday/goal-')) return { kind: 'goal_branch', task_id: null };
  if (ref.startsWith('refs/heads/friday/')) return { kind: 'task_branch', task_id: task(ref.split('/')[3]) };
  if (ref.startsWith('refs/friday/preserved/')) return { kind: 'preserved', task_id: task(ref.split('/')[3]) };
  if (ref.startsWith(BACKUP_PREFIX)) return { kind: 'uncommitted', task_id: task(ref.split('/')[3]) };
  return { kind: 'restored', task_id: task(ref.slice(RESTORED_PREFIX.length).split('/')[0]) };
}

/**
 * The project's code in a backup (review F16): what a clone of the repository would not have, in
 * one git bundle with its full history, written into the backup's staging folder.
 * - Friday's branches: task branches with their commits, goal branches with the integrated work.
 * - The preserved states of earlier attempts (`refs/friday/preserved/`).
 * - The uncommitted work of this clone's task worktrees, recorded through a temporary index like a
 *   preserved state (the checkouts and their indexes stay untouched), and named
 *   `refs/friday/backup/<task>` in the bundle; a restore puts it under `refs/friday/restored/`.
 * - Work an earlier restore brought that recovery has not used yet (`refs/friday/restored/`).
 * Ignored files (installed dependencies, build output, ignored settings files) are not recorded,
 * and neither is the main checkout, which is yours.
 */
export async function backupCode(state: FridayState, project: ProjectRef, staging: string): Promise<BackupCode> {
  const main = await GitRoot.open(project.root).catch(() => null);
  if (!main) return { included: false, reason: 'the project is not a git repository' };
  const root = main.root;
  const drop = async () => {
    for (const ref of await listRefs(root, BACKUP_PREFIX)) await runGit(root, ['update-ref', '-d', ref]);
  };
  // Names left by a backup that did not finish.
  await drop();
  const worktrees: NonNullable<BackupCode['worktrees']> = [];
  const skipped: NonNullable<BackupCode['skipped']> = [];
  try {
    const named = new Set<string>();
    // Newest first: a task's current worktree gets the task's own name.
    for (const w of state.q.worktrees(project.project_id, ['active', 'preserved'])) {
      if (!state.inThisClone(w.path)) {
        skipped.push({ task_id: w.task_id, path: w.path, reason: 'it belongs to another clone of the project' });
        continue;
      }
      if (!existsSync(w.path)) {
        skipped.push({ task_id: w.task_id, path: w.path, reason: 'its folder is gone' });
        continue;
      }
      try {
        const tree = await GitRoot.open(w.path);
        const identity = await tree.identity();
        if (!identity.dirty) continue;
        const content = await tree.contentTree();
        const commit = await commitTree(
          tree.root,
          content.tree,
          content.head ? [content.head] : [],
          `Uncommitted work of ${w.task_id} at a backup`,
          FRIDAY_IDENTITY,
        );
        const name = named.has(w.task_id) ? `${w.task_id}.${w.worktree_id}` : w.task_id;
        named.add(w.task_id);
        await runGit(root, ['update-ref', `${BACKUP_PREFIX}${name}`, commit]);
        worktrees.push({
          task_id: w.task_id,
          worktree_id: w.worktree_id,
          path: w.path,
          head: content.head,
          files: identity.files,
          restores_to: `${RESTORED_PREFIX}${name}`,
        });
      } catch (e) {
        skipped.push({ task_id: w.task_id, path: w.path, reason: (e as Error).message });
      }
    }
    const refs = (await Promise.all([...BACKUP_REF_PREFIXES, BACKUP_PREFIX].map((p) => listRefs(root, p)))).flat();
    if (!refs.length) {
      return {
        included: false,
        reason: 'there is no Friday branch, preserved state or uncommitted task work to keep',
        worktrees,
        skipped,
      };
    }
    const file = path.join(staging, CODE_BUNDLE);
    const written = await writeBundle(root, file, refs);
    return {
      included: true,
      bundle: CODE_BUNDLE,
      bytes: statSync(file).size,
      sha256: await hashFile(file),
      refs: written.map((r) => ({ ...r, ...kindOf(r.ref) })),
      worktrees,
      skipped,
    };
  } finally {
    await drop();
  }
}
