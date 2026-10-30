import { createHash, randomBytes } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { existsSync } from 'node:fs';
import {
  copyFile,
  link,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from './log.js';

/**
 * Installed dependencies kept per lockfile, so a task worktree whose lockfile another worktree
 * already installed starts in seconds instead of paying the install again. The cache is a folder
 * beside the worktrees folder (`friday-dependency-cache`), one entry per key: the hash of the
 * package manager, whether lifecycle scripts ran, and the bytes of the lockfile, `package.json`
 * and the manager's own configuration file. A worktree's `node_modules` folders are cloned into
 * the entry after a successful install, and cloned back into every later worktree with the same
 * key. A clone is a tree of hard links (a copy where a link is refused), so the worktrees and the
 * entry share file content but own their directory entries: nothing an agent installs, removes or
 * edits in its worktree reaches the entry or another worktree, and removing a worktree removes
 * only its own links. Links inside the tree (pnpm's junctions and symbolic links) and the
 * absolute paths pnpm writes into its bin shims and `.modules.yaml` are rewritten from the
 * worktree the entry came from to the worktree it is cloned into. A different lockfile is a
 * different key, so a stale tree is never reused; entries are pruned by size, oldest use first.
 * Nothing here costs a model token.
 */

export const DEPENDENCY_CACHE_DIRNAME = 'friday-dependency-cache';
export const META_FILE = 'meta.json';
const TREE_DIR = 'tree';
const STAGING_PREFIX = '.staging-';
/** A staging folder a crash left behind is removed once this old. */
const STAGING_MAX_AGE_MS = 60 * 60 * 1000;
/** Files beside a lockfile whose content changes what an install produces. */
const CONFIG_FILES: Record<string, string[]> = {
  pnpm: ['.npmrc', 'pnpm-workspace.yaml'],
  npm: ['.npmrc'],
  yarn: ['.yarnrc', '.yarnrc.yml'],
  bun: ['bunfig.toml'],
};
/** How deep `node_modules` folders of workspace packages are looked for (`packages/<name>/node_modules`). */
const NODE_MODULES_DEPTH = 3;
/** The largest text file rewritten for an absolute path (pnpm's shims are a few KB). */
const REWRITE_MAX_BYTES = 64 * 1024;
const CLONE_CONCURRENCY = 64;

/** `friday-dependency-cache` beside the worktrees folder (the same volume, so hard links work). */
export function dependencyCacheDir(worktreesDir: string): string {
  return path.join(path.dirname(worktreesDir), DEPENDENCY_CACHE_DIRNAME);
}

export interface CacheEntryMeta {
  key: string;
  manager: string;
  lockfile: string;
  scripts: boolean;
  created_at: string;
  last_used_at: string;
  /** Regular files in the entry. */
  files: number;
  bytes: number;
  /** The `node_modules` folders the entry holds, relative to the worktree root, `/`-separated. */
  dirs: string[];
}

/** What a clone did, for the run's record and the log. */
export interface CloneStats {
  files: number;
  linked: number;
  copied: number;
  links: number;
  bytes: number;
  duration_ms: number;
}

/**
 * The key of an install: the manager, whether scripts ran, and the bytes of every file that
 * decides the tree. A changed lockfile is a new key; a reinstall never reuses a stale tree.
 */
export async function dependencyCacheKey(
  root: string,
  manager: string,
  lockfile: string,
  scripts: boolean,
): Promise<string> {
  const h = createHash('sha256');
  h.update(`${manager}\0${scripts ? 'scripts' : 'no-scripts'}\0`);
  for (const name of [lockfile, 'package.json', ...(CONFIG_FILES[manager] ?? [])]) {
    const bytes = await readFile(path.join(root, name)).catch(() => null);
    if (!bytes) continue;
    h.update(`${name}\0${bytes.length}\0`);
    h.update(bytes);
  }
  return h.digest('hex').slice(0, 32);
}

/** The `node_modules` folders of a checkout, as `/`-separated paths relative to it, the root's first. */
export async function nodeModulesDirs(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[]);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'node_modules') {
        found.push(rel ? `${rel}/node_modules` : 'node_modules');
        continue;
      }
      if (e.name.startsWith('.') || depth >= NODE_MODULES_DEPTH) continue;
      await walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
    }
  };
  await walk(root, '', 1);
  return found.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

