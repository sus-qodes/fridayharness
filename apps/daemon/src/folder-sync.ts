import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runGit } from '@friday/git';
import type { Actor } from '@friday/protocol';
import type { FridayState } from '@friday/state';
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
  /** In the way, and the person chose to keep their own version of it: not asked about again. */
  kept: string[];
}

/** What the goal has for a file, as git names it; `absent` when the goal has no such file. */
export async function tipBlob(root: string, tip: string, file: string): Promise<string> {
  const r = await runGit(root, ['rev-parse', '--verify', '--quiet', `${tip}:${file}`], { okCodes: [1, 128] });
  return r.code === 0 ? r.stdout.trim() : 'absent';
}

/**
 * The files a person chose to keep their own version of, for the goal's work as it is now: a choice
 * holds for the version of the goal's file it was made against, and is asked again when the goal
 * changes that file once more.
 */
export async function keptFiles(
  state: FridayState,
  projectId: string,
  goalId: string,
  root: string,
  tip: string,
): Promise<Set<string>> {
  const latest = new Map<string, string>();
  for (const e of state.store.readSince(projectId, 0, { types: ['folder.file_kept'], limit: 5000 })) {
    const p = e.payload as { goal_id?: unknown; path?: unknown; theirs?: unknown };
    if (p.goal_id === goalId && typeof p.path === 'string' && typeof p.theirs === 'string')
      latest.set(p.path, p.theirs);
  }
  const kept = new Set<string>();
  for (const [file, theirs] of latest) if ((await tipBlob(root, tip, file)) === theirs) kept.add(file);
  return kept;
}

const SHOWN_MAX = 20_000;

/** Both versions of a file that is in the way, as text, for a person to compare. */
export async function bothVersions(
  root: string,
  tip: string,
  file: string,
): Promise<{ path: string; mine: string | null; theirs: string | null }> {
  const abs = path.resolve(root, file);
  const cut = (text: string) =>
    text.length > SHOWN_MAX ? `${text.slice(0, SHOWN_MAX)}\n[cut after ${SHOWN_MAX} characters]` : text;
  let mine: string | null = null;
  try {
    mine = existsSync(abs) ? cut(readFileSync(abs, 'utf8')) : null;
  } catch {
    mine = null;
  }
  const shown = await runGit(root, ['show', `${tip}:${file}`], { okCodes: [1, 128] });
  return { path: file, mine, theirs: shown.code === 0 ? cut(shown.stdout) : null };
}

/**
 * Replaces the person's version of a file with the goal's finished one, on their say. Their version
 * is stored in git first (a loose object, nothing else changes), and its name is returned: `putBack`
 * restores it. Null: the folder had no such file.
 */
export async function takeTheirs(root: string, tip: string, file: string): Promise<string | null> {
  const abs = path.resolve(root, file);
  let backup: string | null = null;
  if (existsSync(abs)) {
    backup = (await runGit(root, ['hash-object', '-w', '--no-filters', '--', file])).stdout.trim() || null;
  }
  if ((await tipBlob(root, tip, file)) === 'absent') rmSync(abs, { force: true });
  else await runGit(root, ['--literal-pathspecs', 'restore', `--source=${tip}`, '--worktree', '--', file]);
  return backup;
}

/** Puts a person's version back, byte for byte, from the backup `takeTheirs` made. */
export async function putBack(root: string, file: string, backup: string | null): Promise<void> {
  const abs = path.resolve(root, file);
  if (!backup) {
    rmSync(abs, { force: true });
    return;
  }
  // The bytes as they were: read as a buffer, which `runGit` (text) does not give.
  const blob = spawnSync('git', ['-C', root, 'cat-file', 'blob', backup], {
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (blob.status !== 0) throw new Error(`the saved version of ${file} could not be read back`);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, blob.stdout);
}

/** The question's kind: a person and the goal changed the same file in the project folder. */
export const FOLDER_CONFLICT = 'folder_conflict';

/**
 * Asks the person which version of each file to keep, once per task: the session in the folder
 * does not start that task until they have chosen (2026-11-17). Before, the file was left as it
 * was and only the agent was told, which then built on the wrong version.
 */
export function askAboutFiles(
  state: FridayState,
  projectId: string,
  actor: Actor,
  task: { task_id: string; goal_id: string | null },
  s: FolderSync,
): void {
  if (state.q.escalations(projectId, 'pending', { task_id: task.task_id }).some((e) => e.kind === FOLDER_CONFLICT))
    return;
  state.raiseEscalation(projectId, actor, {
    kind: FOLDER_CONFLICT,
    goal_id: task.goal_id,
    task_id: task.task_id,
    question: `You changed ${s.in_the_way.length === 1 ? 'a file' : `${s.in_the_way.length} files`} in the project folder that this goal's finished work also changes: ${s.in_the_way.slice(0, 12).join(', ')}. Which version should the agent in this folder work with?`,
    options: ['keep mine', 'take the finished version'],
    details: { files: s.in_the_way.slice(0, 200), goal_head: s.goal_head },
  });
}

export async function syncFolder(
  root: string,
  tip: string,
  kept: ReadonlySet<string> = new Set(),
  // `dryRun`: what a sync would do and leave in the way, with nothing written.
  opts: { dryRun?: boolean } = {},
): Promise<FolderSync> {
  const out: FolderSync = { goal_head: tip, brought: [], already: [], in_the_way: [], kept: [] };
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
    else if (kept.has(file)) out.kept.push(file);
    else if (theirs.has(file) || status.some((e) => covers(e, file))) out.in_the_way.push(file);
    else {
      const there = await runGit(root, ['rev-parse', '--verify', '--quiet', `${tip}:${file}`], { okCodes: [1, 128] });
      (there.code === 0 ? write : remove).push(file);
    }
  }
  out.brought = [...write, ...remove];
  if (opts.dryRun) return out;
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
  return out;
}

/** What the agent is told when its task waits for the person's choice. */
export function waitingNote(s: FolderSync): string {
  return `This task cannot start yet. The person who works in this folder changed ${s.in_the_way.length === 1 ? 'a file' : 'files'} that the goal's finished work also changes (${s.in_the_way.slice(0, 12).join(', ')}), and Friday is asking them which version to keep. Tell them to answer in Friday, then take the task again. Do not edit those files.`;
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
