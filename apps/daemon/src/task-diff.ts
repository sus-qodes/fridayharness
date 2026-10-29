import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { GitRoot, runGit } from '@friday/git';
import { sensitiveClassOf } from '@friday/policy';
import { FridayError, type GoalDiff, type TaskDiff, type TaskDiffFile } from '@friday/protocol';
import type { ProjectRef } from '@friday/sdk';
import type { FridayState } from '@friday/state';

/**
 * A task's or goal's changes, file by file, with each side's content (plan M9 §5.4, FD-11). The
 * client computes and highlights the diff.
 *
 * - Git is read with plumbing commands and without optional locks: nothing writes the index under
 *   an agent.
 * - A working file is read only when every component of its path, from the checkout down, is a real
 *   folder or file (no link or junction anywhere), its real path stays in the real checkout, and the
 *   handle opened is the file that was checked (LESSONS UI-25).
 * - Friday's protected files (its state, runtime files, secrets) are listed but never shown.
 * - Everything returned passes the redactor.
 */

export const DIFF_SIDE_CAP = 256 * 1024;
export const DIFF_TOTAL_CAP = 2 * 1024 * 1024;
export const DIFF_FILE_CAP = 300;
const BINARY_PROBE = 8000;
const STAT_READ_CAP = 4 * 1024 * 1024;
const WINDOWS = process.platform === 'win32';

export interface DiffOptions {
  /** Line counts instead of contents. */
  stat?: boolean;
  /** The per-user state folder (Friday's protected paths). */
  stateDir?: string;
}

type Change = TaskDiffFile['change'];
interface Side {
  text: string | null;
  binary: boolean;
  tooLarge: boolean;
  link: boolean;
}
const NONE: Side = { text: null, binary: false, tooLarge: false, link: false };

const strict = new TextDecoder('utf-8', { fatal: true });

/** Bytes as text, or null when they are not text (a NUL early on, or not valid UTF-8). */
function asText(bytes: Buffer): string | null {
  if (bytes.subarray(0, BINARY_PROBE).includes(0)) return null;
  try {
    return strict.decode(bytes);
  } catch {
    return null;
  }
}

/** One `cat-file --batch` read of many blobs, as raw bytes; blobs over the cap are not read. */
async function readBlobs(root: string, specs: string[]): Promise<Map<string, Side>> {
  const out = new Map<string, Side>();
  const usable = [...new Set(specs)].filter((s) => !s.includes('\n'));
  if (!usable.length) return out;
  const check = await runGit(root, ['cat-file', '--batch-check'], { input: `${usable.join('\n')}\n`, okCodes: [128] });
  const toRead: { spec: string; sha: string; size: number }[] = [];
  const lines = check.stdout.split('\n');
  usable.forEach((spec, i) => {
    const m = /^([0-9a-f]{40,64}) (\w+) (\d+)$/.exec(lines[i] ?? '');
    if (m?.[2] !== 'blob') {
      out.set(spec, NONE);
      return;
    }
    const size = Number(m[3]);
    if (size > DIFF_SIDE_CAP) out.set(spec, { ...NONE, tooLarge: true });
    else toRead.push({ spec, sha: m[1] as string, size });
  });
  if (!toRead.length) return out;
  const total = toRead.reduce((n, b) => n + b.size + 128, 0);
  const res = await runGit(root, ['cat-file', '--batch'], {
    input: `${toRead.map((b) => b.sha).join('\n')}\n`,
    raw: true,
    maxBytes: total + 4096,
  });
  const bytes = res.bytes ?? Buffer.alloc(0);
  let at = 0;
  for (const b of toRead) {
    const nl = bytes.indexOf(10, at);
    if (nl < 0) break;
    const header = bytes.subarray(at, nl).toString('utf8');
    const size = Number(header.split(' ')[2]);
    const body = bytes.subarray(nl + 1, nl + 1 + size);
    at = nl + 1 + size + 1;
    const text = asText(body);
    out.set(b.spec, text === null ? { ...NONE, binary: true } : { ...NONE, text });
  }
  return out;
}

/**
 * A working file's content, only when no component of its path is a link and the handle opened is
 * the file that was checked; at most cap + 1 bytes are read.
 */
