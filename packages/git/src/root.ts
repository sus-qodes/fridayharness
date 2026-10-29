import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, type FSWatcher, watch as fsWatch, rmSync, statSync, utimesSync } from 'node:fs';
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
  /** Their paths. A tracked file git reports changed only because its size changed is left out. */
  paths: string[];
  hash: string | null;
  /** `content`: blob ids of the files' content. `approximate`: size and modification time. */
  basis: 'content' | 'approximate';
  /** Why the identity is approximate. */
  reason?: string;
  /** Compact form for cache keys: `<head>` or `<head>+<first 12 of hash>`. */
  version: string;
}

/** What a checkout holds, as git objects (review F04). */
export interface ContentTree {
  /** The commit its HEAD names; null on a branch with no commit yet. */
  head: string | null;
  /** The tree of every file git sees in it: tracked ones, and untracked ones that are not ignored. */
  tree: string;
}

/** A path changed since a base commit (ADR-0024 §3). Paths are root-relative with forward slashes. */
export interface ChangedPath {
  path: string;
  change: 'added' | 'modified' | 'deleted' | 'renamed';
  /** The previous path of a rename. */
  origPath?: string;
  /** Changed by commits between the base and HEAD. */
  committed: boolean;
  /** Changed in the index or working tree, judged by content. */
  uncommitted: boolean;
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

