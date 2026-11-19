/**
 * Friday's own folders, skipped by the project's linter (2026-11-19, the trial's F18).
 *
 * `eslint . --max-warnings 0` in the project folder linted Friday's hook launcher
 * (`.friday/harness/<host>/hook.mjs`, a bundle) and failed on it; an agent then changed the
 * project's own `eslint.config.js` to get past it. Since ESLint 10 a config file is looked up from
 * each file's own folder, so one in a folder of Friday's that ignores everything in it makes the
 * project's lint skip that folder, and nothing of the project's own settings changes. (ESLint 8
 * skips folders that start with a dot by itself; ESLint 9 reads only the project's own config.)
 */
import { existsSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** The file's name: ESLint's own. */
export const LINT_SKIP_FILE = 'eslint.config.mjs';

/** What it says: nothing in this folder is the project's code to lint. */
export const LINT_SKIP = [
  "// Friday's own files, not your project's code: ESLint 10 and later skip this folder.",
  "export default [{ ignores: ['**'] }];",
  '',
].join('\n');

/** The folders of Friday's that hold scripts in a project, relative to its root. */
export const LINT_SKIP_FOLDERS = ['.friday', '.agents/.friday'] as const;

const isFolder = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Writes the file into each of Friday's folders the project has that lacks one; a file already
 * there, whatever it says, is left as it is. `skip` leaves a folder out: the daemon skips one git
 * tracks, where a new file would be a change in the person's folder (setup writes it there, as a
 * file to commit with Friday's others). Answers the files written, relative to the root.
 */
export function ensureLintSkip(root: string, skip: (folder: string) => boolean = () => false): string[] {
  const written: string[] = [];
  for (const folder of LINT_SKIP_FOLDERS) {
    const dir = path.join(root, ...folder.split('/'));
    // Only where Friday's scripts are: in `.friday`, its hook launchers under `harness/`.
    const scripts = folder === '.friday' ? path.join(dir, 'harness') : dir;
    if (!isFolder(scripts) || skip(folder)) continue;
    const file = path.join(dir, LINT_SKIP_FILE);
    if (existsSync(file)) continue;
    writeFileSync(file, LINT_SKIP, { flag: 'wx' });
    written.push(`${folder}/${LINT_SKIP_FILE}`);
  }
  return written;
}
