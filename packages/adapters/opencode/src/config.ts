import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { applyPlan, type FileChange } from '@friday/adapter-claude';
import { CONFIG_FILE, OPENCODE_VERSION } from './profile.js';

/** A tracked declaration only: runtime config/plugin/credentials live outside the checkout. */
export function planOpenCode(opts: { projectDir: string; remove?: boolean }): FileChange[] {
  const file = path.join(realpathSync(opts.projectDir), CONFIG_FILE);
  noLinks(file);
  const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const after = opts.remove
    ? null
    : `${JSON.stringify(
        {
          owner: 'friday',
          host: 'opencode',
          version: OPENCODE_VERSION,
          mode: 'preflight',
          experimental: true,
        },
        null,
        2,
      )}\n`;
  if (before === after) return [];
  if (before !== null) {
    try {
      if ((JSON.parse(before) as { owner?: string }).owner !== 'friday') throw new Error();
    } catch {
      throw new Error('refusing to replace an unowned OpenCode declaration');
    }
  }
  return [
    {
      path: file,
      display: CONFIG_FILE,
      before,
      after,
      tracked: true,
      owned: false,
      note: 'declares the experimental no-model OpenCode profile',
    },
  ];
}
function noLinks(file: string): void {
  for (let p = file; p !== path.dirname(p); p = path.dirname(p)) {
    if (lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error('OpenCode configuration path contains a link');
  }
}
export function applyOpenCodePlan(changes: FileChange[]): void {
  for (const change of changes) {
    noLinks(change.path);
    const current = existsSync(change.path) ? readFileSync(change.path, 'utf8') : null;
    if (current !== change.before) throw new Error('OpenCode configuration changed since it was read');
  }
  applyPlan(changes);
}
