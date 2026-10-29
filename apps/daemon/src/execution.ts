import { type ExecutionProfile, executeRun, type ProcessGroups, ProfileError, prepareRun } from '@friday/execution';
import type { CheckOutcome } from '@friday/verification';
import type { EffectivePolicy } from './policy.js';

/**
 * The execution profile of the effective policy (ADR-0029 §4): the same object while the policy
 * does not change, so binaries are looked up once per policy.
 */
export function profileCache(deps: {
  /** The project and its task worktrees: binaries there are never run. */
  forbiddenRoots: () => string[];
  /** The per-user state folder. */
  stateDir: string;
  env: NodeJS.ProcessEnv;
}): (policy: EffectivePolicy) => ExecutionProfile {
  let last: { version: string; profile: ExecutionProfile } | undefined;
  return (policy) => {
    if (last?.version === policy.version) return last.profile;
    const profile: ExecutionProfile = {
      binaries: policy.execution.binaries,
      envPassthrough: policy.execution.env_passthrough,
      forbiddenRoots: deps.forbiddenRoots(),
      base: deps.env,
      stateDir: deps.stateDir,
    };
    last = { version: policy.version, profile };
    return profile;
  };
}

/**
 * Runs one check in the execution profile (ADR-0029 §6). A command the profile refuses fails the
 * check, with the reason as its output. With `groups`, the check's whole process tree is a group:
 * what the check leaves running when it exits ends with it (review F07).
 */
export async function runCheckInProfile(
  profile: ExecutionProfile,
  spec: {
    name: string;
    command: string;
    args: readonly string[];
    /** The checkout being verified. */
    root: string;
    cwd: string;
    env?: Record<string, string>;
    timeoutMs: number;
  },
  groups?: ProcessGroups,
): Promise<CheckOutcome> {
  const group = groups?.create();
  try {
    const run = prepareRun(
      { command: spec.command, args: spec.args, root: spec.root, cwd: spec.cwd, env: spec.env ?? {} },
      profile,
    );
    const out = await executeRun(run, profile, { timeoutMs: spec.timeoutMs, ...(group ? { group } : {}) });
    return {
      name: spec.name,
      passed: out.passed,
      exit_code: out.exit_code,
      signal: out.signal,
      timed_out: out.timed_out,
      duration_ms: out.duration_ms,
      output: out.output,
      output_truncated: out.output_truncated,
      spawn_error: out.spawn_error,
    };
  } catch (e) {
    if (!(e instanceof ProfileError)) throw e;
    const reason = `refused by the execution profile: ${e.message}`;
    return {
      name: spec.name,
      passed: false,
      exit_code: null,
      signal: null,
      timed_out: false,
      duration_ms: 0,
      output: reason,
      output_truncated: false,
      spawn_error: reason,
    };
  } finally {
    await group?.close();
  }
}
