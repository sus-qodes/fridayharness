import { rmSync } from 'node:fs';
import path from 'node:path';
import { runGit } from '@friday/git';
import { covers, folderStatus, sameAsTip } from './land.js';

/**
 * The goal's finished work, brought into the project folder (2026-11-17).
 *
 * An agent its person runs in the project folder (Antigravity, Claude Code in an editor) works on
 * what that folder holds, while the agents Friday starts hand their verified work to the goal
 * branch. Before such an agent starts a task of the goal, the files the goal changed are written
 * into the folder, so it builds on them. In the live run of 2026-11-17 it was asked to describe
 * code that was not in its folder.
 *
 * What is written, and what is not:
 * - only files the goal branch changed since it parted from the folder's commit;
 * - only where the folder still holds the committed version: a file the person changed, staged or
 *   left untracked there is never overwritten, and neither is one their own commits changed. Those
 *   are returned as `in_the_way`, untouched;
 * - the working tree only: the index and the branch stay as they are, so every file brought in
 *   shows as an uncommitted change, and `git restore` puts the committed version back.
 */
export interface FolderSync {
  goal_head: string;
  /** Written into the folder now. */
  brought: string[];
  /** Already there with the goal's content (the folder's own agent made them, or an earlier sync). */
  already: string[];
  /** Changed in the folder by its person, differently: left exactly as they are. */
  in_the_way: string[];
}

export async function syncFolder(root: string, tip: string): Promise<FolderSync> {
  const out: FolderSync = { goal_head: tip, brought: [], already: [], in_the_way: [] };
  const head = (await runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { okCodes: [1, 128] })).stdout.trim();
  if (!head || head === tip) return out;
  const names = async (range: string) => {
    const r = await runGit(root, ['diff', '--name-only', '--no-renames', '-z', range], { okCodes: [128] });
    return r.code === 0 ? r.stdout.split('\0').filter(Boolean) : [];
  };
  // What the goal changed since the two parted, and what the person's own commits changed since.
  const files = await names(`${head}...${tip}`);
  if (!files.length) return out;
  const theirs = new Set(await names(`${tip}...${head}`));
  const status = await folderStatus(root);
  const write: string[] = [];
  const remove: string[] = [];
  for (const file of files) {
    if (await sameAsTip(root, tip, file)) out.already.push(file);
    else if (theirs.has(file) || status.some((e) => covers(e, file))) out.in_the_way.push(file);
    else {
      const there = await runGit(root, ['rev-parse', '--verify', '--quiet', `${tip}:${file}`], { okCodes: [1, 128] });
      (there.code === 0 ? write : remove).push(file);
    }
  }
  for (let i = 0; i < write.length; i += 50) {
    await runGit(
      root,
      ['--literal-pathspecs', 'restore', `--source=${tip}`, '--worktree', '--', ...write.slice(i, i + 50)],
      {
        timeoutMs: 300_000,
      },
    );
  }
  for (const file of remove) rmSync(path.resolve(root, file), { force: true });
  out.brought = [...write, ...remove];
  return out;
}

/** What the agent is told about it, with its claim. */
export function syncNote(s: FolderSync): string | null {
  const parts: string[] = [];
  if (s.brought.length) {
    parts.push(
      `Friday put the finished work of this goal's other tasks into this folder before you started (${s.brought.length} file(s): ${s.brought.slice(0, 12).join(', ')}${s.brought.length > 12 ? ', ...' : ''}). They show as uncommitted changes; they are not yours to list in your claim.`,
    );
  }
  if (s.in_the_way.length) {
    parts.push(
      `These files hold changes of the person who works in this folder, so Friday did not replace them with the goal's finished version: ${s.in_the_way.slice(0, 12).join(', ')}${s.in_the_way.length > 12 ? ', ...' : ''}. Leave them as they are, and tell the person: your task may need the finished version.`,
    );
  }
  return parts.length ? parts.join(' ') : null;
}
