import type { HostFailure } from '@friday/protocol';

/**
 * Where a failure was seen: `start`, the host could not be launched or given its task; `exit`, the
 * host's process ended while a turn ran; `turn`, the host itself reported that its turn ended in
 * an error (which is a work failure unless the text says the host could not serve it).
 */
export type HostFailureSite = 'start' | 'exit' | 'turn';

// A sign-in the host no longer has: also a subscription's OAuth token that ran out ("OAuth token
// has expired", "Please run /login"), which read as a failed task (2026-11-17). Only the host's own
// words for it: "token expired" or "session expired" alone may be what a task's tests printed.
const AUTH =
  /not (?:logged|signed) in|please (?:log|sign) in|login required|unauthori[sz]ed|invalid (?:api[ -]?)?key|authentication(?:_| )\s*(?:failed|required|error)|expired (?:token|credentials|session)|oauth (?:access )?token (?:has |is )?expired|please run \/login|(?:^|\n)\s*(?:HTTP\s+)?40[13]\b/i;
// A limit of the account that passes with time. A subscription's usage limit is one ("Claude AI
// usage limit reached|<epoch>", "5-hour limit reached ∙ resets 3pm", "You've hit your limit · resets
// 5pm"): it used to count as the work's failure, so the task was retried at once on the same host
// and handed to a person as failed (2026-11-17). "limit reached" alone is not taken for one: a
// task's own error may say it (a recursion limit, a context limit).
const RATE =
  /rate[ -]?limit|too many requests|(?:^|\n)\s*(?:HTTP\s+)?(?:429|529)\b|overloaded|(?:api|token|request|usage|insufficient)[ _-]quota|quota_exceeded|at capacity|try again (?:later|in)|usage limit|\b(?:5|five)[- ]hour limit|\b(?:hourly|daily|weekly|monthly|session|plan) (?:usage )?limit|hit (?:your|the) (?:usage )?limit|limit reached\s*[|∙·•,;:-]?\s*(?:\d{9,11}\b|resets?\b)/i;
const RETRY_AFTER = /retry[- ]after[:\s]+(\d+)/i;
const TRY_AGAIN = /try again in (\d+)\s*(s|secs?|seconds?|m|mins?|minutes?|h|hours?)\b/i;
// When a usage limit lifts: the moment itself after a bar (seconds since 1970), or a time of day.
const RESET_EPOCH = /limit reached\s*\|\s*(\d{9,11})\b/i;
const RESET_CLOCK = /resets?(?: at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;
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

/**
 * The seconds a rate-limited host asked to wait, when its text says; capped to a day. A usage limit
 * names the moment it lifts instead (`…|<epoch>`, "resets 3pm", "resets at 15:30"): the wait is from
 * `now` to then, the time of day read in this machine's time zone, as the host printed it.
 */
export function retryAfterSeconds(text: string, now: Date = new Date()): number | undefined {
  const direct = RETRY_AFTER.exec(text);
  if (direct) return Math.min(86_400, Math.max(1, Number(direct[1])));
  const again = TRY_AGAIN.exec(text);
  if (again) return Math.min(86_400, Math.max(1, Number(again[1]) * unitSeconds(again[2] ?? 's')));
  const epoch = RESET_EPOCH.exec(text);
  if (epoch) {
    const wait = Math.ceil(Number(epoch[1]) - now.getTime() / 1000);
    // A moment already past says nothing about how long to wait.
    return wait > 0 ? Math.min(86_400, wait) : undefined;
  }
  const clock = RESET_CLOCK.exec(text);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2] ?? 0);
    const half = clock[3]?.toLowerCase();
    if (half === 'pm' && hour < 12) hour += 12;
    if (half === 'am' && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) return undefined;
    const at = new Date(now.getTime());
    at.setHours(hour, minute, 0, 0);
    // The next time the clock shows it: today, or tomorrow when it has passed.
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    return Math.min(86_400, Math.max(1, Math.ceil((at.getTime() - now.getTime()) / 1000)));
  }
  return undefined;
}

/**
 * How a host failed, from what it printed or returned (ADR-0035 §3): a sign-in problem or a rate
 * limit wherever it appears; otherwise a failure to launch or to take the task is `start`, a process
 * that died mid-turn is `transport`, and a turn the host ended with an error of its own is a work
 * failure, which is nobody's bench (null).
 */
export function classifyHostFailure(text: string, site: HostFailureSite, now: Date = new Date()): HostFailure | null {
  const t = text ?? '';
  if (AUTH.test(t)) return { kind: 'auth' };
  if (UNSUPPORTED_MODEL.test(t)) return { kind: 'runtime_unavailable' };
  if (RATE.test(t)) {
    const retry_after_s = retryAfterSeconds(t, now);
    return retry_after_s === undefined ? { kind: 'rate_limit' } : { kind: 'rate_limit', retry_after_s };
  }
  if (site === 'start') return { kind: 'start' };
  if (site === 'exit') return { kind: LAUNCH.test(t) ? 'start' : 'transport' };
  return null;
}
