import { existsSync } from 'node:fs';
import path from 'node:path';
import { type ExecutionProfile, executeRun, type ProcessGroups, ProfileError, prepareRun } from '@friday/execution';
import type { Logger } from './log.js';
import type { EffectivePolicy } from './policy.js';

/**
 * Dependencies in a fresh task worktree (plan Phase 7). A worktree starts as a bare checkout: the
 * large trial lost its harness while the agent waited for an approval to install them, so Friday
 * installs them itself before the agent starts, in the execution profile, under the policy's trust
 * rule: the project's own command, or lifecycle scripts, run only once this clone trusted the
 * policy (ADR-0028); a lockfile install with scripts ignored runs project code of no kind, so it
 * runs by default. Nothing is installed silently: the outcome is on the run's record, and an
 * agent whose dependencies could not be installed is told so when it starts.
 */

export type SetupStatus = 'passed' | 'failed' | 'skipped' | 'refused';

/** What the setup did, as the run's record carries it (never a credential: the output is redacted). */
export interface SetupOutcome {
  status: SetupStatus;
  /** `config`: the project's own command; `lockfile`: detected from the lockfile; null when nothing ran. */
  source: 'config' | 'lockfile' | null;
  command: string | null;
  args: string[];
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number | null;
  /** Why it was skipped or refused, or how it failed; `ok` when it passed. */
  reason: string;
  output_tail: string | null;
}

export interface SetupPlan {
  source: 'config' | 'lockfile';
  command: string;
  args: string[];
  /** The package manager, for a detected install. */
  manager: string | null;
}

export type SetupDecision = SetupPlan | { skipped: string } | { refused: string };

/** The lockfiles Friday recognizes, with the install each one calls for (frozen, offline first). */
const LOCKFILES: { file: string; manager: string; args: (scripts: boolean) => string[] }[] = [
  {
    file: 'pnpm-lock.yaml',
    manager: 'pnpm',
    args: (s) => ['install', '--frozen-lockfile', '--prefer-offline', ...(s ? [] : ['--ignore-scripts'])],
  },
  {
    file: 'package-lock.json',
    manager: 'npm',
    args: (s) => ['ci', '--prefer-offline', '--no-audit', '--no-fund', ...(s ? [] : ['--ignore-scripts'])],
  },
  {
    file: 'npm-shrinkwrap.json',
    manager: 'npm',
    args: (s) => ['ci', '--prefer-offline', '--no-audit', '--no-fund', ...(s ? [] : ['--ignore-scripts'])],
  },
  {
    file: 'yarn.lock',
    manager: 'yarn',
    args: (s) => ['install', '--frozen-lockfile', ...(s ? [] : ['--ignore-scripts'])],
  },
  {
    file: 'bun.lock',
    manager: 'bun',
    args: (s) => ['install', '--frozen-lockfile', ...(s ? [] : ['--ignore-scripts'])],
  },
  {
    file: 'bun.lockb',
    manager: 'bun',
    args: (s) => ['install', '--frozen-lockfile', ...(s ? [] : ['--ignore-scripts'])],
  },
];

export const LOCKFILE_NAMES: readonly string[] = LOCKFILES.map((l) => l.file);

/**
 * What to run in a worktree, from what is there and what the policy allows: the project's own
 * command when trusted; a declared command this clone has not trusted is refused, never replaced
 * by a guess; otherwise the install the lockfile calls for, with lifecycle scripts only when
 * trusted; nothing when there is no package.json, no lockfile, or `node_modules` already.
 */
export function planSetup(
  root: string,
  opts: {
    enabled: boolean;
    declared: { command: string; args: string[] } | null;
    held: { source: string; reason: string } | null;
    allowScripts: boolean;
  },
): SetupDecision {
  if (!opts.enabled) return { skipped: 'worktrees.setup.enabled is false' };
  if (existsSync(path.join(root, 'node_modules'))) return { skipped: 'node_modules is already there' };
  if (opts.declared) {
    return { source: 'config', command: opts.declared.command, args: [...opts.declared.args], manager: null };
  }
  if (opts.held) {
    return { refused: `${opts.held.source} declares worktrees.setup.command, which ${opts.held.reason}` };
  }
  if (!existsSync(path.join(root, 'package.json'))) return { skipped: 'no package.json' };
  for (const l of LOCKFILES) {
    if (existsSync(path.join(root, l.file))) {
      return { source: 'lockfile', command: l.manager, args: l.args(opts.allowScripts), manager: l.manager };
    }
  }
  return { skipped: `no lockfile (${LOCKFILE_NAMES.join(', ')})` };
}