/**
 * The textual forms of an absolute folder path as package managers write it: as given, with
 * forward slashes, JSON-escaped (pnpm's `.modules.yaml` quotes paths that way) and, on Windows,
 * as WSL spells the same folder (pnpm's POSIX shims carry it).
 */
export function pathForms(p: string): string[] {
  const forms = [p, p.replaceAll('\\', '/'), p.replaceAll('\\', '\\\\')];
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  const [, letter, rest] = drive ?? [];
  if (letter !== undefined && rest !== undefined)
    forms.push(`/mnt/${letter.toLowerCase()}/${rest.replaceAll('\\', '/')}`);
  return [...new Set(forms)];
}

/** Replaces every form of `from` with the same form of `to`. */
export function rewritePaths(text: string, from: string, to: string): string {
  const f = pathForms(from);
  const t = pathForms(to);
  let out = text;
  f.forEach((form, i) => {
    out = out.replaceAll(form, t[i] ?? to);
  });
  return out;
}

const samePrefix = (p: string, prefix: string) =>
  process.platform === 'win32'
    ? p.toLowerCase() === prefix.toLowerCase() || p.toLowerCase().startsWith(`${prefix.toLowerCase()}${path.sep}`)
    : p === prefix || p.startsWith(`${prefix}${path.sep}`);

/** A link target under `from` becomes the same path under `to`; any other target is kept. */
export function rewriteLinkTarget(target: string, from: string, to: string): string {
  if (!path.isAbsolute(target)) return target;
  const plain = target.replace(/^\\\\\?\\/, '');
  return samePrefix(plain, from) ? path.join(to, plain.slice(from.length)) : plain;
}

/** Whether a file is one pnpm writes an absolute path into: a bin shim, or `node_modules/.modules.yaml`. */
const carriesPaths = (parent: string, name: string) =>
  parent === '.bin' || (name === '.modules.yaml' && parent === 'node_modules');

/** A bounded pool: `size` jobs in flight at once. */
class Pool {
  #running = 0;
  readonly #waiting: (() => void)[] = [];
  constructor(private readonly size: number) {}
  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.#running >= this.size) await new Promise<void>((r) => this.#waiting.push(r));
    this.#running++;
    try {
      return await job();
    } finally {
      this.#running--;
      this.#waiting.shift()?.();
    }
  }
}

/**
 * Clones one `node_modules` tree from `src` to `dst` as hard links (a copy where linking is refused:
 * another volume, a file at the link limit), recreating links with targets under `roots.from`
 * rewritten to `roots.to`, and rewriting the files that carry the root's absolute path as text.
 * Every file is `stat`ed only when its size is wanted (`countBytes`, the store): a restore of
 * tens of thousands of files is one `link` each.
 */