export function readWorkingFile(root: string, file: string, cap = DIFF_SIDE_CAP): Side {
  try {
    const realRoot = realpathSync(root);
    let cur = root;
    let last: ReturnType<typeof lstatSync> | null = null;
    for (const part of file.split('/')) {
      if (!part || part === '.' || part === '..') return { ...NONE, link: true };
      cur = path.join(cur, part);
      last = lstatSync(cur);
      if (last.isSymbolicLink()) return { ...NONE, link: true };
    }
    if (!last?.isFile()) return NONE;
    const real = realpathSync(cur);
    const inside = WINDOWS
      ? real.toLowerCase().startsWith(`${realRoot.toLowerCase()}${path.sep}`)
      : real.startsWith(`${realRoot}${path.sep}`);
    if (!inside) return { ...NONE, link: true };
    if (last.size > cap) return { ...NONE, tooLarge: true };
    const fd = openSync(cur, 'r');
    try {
      const st = fstatSync(fd);
      const same =
        st.size === last.size &&
        (st.ino === 0 || last.ino === 0 ? st.mtimeMs === last.mtimeMs : st.ino === last.ino && st.dev === last.dev);
      if (!same || !st.isFile()) return { ...NONE, link: true };
      const buf = Buffer.alloc(Math.min(st.size, cap) + 1);
      const n = readSync(fd, buf, 0, buf.length, 0);
      if (n > cap) return { ...NONE, tooLarge: true };
      const text = asText(buf.subarray(0, n));
      return text === null ? { ...NONE, binary: true } : { ...NONE, text };
    } finally {
      closeSync(fd);
    }
  } catch {
    return NONE;
  }
}

/** Files changed between two revisions, renames detected. */
async function changesBetween(
  root: string,
  a: string,
  b: string,
): Promise<{ path: string; change: Change; orig: string | null }[]> {
  const r = await runGit(root, ['diff-tree', '-r', '-z', '-M', '--name-status', a, b], { okCodes: [128] });
  if (r.code !== 0) return [];
  const t = r.stdout.split('\0');
  const out: { path: string; change: Change; orig: string | null }[] = [];
  for (let i = 0; i < t.length; i++) {
    const code = t[i];
    if (!code) continue;
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      out.push({
        path: t[i + 2] ?? '',
        change: letter === 'R' ? 'renamed' : 'added',
        orig: letter === 'R' ? (t[i + 1] ?? null) : null,
      });
      i += 2;
    } else {
      out.push({
        path: t[i + 1] ?? '',
        change: letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified',
        orig: null,
      });
      i += 1;
    }
  }
  return out.filter((c) => c.path);
}

/** Line counts per path from `--numstat -z` output (renames keyed by their new path). */
function parseNumstat(stdout: string): Map<string, { added: number | null; removed: number | null }> {
  const out = new Map<string, { added: number | null; removed: number | null }>();
  const t = stdout.split('\0');
  for (let i = 0; i < t.length; i++) {
    const rec = t[i];
    if (!rec) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec);
    if (!m) continue;
    const counts = { added: m[1] === '-' ? null : Number(m[1]), removed: m[2] === '-' ? null : Number(m[2]) };
    if (m[3]) out.set(m[3], counts);
    else {
      // A rename: the old and new paths follow as their own records.
      const to = t[i + 2];
      if (to) out.set(to, counts);
      i += 2;
    }
  }
  return out;
}

function lineCount(text: string): number {
  if (!text) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith('\n') ? n : n + 1;
}

/** Collects files into the answer within the caps; protected files and redaction applied. */
class Collector {
  readonly files: TaskDiffFile[] = [];
  total = 0;
  truncated = false;
  constructor(
    private readonly state: FridayState,
    private readonly opts: DiffOptions,
    private readonly classOf: (p: string) => string | null,
  ) {}

  add(
    f: Omit<TaskDiffFile, 'protected' | 'added' | 'removed'> & { added?: number | null; removed?: number | null },
  ): void {
    const isProtected = this.classOf(f.path) !== null || (f.orig_path !== null && this.classOf(f.orig_path) !== null);
    const redact = (s: string | null) => (s === null ? null : this.state.redactor.redactString(s).value);
    let file: TaskDiffFile = {
      ...f,
      protected: isProtected,
      before: isProtected || this.opts.stat ? null : redact(f.before),
      after: isProtected || this.opts.stat ? null : redact(f.after),
      added: isProtected ? null : (f.added ?? null),
      removed: isProtected ? null : (f.removed ?? null),
    };
    if (this.files.length >= DIFF_FILE_CAP) {
      this.truncated = true;
      file = { ...file, before: null, after: null, too_large: true };
    } else {
      const size = (file.before?.length ?? 0) + (file.after?.length ?? 0);
      if (this.total + size > DIFF_TOTAL_CAP) {
        this.truncated = true;
        file = { ...file, before: null, after: null, too_large: true };
      } else this.total += size;
    }
    this.files.push(file);
  }
}

