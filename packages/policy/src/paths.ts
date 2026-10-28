import path from 'node:path';
import picomatch from 'picomatch';

const WIN = process.platform === 'win32';

export interface PathContext {
  /** Real path of the project's main worktree. */
  projectRoot: string;
  /** Friday's per-user state directory (contains every project's private dir). */
  stateDir?: string;
  /** Platform override for tests. */
  windows?: boolean;
}

export interface CanonicalPath {
  /** Absolute, normalized path as given. */
  absolute: string;
  /** Project-relative POSIX path, or null when outside the project. */
  relative: string | null;
}

function isWindows(ctx: PathContext): boolean {
  return ctx.windows ?? WIN;
}

/**
 * Resolves a path reported by a tool against the project root (plan B19). Relative paths are
 * taken from the root; `..` segments are resolved before deciding whether the path is inside.
 * UNC and `\\?\` device paths are never considered inside the project.
 */
export function canonicalize(p: string, ctx: PathContext): CanonicalPath {
  const win = isWindows(ctx);
  const lib = win ? path.win32 : path.posix;
  const raw = p.trim().replace(/^["']|["']$/g, '');
  const absolute = lib.resolve(ctx.projectRoot, raw);
  if (win && (/^\\\\/.test(raw) || /^\\\\[?.]\\/.test(absolute))) return { absolute, relative: null };
  const rootN = win ? lib.resolve(ctx.projectRoot).toLowerCase() : lib.resolve(ctx.projectRoot);
  const absN = win ? absolute.toLowerCase() : absolute;
  // NTFS alternate data streams (file.ts:stream) and trailing dots/spaces alias real files.
  const cleaned = win ? absN.replace(/:[^\\/:]*$/, (m, off) => (off > 2 ? '' : m)).replace(/[. ]+$/, '') : absN;
  const rel = lib.relative(rootN, cleaned);
  if (rel === '') return { absolute, relative: '.' };
  if (rel.startsWith('..') || lib.isAbsolute(rel)) return { absolute, relative: null };
  return { absolute, relative: rel.split(lib.sep).join('/') };
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