async function cloneTree(
  src: string,
  dst: string,
  roots: { from: string; to: string },
  stats: CloneStats,
  pool: Pool,
  countBytes: boolean,
): Promise<void> {
  await mkdir(dst, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  const parent = path.basename(src);
  const jobs: Promise<unknown>[] = [];
  for (const e of entries) {
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isSymbolicLink()) {
      jobs.push(
        pool.run(async () => {
          const target = rewriteLinkTarget(await readlink(from), roots.from, roots.to);
          // Windows needs the kind: a junction for an absolute folder target (pnpm's), else a
          // directory or file link; a dangling link is taken for a folder.
          const isDir = await stat(from)
            .then((s) => s.isDirectory())
            .catch(() => true);
          const kind =
            process.platform !== 'win32' ? undefined : !isDir ? 'file' : path.isAbsolute(target) ? 'junction' : 'dir';
          await symlink(target, to, kind);
          stats.links++;
        }),
      );
    } else if (e.isDirectory()) {
      jobs.push(cloneTree(from, to, roots, stats, pool, countBytes));
    } else if (e.isFile()) {
      jobs.push(
        pool.run(async () => {
          const carries = carriesPaths(parent, e.name);
          const size = countBytes || carries ? (await stat(from)).size : 0;
          stats.files++;
          stats.bytes += size;
          if (carries && size <= REWRITE_MAX_BYTES) {
            const text = await readFile(from, 'utf8');
            const out = rewritePaths(text, roots.from, roots.to);
            if (out !== text) {
              await writeFile(to, out);
              stats.copied++;
              return;
            }
          }
          try {
            await link(from, to);
            stats.linked++;
          } catch {
            await copyFile(from, to);
            stats.copied++;
          }
        }),
      );
    }
  }
  await Promise.all(jobs);
}

async function readMeta(file: string): Promise<CacheEntryMeta | null> {
  try {
    const m = JSON.parse(await readFile(file, 'utf8')) as CacheEntryMeta;
    return m && typeof m.key === 'string' && Array.isArray(m.dirs) ? m : null;
  } catch {
    return null;
  }
}

