/**
 * Parsing of `git status --porcelain=v2 --branch -z` (ADR-0019 §2). Paths are relative to the
 * root with forward slashes, exactly as git reports them.
 */

export type EntryKind = 'changed' | 'renamed' | 'copied' | 'unmerged' | 'untracked' | 'ignored';

/** One state letter per side, `.` when unchanged (git's own codes: M, T, A, D, R, C, U). */
export interface StatusEntry {
  kind: EntryKind;
  path: string;
  /** The previous path of a rename or copy. */
  origPath?: string;
  index: string;
  worktree: string;
  /** Git's submodule field (`N...` for a normal path, `S<c><m><u>` for a submodule). */
  submodule: string;
  /** Object names in HEAD and the index, where git reports them. */
  headObject?: string;
  indexObject?: string;
}

export interface StatusHead {
  /** Null in a repository without commits. */
  commit: string | null;
  /** Null when HEAD is detached. */
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface Status {
  head: StatusHead;
  entries: StatusEntry[];
  clean: boolean;
}

export function parseStatusV2(raw: string): Status {
  const head: StatusHead = { commit: null, branch: null, upstream: null, ahead: 0, behind: 0 };
  const entries: StatusEntry[] = [];
  const tokens = raw.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string;
    if (!t) continue;
    if (t.startsWith('# ')) {
      const [, key, ...rest] = t.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') head.commit = value === '(initial)' ? null : value;
      else if (key === 'branch.head') head.branch = value === '(detached)' ? null : value;
      else if (key === 'branch.upstream') head.upstream = value;
      else if (key === 'branch.ab') {
        const m = value.match(/^\+(\d+) -(\d+)$/);
        if (m) {
          head.ahead = Number(m[1]);
          head.behind = Number(m[2]);
        }
      }
      continue;
    }
    const type = t[0];
    if (type === '1') {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const f = t.split(' ');
      entries.push({
        kind: 'changed',
        index: (f[1] ?? '..')[0] as string,
        worktree: (f[1] ?? '..')[1] as string,
        submodule: f[2] ?? 'N...',
        headObject: f[6],
        indexObject: f[7],
        path: f.slice(8).join(' '),
      });
    } else if (type === '2') {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>, then <origPath> as the next token
      const f = t.split(' ');
      entries.push({
        kind: (f[8] ?? 'R').startsWith('C') ? 'copied' : 'renamed',
        index: (f[1] ?? '..')[0] as string,
        worktree: (f[1] ?? '..')[1] as string,
        submodule: f[2] ?? 'N...',
        headObject: f[6],
        indexObject: f[7],
        path: f.slice(9).join(' '),
        origPath: tokens[i + 1] ?? '',
      });
      i += 1;
    } else if (type === 'u') {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const f = t.split(' ');
      entries.push({
        kind: 'unmerged',
        index: (f[1] ?? '..')[0] as string,
        worktree: (f[1] ?? '..')[1] as string,
        submodule: f[2] ?? 'N...',
        path: f.slice(10).join(' '),
      });
    } else if (type === '?' || type === '!') {
      entries.push({
        kind: type === '?' ? 'untracked' : 'ignored',
        index: '.',
        worktree: type,
        submodule: 'N...',
        path: t.slice(2),
      });
    }
  }
  const relevant = entries.filter((e) => e.kind !== 'ignored');
  return { head, entries, clean: relevant.length === 0 };
}
