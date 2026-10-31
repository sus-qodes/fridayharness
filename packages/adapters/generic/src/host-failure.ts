import type { HostFailure } from '@friday/protocol';

/**
 * Where a failure was seen: `start`, the host could not be launched or given its task; `exit`, the
 * host's process ended while a turn ran; `turn`, the host itself reported that its turn ended in
 * an error (which is a work failure unless the text says the host could not serve it).
 */
export type HostFailureSite = 'start' | 'exit' | 'turn';

const AUTH =
  /not (?:logged|signed) in|please (?:log|sign) in|login required|unauthori[sz]ed|invalid (?:api[ -]?)?key|authentication(?:_| )\s*(?:failed|required|error)|expired (?:token|credentials|session)|(?:^|\n)\s*(?:HTTP\s+)?40[13]\b/i;
const RATE =
  /rate[ -]?limit|too many requests|(?:^|\n)\s*(?:HTTP\s+)?(?:429|529)\b|overloaded|(?:api|token|request|usage|insufficient)[ _-]quota|quota_exceeded|at capacity|try again (?:later|in)/i;
const RETRY_AFTER = /retry[- ]after[:\s]+(\d+)/i;
const TRY_AGAIN = /try again in (\d+)\s*(s|secs?|seconds?|m|mins?|minutes?|h|hours?)\b/i;
const LAUNCH = /ENOENT|EACCES|spawn|not found|is not recognized|no such file|cannot execute|command not found/i;
// A model the host cannot serve on this account or machine (Codex with a ChatGPT account refusing a
// model name; a model that does not exist there): the host's failure, benched as `runtime_unavailable`.
const UNSUPPORTED_MODEL =
  /model['"]? .{0,80}?(?:is )?not (?:supported|available|found)|unsupported model|unknown model|model_not_found|no such model|model .{0,40}?does not exist/i;

const UNIT_S: Record<string, number> = { s: 1, sec: 1, secs: 1, second: 1, seconds: 1 };
const unitSeconds = (unit: string): number => {
  const u = unit.toLowerCase();
  if (u in UNIT_S) return UNIT_S[u] as number;
  if (u.startsWith('m')) return 60;
  return 3600;
};

/** The seconds a rate-limited host asked to wait, when its text says; capped to a day. */
export function retryAfterSeconds(text: string): number | undefined {
  const direct = RETRY_AFTER.exec(text);
  if (direct) return Math.min(86_400, Math.max(1, Number(direct[1])));
  const again = TRY_AGAIN.exec(text);
  if (again) return Math.min(86_400, Math.max(1, Number(again[1]) * unitSeconds(again[2] ?? 's')));
  return undefined;
}

/**
 * How a host failed, from what it printed or returned (ADR-0035 §3): a sign-in problem or a rate
 * limit wherever it appears; otherwise a failure to launch or to take the task is `start`, a process
 * that died mid-turn is `transport`, and a turn the host ended with an error of its own is a work
 * failure, which is nobody's bench (null).
 */
export function classifyHostFailure(text: string, site: HostFailureSite): HostFailure | null {
  const t = text ?? '';
  if (AUTH.test(t)) return { kind: 'auth' };
  if (UNSUPPORTED_MODEL.test(t)) return { kind: 'runtime_unavailable' };
  if (RATE.test(t)) {
    const retry_after_s = retryAfterSeconds(t);
    return retry_after_s === undefined ? { kind: 'rate_limit' } : { kind: 'rate_limit', retry_after_s };
  }
  if (site === 'start') return { kind: 'start' };
  if (site === 'exit') return { kind: LAUNCH.test(t) ? 'start' : 'transport' };
  return null;
}
