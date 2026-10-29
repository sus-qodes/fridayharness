import { runGit } from '@friday/git';
import { matchesAny } from '@friday/policy';
import { type FilesListing, FridayError, type GlobCounts } from '@friday/protocol';

/**
 * The repository as the plan editor's scope picker needs it (plan M9 §5.11): the tracked files one
 * level under a folder, and how many tracked files each write-scope glob matches. Only what git
 * tracks is listed (`git ls-files`), so nothing ignored or private is ever named.
 */

export const LIST_CAP = 2000;
export const MATCH_FILE_CAP = 50_000;

const SAFE_DIR = /^(?:[^/\\\0]+\/)*[^/\\\0]*$/;

async function trackedFiles(root: string): Promise<{ files: string[]; truncated: boolean }> {
  const r = await runGit(root, ['ls-files', '-z', '--cached'], { maxBytes: 32 * 1024 * 1024, timeoutMs: 30_000 });
  const all = r.stdout.split('\0').filter(Boolean);
  return { files: all.slice(0, MATCH_FILE_CAP), truncated: all.length > MATCH_FILE_CAP };
}

/** The tracked files and folders directly under `dir` (forward slashes, project-relative). */
export async function listFiles(root: string, dirArg: string): Promise<FilesListing> {
  const dir = dirArg.replace(/^\/+|\/+$/g, '');
  if (!SAFE_DIR.test(dir) || dir.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw new FridayError('invalid_request', 'dir must be a project-relative folder');
  }
  const prefix = dir ? `${dir}/` : '';
  const { files } = await trackedFiles(root);
  const folders = new Map<string, number>();
  const entries: FilesListing['entries'] = [];
  for (const f of files) {
    if (!f.startsWith(prefix)) continue;
    const rest = f.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) entries.push({ name: rest, path: f, kind: 'file', files: null });
    else {
      const name = rest.slice(0, slash);
      folders.set(name, (folders.get(name) ?? 0) + 1);
    }
  }
  const dirs: FilesListing['entries'] = [...folders].map(([name, n]) => ({
    name,
    path: `${prefix}${name}`,
    kind: 'dir',
    files: n,
  }));
  const all = [
    ...dirs.sort((a, b) => a.name.localeCompare(b.name)),
    ...entries.sort((a, b) => a.name.localeCompare(b.name)),
  ];
  return { dir, entries: all.slice(0, LIST_CAP), truncated: all.length > LIST_CAP };
}

/** How many tracked files each glob matches, with the policy's own glob rules. */
export async function countMatches(root: string, globs: string[]): Promise<GlobCounts> {
  const { files, truncated } = await trackedFiles(root);
  const counts: Record<string, number> = {};
  for (const g of globs) counts[g] = files.filter((f) => matchesAny(f, [g])).length;
  return { counts, total: files.length, truncated };
}
