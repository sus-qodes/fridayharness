/**
 * Project-relative POSIX globs as task scopes use them (`backend/**`, `src/*.ts`, `{a,b}/**`), for
 * colouring the code graph by the write scopes of running tasks. `**` crosses folders, `*` and `?`
 * do not; a pattern without wildcards also matches everything below it as a folder. Pure.
 */

const cache = new Map<string, RegExp>();

function escapeChar(ch: string): string {
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/** The regular expression of one glob (anchored at both ends). */
export function globToRegExp(glob: string): RegExp {
  const cached = cache.get(glob);
  if (cached) return cached;
  const g = normalizePath(glob);
  let out = '';
  let inBraces = 0;
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string;
    if (c === '*') {
      if (g[i + 1] === '*') {
        const slashAfter = g[i + 2] === '/';
        const atStart = i === 0 || g[i - 1] === '/';
        if (atStart && slashAfter) {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '{') {
      inBraces++;
      out += '(?:';
    } else if (c === '}' && inBraces > 0) {
      inBraces--;
      out += ')';
    } else if (c === ',' && inBraces > 0) out += '|';
    else out += escapeChar(c);
  }
  while (inBraces-- > 0) out += ')';
  const hasWildcard = /[*?{]/.test(g);
  const re = new RegExp(hasWildcard ? `^${out}$` : `^${out}(?:/.*)?$`);
  cache.set(glob, re);
  return re;
}

/** `.\\a\\b.ts` → `a/b.ts`. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

export function matchesGlob(path: string, glob: string): boolean {
  if (!glob) return false;
  return globToRegExp(glob).test(normalizePath(path));
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => matchesGlob(path, g));
}
