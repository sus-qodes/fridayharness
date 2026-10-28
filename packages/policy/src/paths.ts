import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';

const WIN = process.platform === 'win32';

export interface PathContext {
  /** Real path of the project's main worktree. */
  projectRoot: string;
  /** Friday's per-user state directory (contains every project's private dir). */
  stateDir?: string;
  /** Platform override for tests. Links are resolved on disk only when it matches the host. */
  windows?: boolean;
}

export interface CanonicalPath {
  /** Absolute, normalized path as given. */
  absolute: string;
  /** Project-relative POSIX path, or null when outside the project. */
  relative: string | null;
  /**
   * What the path refers to on disk: symlinks and junctions resolved, for a new file through
   * its nearest existing ancestor. Equal to `absolute` when nothing on the way is a link.
   */
  real: string;
  /** Project-relative POSIX form of `real`, or null when the target is outside the project. */
  realRelative: string | null;
  /** True when a link on the way makes `real` differ from `absolute`. */
  linked: boolean;
}

function isWindows(ctx: PathContext): boolean {
  return ctx.windows ?? WIN;
}

const MAX_LINK_HOPS = 32;

/**
 * The filesystem target of an absolute path (plan B19): resolves every symlink and junction on
 * the way, including a dangling final link, and keeps the part of the path that does not exist
 * yet. Errors other than "does not exist" leave the path as given. This narrows aliasing; it
 * does not remove races with a process that changes links after the check (not a sandbox).
 */
function realTarget(absolute: string, lib: typeof path.win32 | typeof path.posix): string {
  let current = absolute;
  const rest: string[] = [];
  for (let hops = 0; hops < MAX_LINK_HOPS; ) {
    try {
      const real = realpathSync.native(current);
      return rest.length ? lib.join(real, ...rest.slice().reverse()) : real;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return absolute;
    }
    let link: string | null = null;
    try {
      if (lstatSync(current).isSymbolicLink()) link = readlinkSync(current);
    } catch {
      link = null;
    }
    if (link !== null) {
      // A dangling link: writing through it would create its target.
      current = lib.resolve(lib.dirname(current), link);
      hops += 1;
      continue;
    }
    const parent = lib.dirname(current);
    if (parent === current) return absolute;
    rest.push(lib.basename(current));
    current = parent;
  }
  return absolute;
}

const realRoots = new Map<string, string>();

/** Real path of a root directory, cached (roots do not move while a process runs). */
function realRoot(root: string, lib: typeof path.win32 | typeof path.posix, onDisk: boolean): string {
  const resolved = lib.resolve(root);
  if (!onDisk) return resolved;
  let real = realRoots.get(resolved);
  if (real === undefined) {
    real = realTarget(resolved, lib);
    realRoots.set(resolved, real);
  }
  return real;
}

/** Project-relative POSIX path of an absolute path, or null when it is outside `root`. */
function relativeTo(root: string, absolute: string, win: boolean): string | null {
  const lib = win ? path.win32 : path.posix;
  const rootN = win ? root.toLowerCase() : root;
  const absN = win ? absolute.toLowerCase() : absolute;
  // NTFS alternate data streams (file.ts:stream) and trailing dots/spaces alias real files.
  const cleaned = win ? absN.replace(/:[^\\/:]*$/, (m, off) => (off > 2 ? '' : m)).replace(/[. ]+$/, '') : absN;
  const rel = lib.relative(rootN, cleaned);
  if (rel === '') return '.';
  if (rel.startsWith('..') || lib.isAbsolute(rel)) return null;
  return rel.split(lib.sep).join('/');
}

/**
 * Resolves a path reported by a tool against the project root (plan B19). Relative paths are
 * taken from the root; `..` segments are resolved before deciding whether the path is inside.
 * UNC and `\\?\` device paths are never considered inside the project. Callers check both the
 * path as given and its real target: a link inside the project can point anywhere.
 */
export function canonicalize(p: string, ctx: PathContext): CanonicalPath {
  const win = isWindows(ctx);
  const lib = win ? path.win32 : path.posix;
  const onDisk = win === WIN;
  const raw = p.trim().replace(/^["']|["']$/g, '');
  const absolute = lib.resolve(ctx.projectRoot, raw);
  if (win && (/^\\\\/.test(raw) || /^\\\\[?.]\\/.test(absolute))) {
    return { absolute, relative: null, real: absolute, realRelative: null, linked: false };
  }
  const relative = relativeTo(lib.resolve(ctx.projectRoot), absolute, win);
  const real = onDisk ? realTarget(absolute, lib) : absolute;
  const rootReal = realRoot(ctx.projectRoot, lib, onDisk);
  const realRelative = relativeTo(rootReal, real, win);
  const same = win ? real.toLowerCase() === absolute.toLowerCase() : real === absolute;
  // The root itself may be reached through a link (a short 8.3 name, a symlinked temp dir).
  const linked = !same && realRelative !== relative;
  return { absolute, relative, real, realRelative: linked ? realRelative : relative, linked };
}

/** Real path of a directory such as the state dir, for comparisons with `CanonicalPath.real`. */
export function realDirectory(dir: string, windows = WIN): string {
  const lib = windows ? path.win32 : path.posix;
  return realRoot(dir, lib, windows === WIN);
}

export function isInside(child: string, parent: string, windows = WIN): boolean {
  const lib = windows ? path.win32 : path.posix;
  const a = windows ? lib.resolve(child).toLowerCase() : lib.resolve(child);
  const b = windows ? lib.resolve(parent).toLowerCase() : lib.resolve(parent);
  const rel = lib.relative(b, a);
  return rel === '' || (!rel.startsWith('..') && !lib.isAbsolute(rel));
}

const matcherCache = new Map<string, (s: string) => boolean>();

/** Project-relative POSIX path against globs (gitignore-like `**`), case-insensitive on Windows. */
export function matchesAny(relative: string, globs: readonly string[], windows = WIN): boolean {
  if (globs.length === 0) return false;
  const key = `${windows ? 'w' : 'p'}|${globs.join('\n')}`;
  let m = matcherCache.get(key);
  if (!m) {
    const normalized = globs.map((g) => g.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '/**'));
    m = picomatch(normalized, { dot: true, nocase: windows });
    matcherCache.set(key, m);
  }
  return m(relative);
}

/** Two glob lists may touch the same file (conservative: equal prefixes or wildcards overlap). */
export function globsOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  const stem = (g: string) => g.replaceAll('\\', '/').split(/[*?[{]/)[0] ?? '';
  for (const x of a) {
    for (const y of b) {
      const sx = stem(x).toLowerCase();
      const sy = stem(y).toLowerCase();
      if (sx.startsWith(sy) || sy.startsWith(sx)) return true;
    }
  }
  return false;
}