const OUTPUT_TAIL = 2000;

export interface WorktreeSetupDeps {
  settings: () => { enabled: boolean; timeout_s: number };
  policy: () => EffectivePolicy;
  profile: () => ExecutionProfile;
  groups: ProcessGroups;
  logger: Logger;
  /** Removes credentials from what the install printed. */
  redact: (text: string) => string;
}

/** Runs the setup a worktree calls for, in the execution profile, and reports what happened. */
export class WorktreeSetup {
  constructor(private readonly deps: WorktreeSetupDeps) {}

  async run(worktree: { path: string }, ids: { task_id: string; run_id: string }): Promise<SetupOutcome> {
    const { logger } = this.deps;
    const policy = this.deps.policy();
    const settings = this.deps.settings();
    const decision = planSetup(worktree.path, {
      enabled: settings.enabled,
      declared: policy.worktree_setup
        ? { command: policy.worktree_setup.command, args: policy.worktree_setup.args }
        : null,
      held: policy.worktree_setup_held,
      allowScripts: policy.worktree_scripts,
    });
    const none = {
      source: null,
      command: null,
      args: [],
      exit_code: null,
      timed_out: false,
      duration_ms: null,
      output_tail: null,
    };
    if ('skipped' in decision) return { status: 'skipped', reason: decision.skipped, ...none };
    if ('refused' in decision) {
      logger.warn('task worktree dependencies not installed', { ...ids, reason: decision.refused });
      return { status: 'refused', reason: decision.refused, ...none };
    }
    const base = { source: decision.source, command: decision.command, args: decision.args };
    const group = this.deps.groups.create();
    try {
      const run = prepareRun(
        {
          command: decision.command,
          args: decision.args,
          root: worktree.path,
          cwd: worktree.path,
          // Non-interactive, as an installer on a build machine.
          env: { CI: 'true', FRIDAY_WORKTREE_SETUP: '1' },
        },
        this.deps.profile(),
      );
      logger.info('installing task worktree dependencies', { ...ids, command: decision.command, args: decision.args });
      const out = await executeRun(run, this.deps.profile(), {
        timeoutMs: settings.timeout_s * 1000,
        group,
        maxOutputChars: 64 * 1024,
      });
      const tail = this.deps.redact(out.output.slice(-OUTPUT_TAIL)) || null;
      const result: SetupOutcome = {
        status: out.passed ? 'passed' : 'failed',
        ...base,
        exit_code: out.exit_code,
        timed_out: out.timed_out,
        duration_ms: out.duration_ms,
        reason: out.passed
          ? 'ok'
          : out.timed_out
            ? `${decision.command} did not finish within ${settings.timeout_s} s`
            : out.spawn_error
              ? `${decision.command} could not start: ${out.spawn_error}`
              : `${decision.command} exited with ${out.exit_code ?? out.signal ?? 'an unknown status'}`,
        output_tail: tail,
      };
      const detail = { ...ids, status: result.status, duration_ms: out.duration_ms, reason: result.reason };
      if (out.passed) logger.info('task worktree dependencies installed', detail);
      else logger.warn('task worktree dependencies not installed', detail);
      return result;
    } catch (e) {
      const reason =
        e instanceof ProfileError ? `refused by the execution profile: ${e.message}` : (e as Error).message;
      logger.warn('task worktree dependencies not installed', { ...ids, reason });
      return {
        status: e instanceof ProfileError ? 'refused' : 'failed',
        ...base,
        exit_code: null,
        timed_out: false,
        duration_ms: null,
        reason,
        output_tail: null,
      };
    } finally {
      await group.close().catch(() => undefined);
    }
  }
}
