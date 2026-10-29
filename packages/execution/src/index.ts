/**
 * @friday/execution
 * The execution profile checks and operations run in, and the gateway that runs a project's
 * operations with stored secrets the agent never sees (spec Part 07 §9–§10, ADR-0029).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProcessGroup } from './groups.js';
import {
  checkArguments,
  type ExecutionProfile,
  ProfileError,
  profileEnvironment,
  type ResolvedBinary,
  resolveBinary,
} from './profile.js';
import { type ProcessOutcome, runProcess } from './runner.js';
import { MIN_SECRET_LENGTH, sanitizeOutput } from './sanitize.js';

export const PACKAGE_NAME = '@friday/execution';

export * from './groups.js';
export * from './profile.js';
export * from './runner.js';
export * from './sanitize.js';

export interface RunSpec {
  command: string;
  args: readonly string[];
  /** The checkout the run belongs to; `cwd` must stay inside it. */
  root: string;
  cwd: string;
  /** Plain variables of the check or operation. */
  env?: Record<string, string>;
}

/** A run the profile accepted: its binary resolved, its arguments and folder checked. */
export interface PreparedRun {
  binary: ResolvedBinary;
  args: string[];
  root: string;
  cwd: string;
  env: Record<string, string>;
}

/** Checks a run against the profile before anything starts; throws a ProfileError. */
export function prepareRun(spec: RunSpec, profile: ExecutionProfile): PreparedRun {
  const binary = resolveBinary(spec.command, profile);
  checkArguments(spec.args, spec.cwd, spec.root, profile, binary.viaCmd);
  return { binary, args: [...spec.args], root: spec.root, cwd: spec.cwd, env: { ...(spec.env ?? {}) } };
}

export interface ProfileOutcome extends ProcessOutcome {
  /** Exit code 0 within the time limit. */
  passed: boolean;
  /** Occurrences of a credential (or of a known credential format) removed from the output. */
  redactions: number;
  binary: string;
}

/**
 * Runs a prepared command in the profile: a fresh temporary folder, the minimal environment plus
 * its variables and credentials, the output sanitized of every credential it was given.
 */
export async function executeRun(
  run: PreparedRun,
  profile: ExecutionProfile,
  opts: {
    timeoutMs: number;
    /** Variable name → value, with the secret's name for the redaction marker. */
    credentials?: readonly { variable: string; name: string; value: string }[];
    maxOutputChars?: number;
    /** The group the run's whole process tree belongs to (review F07). */
    group?: ProcessGroup;
    onStart?: (pid: number | undefined, stop: () => Promise<void>) => void;
  },
): Promise<ProfileOutcome> {
  const credentials = opts.credentials ?? [];
  const short = credentials.find((c) => c.value.length < MIN_SECRET_LENGTH);
  if (short) {
    throw new ProfileError(
      'credential.too_short',
      `the secret ${short.name} has fewer than ${MIN_SECRET_LENGTH} characters, too short to keep out of the output`,
    );
  }
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'fx-'));
  try {
    const env = profileEnvironment(profile, {
      tempDir,
      env: run.env,
      credentials: Object.fromEntries(credentials.map((c) => [c.variable, c.value])),
    });
    const outcome = await runProcess({
      command: run.binary.path,
      args: run.args,
      cwd: run.cwd,
      env,
      viaCmd: run.binary.viaCmd,
      timeoutMs: opts.timeoutMs,
      ...(opts.maxOutputChars ? { maxOutputChars: opts.maxOutputChars } : {}),
      ...(opts.group ? { group: opts.group } : {}),
      ...(opts.onStart ? { onStart: opts.onStart } : {}),
    });
    // A tail cut in the middle of a line could start inside a value, which no variant would match.
    const kept = outcome.output_truncated ? outcome.output.slice(outcome.output.indexOf('\n') + 1) : outcome.output;
    const clean = sanitizeOutput(kept, credentials);
    return {
      ...outcome,
      output: clean.text,
      redactions: clean.redactions,
      passed: outcome.exit_code === 0 && !outcome.timed_out && !outcome.spawn_error,
      binary: run.binary.path,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 });
  }
}
