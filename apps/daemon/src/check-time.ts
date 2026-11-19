/**
 * A check's time limit (2026-11-19, the trial's F8).
 *
 * In the trial, the project's lint took 116 s of its 120 s limit while another agent worked at the
 * same time; alone it takes 25 s. Had it gone over, correct work would have been failed by a busy
 * computer, said as "failed". Here:
 * - a check that runs out of time is run once more, with twice the time, before it counts;
 * - what happened is said in words, and as a finding the check's row shows;
 * - the limit the measured times call for is suggested, to be set with one click in Settings.
 */
import type { ExecutionProfile, ProcessGroups } from '@friday/execution';
import type { VerificationFinding } from '@friday/protocol';
import { type CheckOutcome, durationWords, summarizeOutcome } from '@friday/verification';
import { runCheckInProfile } from './execution.js';

/** The longest a check may be given (config.yaml's own maximum). */
export const CHECK_LIMIT_MAX_MS = 3_600_000;
/** A check's limit when config.yaml sets none. */
export const CHECK_LIMIT_DEFAULT_MS = 120_000;
/** The rule of the finding a check that ran out of time carries. */
export const RAN_OUT_OF_TIME = 'check.ran_out_of_time';

const MINUTE = 60_000;

export interface TimedCheck {
  outcome: CheckOutcome;
  /** The limit the first try ran out of, when there was a second try; else null. */
  first_limit_ms: number | null;
}

/**
 * Runs a check, and once more with twice the time if it ran out of it (at most the maximum). The
 * second try's outcome is the check's: its time is what the check needed.
 */
export async function runCheckWithSecondTry(
  profile: ExecutionProfile,
  spec: Parameters<typeof runCheckInProfile>[1],
  groups?: ProcessGroups,
): Promise<TimedCheck> {
  const outcome = await runCheckInProfile(profile, spec, groups);
  if (!outcome.timed_out || spec.timeoutMs >= CHECK_LIMIT_MAX_MS) return { outcome, first_limit_ms: null };
  const again = await runCheckInProfile(
    profile,
    { ...spec, timeoutMs: Math.min(spec.timeoutMs * 2, CHECK_LIMIT_MAX_MS) },
    groups,
  );
  return { outcome: again, first_limit_ms: spec.timeoutMs };
}

/** The one-line summary of a timed check, and the finding its row shows when time ran short. */
export function timedSummary(
  name: string,
  r: TimedCheck,
  limitMs: number,
): { summary: string; finding: VerificationFinding | null } {
  const { outcome, first_limit_ms: first } = r;
  const limit = durationWords(limitMs);
  if (first !== null && !outcome.timed_out) {
    const more = durationWords(Math.min(first * 2, CHECK_LIMIT_MAX_MS));
    const how = outcome.passed ? 'passed' : summarizeOutcome(outcome).replace(/ in \d+ ms/, '');
    return {
      summary: `ran out of its ${limit} time limit; on a second try with ${more} it ${how}`,
      finding: {
        rule: RAN_OUT_OF_TIME,
        severity: 'warn',
        message: `“${name}” did not finish within its ${limit} limit, so Friday ran it again with ${more}, and it took ${durationWords(outcome.duration_ms)}. The computer was probably busy (other agents at work). Give it more time in Settings → Checks.`,
        paths: [],
      },
    };
  }
  if (outcome.timed_out) {
    const twice = first !== null;
    return {
      summary: twice
        ? `ran out of time twice: stopped at its ${limit} limit, then at ${durationWords(Math.min(first * 2, CHECK_LIMIT_MAX_MS))}`
        : `ran out of time: stopped at its ${limit} limit`,
      finding: {
        rule: RAN_OUT_OF_TIME,
        severity: 'fail',
        message: `“${name}” ran out of time${twice ? `, also on a second try with ${durationWords(Math.min(first * 2, CHECK_LIMIT_MAX_MS))}` : ''}. If it usually finishes sooner, it may be waiting for something (a watch mode, a question, a database that is not running); if not, give it more time in Settings → Checks.`,
        paths: [],
      },
    };
  }
  return { summary: summarizeOutcome(outcome), finding: null };
}

/**
 * The limit to suggest for a check that took `longestMs` at most: three times that, in whole
 * minutes, at least two, at most the maximum. Checks take several times longer while agents work
 * at the same time (lint: 25 s alone, 116 s beside another agent). Null when the limit it has is
 * already enough.
 */
export function suggestedLimit(limitMs: number, longestMs: number | null): number | null {
  if (longestMs === null || !Number.isFinite(longestMs) || longestMs <= 0) return null;
  const want = Math.min(CHECK_LIMIT_MAX_MS, Math.max(2 * MINUTE, Math.ceil((longestMs * 3) / MINUTE) * MINUTE));
  return want > limitMs ? want : null;
}
