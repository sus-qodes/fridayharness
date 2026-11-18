/**
 * A project whose packages cannot be installed in a new task folder, said to its person
 * (2026-11-18).
 *
 * Every task folder starts with a clean install. In the trial the project's lockfile had gone out
 * of step with its `package.json`, so that install failed in two seconds in all four folders of a
 * goal. Only the agents were told: each installed by itself, differently, and spent minutes on
 * it; the person saw nothing, and nothing in the app could put it right.
 *
 * So the first such failure is a question in the waiting list: what npm said, in a sentence, and
 * "Have an agent repair it", which starts a goal for exactly that. It is asked once per lockfile
 * (a "not now" is remembered for that file's content), and it closes by itself when an install
 * passes again.
 *
 * Only for what an agent can repair from the repository: a lockfile npm refuses. A registry that
 * is down or a network that is off fails the same install, and no goal fixes those.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Actor } from '@friday/protocol';
import type { FridayState } from '@friday/state';
import { judgeCleanInstall } from './clean-install.js';
import type { SetupOutcome } from './worktree-setup.js';

export const INSTALL_BROKEN = 'install_broken';
const SYSTEM: Actor = { kind: 'system', id: 'friday' };

/** The lockfile npm installs from in `dir`, or null. */
function lockfileIn(dir: string): string | null {
  return ['npm-shrinkwrap.json', 'package-lock.json'].find((f) => existsSync(path.join(dir, f))) ?? null;
}

/** What identifies this state of the project's package list: the lockfile and the manifest beside it. */
function listKey(dir: string, lockfile: string): string {
  const h = createHash('sha256');
  for (const f of [lockfile, 'package.json']) {
    try {
      h.update(readFileSync(path.join(dir, f)));
    } catch {
      h.update(`(no ${f})`);
    }
    h.update('\0');
  }
  return h.digest('hex').slice(0, 24);
}

/**
 * Called with every set-up of a task folder. A lockfile npm refuses raises the question, once for
 * that lockfile; an install that passed closes the question that is open. Returns what it did.
 */
export function noteInstall(
  state: FridayState,
  projectId: string,
  setup: SetupOutcome,
  folder: string,
  taskId: string,
): 'asked' | 'closed' | null {
  if (setup.source !== 'lockfile' || setup.command !== 'npm') return null;
  if (setup.status === 'passed') {
    const open = state.q.escalations(projectId, 'pending').some((e) => e.kind === INSTALL_BROKEN);
    if (!open) return null;
    state.settleProjectQuestions(projectId, INSTALL_BROKEN, 'the packages install again in a new task folder');
    return 'closed';
  }
  if (setup.status !== 'failed') return null;
  const lockfile = lockfileIn(folder);
  if (!lockfile) return null;
  const judged = judgeCleanInstall(
    {
      passed: false,
      output: setup.output_tail ?? '',
      timed_out: setup.timed_out,
      spawn_error: null,
      exit_code: setup.exit_code,
    },
    { dir: '', lockfile },
  );
  if (judged.verdict !== 'out_of_step') return null;
  const key = listKey(folder, lockfile);
  // Asked before for this very lockfile, answered or not: once is enough.
  const asked = state.q.escalations(projectId).some((e) => {
    if (e.kind !== INSTALL_BROKEN) return false;
    try {
      return (JSON.parse(String(e.details_json ?? '{}')) as { key?: unknown }).key === key;
    } catch {
      return false;
    }
  });
  if (asked) return null;
  const missing = (setup.output_tail ?? '')
    .split('\n')
    .map((l) => l.replace(/^npm (?:error|ERR!)\s*/i, '').trim())
    .filter((l) => /^(?:Missing|Invalid): /i.test(l))
    .slice(0, 6);
  state.raiseEscalation(projectId, SYSTEM, {
    kind: INSTALL_BROKEN,
    goal_id: null,
    task_id: null,
    question: `This project's packages cannot be installed in a new task folder: ${lockfile} does not match package.json. Each agent then has to install by itself, which costs minutes on every task, or fails. Have an agent repair ${lockfile}?`,
    options: ['have an agent repair it', 'not now'],
    details: {
      key,
      lockfile,
      first_task_id: taskId,
      command: [setup.command, ...setup.args].join(' '),
      missing,
      evidence: [
        `install: ${[setup.command, ...setup.args].join(' ')}`,
        ...(missing.length ? [`npm said: ${missing.join('; ')}`] : []),
      ],
    },
  });
  return 'asked';
}

/** What the repair goal asks for: the lockfile, and nothing else. */
export function repairRequest(lockfile: string): string {
  return `Repair ${lockfile} so that a clean install (npm ci) works again: bring it in step with package.json by running npm install, and change nothing else. Check with "npm ci --dry-run --ignore-scripts".`;
}