function protectedClassifier(root: string, mainRoot: string, stateDir: string | undefined) {
  const ctx = { projectRoot: root, mainRoot, ...(stateDir ? { stateDir } : {}) };
  return (p: string) => sensitiveClassOf(p, ctx, 'read')?.class ?? null;
}

/** Contents of committed changes between two revisions (verified tree, integrated commit, goal). */
async function committedFiles(c: Collector, root: string, base: string, head: string, stat: boolean): Promise<boolean> {
  const changes = await changesBetween(root, base, head);
  if (!changes.length) return false;
  const counts = stat
    ? parseNumstat(
        (await runGit(root, ['diff-tree', '-r', '-z', '-M', '--numstat', base, head], { okCodes: [128] })).stdout,
      )
    : new Map();
  const listed = changes.slice(0, DIFF_FILE_CAP);
  const blobs = stat
    ? new Map<string, Side>()
    : await readBlobs(root, [
        ...listed.filter((x) => x.change !== 'added').map((x) => `${base}:${x.orig ?? x.path}`),
        ...listed.filter((x) => x.change !== 'deleted').map((x) => `${head}:${x.path}`),
      ]);
  for (const x of changes) {
    const before = x.change === 'added' ? NONE : (blobs.get(`${base}:${x.orig ?? x.path}`) ?? NONE);
    const after = x.change === 'deleted' ? NONE : (blobs.get(`${head}:${x.path}`) ?? NONE);
    const n = counts.get(x.path);
    c.add({
      path: x.path,
      change: x.change,
      orig_path: x.orig,
      committed: true,
      uncommitted: false,
      binary: before.binary || after.binary || (stat && n !== undefined && n.added === null),
      too_large: before.tooLarge || after.tooLarge,
      link: false,
      before: before.text,
      after: after.text,
      added: n?.added ?? null,
      removed: n?.removed ?? null,
    });
  }
  return true;
}

export async function taskDiff(
  state: FridayState,
  project: ProjectRef,
  taskId: string,
  opts: DiffOptions = {},
): Promise<TaskDiff> {
  const pid = project.project_id;
  const task = state.q.findTask(pid, taskId);
  if (!task) throw new FridayError('task_not_found', `no task ${taskId}`);
  const run = task.current_run_id ? state.q.findRun(task.current_run_id) : state.q.runs(taskId).at(-1);
  const verification = state.q.latestVerification(taskId);
  const integration = state.q.latestIntegration(pid, taskId);
  const notes: string[] = [];
  const stat = Boolean(opts.stat);

  // 1. The run's checkout as it is now: committed and uncommitted work since its base (or since
  // HEAD when the run has no base: worktrees off).
  const root = run?.execution_root ?? null;
  if (root && run) {
    const c = new Collector(state, opts, protectedClassifier(root, project.root, opts.stateDir));
    try {
      const git = await GitRoot.open(root);
      const base = run.base_commit ?? (await git.refs()).head;
      if (base) {
        const { changes, base_found } = await git.changesSince(base);
        if (base_found) {
          const counts = stat
            ? parseNumstat(
                (await runGit(root, ['diff-index', '-z', '-M', '--numstat', base, '--'], { okCodes: [128] })).stdout,
              )
            : new Map();
          const listed = changes.slice(0, DIFF_FILE_CAP);
          const blobs = stat
            ? new Map<string, Side>()
            : await readBlobs(
                root,
                listed.filter((x) => x.change !== 'added').map((x) => `${base}:${x.origPath ?? x.path}`),
              );
          for (const x of changes) {
            const before = x.change === 'added' ? NONE : (blobs.get(`${base}:${x.origPath ?? x.path}`) ?? NONE);
            const inList = c.files.length < DIFF_FILE_CAP;
            const after = x.change === 'deleted' ? NONE : stat ? NONE : inList ? readWorkingFile(root, x.path) : NONE;
            let n = counts.get(x.path);
            if (stat && !n && x.change !== 'deleted') {
              // Not in the index (untracked): every line is added.
              const w = readWorkingFile(root, x.path, STAT_READ_CAP);
              n = w.text !== null ? { added: lineCount(w.text), removed: 0 } : { added: null, removed: null };
            }
            c.add({
              path: x.path,
              change: x.change,
              orig_path: x.origPath ?? null,
              committed: x.committed,
              uncommitted: x.uncommitted,
              binary: before.binary || after.binary,
              too_large: before.tooLarge || after.tooLarge,
              link: after.link,
              before: before.text,
              after: after.text,
              added: n?.added ?? null,
              removed: n?.removed ?? null,
            });
          }
          return { task_id: taskId, source: 'worktree', root, base, files: c.files, truncated: c.truncated, notes };
        }
        notes.push(`the run's base commit ${base.slice(0, 12)} is not in its checkout`);
      }
    } catch (e) {
      notes.push(`the run's checkout could not be read: ${(e as Error).message}`);
    }
  }

  // 2. The verified tree against its base. 3. The integrated commit against the task's own base:
  // an integration's base_commit is the goal branch before the merge, never the task's (UI-31).
  const c = new Collector(state, opts, protectedClassifier(project.root, project.root, opts.stateDir));
  if (verification?.base_commit && verification.tree) {
    if (await committedFiles(c, project.root, verification.base_commit, verification.tree, stat)) {
      return {
        task_id: taskId,
        source: 'verified',
        root: project.root,
        base: verification.base_commit,
        files: c.files,
        truncated: c.truncated,
        notes,
      };
    }
  }
  if (integration?.task_commit) {
    let base = verification?.base_commit ?? run?.base_commit ?? null;
    if (!base && integration.base_commit) {
      const mb = await runGit(project.root, ['merge-base', integration.task_commit, integration.base_commit], {
        okCodes: [1, 128],
      });
      base = mb.code === 0 ? mb.stdout.trim() || null : null;
    }
    if (base && (await committedFiles(c, project.root, base, integration.task_commit, stat))) {
      return {
        task_id: taskId,
        source: 'integrated',
        root: project.root,
        base,
        files: c.files,
        truncated: c.truncated,
        notes,
      };
    }
  }

  // 4. Nothing to compare: the paths Friday saw and the agent claimed.
  const seen = new Set<string>([
    ...(run?.observed_paths ?? []),
    ...((run?.claim as { changed_paths?: string[] } | null)?.changed_paths ?? []),
  ]);
  for (const p of seen) {
    c.add({
      path: p,
      change: 'modified',
      orig_path: null,
      committed: false,
      uncommitted: false,
      binary: false,
      too_large: false,
      link: false,
      before: null,
      after: null,
    });
  }
  if (!c.files.length) notes.push('no changes recorded for this task yet');
  else notes.push('no revision to compare: these are the paths Friday saw and the agent claimed');
  return { task_id: taskId, source: 'none', root, base: null, files: c.files, truncated: c.truncated, notes };
}

