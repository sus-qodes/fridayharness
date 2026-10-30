/**
 * OpenCode checkpoint E (plan M14.5): is a small model on this machine worth sending small tasks
 * to? Three task kinds of the fixture shop (`tests/fixtures/opencode-e/tasks.json`): a new function
 * with its tests, a reported bug fixed with a test, an edit of existing code with a test added. Each is
 * done by OpenCode under Friday and by OpenCode alone, and judged by the same hidden checks. What the
 * live test `tests/scenarios/opencode-e.live.test.ts` needs lives here, so it is tested offline.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { deterministicGit } from '@friday/test-support';
import { parseTap } from './benefit.js';
import { REPO_ROOT } from './cli.js';

const DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'opencode-e');
export const E_HIDDEN_TESTS = path.join(DIR, 'acceptance.hidden.test.mjs');

export interface ETask {
  key: 'add-function' | 'fix-bug' | 'edit-existing';
  kind: string;
  summary: string;
  description: string;
  scope: { write: string[]; read: string[] };
}

export const E_TASKS: readonly ETask[] = JSON.parse(readFileSync(path.join(DIR, 'tasks.json'), 'utf8')) as ETask[];

/** The shop of checkpoint E: the fixture shop with the percentage label, its bug and its one test, committed. */
export async function prepareEShop(root: string): Promise<void> {
  cpSync(path.join(DIR, 'shop'), root, { recursive: true });
  await deterministicGit(root, { startEpoch: 1_767_260_000 }).commitAll('feat: a percentage label');
}

export interface EVerdict {
  /** The project's own tests on the final code. */
  project: boolean;
  checks: Record<string, boolean>;
  /** Each task: every hidden check that names it passes. */
  tasks: Record<string, boolean>;
}

/** Judges a folder's final code: the project's tests and the hidden checks, each task by its own. */
export function judgeE(dir: string): EVerdict {
  const project = spawnSync(process.execPath, ['--test', '**/test/*.test.ts'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  });
  const hidden = spawnSync(process.execPath, ['--test', '--test-reporter=tap', E_HIDDEN_TESTS], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
    env: { ...process.env, OPENCODE_E_TREE: dir },
  });
  const checks = parseTap(`${hidden.stdout ?? ''}`);
  const tasks = Object.fromEntries(
    E_TASKS.map((t) => {
      const mine = Object.entries(checks).filter(([name]) => name.startsWith(`${t.key}:`));
      return [t.key, mine.length > 0 && mine.every(([, ok]) => ok)];
    }),
  );
  return { project: project.status === 0, checks, tasks };
}

/** The prompt OpenCode alone gets for a task: the task as written, nothing else. */
export function plainPrompt(t: ETask): string {
  return `${t.summary}\n\n${t.description}`;
}