/** Written beside and moved into place, so a concurrent reader sees the old file or the new. */
async function writeMeta(file: string, meta: CacheEntryMeta): Promise<void> {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(meta, null, 2)}\n`);
  await rename(tmp, file);
}

export interface DependencyCacheOptions {
  dir: string;
  /** The size the cache may reach before its least recently used entries go. */
  maxBytes: () => number;
  logger: Logger;
  now?: () => Date;
}

export class DependencyCache {
  constructor(private readonly opts: DependencyCacheOptions) {}

  get dir(): string {
    return this.opts.dir;
  }

  entryDir(key: string): string {
    return path.join(this.opts.dir, key);
  }

  /** The entry for a key, when it is complete (an entry is moved into place whole). */
  async lookup(key: string): Promise<CacheEntryMeta | null> {
    const meta = await readMeta(path.join(this.entryDir(key), META_FILE));
    return meta && existsSync(path.join(this.entryDir(key), TREE_DIR)) ? meta : null;
  }

  /**
   * Clones the entry's trees into a worktree and notes the use. A `node_modules` already there,
   * or one whose parent folder the checkout does not have, is left as it is. A clone that fails
   * half way is removed before the error is thrown, so the install can run instead.
   */
  async restore(key: string, worktree: string): Promise<CloneStats> {
    const meta = await this.lookup(key);
    if (!meta) throw new Error(`no dependency cache entry ${key}`);
    const started = Date.now();
    const stats: CloneStats = { files: 0, linked: 0, copied: 0, links: 0, bytes: 0, duration_ms: 0 };
    const tree = path.join(this.entryDir(key), TREE_DIR);
    const pool = new Pool(CLONE_CONCURRENCY);
    const made: string[] = [];
    try {
      for (const rel of meta.dirs) {
        const dst = path.join(worktree, ...rel.split('/'));
        if (existsSync(dst) || !existsSync(path.dirname(dst))) continue;
        made.push(dst);
        await cloneTree(path.join(tree, ...rel.split('/')), dst, { from: tree, to: worktree }, stats, pool, false);
      }
    } catch (e) {
      for (const dst of made) await rm(dst, { recursive: true, force: true }).catch(() => undefined);
      throw e;
    }
    // The entry's size stands for the clone's: its files are the same files.
    if (made.length === meta.dirs.length) stats.bytes = meta.bytes;
    stats.duration_ms = Date.now() - started;
    await writeMeta(path.join(this.entryDir(key), META_FILE), { ...meta, last_used_at: this.#now() }).catch(
      () => undefined,
    );
    return stats;
  }

  /**
   * Clones a worktree's `node_modules` folders into a new entry: written in a staging folder with
   * every link and path already naming the entry's final place, then moved there whole, so a
   * reader never sees a half entry; when another install of the same key got there first, its
   * entry stays. Then the cache is pruned to its size. Null when the worktree has no `node_modules`.
   */
  async store(
    key: string,
    worktree: string,
    install: { manager: string; lockfile: string; scripts: boolean },
  ): Promise<CloneStats | null> {
    const dirs = await nodeModulesDirs(worktree);
    if (dirs.length === 0) return null;
    const started = Date.now();
    const final = this.entryDir(key);
    const staging = path.join(this.opts.dir, `${STAGING_PREFIX}${randomBytes(6).toString('hex')}`);
    const stats: CloneStats = { files: 0, linked: 0, copied: 0, links: 0, bytes: 0, duration_ms: 0 };
    try {
      await mkdir(path.join(staging, TREE_DIR), { recursive: true });
      const pool = new Pool(CLONE_CONCURRENCY);
      const roots = { from: worktree, to: path.join(final, TREE_DIR) };
      for (const rel of dirs) {
        const parts = rel.split('/');
        await cloneTree(
          path.join(worktree, ...parts),
          path.join(staging, TREE_DIR, ...parts),
          roots,
          stats,
          pool,
          true,
        );
      }
      stats.duration_ms = Date.now() - started;
      const now = this.#now();
      await writeMeta(path.join(staging, META_FILE), {
        key,
        manager: install.manager,
        lockfile: install.lockfile,
        scripts: install.scripts,
        created_at: now,
        last_used_at: now,
        files: stats.files,
        bytes: stats.bytes,
        dirs,
      });
      try {
        await rename(staging, final);
      } catch (e) {
        if (!(await this.lookup(key))) throw e;
        await rm(staging, { recursive: true, force: true });
      }
    } catch (e) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw e;
    }
    await this.prune(key).catch((e) =>
      this.opts.logger.warn('dependency cache not pruned', { reason: (e as Error).message }),
    );
    return stats;
  }

  /** Every complete entry, oldest use first. */
  async entries(): Promise<CacheEntryMeta[]> {
    const names = await readdir(this.opts.dir).catch(() => [] as string[]);
    const metas = await Promise.all(names.filter((n) => !n.startsWith('.')).map((n) => this.lookup(n)));
    return metas
      .filter((m): m is CacheEntryMeta => m !== null)
      .sort((a, b) => a.last_used_at.localeCompare(b.last_used_at));
  }

  /**
   * Removes the least recently used entries while the cache is over its size (`keep` stays), and
   * staging folders a crash left behind.
   */
  async prune(keep?: string): Promise<string[]> {
    const max = this.opts.maxBytes();
    const entries = await this.entries();
    let total = entries.reduce((n, e) => n + e.bytes, 0);
    const removed: string[] = [];
    for (const e of entries) {
      if (total <= max) break;
      if (e.key === keep) continue;
      await this.remove(e.key);
      total -= e.bytes;
      removed.push(e.key);
    }
    const cutoff = Date.now() - STAGING_MAX_AGE_MS;
    for (const name of await readdir(this.opts.dir).catch(() => [] as string[])) {
      if (!name.startsWith(STAGING_PREFIX)) continue;
      const p = path.join(this.opts.dir, name);
      const s = await stat(p).catch(() => null);
      if (s && s.mtimeMs < cutoff) await rm(p, { recursive: true, force: true }).catch(() => undefined);
    }
    if (removed.length) this.opts.logger.info('dependency cache pruned', { removed, bytes: total });
    return removed;
  }

  /** Removes an entry, its meta file first, so a concurrent lookup never finds a half entry. */
  async remove(key: string): Promise<void> {
    const dir = this.entryDir(key);
    await rm(path.join(dir, META_FILE), { force: true });
    // `rm` removes a link without following it: the worktrees' own trees are never touched.
    await rm(dir, { recursive: true, force: true });
  }

  #now(): string {
    return (this.opts.now?.() ?? new Date()).toISOString();
  }
}
