import { createHash } from 'node:crypto';
import { type FSWatcher, watch as fsWatch } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { FridayError } from '@friday/protocol';
import { runGit } from './run.js';
import { parseStatusV2, type Status, type StatusEntry } from './status.js';

export interface Refs {
  /** The real path of the checkout's top folder. */
  root: string;
  gitDir: string;
  commonDir: string;
  /** A checkout made with `git worktree add`, sharing the main checkout's objects. */
  linked: boolean;
  head: string | null;
  branch: string | null;
}

export interface Worktree {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
}

/**
 * The source version of an execution root (ADR-0019 §3): its HEAD and, when it has uncommitted
 * changes, a hash of their content.
 */
export interface SourceIdentity {
  head: string | null;
  dirty: boolean;
  /** Changed, renamed, unmerged and untracked entries. */
  files: number;
  hash: string | null;
  /** `content`: blob ids of the files' content. `approximate`: size and modification time. */
  basis: 'content' | 'approximate';
  /** Why the identity is approximate. */
  reason?: string;
  /** Compact form for cache keys: `<head>` or `<head>+<first 12 of hash>`. */
  version: string;
}

export interface LogEntry {
  commit: string;
  short: string;
  author: string;
  date: string;
  subject: string;
}

export interface DiffEntry {
  path: string;
  origPath?: string;
  /** Null for binary files. */
  added: number | null;
  deleted: number | null;
}

export interface WatchChange {
  paths: string[];
  /** HEAD, the index or a ref moved. */
  git: boolean;
}

const INITIAL = '(initial)';

export class GitRoot {
  private constructor(
    /** Real path of the checkout's top folder. */
    readonly root: string,
    readonly opts: { timeoutMs?: number; maxHashedFiles: number },
  ) {}

  /** Opens the checkout that contains `dir` (its top folder, as a real path). */
  static async open(dir: string, opts: { timeoutMs?: number; maxHashedFiles?: number } = {}): Promise<GitRoot> {
    let real: string;
    try {
      real = await realpath(dir);
    } catch {
      throw new FridayError('invalid_request', `${dir} does not exist`);
    }
    const top = (await runGit(real, ['rev-parse', '--show-toplevel'], { timeoutMs: opts.timeoutMs })).stdout.trim();
    if (!top) throw new FridayError('invalid_request', `${dir} is inside a git directory, not a checkout`);
    return new GitRoot(await realpath(top), {
      timeoutMs: opts.timeoutMs,
      maxHashedFiles: opts.maxHashedFiles ?? 20_000,
    });
  }

  private git(args: string[], extra: Parameters<typeof runGit>[2] = {}) {
    return runGit(this.root, args, { timeoutMs: this.opts.timeoutMs, ...extra });
  }