  /** Every file git sees: tracked, and untracked but not ignored (paths relative to the root). */
  async files(): Promise<string[]> {
    const raw = (await this.git(['ls-files', '-z', '-c', '-o', '--exclude-standard'])).stdout;
    return [...new Set(raw.split('\0').filter(Boolean))];
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
    let entries = s.entries.filter((e) => e.kind !== 'ignored');
    const headText = head ?? INITIAL;
    const clean = (): SourceIdentity => ({
      head,
      dirty: false,
      files: 0,
      paths: [],
      hash: null,
      basis: 'content',
      version: headText,
    });
    if (entries.length === 0) return clean();
    let lines: string[] | null = null;
    let reason: string | undefined;
    if (entries.length > this.opts.maxHashedFiles) {
      reason = `${entries.length} changed files exceed the limit of ${this.opts.maxHashedFiles}`;
    } else if (entries.some((e) => /[\n\r]/.test(e.path))) {
      reason = 'a changed path contains a line break';
    } else {
      try {
        const hashed = await this.contentLines(entries);
        entries = hashed.map((h) => h.entry);
        lines = hashed.map((h) => h.line);
      } catch (e) {
        reason = `a changed file could not be read: ${(e as Error).message}`;
      }
    }
    if (entries.length === 0) return clean();
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
      paths: entries.map((e) => e.path),
      hash,
      basis,
      ...(reason ? { reason } : {}),
      version: `${headText}+${basis === 'approximate' ? '~' : ''}${hash.slice(0, 12)}`,
    };
  }

  /**
   * The exact content of the checkout as a git tree: what a commit of everything in it would hold
   * (review F04). Unlike the identity it has no approximate form: it is the content itself, so
   * equal trees are equal files. It is written through a temporary copy of the checkout's index, so
   * the checkout, its index and its branch stay untouched; the copy keeps the index's file data, so
   * git reads only the files that changed. A file git cannot read makes it fail.
   */
  async contentTree(): Promise<ContentTree> {
    const refs = await this.refs();
    const index = path.join(refs.gitDir, `friday-tree-${randomBytes(4).toString('hex')}.index`);
    const env = { GIT_INDEX_FILE: index };
    try {
      const own = path.join(refs.gitDir, 'index');
      if (existsSync(own)) {
        copyFileSync(own, index);
        // The original's time, so a file changed in the same instant as the index is still re-read.
        const st = statSync(own);
        utimesSync(index, st.atimeMs / 1000, st.mtimeMs / 1000);
      } else if (refs.head) {
        await this.git(['read-tree', refs.head], { env });
      }
      await this.git(['add', '-A'], { env, timeoutMs: Math.max(this.opts.timeoutMs ?? 15_000, 300_000) });
      const tree = (await this.git(['write-tree'], { env })).stdout.trim();
      return { head: refs.head, tree };
    } finally {
      rmSync(index, { force: true });
    }
  }

  /**
   * One line per entry: path, kind and the git blob id of its current content. A tracked file
   * whose content, filtered as `git add` would filter it, equals the index is left out: git
   * reports it changed only because its size changed, as when a checkout made with
   * `core.autocrlf=true` wrote CRLF and an editor wrote LF back (git trusts a size change
   * without reading the file).
   */
  private async contentLines(entries: StatusEntry[]): Promise<{ entry: StatusEntry; line: string }[]> {
    const lines: { entry: StatusEntry; line: string }[] = [];
    const toHash: { entry: StatusEntry; line: string }[] = [];
    for (const e of entries) {
      const tag = `${e.path}\0${e.kind}\0${e.index}${e.worktree}`;
      if (e.submodule.startsWith('S')) {
        lines.push({ entry: e, line: `${tag}\0submodule:${e.submodule}:${e.headObject ?? ''}:${e.indexObject ?? ''}` });
        continue;
      }
      const exists = await lstat(path.join(this.root, e.path)).then(
        () => true,
        () => false,
      );
      if (!exists) lines.push({ entry: e, line: `${tag}\0deleted` });
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
      for (const [i, x] of toHash.entries()) {
        const id = out[i];
        const e = x.entry;
        const sizeOnly =
          e.kind === 'changed' &&
          e.index === '.' &&
          e.worktree === 'M' &&
          e.indexMode !== undefined &&
          e.indexMode === e.worktreeMode &&
          id === e.indexObject;
        if (!sizeOnly) lines.push({ entry: e, line: `${x.line}\0${id}` });
      }
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

  /**
   * The paths changed since `base` (ADR-0024 §3): the commits from the base to HEAD compared tree to
   * tree, plus uncommitted changes judged by content (the identity's paths, so a line-ending-only
   * difference is not a change). Without a base, or with a base this repository does not have,
   * only uncommitted changes count, and `base_found` says which.
   */
  async changesSince(
    base: string | null,
  ): Promise<{ changes: ChangedPath[]; identity: SourceIdentity; base_found: boolean }> {
    const status = await this.status();
    const identity = await this.identity(status);
    const out = new Map<string, ChangedPath>();
    const head = status.head.commit;
    let baseFound = base === null || base === head;
    if (base && head && base !== head) {
      const res = await this.git(['diff-tree', '-r', '-z', '-M', '--name-status', base, head], { okCodes: [128] });
      baseFound = res.code === 0;
      const t = baseFound ? res.stdout.split('\0') : [];
      for (let i = 0; i < t.length; i++) {
        const code = t[i];
        if (!code) continue;
        const letter = code[0];
        if (letter === 'R' || letter === 'C') {
          const from = t[i + 1] ?? '';
          const to = t[i + 2] ?? '';
          i += 2;
          out.set(to, {
            path: to,
            change: letter === 'R' ? 'renamed' : 'added',
            ...(letter === 'R' ? { origPath: from } : {}),
            committed: true,
            uncommitted: false,
          });
        } else {
          const p = t[i + 1] ?? '';
          i += 1;
          out.set(p, {
            path: p,
            change: letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified',
            committed: true,
            uncommitted: false,
          });
        }
      }
    }
    const real = new Set(identity.paths);
    for (const e of status.entries) {
      if (e.kind === 'ignored' || !real.has(e.path)) continue;
      const prev = out.get(e.path);
      const change: ChangedPath['change'] =
        e.index === 'D' || e.worktree === 'D'
          ? 'deleted'
          : e.kind === 'untracked' || e.index === 'A'
            ? 'added'
            : e.kind === 'renamed'
              ? 'renamed'
              : 'modified';
      const origPath = e.origPath ?? prev?.origPath;
      out.set(e.path, {
        path: e.path,
        // A file added by a commit and edited since is still new relative to the base.
        change: prev?.change === 'added' && change === 'modified' ? 'added' : change,
        ...(origPath ? { origPath } : {}),
        committed: Boolean(prev?.committed),
        uncommitted: true,
      });
    }
    const changes = [...out.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { changes, identity, base_found: baseFound };
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