/** The goal branch against its merge base with the main checkout's HEAD: what landing would bring. */
export async function goalDiff(
  state: FridayState,
  project: ProjectRef,
  goalId: string,
  opts: DiffOptions = {},
): Promise<GoalDiff> {
  const goal = state.q.findGoal(project.project_id, goalId);
  if (!goal) throw new FridayError('goal_not_found', `no goal ${goalId}`);
  const branch = `friday/goal-${goalId}`;
  const root = project.root;
  const head = await runGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { okCodes: [1, 128] });
  const notes: string[] = [];
  const c = new Collector(state, opts, protectedClassifier(root, root, opts.stateDir));
  if (head.code !== 0) {
    notes.push(`the goal has no branch ${branch} yet: nothing was integrated`);
    return {
      goal_id: goalId,
      source: 'goal',
      branch,
      head: null,
      merge_base: null,
      root,
      base: null,
      commits_ahead: [],
      files: [],
      truncated: false,
      notes,
    };
  }
  const tip = head.stdout.trim();
  const main = await runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { okCodes: [1, 128] });
  const mb =
    main.code === 0 ? await runGit(root, ['merge-base', main.stdout.trim(), tip], { okCodes: [1, 128] }) : null;
  const base = mb?.code === 0 ? mb.stdout.trim() : null;
  const commits: GoalDiff['commits_ahead'] = [];
  if (base) {
    const log = await runGit(root, ['log', '--format=%H%x1f%s%x1f%an%x1f%aI', '-n', '200', `${base}..${tip}`], {
      okCodes: [128],
    });
    for (const line of log.stdout.split('\n')) {
      const [sha, subject, author, date] = line.split('\x1f');
      if (sha && subject !== undefined)
        commits.push({
          sha,
          subject: state.redactor.redactString(subject).value,
          author: author ?? '',
          date: date ?? '',
        });
    }
    await committedFiles(c, root, base, tip, Boolean(opts.stat));
  } else notes.push('the goal branch shares no history with the main checkout');
  return {
    goal_id: goalId,
    source: 'goal',
    branch,
    head: tip,
    merge_base: base,
    root,
    base,
    commits_ahead: commits,
    files: c.files,
    truncated: c.truncated,
    notes,
  };
}
