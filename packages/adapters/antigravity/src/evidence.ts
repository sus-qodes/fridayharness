/**
 * What a crashed or timed-out PreToolUse hook does to Antigravity's call: the one fact Antigravity's
 * level depends on (plan M8b.3, B21, ADR-0016). The vendor documents no exit codes, no timeout rule
 * and no failure rule for hook commands, and the App's changelog says only that a failing hook "is
 * reported as an error and the conversation continues", which hints at fail-open without saying so.
 * So Friday reports `unverified` until a run records it here.
 *
 * How to record it is in docs/integration/antigravity.md ("Recording the failure behaviour"): the
 * owner's live check runs a PreToolUse hook that crashes and one that outlasts its timeout, and
 * writes what happened to the call below, with the host version, the date and where the run's
 * notes are kept.
 */
import { compareVersions } from '@friday/adapter-claude';

/** What happened to the gated call: it was blocked, or it ran. */
export type FailureOutcome = 'blocks' | 'runs';

export interface FailureEvidence {
  /** The `agy --version` (or App version) the run used, e.g. `1.4.2`. */
  host_version: string | null;
  /** The day of the run, `YYYY-MM-DD`. */
  checked_on: string | null;
  /** A PreToolUse hook that exits non-zero with nothing on stdout (a crashed `node`). */
  crash: FailureOutcome | null;
  /** A PreToolUse hook that outlasts its `timeout`. */
  timeout: FailureOutcome | null;
  /** Where the run's notes and raw replies are kept (a section of docs/integration/antigravity.md). */
  notes: string | null;
}

/** Nothing recorded yet: no run of Antigravity has been made with Friday's hooks. */
export const FAILURE_EVIDENCE: FailureEvidence = {
  host_version: null,
  checked_on: null,
  crash: null,
  timeout: null,
  notes: null,
};

export type AntigravityLevel = 'enforcing' | 'degraded' | 'unverified';

/**
 * The level the evidence supports for `hostVersion` (L1 once Friday's hooks reach the daemon):
 * `enforcing` when both a crash and a timeout block the call, `degraded` when either lets it run,
 * and `unverified` when either is unknown, or when the evidence was recorded on another minor
 * version than the one installed (a new version may behave differently). An unknown installed
 * version is not held against recorded evidence: the hooks run on whatever version is there.
 */
export function levelFromEvidence(e: FailureEvidence, hostVersion: string | null = null): AntigravityLevel {
  if (!e.host_version || e.crash === null || e.timeout === null) return 'unverified';
  if (hostVersion && !sameMinor(e.host_version, hostVersion)) return 'unverified';
  return e.crash === 'blocks' && e.timeout === 'blocks' ? 'enforcing' : 'degraded';
}

function sameMinor(a: string, b: string): boolean {
  const minor = (v: string) => v.split('.').slice(0, 2).join('.');
  return compareVersions(minor(a), minor(b)) === 0;
}

/** Why the level is what it is, in the doctor's words. */
export function levelReason(e: FailureEvidence, hostVersion: string | null = null): string {
  const level = levelFromEvidence(e, hostVersion);
  if (level === 'unverified') {
    if (e.host_version && hostVersion && !sameMinor(e.host_version, hostVersion))
      return `what a crashed or timed-out hook does to the call was recorded for Antigravity ${e.host_version}, not for ${hostVersion}`;
    return 'what Antigravity does with a call when its hook crashes or times out is not documented, and no run has recorded it yet';
  }
  if (level === 'enforcing')
    return `a crashed or timed-out hook blocked the call in a run of Antigravity ${e.host_version} (${e.checked_on ?? 'date not recorded'})`;
  return `a crashed or timed-out hook let the call run in a run of Antigravity ${e.host_version} (${e.checked_on ?? 'date not recorded'})`;
}