  async refs(): Promise<Refs> {
    const dirs = (await this.git(['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'])).stdout
      .trim()
      .split('\n');
    const gitDir = path.resolve(dirs[0] ?? '');
    const commonDir = path.resolve(dirs[1] ?? '');
    const head = (
      await this.git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { okCodes: [1] })
    ).stdout.trim();
    const branch = (await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { okCodes: [1] })).stdout.trim();
    return {
      root: this.root,
      gitDir,
      commonDir,
      linked: path.relative(gitDir, commonDir) !== '',
      head: head || null,
      branch: branch || null,
    };
  }

  /** Every checkout of this repository: the main one and its linked worktrees. */
  async worktrees(): Promise<Worktree[]> {
    const raw = (await this.git(['worktree', 'list', '--porcelain', '-z'])).stdout;
    const out: Worktree[] = [];
    let cur: Worktree | null = null;
    for (const token of raw.split('\0')) {
      if (token === '') {
        if (cur) out.push(cur);
        cur = null;
        continue;
      }
      const [key, ...rest] = token.split(' ');
      const value = rest.join(' ');
      if (key === 'worktree')
        cur = { path: path.resolve(value), head: null, branch: null, detached: false, bare: false };
      else if (cur && key === 'HEAD') cur.head = value;
      else if (cur && key === 'branch') cur.branch = value.replace(/^refs\/heads\//, '');
      else if (cur && key === 'detached') cur.detached = true;
      else if (cur && key === 'bare') cur.bare = true;
    }
    if (cur) out.push(cur);
    return out;
  }

  async status(opts: { ignored?: boolean } = {}): Promise<Status> {
    const raw = (
      await this.git([
        'status',
        '--porcelain=v2',
        '--branch',
        '-z',
        '--untracked-files=all',
        ...(opts.ignored ? ['--ignored=matching'] : []),
      ])
    ).stdout;
    return parseStatusV2(raw);
  }

  /** The dirty-content identity (ADR-0019 §3). */
  async identity(status?: Status): Promise<SourceIdentity> {
    const s = status ?? (await this.status());
    const head = s.head.commit;
    const entries = s.entries.filter((e) => e.kind !== 'ignored');
    const headText = head ?? INITIAL;
    if (entries.length === 0) {
      return { head, dirty: false, files: 0, hash: null, basis: 'content', version: headText };
    }
    let lines: string[] | null = null;
    let reason: string | undefined;
    if (entries.length > this.opts.maxHashedFiles) {
      reason = `${entries.length} changed files exceed the limit of ${this.opts.maxHashedFiles}`;
    } else if (entries.some((e) => /[\n\r]/.test(e.path))) {
      reason = 'a changed path contains a line break';
    } else {
      try {
        lines = await this.contentLines(entries);
      } catch (e) {
        reason = `a changed file could not be read: ${(e as Error).message}`;
      }
    }
    const basis = lines ? 'content' : 'approximate';
    if (!lines) lines = await this.statLines(entries);
    lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const hash = createHash('sha256')
      .update(`${headText}\n${lines.join('\n')}`)
      .digest('hex');
    return {
      head,
      dirty: true,
      files: entries.length,
      hash,
      basis,
      ...(reason ? { reason } : {}),
      version: `${headText}+${basis === 'approximate' ? '~' : ''}${hash.slice(0, 12)}`,
    };
  }

  /** One line per entry: path, kind and the git blob id of its current content. */
  private async contentLines(entries: StatusEntry[]): Promise<string[]> {
    const lines: string[] = [];
    const toHash: { entry: StatusEntry; line: string }[] = [];
    for (const e of entries) {
      const tag = `${e.path}\0${e.kind}\0${e.index}${e.worktree}`;
      if (e.submodule.startsWith('S')) {
        lines.push(`${tag}\0submodule:${e.submodule}:${e.headObject ?? ''}:${e.indexObject ?? ''}`);
        continue;
      }
      const exists = await lstat(path.join(this.root, e.path)).then(
        () => true,
        () => false,
      );
      if (!exists) lines.push(`${tag}\0deleted`);
      else toHash.push({ entry: e, line: tag });
    }
    if (toHash.length) {
      const out = (
        await this.git(['hash-object', '--stdin-paths'], {
          input: `${toHash.map((x) => x.entry.path).join('\n')}\n`,
          timeoutMs: Math.max(this.opts.timeoutMs ?? 15_000, 60_000),
        })
      ).stdout
        .trim()
        .split('\n');
      if (out.length !== toHash.length) throw new Error('git hash-object returned a different number of ids');
      for (const [i, x] of toHash.entries()) lines.push(`${x.line}\0${out[i]}`);
    }
    return lines;
  }

  /** The approximate form: path, kind, size and modification time. */
  private async statLines(entries: StatusEntry[]): Promise<string[]> {
    return Promise.all(
      entries.map(async (e) => {
        const tag = `${e.path}\0${e.kind}\0${e.index}${e.worktree}`;
        const st = await lstat(path.join(this.root, e.path)).catch(() => null);
        return st ? `${tag}\0${st.size}:${Math.trunc(st.mtimeMs)}` : `${tag}\0deleted`;
      }),
    );
  }

  /** Commits that touched `paths` (all commits without paths), newest first; no author emails. */
  async log(opts: { paths?: string[]; limit?: number } = {}): Promise<LogEntry[]> {
    const raw = (
      await this.git(
        [
          'log',
          `-n${opts.limit ?? 20}`,
          '-z',
          '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s',
          ...(opts.paths?.length ? ['--', ...opts.paths] : []),
        ],
        { okCodes: [128] },
      )
    ).stdout;
    return raw
      .split('\0')
      .filter(Boolean)
      .map((r) => {
        const [commit, short, author, date, subject] = r.replace(/^\n/, '').split('\x1f');
        return {
          commit: commit ?? '',
          short: short ?? '',
          author: author ?? '',
          date: date ?? '',
          subject: subject ?? '',
        };
      })
      .filter((e) => e.commit);
  }

  /**
   * Changed paths with line counts: the working tree against HEAD (default) or the index.
   * Plumbing only: porcelain `git diff` rewrites the index even without optional locks. The
   * plumbing commands trust the index's stat data, so their output is limited to the paths
   * `status` (which compares content) reports as changed.
   */
  async diff(opts: { against?: 'HEAD' | 'index'; paths?: string[] } = {}): Promise<DiffEntry[]> {
    const status = await this.status();
    const changed = new Set<string>();
    for (const e of status.entries) {
      if (e.kind === 'untracked' || e.kind === 'ignored') continue;
      if (opts.against === 'index' && e.worktree === '.') continue;
      changed.add(e.path);
      if (e.origPath) changed.add(e.origPath);
    }
    if (changed.size === 0) return [];
    const raw = (
      await this.git([
        ...(opts.against === 'index' ? ['diff-files'] : ['diff-index', 'HEAD']),
        '--numstat',
        '-z',
        '-M',
        ...(opts.paths?.length ? ['--', ...opts.paths] : []),
      ])
    ).stdout;
    return this.parseNumstat(raw).filter((d) => changed.has(d.path) || (d.origPath && changed.has(d.origPath)));
  }

  private parseNumstat(raw: string): DiffEntry[] {
    const tokens = raw.split('\0');
    const out: DiffEntry[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i] as string;
      if (!t) continue;
      const [a, d, p] = t.split('\t');
      const added = a === '-' ? null : Number(a);
      const deleted = d === '-' ? null : Number(d);
      if (p === '' || p === undefined) {
        // A rename: the old and new paths follow as their own tokens.
        out.push({ added, deleted, origPath: tokens[i + 1] ?? '', path: tokens[i + 2] ?? '' });
        i += 2;
      } else {
        out.push({ added, deleted, path: p });
      }
    }
    return out;
  }

  /**
   * Watches the checkout (ADR-0019 §4): changed paths and git state, debounced. A hint to
   * refresh, never a source of truth. Returns a function that stops watching.
   */
  async watch(onChange: (c: WatchChange) => void, opts: { debounceMs?: number } = {}): Promise<() => void> {
    const { gitDir } = await this.refs();
    const debounceMs = opts.debounceMs ?? 200;
    const pending = new Set<string>();
    let gitMoved = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      const change = { paths: [...pending].sort(), git: gitMoved };
      pending.clear();
      gitMoved = false;
      if (change.paths.length || change.git) onChange(change);
    };
    const schedule = () => {
      if (!timer) timer = setTimeout(flush, debounceMs);
    };
    const isGitState = (rel: string) => /^(HEAD|index|packed-refs|ORIG_HEAD|MERGE_HEAD)$|^refs\//.test(rel);
    const watchers: FSWatcher[] = [];
    const inRootGit = path.relative(this.root, gitDir);
    const gitInside = !inRootGit.startsWith('..') && !path.isAbsolute(inRootGit);
    watchers.push(
      fsWatch(this.root, { recursive: true }, (_event, name) => {
        if (!name) return;
        const rel = String(name).split(path.sep).join('/');
        if (rel === '.git' || rel.startsWith('.git/')) {
          if (gitInside && isGitState(rel.slice(5))) {
            gitMoved = true;
            schedule();
          }
          return;
        }
        pending.add(rel);
        schedule();
      }),
    );
    if (!gitInside) {
      // A linked worktree keeps its HEAD and index in a git directory outside the checkout.
      watchers.push(
        fsWatch(gitDir, (_event, name) => {
          if (name && isGitState(String(name))) {
            gitMoved = true;
            schedule();
          }
        }),
      );
    }
    return () => {
      if (timer) clearTimeout(timer);
      for (const w of watchers) w.close();
    };
  }
}
